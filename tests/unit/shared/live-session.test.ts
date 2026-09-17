import { describe, expect, it } from 'vitest';

import type { CloudLiveCloseEvent } from '../../../src/shared/cloud/live-client.js';
import type { LiveFrame } from '../../../src/shared/cloud/live-protocol.js';
import { LiveWorkspaceChannel, type LiveRelayTransport } from '../../../src/shared/cloud/live-session.js';

class LinkedRelay implements LiveRelayTransport {
  peer: LinkedRelay | null = null;
  connected = false;
  readonly received: Uint8Array[] = [];
  private readonly frameListeners = new Set<(frame: Uint8Array) => void>();
  private readonly closeListeners = new Set<(event: CloudLiveCloseEvent) => void>();

  async connect(): Promise<void> { this.connected = true; }

  send(frame: Uint8Array): void {
    if (!this.connected || !this.peer) throw new Error('relay is not connected');
    this.peer.received.push(new Uint8Array(frame));
    for (const listener of this.peer.frameListeners) listener(new Uint8Array(frame));
  }

  close(code = 1000, reason = ''): void {
    this.connected = false;
    for (const listener of this.closeListeners) listener({ code, reason });
  }

  onFrame(listener: (frame: Uint8Array) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onClose(listener: (event: CloudLiveCloseEvent) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }
}

const createLink = (): { owner: LinkedRelay; viewer: LinkedRelay } => {
  const owner = new LinkedRelay();
  const viewer = new LinkedRelay();
  owner.peer = viewer;
  viewer.peer = owner;
  return { owner, viewer };
};

const snapshot: LiveFrame = {
  protocolVersion: 1,
  type: 'workspace-snapshot',
  workspaceId: 'workspace-1',
  ownerEpoch: 1,
  sequence: 0,
  terminals: []
};

const flushRelay = async (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('live workspace channel', () => {
  it('handshakes viewers, sends targeted owner frames, and forwards viewer input', async () => {
    const { owner: ownerRelay, viewer: viewerRelay } = createLink();
    const ownerFrames: Array<{ frame: LiveFrame; sender: string }> = [];
    const viewerFrames: LiveFrame[] = [];
    const ownerErrors: Error[] = [];
    const viewerErrors: Error[] = [];
    const owner = new LiveWorkspaceChannel({
      relay: ownerRelay,
      workspaceId: 'workspace-1',
      localDeviceId: 'device-owner',
      ownerDeviceId: 'device-owner',
      role: 'owner',
      baseKey: new Uint8Array(32).fill(3),
      onFrame: (frame, senderDeviceId) => ownerFrames.push({ frame, sender: senderDeviceId }),
      onError: (error) => ownerErrors.push(error)
    });
    const viewer = new LiveWorkspaceChannel({
      relay: viewerRelay,
      workspaceId: 'workspace-1',
      localDeviceId: 'device-viewer',
      ownerDeviceId: 'device-owner',
      role: 'viewer',
      baseKey: new Uint8Array(32).fill(3),
      onFrame: (frame) => viewerFrames.push(frame),
      onError: (error) => viewerErrors.push(error)
    });

    await owner.connect();
    await viewer.connect();
    await flushRelay();
    expect(ownerErrors).toEqual([]);
    expect(owner.viewerCount).toBe(1);

    expect(await owner.broadcast(snapshot)).toBe(1);
    await flushRelay();
    expect(viewerErrors).toEqual([]);
    expect(viewerRelay.received).toHaveLength(1);
    expect(viewerFrames).toEqual([snapshot]);

    await viewer.send({
      protocolVersion: 1,
      type: 'terminal-input',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      participantDeviceId: 'device-viewer',
      inputId: 'input-1',
      payload: 'ls\n'
    });
    await flushRelay();
    expect(ownerFrames).toHaveLength(1);
    expect(ownerFrames[0]).toMatchObject({ sender: 'device-viewer', frame: { type: 'terminal-input', payload: 'ls\n' } });

    await viewer.close();
    await flushRelay();
    expect(owner.viewerCount).toBe(0);
    await owner.close();
  });

  it('does not create an unbounded broadcast backlog', async () => {
    const { owner: ownerRelay, viewer: viewerRelay } = createLink();
    const owner = new LiveWorkspaceChannel({
      relay: ownerRelay,
      workspaceId: 'workspace-1',
      localDeviceId: 'device-owner',
      ownerDeviceId: 'device-owner',
      role: 'owner',
      baseKey: new Uint8Array(32).fill(4)
    });
    const viewer = new LiveWorkspaceChannel({
      relay: viewerRelay,
      workspaceId: 'workspace-1',
      localDeviceId: 'device-viewer',
      ownerDeviceId: 'device-owner',
      role: 'viewer',
      baseKey: new Uint8Array(32).fill(4)
    });
    await owner.connect();
    await viewer.connect();
    await flushRelay();

    const first = owner.broadcast(snapshot);
    await expect(owner.broadcast(snapshot)).rejects.toThrow('live broadcast busy');
    await first;
    await viewer.close();
    await owner.close();
  });
});
