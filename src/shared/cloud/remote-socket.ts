import { LIVE_MAX_FRAME_BYTES } from './live-protocol.js';
import { parseRemoteWorkspaceClientMessage, parseRemoteWorkspaceServerMessage, type RemoteWorkspaceServerMessage } from './remote-wire.js';
import { LiveWorkspaceViewer } from './live-viewer.js';
import type { RemoteWorkspaceEvent, RemoteWorkspaceSession, RemoteWorkspaceState } from './remote-workspace.js';

export const REMOTE_WORKSPACE_MAX_BUFFERED_BYTES = 256 * 1024;

export interface RemoteWorkspaceSocket {
  readonly readyState: number;
  readonly bufferedAmount?: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type RemoteWorkspaceSocketFactory = (url: string) => RemoteWorkspaceSocket;

const OPEN_STATE = 1;
const CLOSE_STATE = 3;
const MAX_LISTENERS = 16;

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : '远程工作区连接失败';

const textFromSocketData = (data: unknown): string => {
  if (typeof data === 'string') {
    if (new globalThis.TextEncoder().encode(data).byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('remote workspace frame too large');
    return data;
  }
  if (data instanceof Uint8Array) {
    if (data.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('remote workspace frame too large');
    return new globalThis.TextDecoder().decode(data);
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('remote workspace frame too large');
    return new globalThis.TextDecoder().decode(new Uint8Array(data));
  }
  throw new Error('invalid remote workspace frame');
};

const wireBytes = (value: unknown): number => new globalThis.TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * Client-side adapter for the same-origin workspace bridge. The bridge keeps
 * cloud bearer tokens and workspace keys on the server; this class only sees
 * validated live frames and a bounded JSON command channel.
 */
export class RemoteWorkspaceSocketSession implements RemoteWorkspaceSession {
  private readonly viewer: LiveWorkspaceViewer;
  private readonly workspaceId: string;
  private readonly ownerDeviceId: string;
  private readonly socketFactory: RemoteWorkspaceSocketFactory;
  private readonly url: string;
  private readonly listeners = new Set<(event: RemoteWorkspaceEvent) => void>();
  private currentState: RemoteWorkspaceState;
  private socket: RemoteWorkspaceSocket | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;

  constructor(options: {
    url: string;
    workspaceId: string;
    ownerDeviceId: string;
    participantDeviceId: string;
    socketFactory: RemoteWorkspaceSocketFactory;
  }) {
    this.workspaceId = options.workspaceId;
    this.ownerDeviceId = options.ownerDeviceId;
    this.url = options.url;
    this.socketFactory = options.socketFactory;
    this.viewer = new LiveWorkspaceViewer({ workspaceId: options.workspaceId, participantDeviceId: options.participantDeviceId });
    this.currentState = {
      workspaceId: options.workspaceId,
      ownerDeviceId: options.ownerDeviceId,
      status: 'connecting',
      ownerEpoch: null,
      terminals: [],
      participantCount: 0
    };
  }

  get state(): RemoteWorkspaceState { return this.currentState; }

  connect(): Promise<void> {
    this.assertOpen();
    if (this.socket?.readyState === OPEN_STATE) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.updateState({ status: 'connecting', lastError: undefined });
    const socket = this.socketFactory(this.url);
    this.socket = socket;
    this.connecting = new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      socket.onopen = () => settle();
      socket.onerror = () => {
        const error = new Error('remote workspace connection failed');
        this.updateState({ status: 'offline', lastError: error.message });
        settle(error);
      };
      socket.onclose = (event) => {
        if (this.socket === socket) this.socket = null;
        const error = new Error(event.reason || 'remote workspace connection closed');
        settle(error);
        if (!this.closed) this.updateState({ status: event.code === 1000 ? 'closed' : 'offline', lastError: event.reason || undefined });
      };
      socket.onmessage = (event) => { void this.handleMessage(event.data); };
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  async sendInput(sessionId: string, payload: string): Promise<string> {
    this.assertOpen();
    const frame = this.viewer.createInput(sessionId, payload);
    if (frame.type !== 'terminal-input') throw new Error('invalid remote workspace input');
    this.sendWire({ version: 1, type: 'input', sessionId, inputId: frame.inputId, payload: frame.payload });
    return frame.inputId;
  }

  requestResync(sessionId: string, afterSequence = 0): Promise<void> {
    this.assertOpen();
    this.sendWire({ version: 1, type: 'resync', sessionId, afterSequence });
    return Promise.resolve();
  }

  subscribe(listener: (event: RemoteWorkspaceEvent) => void): () => void {
    if (this.listeners.size >= MAX_LISTENERS) throw new Error('remote workspace listener limit reached');
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === OPEN_STATE || socket.readyState === 0) socket.close(1000, 'remote workspace closed');
    }
    this.updateState({ status: 'closed', lastError: undefined });
    this.listeners.clear();
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (this.closed) return;
    try {
      const parsed = JSON.parse(textFromSocketData(data)) as unknown;
      const message = parseRemoteWorkspaceServerMessage(parsed);
      if (message.type === 'state') {
        if (message.ownerDeviceId !== this.ownerDeviceId) throw new Error('remote workspace owner mismatch');
        this.updateState({
          status: message.status,
          ownerEpoch: message.ownerEpoch,
          participantCount: message.participantCount,
          lastError: undefined
        });
        return;
      }
      if (message.type === 'error') {
        this.updateState({ status: 'stale', lastError: message.message });
        return;
      }
      await this.applyFrame(message);
    } catch (error) {
      this.updateState({ status: 'stale', lastError: errorMessage(error) });
    }
  }

  private async applyFrame(message: Extract<RemoteWorkspaceServerMessage, { type: 'frame' }>): Promise<void> {
    if (message.frame.workspaceId !== this.workspaceId) throw new Error('remote workspace id mismatch');
    const result = this.viewer.apply(message.frame);
    if (message.frame.type === 'workspace-snapshot') {
      this.updateState({ status: 'live', ownerEpoch: message.frame.ownerEpoch, terminals: this.viewer.terminalsSnapshot(), lastError: undefined });
    } else if (message.frame.type === 'terminal-output') {
      if (result.status === 'resync-required') {
        await this.requestResync(message.frame.sessionId, result.afterSequence ?? 0);
        this.updateState({ status: 'stale' });
        return;
      }
      if (result.status === 'applied') this.emit({ type: 'output', sessionId: message.frame.sessionId, payload: message.frame.payload });
    } else if (message.frame.type === 'input-ack') {
      this.emit({ type: 'input-ack', sessionId: message.frame.sessionId, inputId: message.frame.inputId, outcome: message.frame.outcome });
    }
    if (result.status === 'epoch-changed') this.updateState({ status: 'stale', ownerEpoch: this.viewer.epoch });
  }

  private sendWire(value: unknown): void {
    const message = parseRemoteWorkspaceClientMessage(value);
    const bytes = wireBytes(message);
    if (bytes > LIVE_MAX_FRAME_BYTES) throw new Error('remote workspace frame too large');
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN_STATE) throw new Error('remote workspace is not connected');
    if ((socket.bufferedAmount ?? 0) + bytes > REMOTE_WORKSPACE_MAX_BUFFERED_BYTES) throw new Error('remote workspace send buffer limit');
    socket.send(JSON.stringify(message));
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

export const browserRemoteWorkspaceSocketFactory = (): RemoteWorkspaceSocketFactory => (
  (url) => new globalThis.WebSocket(url) as unknown as RemoteWorkspaceSocket
);

export const isRemoteWorkspaceSocketClosed = (socket: RemoteWorkspaceSocket | null): boolean => socket === null || socket.readyState === CLOSE_STATE;
