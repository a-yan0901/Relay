import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  TerminalErrorEvent,
  TerminalHostKeyEvent,
  TerminalServerEvent,
  TerminalStatus
} from '@shared/protocol';

const TERMINAL_STATES: readonly TerminalStatus[] = [
  'connecting',
  'awaiting-host-key',
  'connected',
  'reconnecting',
  'closed',
  'failed'
];

const isTerminalStatus = (value: unknown): value is TerminalStatus => (
  typeof value === 'string' && TERMINAL_STATES.includes(value as TerminalStatus)
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

const isServerEvent = (value: unknown): value is TerminalServerEvent => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'status') return isTerminalStatus(value.state);
  if (value.type === 'pong') return true;
  if (value.type === 'exit') return typeof value.code === 'number' || value.code === null;
  if (value.type === 'error') return typeof value.code === 'string' && typeof value.message === 'string';
  return value.type === 'host-key' &&
    typeof value.algorithm === 'string' &&
    typeof value.fingerprint === 'string' &&
    typeof value.address === 'string' &&
    typeof value.port === 'number';
};

const terminalSocketUrl = (): string => {
  const location = globalThis.location;
  const protocol = location?.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = location?.host || 'localhost';
  return `${protocol}//${host}/ws/terminal`;
};

export interface TerminalSocketLike {
  readyState: number;
  binaryType?: string;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  onclose: ((event?: unknown) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface TerminalSize {
  cols: number;
  rows: number;
}

export interface TerminalHostKeyPrompt extends TerminalHostKeyEvent {}

export interface TerminalSessionSnapshot {
  state: TerminalStatus;
  hostKey: TerminalHostKeyPrompt | null;
  error: TerminalErrorEvent | null;
  exit: Extract<TerminalServerEvent, { type: 'exit' }> | null;
  reconnectDelayMs: number;
}

export interface TerminalSessionControllerOptions {
  hostId: string;
  terminalId: string;
  getSize?: () => TerminalSize;
  onOutput?: (data: Uint8Array) => void;
  onExit?: (event: Extract<TerminalServerEvent, { type: 'exit' }>) => void;
  onSnapshot?: (snapshot: TerminalSessionSnapshot) => void;
  webSocketFactory?: (url: string) => TerminalSocketLike;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const defaultSize = (): TerminalSize => ({ cols: 80, rows: 24 });

const defaultWebSocketFactory = (url: string): TerminalSocketLike => (
  new WebSocket(url) as unknown as TerminalSocketLike
);

const validDimension = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= 500;

export class TerminalSessionController {
  private readonly options: Required<Pick<TerminalSessionControllerOptions, 'hostId' | 'terminalId'>> & TerminalSessionControllerOptions;
  private readonly socketFactory: (url: string) => TerminalSocketLike;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly subscribers = new Set<(snapshot: TerminalSessionSnapshot) => void>();
  private socket: TerminalSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconnectAttempt = 0;
  private snapshotValue: TerminalSessionSnapshot = {
    state: 'closed',
    hostKey: null,
    error: null,
    exit: null,
    reconnectDelayMs: 0
  };

  constructor(options: TerminalSessionControllerOptions) {
    if (!options.hostId || !options.terminalId) {
      throw new Error('terminal session identifiers are required');
    }
    const reconnectBaseMs = options.reconnectBaseMs ?? 250;
    const reconnectMaxMs = options.reconnectMaxMs ?? 5_000;
    if (!Number.isFinite(reconnectBaseMs) || reconnectBaseMs < 1 || reconnectBaseMs > reconnectMaxMs) {
      throw new Error('invalid reconnect backoff');
    }
    if (!Number.isFinite(reconnectMaxMs) || reconnectMaxMs > 60_000) {
      throw new Error('invalid reconnect backoff');
    }

    this.options = options as Required<Pick<TerminalSessionControllerOptions, 'hostId' | 'terminalId'>> & TerminalSessionControllerOptions;
    this.socketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
  }

  get snapshot(): TerminalSessionSnapshot {
    return this.snapshotValue;
  }

  subscribe(listener: (snapshot: TerminalSessionSnapshot) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  connect(): void {
    this.stopped = false;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    this.clearReconnectTimer();
    this.updateSnapshot({ state: 'connecting', error: null, exit: null, reconnectDelayMs: 0 });

    const socket = this.socketFactory(terminalSocketUrl());
    this.socket = socket;
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => this.handleOpen(socket);
    socket.onmessage = (event) => { void this.handleMessage(event.data); };
    socket.onerror = () => {
      if (!this.stopped && this.socket === socket) {
        this.updateSnapshot({ state: 'failed', error: { type: 'error', code: 'SSH_CONNECTION_FAILED', message: 'WebSocket 连接异常' } });
      }
    };
    socket.onclose = () => this.handleClose(socket);
  }

  reconnect(): void {
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.detachSocket(this.socket);
    this.socket = null;
    this.connect();
  }

  sendInput(data: string): void {
    if (!this.isSocketOpen()) return;
    this.socket?.send(new TextEncoder().encode(data));
  }

  resize(cols: number, rows: number): void {
    if (!validDimension(cols) || !validDimension(rows) || !this.isSocketOpen()) return;
    this.sendControl({ type: 'resize', cols, rows });
  }

  decideHostKey(decision: 'trust' | 'reject'): void {
    const fingerprint = this.snapshotValue.hostKey?.fingerprint;
    if (!fingerprint || !this.isSocketOpen()) return;
    this.sendControl({ type: 'host-key-decision', decision, fingerprint });
  }

  close(): void {
    if (this.stopped && this.snapshotValue.state === 'closed') return;
    this.stopped = true;
    this.clearReconnectTimer();
    this.reconnectAttempt = 0;
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === 1) {
      socket.send(JSON.stringify({ type: 'close' }));
    }
    this.detachSocket(socket);
    socket?.close(1000, 'terminal closed');
    this.updateSnapshot({ state: 'closed', reconnectDelayMs: 0 });
  }

  private isSocketOpen(): boolean {
    return this.socket?.readyState === 1;
  }

  private handleOpen(socket: TerminalSocketLike): void {
    if (this.stopped || this.socket !== socket) {
      socket.close(1000, 'terminal stopped');
      return;
    }
    const size = this.options.getSize?.() ?? defaultSize();
    if (!validDimension(size.cols) || !validDimension(size.rows)) {
      this.updateSnapshot({ state: 'failed', error: { type: 'error', code: 'PROTOCOL_INVALID_MESSAGE', message: '终端尺寸无效' } });
      socket.close(1008, 'invalid terminal size');
      return;
    }
    this.updateSnapshot({ state: 'connecting', error: null, reconnectDelayMs: 0 });
    this.sendControl({
      type: 'open',
      hostId: this.options.hostId,
      cols: size.cols,
      rows: size.rows,
      requestId: this.options.terminalId,
      term: 'xterm-256color'
    });
  }

  private async handleMessage(data: unknown): Promise<void> {
    if (typeof data === 'string') {
      let decoded: unknown;
      try {
        decoded = JSON.parse(data);
      } catch {
        return;
      }
      if (!isServerEvent(decoded)) return;
      this.handleServerEvent(decoded);
      return;
    }

    if (data instanceof Blob) {
      const buffer = await data.arrayBuffer();
      this.options.onOutput?.(new Uint8Array(buffer));
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.options.onOutput?.(new Uint8Array(data));
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      this.options.onOutput?.(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }
  }

  private handleServerEvent(event: TerminalServerEvent): void {
    switch (event.type) {
      case 'status':
        this.updateSnapshot({
          state: event.state,
          ...(event.state === 'awaiting-host-key' ? {} : { hostKey: null })
        });
        if (event.state === 'connected') {
          this.reconnectAttempt = 0;
          this.updateSnapshot({ reconnectDelayMs: 0, error: null });
        }
        return;
      case 'host-key':
        this.updateSnapshot({ state: 'awaiting-host-key', hostKey: event, error: null });
        return;
      case 'error':
        this.updateSnapshot({ state: 'failed', error: event });
        return;
      case 'exit':
        this.updateSnapshot({ exit: event });
        this.options.onExit?.(event);
        return;
      case 'pong':
        return;
      default:
        return;
    }
  }

  private handleClose(socket: TerminalSocketLike): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.detachSocket(socket);
    if (this.stopped) {
      this.updateSnapshot({ state: 'closed', reconnectDelayMs: 0 });
      return;
    }
    const delay = Math.min(this.reconnectBaseMs * (2 ** this.reconnectAttempt), this.reconnectMaxMs);
    this.reconnectAttempt += 1;
    this.updateSnapshot({ state: 'reconnecting', reconnectDelayMs: delay });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private sendControl(message: Record<string, unknown>): void {
    if (this.isSocketOpen()) this.socket?.send(JSON.stringify(message));
  }

  private updateSnapshot(patch: Partial<TerminalSessionSnapshot>): void {
    this.snapshotValue = { ...this.snapshotValue, ...patch };
    for (const subscriber of this.subscribers) subscriber(this.snapshotValue);
    this.options.onSnapshot?.(this.snapshotValue);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private detachSocket(socket: TerminalSocketLike | null): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }
}

export interface UseTerminalSessionOptions extends TerminalSessionControllerOptions {
  autoConnect?: boolean;
}

export const useTerminalSession = (options: UseTerminalSessionOptions) => {
  const [, forceRender] = useState(0);
  const latestOptions = useRef(options);
  latestOptions.current = options;
  const controllerRef = useRef<TerminalSessionController | null>(null);

  if (controllerRef.current === null) {
    controllerRef.current = new TerminalSessionController({
      ...options,
      onOutput: (data) => latestOptions.current.onOutput?.(data),
      onExit: (event) => latestOptions.current.onExit?.(event)
    });
  }

  const controller = controllerRef.current;
  useEffect(() => {
    const unsubscribe = controller.subscribe(() => forceRender((value) => value + 1));
    if (options.autoConnect !== false) controller.connect();
    return () => {
      unsubscribe();
      controller.close();
    };
  }, [controller, forceRender, options.autoConnect]);

  const connect = useCallback(() => controller.connect(), [controller]);
  const reconnect = useCallback(() => controller.reconnect(), [controller]);
  const sendInput = useCallback((data: string) => controller.sendInput(data), [controller]);
  const resize = useCallback((cols: number, rows: number) => controller.resize(cols, rows), [controller]);
  const decideHostKey = useCallback((decision: 'trust' | 'reject') => controller.decideHostKey(decision), [controller]);
  const close = useCallback(() => controller.close(), [controller]);

  return {
    state: controller.snapshot,
    connect,
    reconnect,
    sendInput,
    resize,
    decideHostKey,
    close
  };
};
