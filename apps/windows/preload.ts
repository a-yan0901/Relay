import { z } from 'zod';

import { AppError, isAppErrorCode } from '../../src/shared/errors.js';
import {
  NativeEventGate,
  NATIVE_BRIDGE_VERSION,
  parseNativeEvent,
  type NativeEventFrame,
  type NativeOperationFrame
} from '../../src/shared/native/bridge.js';
import {
  encodeDesktopIpcRequest,
  DESKTOP_IPC_MAX_FRAME_BYTES,
  type DesktopIpcOperation,
  type DesktopIpcRequest,
  type DesktopIpcResponse
} from './ipc-contract.js';

const MAX_SUBSCRIBERS = 16;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface DesktopIpcTransport {
  invoke(request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
  subscribe(listener: (event: NativeEventFrame) => void): () => void;
}

export interface DesktopPreloadApi {
  invoke(operation: DesktopIpcOperation, payload: unknown): Promise<unknown>;
  subscribe(listener: (event: NativeEventFrame) => void): () => void;
}

export interface DesktopPreloadOptions {
  maxSubscribers?: number;
  eventGate?: NativeEventGate;
}

export interface ElectronRendererIpcLike {
  invoke(channel: string, request: DesktopIpcRequest): Promise<DesktopIpcResponse>;
  on(channel: string, listener: (_event: unknown, value: NativeEventFrame) => void): void;
  removeListener(channel: string, listener: (_event: unknown, value: NativeEventFrame) => void): void;
}

export const createElectronPreloadApi = (ipcRenderer: ElectronRendererIpcLike, options: DesktopPreloadOptions = {}): DesktopPreloadApi => {
  const transport: DesktopIpcTransport = {
    invoke: (request) => ipcRenderer.invoke('relay:invoke', request),
    subscribe: (listener) => {
      const onEvent = (_event: unknown, value: NativeEventFrame): void => listener(value);
      ipcRenderer.on('relay:event', onEvent);
      return () => ipcRenderer.removeListener('relay:event', onEvent);
    }
  };
  return createDesktopPreloadApi(transport, options);
};

const responseSchema = z.object({
  version: z.literal(NATIVE_BRIDGE_VERSION),
  requestId: z.string().regex(REQUEST_ID_PATTERN),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.object({
    code: z.string(),
    message: z.string().max(4096)
  }).strict().optional()
}).strict().superRefine((value, context) => {
  if (value.ok && value.error !== undefined) context.addIssue({ code: 'custom', message: 'successful response contains an error' });
  if (!value.ok && value.error === undefined) context.addIssue({ code: 'custom', message: 'failed response has no error' });
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > DESKTOP_IPC_MAX_FRAME_BYTES) context.addIssue({ code: 'custom', message: 'desktop IPC response too large' });
  } catch {
    context.addIssue({ code: 'custom', message: 'invalid desktop IPC response' });
  }
});

let nextRequestNumber = 0;

const requestId = (): string => {
  nextRequestNumber = nextRequestNumber >= Number.MAX_SAFE_INTEGER - 1 ? 1 : nextRequestNumber + 1;
  return `ipc-${nextRequestNumber}`;
};

const responseError = (value: z.infer<typeof responseSchema>): AppError => {
  if (!value.error || !isAppErrorCode(value.error.code)) return new AppError('PROTOCOL_INVALID_MESSAGE');
  return new AppError(value.error.code, value.error.message);
};

export const createDesktopPreloadApi = (transport: DesktopIpcTransport, options: DesktopPreloadOptions = {}): DesktopPreloadApi => {
  const maxSubscribers = options.maxSubscribers ?? MAX_SUBSCRIBERS;
  if (!Number.isSafeInteger(maxSubscribers) || maxSubscribers < 1 || maxSubscribers > MAX_SUBSCRIBERS) throw new Error('invalid desktop IPC subscriber limit');
  const gate = options.eventGate ?? new NativeEventGate();
  const listeners = new Set<(event: NativeEventFrame) => void>();
  let stopTransportSubscription: (() => void) | undefined;

  const onTransportEvent = (value: NativeEventFrame): void => {
    let event: NativeEventFrame;
    try {
      event = parseNativeEvent(value);
    } catch {
      return;
    }
    const gateResult = gate.accept(event);
    if (gateResult !== 'applied' && gateResult !== 'generation-changed') return;
    for (const listener of listeners) listener(event);
  };

  return {
    async invoke(operation, payload): Promise<unknown> {
      const request = encodeDesktopIpcRequest({ version: 1, requestId: requestId(), operation, payload });
      const rawResponse = await transport.invoke(request);
      const parsedResponse = responseSchema.safeParse(rawResponse);
      if (!parsedResponse.success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      if (parsedResponse.data.requestId !== request.requestId) throw new Error('desktop IPC response mismatch');
      if (!parsedResponse.data.ok) throw responseError(parsedResponse.data);
      return parsedResponse.data.result;
    },
    subscribe(listener): () => void {
      if (typeof listener !== 'function') throw new Error('invalid desktop IPC subscriber');
      if (listeners.size >= maxSubscribers) throw new Error('desktop IPC subscriber limit reached');
      if (listeners.size === 0) gate.reset();
      listeners.add(listener);
      if (listeners.size === 1) stopTransportSubscription = transport.subscribe(onTransportEvent);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          stopTransportSubscription?.();
          stopTransportSubscription = undefined;
          gate.reset();
        }
      };
    }
  };
};

export interface ContextBridgeLike {
  exposeInMainWorld(name: string, api: DesktopPreloadApi): void;
}

export const exposeDesktopPreloadApi = (bridge: ContextBridgeLike, api: DesktopPreloadApi, key = 'relayDesktop'): void => {
  if (key !== 'relayDesktop') throw new Error('invalid preload key');
  bridge.exposeInMainWorld(key, api);
};

export type DesktopIpcInvokeFrame = NativeOperationFrame;
