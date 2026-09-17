import { LIVE_MAX_FRAME_BYTES } from './live-protocol.js';

export const LIVE_MAX_BUFFERED_BYTES = 256 * 1024;

export interface CloudLiveSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type CloudLiveSocketFactory = (url: string, protocols: readonly string[]) => CloudLiveSocket;

export interface CloudLiveRelayOptions {
  baseUrl: string;
  token: string;
  workspaceId: string;
  role: 'owner' | 'viewer';
  socketFactory: CloudLiveSocketFactory;
  maxFrameBytes?: number;
  maxBufferedBytes?: number;
}

export interface CloudLiveCloseEvent {
  code: number;
  reason: string;
}

const OPEN_STATE = 1;
const CLOSED_STATE = 3;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const relayUrl = (baseUrl: string, role: CloudLiveRelayOptions['role'], workspaceId: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error('invalid cloud relay url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('invalid cloud relay url');
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = `/v2/relay/${role}`;
  parsed.search = `?workspaceId=${encodeURIComponent(workspaceId)}`;
  parsed.hash = '';
  return parsed.toString();
};

const frameBytes = (data: unknown): Uint8Array | null => {
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  return null;
};

export class CloudLiveRelay {
  readonly url: string;
  readonly socketProtocols: readonly string[];
  private readonly socketFactory: CloudLiveSocketFactory;
  private readonly maxFrameBytes: number;
  private readonly maxBufferedBytes: number;
  private socket: CloudLiveSocket | null = null;
  private connecting: Promise<void> | null = null;
  private settledClose = false;
  private frameListeners = new Set<(frame: Uint8Array) => void>();
  private closeListeners = new Set<(event: CloudLiveCloseEvent) => void>();
  private errorListeners = new Set<() => void>();

  constructor(options: CloudLiveRelayOptions) {
    if (!TOKEN_PATTERN.test(options.token)) throw new Error('invalid cloud relay token');
    if (!WORKSPACE_PATTERN.test(options.workspaceId)) throw new Error('invalid cloud workspace id');
    this.url = relayUrl(options.baseUrl, options.role, options.workspaceId);
    this.socketProtocols = [`relay-bearer.${options.token}`];
    this.socketFactory = options.socketFactory;
    this.maxFrameBytes = options.maxFrameBytes ?? LIVE_MAX_FRAME_BYTES;
    this.maxBufferedBytes = options.maxBufferedBytes ?? LIVE_MAX_BUFFERED_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 1 || this.maxFrameBytes > LIVE_MAX_FRAME_BYTES) throw new Error('invalid relay frame limit');
    if (!Number.isSafeInteger(this.maxBufferedBytes) || this.maxBufferedBytes < this.maxFrameBytes || this.maxBufferedBytes > 1024 * 1024) throw new Error('invalid relay buffer limit');
  }

  connect(): Promise<void> {
    if (this.socket?.readyState === OPEN_STATE) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.settledClose = false;
    const socket = this.socketFactory(this.url, this.socketProtocols);
    this.socket = socket;
    if ('binaryType' in socket) socket.binaryType = 'arraybuffer';
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
        this.notifyError();
        settle(new Error('cloud relay connection failed'));
      };
      socket.onclose = (event) => {
        this.socket = null;
        this.connecting = null;
        settle(new Error('cloud relay connection closed'));
        this.notifyClose(event);
      };
      socket.onmessage = (event) => this.handleMessage(event.data);
    }).finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  send(frame: Uint8Array): void {
    if (!(frame instanceof Uint8Array) || frame.byteLength > this.maxFrameBytes) throw new Error('relay frame too large');
    const socket = this.socket;
    if (!socket || socket.readyState !== OPEN_STATE) throw new Error('cloud relay is not connected');
    if (socket.bufferedAmount + frame.byteLength > this.maxBufferedBytes) throw new Error('relay send buffer limit');
    socket.send(frame);
  }

  close(code = 1000, reason = ''): void {
    const socket = this.socket;
    if (!socket || this.settledClose) return;
    this.settledClose = true;
    socket.close(code, reason);
  }

  onFrame(listener: (frame: Uint8Array) => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onClose(listener: (event: CloudLiveCloseEvent) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onError(listener: () => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private handleMessage(data: unknown): void {
    const frame = frameBytes(data);
    if (!frame || frame.byteLength > this.maxFrameBytes) {
      this.notifyError();
      this.close(1009, 'frame too large');
      return;
    }
    for (const listener of this.frameListeners) listener(frame);
  }

  private notifyClose(event: CloudLiveCloseEvent): void {
    if (this.settledClose && event.code === 1000) this.settledClose = false;
    for (const listener of this.closeListeners) listener(event);
  }

  private notifyError(): void {
    for (const listener of this.errorListeners) listener();
  }
}

export const createBrowserCloudLiveSocketFactory = (): CloudLiveSocketFactory => (
  (url, protocols) => new globalThis.WebSocket(url, [...protocols]) as unknown as CloudLiveSocket
);

export const isCloudLiveSocketClosed = (socket: CloudLiveSocket | null): boolean => socket === null || socket.readyState === CLOSED_STATE;
