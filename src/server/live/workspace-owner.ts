import { parseLiveFrame, type LiveFrame, type LiveTerminalDescriptor } from '../../shared/cloud/live-protocol.js';
import { LiveWorkspaceState } from '../../shared/cloud/live-state.js';
import type { LiveInputRequest } from '../../shared/cloud/protocol.js';
import type { SshChannel } from '../ssh/types.js';

export interface LiveOwnerTerminal extends LiveTerminalDescriptor {
  channel: SshChannel;
}

export interface LiveWorkspaceOwnerOptions {
  workspaceId: string;
  ownerEpoch?: number;
  maxOutputBytes?: number;
  maxOutputFrames?: number;
  maxInputDedupeEntries?: number;
  publish: (frame: LiveFrame) => void;
}

/**
 * Binds existing SSH channels to the shared live protocol. It never opens an
 * SSH connection and never queues frames: the relay/encryption transport is
 * deliberately injected by the caller.
 */
export class LiveWorkspaceOwner {
  private readonly state: LiveWorkspaceState;
  private readonly publish: (frame: LiveFrame) => void;
  private readonly workspaceId: string;
  private readonly terminals = new Map<string, LiveOwnerTerminal>();
  private closed = false;

  constructor(options: LiveWorkspaceOwnerOptions) {
    this.workspaceId = options.workspaceId;
    this.state = new LiveWorkspaceState({
      workspaceId: options.workspaceId,
      ownerEpoch: options.ownerEpoch,
      maxOutputBytes: options.maxOutputBytes,
      maxOutputFrames: options.maxOutputFrames,
      maxInputDedupeEntries: options.maxInputDedupeEntries
    });
    this.publish = options.publish;
  }

  get ownerEpoch(): number { return this.state.ownerEpoch; }

  publishSnapshot(): void {
    if (!this.closed) this.publish(this.state.snapshot());
  }

  attachTerminal(terminal: LiveOwnerTerminal): void {
    if (this.closed) return;
    const descriptor: LiveTerminalDescriptor = {
      sessionId: terminal.sessionId,
      hostId: terminal.hostId,
      title: terminal.title,
      status: terminal.status,
      columns: terminal.columns,
      rows: terminal.rows,
      ...(terminal.screen === undefined ? {} : { screen: terminal.screen })
    };
    this.terminals.set(terminal.sessionId, terminal);
    this.state.setTerminal(descriptor);
    terminal.channel.on('data', (data) => this.publishOutput(terminal.sessionId, data));
    terminal.channel.on('stderr', (data) => this.publishOutput(terminal.sessionId, data));
    terminal.channel.on('exit', () => this.updateTerminalStatus(terminal.sessionId, 'closed'));
    terminal.channel.on('close', () => this.updateTerminalStatus(terminal.sessionId, 'closed'));
  }

  detachTerminal(sessionId: string): void {
    this.terminals.delete(sessionId);
    this.state.removeTerminal(sessionId);
  }

  handleFrame(value: unknown): void {
    if (this.closed) return;
    const frame = parseLiveFrame(value);
    if (frame.workspaceId !== this.workspaceId) return;
    if (frame.type === 'terminal-input') {
      this.handleInput(frame);
      return;
    }
    if (frame.type === 'resync-request') {
      this.publishSnapshot();
      for (const replayed of this.state.replay(frame.sessionId, frame.afterSequence) ?? []) this.publish(replayed);
    }
  }

  close(): void {
    this.closed = true;
    this.terminals.clear();
  }

  private publishOutput(sessionId: string, data: Buffer): void {
    if (this.closed || data.length === 0 || !this.terminals.has(sessionId)) return;
    const frame = this.state.recordOutput(sessionId, data.toString('utf8'));
    this.publish(frame);
  }

  private updateTerminalStatus(sessionId: string, status: LiveTerminalDescriptor['status']): void {
    const terminal = this.terminals.get(sessionId);
    if (!terminal || this.closed) return;
    const next: LiveTerminalDescriptor = {
      sessionId: terminal.sessionId,
      hostId: terminal.hostId,
      title: terminal.title,
      status,
      columns: terminal.columns,
      rows: terminal.rows,
      ...(terminal.screen === undefined ? {} : { screen: terminal.screen })
    };
    this.state.setTerminal(next);
    this.publishSnapshot();
  }

  private handleInput(frame: Extract<LiveFrame, { type: 'terminal-input' }>): void {
    const input: LiveInputRequest = {
      participantDeviceId: frame.participantDeviceId,
      inputId: frame.inputId,
      sessionId: frame.sessionId,
      payload: frame.payload
    };
    const acceptance = this.terminals.has(frame.sessionId)
      ? this.state.acceptInput(input)
      : { status: 'rejected' as const, reason: 'input-id-reuse' as const };
    if (acceptance.status === 'accepted') {
      this.terminals.get(frame.sessionId)?.channel.write(frame.payload);
    }
    this.publish(this.state.inputAck(input, acceptance));
  }
}
