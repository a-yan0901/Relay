import { describe, expect, it } from 'vitest';

import type { RemoteWorkspaceSocket } from '../../../src/shared/cloud/remote-socket.js';
import { RemoteWorkspaceSocketSession } from '../../../src/shared/cloud/remote-socket.js';

class FakeSocket implements RemoteWorkspaceSocket {
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  message(value: unknown): void { this.onmessage?.({ data: JSON.stringify(value) }); }
}

const snapshot = {
  protocolVersion: 1 as const,
  type: 'workspace-snapshot' as const,
  workspaceId: 'workspace-1',
  ownerEpoch: 1,
  sequence: 0,
  terminals: [{ sessionId: 'session-1', hostId: 'host-1', title: 'Shell', status: 'connected' as const, columns: 80, rows: 24 }]
};

describe('remote workspace local socket session', () => {
  it('keeps the browser wire bounded and translates frames into remote session events', async () => {
    const socket = new FakeSocket();
    const session = new RemoteWorkspaceSocketSession({
      url: 'ws://localhost/ws/cloud/workspaces/workspace-1',
      workspaceId: 'workspace-1',
      ownerDeviceId: 'owner-1',
      participantDeviceId: 'viewer-1',
      socketFactory: () => socket
    });
    const outputs: string[] = [];
    session.subscribe((event) => {
      if (event.type === 'output') outputs.push(event.payload);
    });

    const connecting = session.connect();
    socket.open();
    await connecting;
    socket.message({ version: 1, type: 'state', status: 'live', ownerDeviceId: 'owner-1', participantCount: 2, ownerEpoch: 1 });
    socket.message({ version: 1, type: 'frame', frame: snapshot });
    expect(session.state.status).toBe('live');
    expect(session.state.participantCount).toBe(2);
    expect(session.state.terminals[0]?.title).toBe('Shell');

    socket.message({ version: 1, type: 'frame', frame: { protocolVersion: 1, type: 'terminal-output', workspaceId: 'workspace-1', sessionId: 'session-1', ownerEpoch: 1, sequence: 1, payload: 'ready\n' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(outputs).toEqual(['ready\n']);

    const inputId = await session.sendInput('session-1', 'pwd\n');
    expect(inputId).toMatch(/^input-/u);
    expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toEqual({ version: 1, type: 'input', sessionId: 'session-1', inputId, payload: 'pwd\n' });

    await session.close();
    expect(socket.closed).toBe(true);
    expect(session.state.status).toBe('closed');
  });

  it('rejects a server message with an unexpected owner', async () => {
    const socket = new FakeSocket();
    const session = new RemoteWorkspaceSocketSession({
      url: 'ws://localhost/ws/cloud/workspaces/workspace-1',
      workspaceId: 'workspace-1',
      ownerDeviceId: 'owner-1',
      participantDeviceId: 'viewer-1',
      socketFactory: () => socket
    });
    const connecting = session.connect();
    socket.open();
    await connecting;
    socket.message({ version: 1, type: 'state', status: 'live', ownerDeviceId: 'other-owner', participantCount: 0, ownerEpoch: 1 });
    expect(session.state.status).toBe('stale');
    expect(session.state.lastError).toContain('owner');
  });
});
