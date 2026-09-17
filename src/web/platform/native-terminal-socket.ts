import { isAppErrorCode, type AppErrorCode } from '../../shared/errors.js';
import { terminalClientMessageSchema, type TerminalClientMessage, type TerminalServerEvent, type TerminalStatus } from '../../shared/protocol.js';
import type { NativeEventFrame } from '../../shared/native/bridge.js';
import type { NativeOperationPort } from '../../shared/native/core-runtime.js';
import type { TerminalSocketLike } from '../hooks/use-terminal-session.js';

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const NATIVE_INPUT_CHUNK_BYTES = 32 * 1024;
const NATIVE_INPUT_QUEUE_CHUNKS = 8;
const NATIVE_INPUT_QUEUE_BYTES = 64 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | null => typeof value === 'string' ? value : null;

const decodeBase64Url = (value: string): Uint8Array | null => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length > 48 * 1024 || typeof globalThis.atob !== 'function') return null;
  try {
    const padded = value.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - value.length % 4) % 4);
    const binary = globalThis.atob(padded);
    if (binary.length > NATIVE_INPUT_CHUNK_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.codePointAt(index) ?? 0;
    return bytes;
  } catch {
    return null;
  }
};

const errorDetails = (error: unknown): { code: AppErrorCode; message: string } => {
  if (isRecord(error) && typeof error.code === 'string' && isAppErrorCode(error.code)) {
    return { code: error.code, message: typeof error.message === 'string' ? error.message : '原生操作失败' };
  }
  return { code: 'SSH_CONNECTION_FAILED', message: '远程连接异常' };
};

const eventData = (event: NativeEventFrame): Record<string, unknown> | null => isRecord(event.payload) ? event.payload : null;
const terminalStatuses: readonly TerminalStatus[] = ['connecting', 'awaiting-host-key', 'awaiting-credential', 'connected', 'reconnecting', 'interrupted', 'needs-reopen', 'closed', 'failed'];

export class NativeTerminalSocket implements TerminalSocketLike {
  readyState = SOCKET_CONNECTING;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event?: unknown) => void) | null = null;
  onclose: ((event?: unknown) => void) | null = null;

  private readonly stopEvents: () => void;
  private sessionId: string | null = null;
  private requestId: string | null = null;
  private closedByUser = false;
  private readonly inputQueue: string[] = [];
  private inputQueueBytes = 0;
  private inputInFlightBytes = 0;
  private inputPumpActive = false;

  constructor(private readonly port: NativeOperationPort, _url: string) {
    this.stopEvents = port.subscribe((event) => this.handleNativeEvent(event));
    queueMicrotask(() => {
      if (this.readyState !== SOCKET_CONNECTING) return;
      this.readyState = SOCKET_OPEN;
      this.onopen?.();
    });
  }

  send(data: string | Uint8Array): void {
    if (this.readyState !== SOCKET_OPEN) throw new Error('native terminal socket is not open');
    if (data instanceof Uint8Array) {
      this.enqueueInput(data);
      return;
    }
    let decoded: unknown;
    try { decoded = JSON.parse(data); } catch { this.emitError('PROTOCOL_INVALID_MESSAGE', '终端控制消息无效'); return; }
    const parsed = terminalClientMessageSchema.safeParse(decoded);
    if (!parsed.success) { this.emitError('PROTOCOL_INVALID_MESSAGE', '终端控制消息无效'); return; }
    void this.handleControl(parsed.data);
  }

  close(code = 1000, reason = 'terminal closed'): void {
    if (this.readyState === SOCKET_CLOSED || this.readyState === SOCKET_CLOSING) return;
    this.closedByUser = true;
    this.readyState = SOCKET_CLOSING;
    this.clearInputQueue();
    const sessionId = this.sessionId;
    if (sessionId) void this.port.invoke('sessions.close', { sessionId }).catch(() => undefined);
    this.finishClose(code, reason);
  }

  private enqueueInput(data: Uint8Array): void {
    if (!this.sessionId) return;
    const decoder = new TextDecoder();
    for (let offset = 0; offset < data.byteLength; offset += NATIVE_INPUT_CHUNK_BYTES) {
      const chunk = data.subarray(offset, Math.min(data.byteLength, offset + NATIVE_INPUT_CHUNK_BYTES));
      const text = decoder.decode(chunk, { stream: offset + chunk.byteLength < data.byteLength });
      if (!this.enqueueTextInput(text)) break;
    }
  }

  private enqueueTextInput(data: string): boolean {
    if (!this.sessionId || data.length === 0) return true;
    if (this.inputQueue.length + (this.inputPumpActive ? 1 : 0) >= NATIVE_INPUT_QUEUE_CHUNKS || this.inputQueueBytes + this.inputInFlightBytes + data.length > NATIVE_INPUT_QUEUE_BYTES) {
      this.emitError('SSH_CONNECTION_FAILED', '终端输入过快，请稍后重试');
      return false;
    }
    this.inputQueue.push(data);
    this.inputQueueBytes += data.length;
    void this.drainInputQueue();
    return true;
  }

  private async drainInputQueue(): Promise<void> {
    if (this.inputPumpActive) return;
    this.inputPumpActive = true;
    try {
      while (this.readyState === SOCKET_OPEN && this.sessionId !== null && this.inputQueue.length > 0) {
        const data = this.inputQueue.shift();
        if (data === undefined) break;
        this.inputQueueBytes -= data.length;
        this.inputInFlightBytes = data.length;
        try {
          await this.port.invoke('sessions.write', { sessionId: this.sessionId, data });
        } catch (error) {
          const details = errorDetails(error);
          this.emitError(details.code, details.message);
        } finally {
          this.inputInFlightBytes = 0;
        }
      }
    } finally {
      this.inputPumpActive = false;
    }
  }

  private clearInputQueue(): void {
    this.inputQueue.length = 0;
    this.inputQueueBytes = 0;
    this.inputInFlightBytes = 0;
  }

  private async handleControl(message: TerminalClientMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'open': {
          if (this.requestId !== null) throw new Error('terminal already opened');
          this.requestId = message.requestId;
          this.sessionId = message.requestId;
          const result = await this.port.invoke<{ sessionId?: string }>('sessions.openShell', { request: message });
          if (typeof result.sessionId === 'string') this.sessionId = result.sessionId;
          return;
        }
        case 'resize':
          await this.invokeSession('sessions.resize', { cols: message.cols, rows: message.rows });
          return;
        case 'input':
          this.enqueueTextInput(message.data);
          return;
        case 'host-key-decision':
          await this.invokeSession('sessions.hostKeyDecision', { decision: message.decision, fingerprint: message.fingerprint });
          return;
        case 'credential':
          await this.invokeSession('sessions.credential', { hostId: message.hostId, credential: message.credential });
          return;
        case 'ping':
          this.emitServerEvent({ type: 'pong' });
          return;
        case 'close':
          this.close(1000, 'terminal closed');
          return;
        default:
          return;
      }
    } catch (error) {
      const details = errorDetails(error);
      this.emitServerEvent({ type: 'error', ...details });
    }
  }

  private async invokeSession(operation: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.sessionId) throw new Error('terminal session is not open');
    await this.port.invoke(operation, { sessionId: this.sessionId, ...payload });
  }

  private handleNativeEvent(event: NativeEventFrame): void {
    const currentSessionId = this.sessionId ?? this.requestId;
    if (event.sessionId !== undefined && currentSessionId !== null && event.sessionId !== currentSessionId) return;
    const payload = eventData(event);
    switch (event.kind) {
      case 'terminal.output': {
        const data = asText(payload?.data);
        const bytes = data === null ? null : decodeBase64Url(data);
        if (bytes === null) { this.emitError('PROTOCOL_INVALID_MESSAGE', '终端输出超出限制'); return; }
        this.onmessage?.({ data: bytes });
        return;
      }
      case 'terminal.status': {
        const state = asText(payload?.state);
        if (!state || !terminalStatuses.includes(state as TerminalStatus)) return;
        this.emitServerEvent({ type: 'status', state: state as TerminalStatus, serviceInstanceId: asText(payload?.serviceInstanceId) ?? 'native-local' });
        return;
      }
      case 'terminal.host-key':
        if (payload) this.emitServerEvent({ type: 'host-key', ...payload } as TerminalServerEvent);
        return;
      case 'terminal.credential-required':
        if (payload) this.emitServerEvent({ type: 'credential-required', ...payload } as TerminalServerEvent);
        return;
      case 'terminal.diagnostic':
        if (payload?.diagnostic) this.emitServerEvent({ type: 'diagnostic', diagnostic: payload.diagnostic } as TerminalServerEvent);
        return;
      case 'terminal.error':
        if (payload) this.emitServerEvent({ type: 'error', ...payload } as TerminalServerEvent);
        return;
      case 'terminal.exit':
        if (payload) this.emitServerEvent({ type: 'exit', ...payload } as TerminalServerEvent);
        return;
      case 'terminal.close':
        if (payload?.clean === true) {
          this.emitServerEvent({ type: 'status', state: 'closed', serviceInstanceId: 'native-local' });
        } else {
          this.finishClose(1011, 'remote connection interrupted');
        }
        return;
      default:
        return;
    }
  }

  private emitServerEvent(event: TerminalServerEvent): void {
    if (this.readyState !== SOCKET_OPEN) return;
    this.onmessage?.({ data: JSON.stringify(event) });
  }

  private emitError(code: AppErrorCode, message: string): void {
    this.emitServerEvent({ type: 'error', code, message });
    this.onerror?.({ code, message });
  }

  private finishClose(code: number, reason: string): void {
    if (this.readyState === SOCKET_CLOSED) return;
    this.clearInputQueue();
    this.readyState = SOCKET_CLOSED;
    this.stopEvents();
    this.onclose?.({ code, reason, wasClean: code === 1000 && this.closedByUser });
  }
}

export const createNativeTerminalSocket = (port: NativeOperationPort, url: string): TerminalSocketLike => new NativeTerminalSocket(port, url);
