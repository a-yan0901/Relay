import { z } from 'zod';

export const NATIVE_BRIDGE_VERSION = 1 as const;
export const NATIVE_BRIDGE_MAX_FRAME_BYTES = 64 * 1024;
export const BOUNDED_NATIVE_CHUNK_BYTES = 64 * 1024;
export const BOUNDED_NATIVE_IN_FLIGHT_CHUNKS = 8;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const operationSchema = z.object({
  version: z.literal(NATIVE_BRIDGE_VERSION),
  requestId: z.string().regex(SAFE_ID),
  operation: z.string().min(1).max(96),
  payload: z.unknown()
}).strict();

const eventSchema = z.object({
  version: z.literal(NATIVE_BRIDGE_VERSION),
  generation: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  kind: z.string().min(1).max(96),
  requestId: z.string().regex(SAFE_ID).optional(),
  sessionId: z.string().regex(SAFE_ID).optional(),
  transferId: z.string().regex(SAFE_ID).optional(),
  payload: z.unknown()
}).strict();

export interface NativeOperationFrame {
  version: typeof NATIVE_BRIDGE_VERSION;
  requestId: string;
  operation: string;
  payload: unknown;
}

export interface NativeEventFrame {
  version: typeof NATIVE_BRIDGE_VERSION;
  generation: number;
  sequence: number;
  kind: string;
  requestId?: string;
  sessionId?: string;
  transferId?: string;
  payload: unknown;
}

const assertFrameBytes = (value: unknown, message: string): void => {
  let encoded: Uint8Array;
  try {
    encoded = new globalThis.TextEncoder().encode(JSON.stringify(value));
  } catch {
    throw new Error(message);
  }
  if (encoded.byteLength > NATIVE_BRIDGE_MAX_FRAME_BYTES) throw new Error(message);
};

export const parseNativeOperation = (value: unknown): NativeOperationFrame => {
  const parsed = operationSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid native operation');
  assertFrameBytes(parsed.data, 'native operation too large');
  return parsed.data;
};

export const parseNativeEvent = (value: unknown): NativeEventFrame => {
  const parsed = eventSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid native event');
  assertFrameBytes(parsed.data, 'native event too large');
  return parsed.data;
};

export class BoundedNativeChunkWindow {
  private readonly chunks = new Map<number, Uint8Array>();
  private bytes = 0;

  constructor(
    private readonly maxChunks = BOUNDED_NATIVE_IN_FLIGHT_CHUNKS,
    private readonly maxChunkBytes = BOUNDED_NATIVE_CHUNK_BYTES
  ) {
    if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > BOUNDED_NATIVE_IN_FLIGHT_CHUNKS) throw new Error('invalid native chunk window');
    if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > BOUNDED_NATIVE_CHUNK_BYTES) throw new Error('invalid native chunk size');
  }

  get inFlightChunks(): number { return this.chunks.size; }
  get inFlightBytes(): number { return this.bytes; }

  offer(sequence: number, chunk: Uint8Array): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 1 || !(chunk instanceof Uint8Array) || chunk.byteLength > this.maxChunkBytes) return false;
    if (this.chunks.has(sequence)) return true;
    if (this.chunks.size >= this.maxChunks || this.bytes + chunk.byteLength > this.maxChunks * this.maxChunkBytes) return false;
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    this.chunks.set(sequence, copy);
    this.bytes += copy.byteLength;
    return true;
  }

  ack(sequence: number): boolean {
    const chunk = this.chunks.get(sequence);
    if (!chunk) return false;
    this.bytes -= chunk.byteLength;
    this.chunks.delete(sequence);
    return true;
  }

  cancel(): void {
    this.chunks.clear();
    this.bytes = 0;
  }
}

export type NativeEventGateResult = 'applied' | 'duplicate' | 'resync-required' | 'generation-changed' | 'stale';

export class NativeEventGate {
  private generation: number | null = null;
  private sequence = 0;

  accept(event: NativeEventFrame): NativeEventGateResult {
    if (this.generation === null) {
      this.generation = event.generation;
      this.sequence = event.sequence;
      return 'applied';
    }
    if (event.generation < this.generation) return 'stale';
    if (event.generation > this.generation) {
      this.generation = event.generation;
      this.sequence = 0;
      return 'generation-changed';
    }
    if (event.sequence <= this.sequence) return 'duplicate';
    if (event.sequence !== this.sequence + 1) return 'resync-required';
    this.sequence = event.sequence;
    return 'applied';
  }
}
