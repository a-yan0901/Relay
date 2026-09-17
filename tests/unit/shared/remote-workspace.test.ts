import { describe, expect, it } from 'vitest';

import type { CloudLiveCloseEvent } from '../../../src/shared/cloud/live-client.js';
import type { LiveRelayTransport } from '../../../src/shared/cloud/live-session.js';
import { LiveWorkspaceChannel } from '../../../src/shared/cloud/live-session.js';
import { LiveWorkspaceViewer } from '../../../src/shared/cloud/live-viewer.js';
import { LiveRemoteWorkspaceSession } from '../../../src/shared/cloud/remote-workspace.js';
import type { LiveFrame } from '../../../src/shared/cloud/live-protocol.js';

class PairRelay implements LiveRelayTransport {
  peer: PairRelay | null = null;
  connected = false;
  private readonly listeners = new Set<(frame: Uint8Array) => void>();
  private readonly closes = new Set<(event: CloudLiveCloseEvent) => void>();

  async connect(): Promise<void> { this.connected = true; }
  send(frame: Uint8Array): void {
    if (!this.peer) throw new Error('missing peer');
    for (const listener of this.peer.listeners) listener(new Uint8Array(frame));
  }
  onFrame(listener: (frame: Uint8Array) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onClose(listener: (event: CloudLiveCloseEvent) => void): () => void { this.closes.add(listener); return () => this.closes.delete(listener); }
  close(): void { this.connected = false; for (const listener of this.closes) listener({ code: 1000, reason: '' }); }
}

const relayPair = (): [PairRelay, PairRelay] => {
  const left = new PairRelay();
  const right = new PairRelay();
  left.peer = right;
  right.peer = left;
  return [left, right];
};

const snapshot = (): LiveFrame => ({
  protocolVersion: 1,
  type: 'workspace-snapshot',
  workspaceId: 'workspace-1',
  ownerEpoch: 1,
  sequence: 0,
  terminals: [{ sessionId: 'session-1', hostId: 'host-1', title: 'Server', status: 'connected', columns: 80, rows: 24, screen: 'ready' }]
});

describe('live remote workspace session', () => {
  it('connects a viewer, exposes the owner snapshot/output and sends bounded input', async () => {
    const [ownerRelay, viewerRelay] = relayPair();
    const baseKey = new Uint8Array(32).fill(7);
    const owner = new LiveWorkspaceChannel({ relay: ownerRelay, workspaceId: 'workspace-1', localDeviceId: 'owner-1', ownerDeviceId: 'owner-1', role: 'owner', baseKey });
    const viewerChannel = new LiveWorkspaceChannel({ relay: viewerRelay, workspaceId: 'workspace-1', localDeviceId: 'viewer-1', ownerDeviceId: 'owner-1', role: 'viewer', baseKey });
    const viewer = new LiveWorkspaceViewer({ workspaceId: 'workspace-1', participantDeviceId: 'viewer-1' });
    const session = new LiveRemoteWorkspaceSession({ channel: viewerChannel, viewer, workspaceId: 'workspace-1', ownerDeviceId: 'owner-1' });
    const events: Array<{ type: string; payload?: string; outcome?: string }> = [];
    session.subscribe((event) => {
      if (event.type === 'output') events.push({ type: event.type, payload: event.payload });
      if (event.type === 'input-ack') events.push({ type: event.type, outcome: event.outcome });
    });
    let receivedInput: LiveFrame | null = null;
    owner.subscribe((frame) => { if (frame.type === 'terminal-input') receivedInput = frame; });

    await owner.connect();
    await session.connect();
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await owner.broadcast(snapshot());
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(session.state.status).toBe('live');
    expect(session.state.terminals[0]?.screen).toBe('ready');

    await owner.broadcast({ protocolVersion: 1, type: 'terminal-output', workspaceId: 'workspace-1', sessionId: 'session-1', ownerEpoch: 1, sequence: 1, payload: 'output' });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(events).toContainEqual({ type: 'output', payload: 'output' });

    const inputId = await session.sendInput('session-1', 'ls\n');
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(inputId).toMatch(/^input-/u);
    expect(receivedInput).toEqual(expect.objectContaining({ type: 'terminal-input', participantDeviceId: 'viewer-1', payload: 'ls\n' }));
    if (!receivedInput || receivedInput.type !== 'terminal-input') throw new Error('input not received');
    await owner.broadcast({ protocolVersion: 1, type: 'input-ack', workspaceId: 'workspace-1', sessionId: 'session-1', inputId, inputSequence: 1, outcome: 'accepted' });
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(events).toContainEqual({ type: 'input-ack', outcome: 'accepted' });

    await session.close();
    expect(session.state.status).toBe('closed');
  });
});
