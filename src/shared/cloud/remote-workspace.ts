import type { LiveWorkspaceChannel } from './live-session.js';
import { LiveWorkspaceViewer } from './live-viewer.js';
import { parseLiveFrame, type LiveFrame, type LiveTerminalDescriptor } from './live-protocol.js';

export type RemoteWorkspaceStatus = 'connecting' | 'live' | 'stale' | 'closed' | 'offline';

export interface RemoteWorkspaceState {
  workspaceId: string;
  ownerDeviceId: string;
  status: RemoteWorkspaceStatus;
  ownerEpoch: number | null;
  terminals: readonly LiveTerminalDescriptor[];
  participantCount: number;
  lastError?: string;
}

export type RemoteWorkspaceEvent =
  | { type: 'state'; state: RemoteWorkspaceState }
  | { type: 'output'; sessionId: string; payload: string }
  | { type: 'input-ack'; sessionId: string; inputId: string; outcome: 'accepted' | 'duplicate' | 'unknown' };

export interface RemoteWorkspaceSession {
  readonly state: RemoteWorkspaceState;
  connect(): Promise<void>;
  sendInput(sessionId: string, payload: string): Promise<string>;
  requestResync(sessionId: string, afterSequence?: number): Promise<void>;
  subscribe(listener: (event: RemoteWorkspaceEvent) => void): () => void;
  close(): Promise<void>;
}

const MAX_SESSION_LISTENERS = 16;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '远端工作区连接失败';

/**
 * Shared viewer-side adapter. The channel performs per-device live encryption;
 * this class only translates bounded protocol frames into UI/runtime events.
 */
export class LiveRemoteWorkspaceSession implements RemoteWorkspaceSession {
  private readonly channel: LiveWorkspaceChannel;
  private readonly viewer: LiveWorkspaceViewer;
  private readonly workspaceId: string;
  private readonly ownerDeviceId: string;
  private readonly listeners = new Set<(event: RemoteWorkspaceEvent) => void>();
  private currentState: RemoteWorkspaceState;
  private removeChannelListener: (() => void) | null = null;
  private closed = false;

  constructor(options: {
    channel: LiveWorkspaceChannel;
    viewer: LiveWorkspaceViewer;
    workspaceId: string;
    ownerDeviceId: string;
  }) {
    this.channel = options.channel;
    this.viewer = options.viewer;
    this.workspaceId = options.workspaceId;
    this.ownerDeviceId = options.ownerDeviceId;
    this.currentState = {
      workspaceId: options.workspaceId,
      ownerDeviceId: options.ownerDeviceId,
      status: 'connecting',
      ownerEpoch: null,
      terminals: [],
      participantCount: 0
    };
    this.removeChannelListener = this.channel.subscribe((frame) => { void this.handleFrame(frame); });
  }

  get state(): RemoteWorkspaceState { return this.currentState; }

  async connect(): Promise<void> {
    this.assertOpen();
    this.updateState({ status: 'connecting', lastError: undefined });
    try {
      await this.channel.connect();
      this.updateState({ status: 'connecting' });
    } catch (error) {
      this.updateState({ status: 'offline', lastError: errorMessage(error) });
      throw error;
    }
  }

  async sendInput(sessionId: string, payload: string): Promise<string> {
    this.assertOpen();
    const frame = this.viewer.createInput(sessionId, payload);
    try {
      await this.channel.send(frame);
      return frame.inputId;
    } catch (error) {
      this.updateState({ status: 'stale', lastError: errorMessage(error) });
      throw error;
    }
  }

  async requestResync(sessionId: string, afterSequence = 0): Promise<void> {
    this.assertOpen();
    await this.channel.send(parseLiveFrame({
      protocolVersion: 1,
      type: 'resync-request',
      workspaceId: this.workspaceId,
      sessionId,
      afterSequence
    }));
  }

  subscribe(listener: (event: RemoteWorkspaceEvent) => void): () => void {
    if (this.listeners.size >= MAX_SESSION_LISTENERS) throw new Error('remote workspace listener limit reached');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.removeChannelListener?.();
    this.removeChannelListener = null;
    await this.channel.close();
    this.updateState({ status: 'closed' });
    this.listeners.clear();
  }

  private async handleFrame(frame: LiveFrame): Promise<void> {
    if (this.closed || frame.workspaceId !== this.workspaceId) return;
    try {
      const result = this.viewer.apply(frame);
      if (frame.type === 'workspace-snapshot') {
        this.updateState({
          status: 'live',
          ownerEpoch: frame.ownerEpoch,
          terminals: this.viewer.terminalsSnapshot(),
          lastError: undefined
        });
      } else if (frame.type === 'terminal-output') {
        if (result.status === 'resync-required') {
          await this.requestResync(frame.sessionId, result.afterSequence ?? 0);
          this.updateState({ status: 'stale' });
          return;
        }
        if (result.status === 'applied') this.emit({ type: 'output', sessionId: frame.sessionId, payload: frame.payload });
      } else if (frame.type === 'input-ack') {
        this.emit({ type: 'input-ack', sessionId: frame.sessionId, inputId: frame.inputId, outcome: frame.outcome });
      }
      if (result.status === 'epoch-changed') this.updateState({ status: 'stale', ownerEpoch: this.viewer.epoch });
    } catch (error) {
      this.updateState({ status: 'stale', lastError: errorMessage(error) });
    }
  }

  private updateState(patch: Partial<RemoteWorkspaceState>): void {
    this.currentState = { ...this.currentState, ...patch };
    this.emit({ type: 'state', state: this.currentState });
  }

  private emit(event: RemoteWorkspaceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('remote workspace is closed');
  }
}
