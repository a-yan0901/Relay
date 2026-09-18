import { isAppErrorCode, type AppErrorCode } from '../../shared/errors.js';
import { terminalClientMessageSchema, type TerminalClientMessage, type TerminalServerEvent, type TerminalStatus } from '../../shared/protocol.js';
import type { NativeEventFrame } from '../../shared/native/bridge.js';
import type { NativeOperationPort } from '../../shared/native/core-runtime.js';
import { utf8ByteLength } from '../../shared/utf8.js';
import type { TerminalSocketLike } from '../hooks/use-terminal-session.js';

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const SOCKET_CLOSED = 3;
const NATIVE_INPUT_CHUNK_BYTES = 32 * 1024;
const NATIVE_INPUT_QUEUE_CHUNKS = 8;
const NATIVE_INPUT_QUEUE_BYTES = 64 * 1024;
const NATIVE_SERVICE_INSTANCE_ID = 'desktop-local';
let nativeSessionRequestNumber = 0;

const nextNativeSessionRequestId = (terminalId: string): string => {
  nativeSessionRequestNumber = nativeSessionRequestNumber >= Number.MAX_SAFE_INTEGER - 1 ? 1 : nativeSessionRequestNumber + 1;
  const suffix = `native-${Date.now().toString(36)}-${nativeSessionRequestNumber.toString(36)}`;
  return `${terminalId.slice(0, Math.max(1, 128 - suffix.length - 1))}:${suffix}`;
};
interface QueuedInput {
  data: string;
  bytes: number;
}

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
  private needsReopen = false;
  private nativeSessionReady = false;
  private shellReady = false;
  private pendingResize: { cols: number; rows: number } | null = null;
  private readonly inputQueue: QueuedInput[] = [];
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
    if (sessionId && this.nativeSessionReady) void this.port.invoke('sessions.close', { sessionId }).catch(() => undefined);
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
    const bytes = utf8ByteLength(data);
    if (bytes > NATIVE_INPUT_CHUNK_BYTES || this.inputQueue.length + (this.inputPumpActive ? 1 : 0) >= NATIVE_INPUT_QUEUE_CHUNKS || this.inputQueueBytes + this.inputInFlightBytes + bytes > NATIVE_INPUT_QUEUE_BYTES) {
      this.emitError('SSH_CONNECTION_FAILED', '终端输入过快，请稍后重试');
      return false;
    }
    this.inputQueue.push({ data, bytes });
    this.inputQueueBytes += bytes;
    void this.drainInputQueue();
    return true;
  }

  private async drainInputQueue(): Promise<void> {
    if (this.inputPumpActive) return;
    this.inputPumpActive = true;
    try {
      while (this.readyState === SOCKET_OPEN && this.shellReady && this.sessionId !== null && this.inputQueue.length > 0) {
        const queued = this.inputQueue.shift();
        if (queued === undefined) break;
        this.inputQueueBytes -= queued.bytes;
        this.inputInFlightBytes = queued.bytes;
        try {
          await this.port.invoke('sessions.write', { sessionId: this.sessionId, data: queued.data });
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
          const nativeRequestId = nextNativeSessionRequestId(message.requestId);
          const nativeRequest = { ...message, requestId: nativeRequestId };
          this.requestId = nativeRequestId;
          this.sessionId = nativeRequestId;
          const result = await this.port.invoke<{ sessionId?: string }>('sessions.openShell', { request: nativeRequest });
          if (typeof result.sessionId === 'string') this.sessionId = result.sessionId;
          if (this.closedByUser || this.readyState !== SOCKET_OPEN) {
            if (this.sessionId) await this.port.invoke('sessions.close', { sessionId: this.sessionId }).catch(() => undefined);
            return;
          }
          this.nativeSessionReady = true;
          if (this.shellReady) void this.flushShellReadyQueue();
          return;
        }
        case 'resize':
          this.pendingResize = { cols: message.cols, rows: message.rows };
          if (!this.nativeSessionReady || !this.shellReady) return;
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
        if (state === 'needs-reopen') this.needsReopen = true;
        if (state === 'connected') {
          this.needsReopen = false;
          this.shellReady = true;
          if (this.nativeSessionReady) void this.flushShellReadyQueue();
        }
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
          this.emitServerEvent({ type: 'status', state: 'closed', serviceInstanceId: NATIVE_SERVICE_INSTANCE_ID });
        } else {
          this.finishClose(this.needsReopen ? 1000 : 1011, this.needsReopen ? 'native session needs reopen' : 'remote connection interrupted');
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
    this.nativeSessionReady = false;
    this.shellReady = false;
    this.pendingResize = null;
    this.readyState = SOCKET_CLOSED;
    this.stopEvents();
    this.onclose?.({ code, reason, wasClean: code === 1000 && this.closedByUser });
  }

  private async flushShellReadyQueue(): Promise<void> {
    const pendingResize = this.pendingResize;
    this.pendingResize = null;
    try {
      if (pendingResize && this.sessionId) {
        await this.port.invoke('sessions.resize', { sessionId: this.sessionId, ...pendingResize });
      }
      await this.drainInputQueue();
    } catch (error) {
      const details = errorDetails(error);
      this.emitError(details.code, details.message);
    }
  }
}

export const createNativeTerminalSocket = (port: NativeOperationPort, url: string): TerminalSocketLike => new NativeTerminalSocket(port, url);
