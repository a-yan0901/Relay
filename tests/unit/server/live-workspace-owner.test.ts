import { describe, expect, it } from 'vitest';

import { LiveWorkspaceOwner } from '../../../src/server/live/workspace-owner.js';
import type { SshChannel } from '../../../src/server/ssh/types.js';

class FakeChannel implements SshChannel {
  readonly writes: string[] = [];
  private readonly listeners = {
    data: [] as Array<(data: Buffer) => void>,
    stderr: [] as Array<(data: Buffer) => void>,
    exit: [] as Array<(code: number | null, signal?: string) => void>,
    close: [] as Array<() => void>,
    error: [] as Array<(error: Error) => void>
  };

  write(data: string | Buffer): void { this.writes.push(data.toString()); }
  resize(): void {}
  close(): void { for (const listener of this.listeners.close) listener(); }
  on(event: 'data' | 'stderr', listener: (data: Buffer) => void): this;
  on(event: 'exit', listener: (code: number | null, signal?: string) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: keyof FakeChannel['listeners'], listener: (...args: never[]) => void): this {
    this.listeners[event].push(listener as never);
    return this;
  }
  emitOutput(data: string): void { for (const listener of this.listeners.data) listener(Buffer.from(data)); }
  emitClose(): void { for (const listener of this.listeners.close) listener(); }
}

describe('live workspace owner', () => {
  it('publishes a snapshot and bounded output, then replays from a requested sequence', () => {
    const channel = new FakeChannel();
    const published: unknown[] = [];
    const owner = new LiveWorkspaceOwner({ workspaceId: 'workspace-1', ownerEpoch: 7, publish: (frame) => published.push(frame), maxOutputFrames: 2 });
    owner.attachTerminal({ sessionId: 'session-1', hostId: 'host-1', title: 'Shell', status: 'connected', columns: 80, rows: 24, channel });
    owner.publishSnapshot();
    channel.emitOutput('one');
    channel.emitOutput('two');
    channel.emitOutput('three');
    owner.handleFrame({ protocolVersion: 1, type: 'resync-request', workspaceId: 'workspace-1', sessionId: 'session-1', afterSequence: 1 });

    expect(published[0]).toMatchObject({ type: 'workspace-snapshot', ownerEpoch: 7 });
    expect(published.filter((frame) => (frame as { type: string }).type === 'terminal-output')).toHaveLength(5);
    expect(published.at(-1)).toMatchObject({ type: 'terminal-output', sequence: 3, payload: 'three' });
  });

  it('writes an accepted input once and acknowledges duplicates without repeating the SSH write', () => {
    const channel = new FakeChannel();
    const published: unknown[] = [];
    const owner = new LiveWorkspaceOwner({ workspaceId: 'workspace-1', publish: (frame) => published.push(frame) });
    owner.attachTerminal({ sessionId: 'session-1', hostId: 'host-1', title: 'Shell', status: 'connected', columns: 80, rows: 24, channel });
    const input = { protocolVersion: 1 as const, type: 'terminal-input' as const, workspaceId: 'workspace-1', sessionId: 'session-1', participantDeviceId: 'device-viewer', inputId: 'input-1', payload: 'ls\n' };

    owner.handleFrame(input);
    owner.handleFrame(input);

    expect(channel.writes).toEqual(['ls\n']);
    expect(published.filter((frame) => (frame as { type: string }).type === 'input-ack')).toHaveLength(2);
    expect(published.at(-1)).toMatchObject({ type: 'input-ack', outcome: 'duplicate', inputSequence: 1 });
  });
});
