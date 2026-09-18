import { z } from 'zod';

import { AppError, isAppErrorCode } from '../../shared/errors.js';
import {
  NativeEventGate,
  NATIVE_BRIDGE_MAX_FRAME_BYTES,
  NATIVE_BRIDGE_VERSION,
  parseNativeEvent,
  parseNativeOperation,
  type NativeEventFrame,
  type NativeOperationFrame
} from '../../shared/native/bridge.js';
import type { NativeOperationPort } from '../../shared/native/core-runtime.js';

const MAX_SUBSCRIBERS = 16;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface AndroidNativePlugin {
  invoke(frame: NativeOperationFrame): Promise<unknown>;
  addListener(eventName: 'event', listener: (value: unknown) => void): { remove(): void | Promise<void> } | PromiseLike<{ remove(): void | Promise<void> }>;
}

export interface AndroidNativeBridgeOptions {
  maxSubscribers?: number;
  eventGate?: NativeEventGate;
}

const responseSchema = z.object({
  version: z.literal(NATIVE_BRIDGE_VERSION),
  requestId: z.string().regex(SAFE_ID),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string().max(4096) }).strict().optional()
}).strict().superRefine((value, context) => {
  if (value.ok && value.error !== undefined) context.addIssue({ code: 'custom', message: 'successful response contains an error' });
  if (!value.ok && value.error === undefined) context.addIssue({ code: 'custom', message: 'failed response has no error' });
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > NATIVE_BRIDGE_MAX_FRAME_BYTES) context.addIssue({ code: 'custom', message: 'native response too large' });
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid native response' });
  }
});

let requestNumber = 0;

const nextRequestId = (): string => {
  requestNumber = requestNumber >= Number.MAX_SAFE_INTEGER - 1 ? 1 : requestNumber + 1;
  return `android-${requestNumber}`;
};

const errorFromResponse = (value: z.infer<typeof responseSchema>): AppError => {
  if (!value.error || !isAppErrorCode(value.error.code)) return new AppError('PROTOCOL_INVALID_MESSAGE');
  return new AppError(value.error.code, value.error.message);
};

const eventValue = (value: unknown): unknown => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return record.event ?? value;
};

class AndroidNativeBridge implements NativeOperationPort {
  private readonly listeners = new Set<(event: NativeEventFrame) => void>();
  private readonly gate: NativeEventGate;
  private sessionCloseQueue: Promise<void> = Promise.resolve();
  private eventReady: Promise<{ remove(): void }> | null = null;
  private registration: { remove(): void } | null = null;

  constructor(private readonly plugin: AndroidNativePlugin, private readonly maxSubscribers: number, gate?: NativeEventGate) {
    this.gate = gate ?? new NativeEventGate();
  }

  async invoke<T = unknown>(operation: string, payload: unknown): Promise<T> {
    if (this.listeners.size > 0) await this.ensureEventListener();
    const request = parseNativeOperation({ version: NATIVE_BRIDGE_VERSION, requestId: nextRequestId(), operation, payload });
    let raw: unknown;
    if (operation === 'sessions.close') {
      // JSch disconnect can still be unwinding after the native close response
      // is requested. Serialize closes and make a subsequent shell wait for
      // the entire close chain, otherwise a rapid close/open can race native
      // session cleanup on Android.
      const queuedClose = this.sessionCloseQueue.then(
        () => this.plugin.invoke(request),
        () => this.plugin.invoke(request)
      );
      this.sessionCloseQueue = queuedClose.then(() => undefined, () => undefined);
      raw = await queuedClose;
    } else {
      if (operation === 'sessions.openShell' || operation === 'sessions.reconnect') await this.sessionCloseQueue;
      raw = await this.plugin.invoke(request);
    }
    const parsed = responseSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
    if (parsed.data.requestId !== request.requestId) throw new AppError('PROTOCOL_INVALID_MESSAGE', '原生请求响应不匹配');
    if (!parsed.data.ok) throw errorFromResponse(parsed.data);
    return parsed.data.result as T;
  }

  subscribe(listener: (event: NativeEventFrame) => void): () => void {
    if (typeof listener !== 'function') throw new Error('invalid android native subscriber');
    if (this.listeners.size >= this.maxSubscribers) throw new Error('android native subscriber limit reached');
    if (this.listeners.size === 0) this.gate.reset();
    this.listeners.add(listener);
    void this.ensureEventListener();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.releaseEventListener();
    };
  }

  private ensureEventListener(): Promise<{ remove(): void }> {
    if (this.eventReady) return this.eventReady;
    this.eventReady = Promise.resolve().then(() => this.plugin.addListener('event', (raw) => {
      let event: NativeEventFrame;
      try { event = parseNativeEvent(eventValue(raw)); } catch { return; }
      const result = this.gate.accept(event);
      if (result !== 'applied' && result !== 'generation-changed') return;
      for (const listener of this.listeners) listener(event);
    })).then((registration) => {
      this.registration = registration;
      return registration;
    }).catch(() => {
      this.eventReady = null;
      throw new AppError('CAPABILITY_UNAVAILABLE', 'Android 原生事件通道不可用');
    });
    return this.eventReady;
  }

  private releaseEventListener(): void {
    const ready = this.eventReady;
    this.eventReady = null;
    const registration = this.registration;
    this.registration = null;
    this.gate.reset();
    if (registration) {
      registration.remove();
      return;
    }
    void ready?.then((resolved) => resolved.remove()).catch(() => undefined);
  }
}

export const createAndroidNativeBridge = (plugin: AndroidNativePlugin, options: AndroidNativeBridgeOptions = {}): NativeOperationPort => {
  const maxSubscribers = options.maxSubscribers ?? MAX_SUBSCRIBERS;
  if (!Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1 || maxSubscribers > MAX_SUBSCRIBERS) throw new Error('invalid android native subscriber limit');
  return new AndroidNativeBridge(plugin, maxSubscribers, options.eventGate);
};
