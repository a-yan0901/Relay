import { useCallback, useEffect, useRef, useState } from 'react';

import type { OperationDiagnostic } from '@shared/core/models';
import { operationErrorToDiagnostic } from '@shared/core/state-machines';
import type {
  TerminalCredentialRequiredEvent,
  TerminalErrorEvent,
  TerminalHostKeyEvent,
  TerminalServerEvent,
  TerminalStatus
} from '@shared/protocol';
import type { HostCredentialInput } from '@shared/validation';

const TERMINAL_STATES: readonly TerminalStatus[] = [
  'connecting',
  'awaiting-host-key',
  'awaiting-credential',
  'connected',
  'reconnecting',
  'interrupted',
  'needs-reopen',
  'closed',
  'failed'
];

const isTerminalStatus = (value: unknown): value is TerminalStatus => (
  typeof value === 'string' && TERMINAL_STATES.includes(value as TerminalStatus)
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null
);

const DIAGNOSTIC_KINDS = ['terminal', 'transfer', 'command'] as const;
const DIAGNOSTIC_STAGES = ['dns', 'tcp', 'jump-host', 'host-key', 'auth', 'pty', 'sftp', 'command'] as const;
const DIAGNOSTIC_STATES = ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'needs-reopen'] as const;
const DIAGNOSTIC_ACTIONS = ['wait', 'retry', 'edit-credentials', 'confirm-host-key', 'reopen', 'none'] as const;

const isDiagnostic = (value: unknown): value is OperationDiagnostic => {
  if (!isRecord(value)) return false;
  return typeof value.operationId === 'string' && typeof value.hostId === 'string' &&
    typeof value.kind === 'string' && DIAGNOSTIC_KINDS.includes(value.kind as typeof DIAGNOSTIC_KINDS[number]) &&
    typeof value.stage === 'string' && DIAGNOSTIC_STAGES.includes(value.stage as typeof DIAGNOSTIC_STAGES[number]) &&
    typeof value.state === 'string' && DIAGNOSTIC_STATES.includes(value.state as typeof DIAGNOSTIC_STATES[number]) &&
    typeof value.retryable === 'boolean' && typeof value.nextAction === 'string' &&
    DIAGNOSTIC_ACTIONS.includes(value.nextAction as typeof DIAGNOSTIC_ACTIONS[number]) &&
    typeof value.startedAt === 'string' &&
    (value.errorCode === undefined || typeof value.errorCode === 'string') &&
    (value.requestId === undefined || typeof value.requestId === 'string') &&
    (value.endedAt === undefined || typeof value.endedAt === 'string');
};

const isServerEvent = (value: unknown): value is TerminalServerEvent => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'status') return isTerminalStatus(value.state) &&
    (value.serviceInstanceId === undefined || typeof value.serviceInstanceId === 'string');
  if (value.type === 'diagnostic') return isDiagnostic(value.diagnostic);
  if (value.type === 'pong') return true;
  if (value.type === 'exit') return typeof value.code === 'number' || value.code === null;
  if (value.type === 'error') return typeof value.code === 'string' && typeof value.message === 'string';
  if (value.type === 'credential-required') return typeof value.hostId === 'string' &&
    (value.authType === 'password' || value.authType === 'private_key') &&
    typeof value.name === 'string' && typeof value.address === 'string' &&
    typeof value.port === 'number' && typeof value.username === 'string';
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
  credential: TerminalCredentialRequiredEvent | null;
  error: TerminalErrorEvent | null;
  exit: Extract<TerminalServerEvent, { type: 'exit' }> | null;
  reconnectDelayMs: number;
  diagnostics: OperationDiagnostic[];
}

export interface TerminalSessionControllerOptions {
  hostId: string;
  terminalId: string;
  getSize?: () => TerminalSize;
  onOutput?: (data: Uint8Array) => void;
  onExit?: (event: Extract<TerminalServerEvent, { type: 'exit' }>) => void;
  onSnapshot?: (snapshot: TerminalSessionSnapshot) => void;
  webSocketFactory?: (url: string) => TerminalSocketLike;
  reconnectEnabled?: boolean;
  reconnectMaxAttempts?: number;
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
  private readonly reconnectEnabled: boolean;
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly subscribers = new Set<(snapshot: TerminalSessionSnapshot) => void>();
  private socket: TerminalSocketLike | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private retryBlocked = false;
  private reconnectAttempt = 0;
  private serviceInstanceId: string | null = null;
  private snapshotValue: TerminalSessionSnapshot = {
    state: 'closed',
    hostKey: null,
    credential: null,
    error: null,
    exit: null,
    reconnectDelayMs: 0,
    diagnostics: []
  };

  constructor(options: TerminalSessionControllerOptions) {
    if (!options.hostId || !options.terminalId) {
      throw new Error('terminal session identifiers are required');
    }
    const reconnectBaseMs = options.reconnectBaseMs ?? 250;
    const reconnectMaxMs = options.reconnectMaxMs ?? 5_000;
    const reconnectEnabled = options.reconnectEnabled ?? true;
    const reconnectMaxAttempts = options.reconnectMaxAttempts ?? 5;
    if (typeof reconnectEnabled !== 'boolean' || !Number.isInteger(reconnectMaxAttempts) || reconnectMaxAttempts < 0 || reconnectMaxAttempts > 20) {
      throw new Error('invalid reconnect policy');
    }
    if (!Number.isFinite(reconnectBaseMs) || reconnectBaseMs < 0 || reconnectBaseMs > reconnectMaxMs) {
      throw new Error('invalid reconnect backoff');
    }
    if (!Number.isFinite(reconnectMaxMs) || reconnectMaxMs > 60_000) {
      throw new Error('invalid reconnect backoff');
    }

    this.options = options as Required<Pick<TerminalSessionControllerOptions, 'hostId' | 'terminalId'>> & TerminalSessionControllerOptions;
    this.socketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.reconnectEnabled = reconnectEnabled;
    this.reconnectMaxAttempts = reconnectMaxAttempts;
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
    if (this.retryBlocked) return;
    if (this.socket && (this.socket.readyState === 0 || this.socket.readyState === 1)) return;
    this.clearReconnectTimer();
    this.updateSnapshot({ state: 'connecting', error: null, exit: null, credential: null, reconnectDelayMs: 0, diagnostics: [] });

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
    socket.onclose = (event) => this.handleClose(socket, event);
  }

  reconnect(): void {
    if (this.snapshotValue.state === 'needs-reopen') {
      this.serviceInstanceId = null;
    }
    this.stopped = false;
    this.retryBlocked = false;
    this.reconnectAttempt = 0;
    this.clearReconnectTimer();
    this.detachSocket(this.socket);
    this.socket = null;
    this.connect();
  }

  submitCredential(credential: HostCredentialInput): void {
    const prompt = this.snapshotValue.credential;
    if (!prompt || credential.type !== prompt.authType || !this.isSocketOpen()) return;
    this.sendControl({ type: 'credential', hostId: prompt.hostId, credential });
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
    this.updateSnapshot({ state: 'closed', credential: null, reconnectDelayMs: 0 });
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
      term: 'xterm-256color',
      ...(this.serviceInstanceId === null ? {} : { knownServiceInstanceId: this.serviceInstanceId })
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
        if (event.serviceInstanceId !== undefined) {
          if (this.serviceInstanceId !== null && this.serviceInstanceId !== event.serviceInstanceId) {
            this.retryBlocked = true;
            this.clearReconnectTimer();
            const currentSocket = this.socket;
            this.detachSocket(currentSocket);
            this.socket = null;
            const at = new Date().toISOString();
            this.updateSnapshot({
              state: 'needs-reopen',
              reconnectDelayMs: 0,
              error: { type: 'error', code: 'SESSION_NEEDS_REOPEN', message: '服务已重启，请重新打开终端' },
              credential: null,
              hostKey: null,
              diagnostics: [...this.snapshotValue.diagnostics, operationErrorToDiagnostic({
                operationId: this.options.terminalId,
                hostId: this.options.hostId,
                errorCode: 'SERVICE_RESTARTED',
                state: 'needs-reopen',
                requestId: this.options.terminalId,
                at
              })].slice(-100)
            });
            currentSocket?.close(1008, 'service restarted');
            return;
          }
          this.serviceInstanceId = event.serviceInstanceId;
        }
        this.updateSnapshot({
          state: event.state,
          ...(event.state === 'awaiting-host-key' ? {} : { hostKey: null }),
          ...(event.state === 'awaiting-credential' ? {} : { credential: null })
        });
        if (event.state === 'connected') {
          this.reconnectAttempt = 0;
          this.updateSnapshot({ reconnectDelayMs: 0, error: null, credential: null });
        }
        return;
      case 'host-key':
        this.updateSnapshot({ state: 'awaiting-host-key', hostKey: event, error: null });
        return;
      case 'credential-required':
        this.updateSnapshot({ state: 'awaiting-credential', credential: event, error: null });
        return;
      case 'error': {
        this.retryBlocked = true;
        const needsReopen = ['SESSION_NEEDS_REOPEN', 'SERVICE_RESTARTED', 'OPERATION_NOT_FOUND'].includes(event.code);
        const state = needsReopen ? 'needs-reopen' : 'failed';
        const diagnostic = operationErrorToDiagnostic({
          operationId: this.options.terminalId,
          hostId: this.options.hostId,
          errorCode: event.code,
          state,
          requestId: this.options.terminalId,
          at: new Date().toISOString()
        });
        const hasMatchingDiagnostic = this.snapshotValue.diagnostics.some((item) => (
          item.operationId === diagnostic.operationId && item.errorCode === diagnostic.errorCode && item.state !== 'running'
        ));
        this.updateSnapshot({
          state,
          error: event,
          credential: null,
          ...(needsReopen ? { reconnectDelayMs: 0 } : {}),
          ...(hasMatchingDiagnostic ? {} : { diagnostics: [...this.snapshotValue.diagnostics, diagnostic].slice(-100) })
        });
        return;
      }
      case 'diagnostic':
        this.updateSnapshot({ diagnostics: [...this.snapshotValue.diagnostics, event.diagnostic].slice(-100) });
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

  private handleClose(socket: TerminalSocketLike, event?: unknown): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.detachSocket(socket);
    if (this.stopped) {
      this.updateSnapshot({ state: 'closed', credential: null, reconnectDelayMs: 0 });
      return;
    }
    if (isRecord(event) && event.code === 1008) {
      this.retryBlocked = true;
      this.updateSnapshot({
        state: 'needs-reopen',
        reconnectDelayMs: 0,
        error: { type: 'error', code: 'SESSION_NEEDS_REOPEN', message: '服务会话已失效，请重新连接终端' }
      });
      return;
    }
    if (this.retryBlocked) return;
    if (!this.reconnectEnabled || this.reconnectAttempt >= this.reconnectMaxAttempts) {
      this.retryBlocked = true;
      this.updateSnapshot({
        state: 'failed',
        reconnectDelayMs: 0,
        error: { type: 'error', code: 'SSH_CONNECTION_FAILED', message: '自动重连次数已用尽，请手动重试' }
      });
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
      onExit: (event) => latestOptions.current.onExit?.(event),
      onSnapshot: (snapshot) => latestOptions.current.onSnapshot?.(snapshot)
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
  const submitCredential = useCallback((credential: HostCredentialInput) => controller.submitCredential(credential), [controller]);
  const close = useCallback(() => controller.close(), [controller]);

  return {
    state: controller.snapshot,
    connect,
    reconnect,
    sendInput,
    resize,
    decideHostKey,
    submitCredential,
    close
  };
};
