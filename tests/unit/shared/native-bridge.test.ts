import { describe, expect, it } from 'vitest';

import {
  BOUNDED_NATIVE_CHUNK_BYTES,
  BOUNDED_NATIVE_IN_FLIGHT_CHUNKS,
  BoundedNativeChunkWindow,
  NativeEventGate,
  parseNativeOperation
} from '../../../src/shared/native/bridge.js';

describe('bounded native bridge contract', () => {
  it('rejects oversized operation payloads before dispatch', () => {
    expect(() => parseNativeOperation({
      version: 1,
      requestId: 'request-1',
      operation: 'session.open',
      payload: { value: 'x'.repeat(64 * 1024) }
    })).toThrow('native operation too large');
  });

  it('keeps file streaming within eight 64 KiB in-flight chunks', () => {
    const window = new BoundedNativeChunkWindow();
    for (let sequence = 1; sequence <= BOUNDED_NATIVE_IN_FLIGHT_CHUNKS; sequence += 1) {
      expect(window.offer(sequence, new Uint8Array(BOUNDED_NATIVE_CHUNK_BYTES))).toBe(true);
    }
    expect(window.offer(BOUNDED_NATIVE_IN_FLIGHT_CHUNKS + 1, new Uint8Array(1))).toBe(false);
    expect(window.inFlightBytes).toBe(BOUNDED_NATIVE_IN_FLIGHT_CHUNKS * BOUNDED_NATIVE_CHUNK_BYTES);
    window.ack(1);
    expect(window.offer(BOUNDED_NATIVE_IN_FLIGHT_CHUNKS + 1, new Uint8Array(1))).toBe(true);
    window.cancel();
    expect(window.inFlightBytes).toBe(0);
  });

  it('drops duplicate and stale events while requiring a new generation after restart', () => {
    const gate = new NativeEventGate();
    expect(gate.accept({ version: 1, generation: 2, sequence: 1, kind: 'session.output', sessionId: 'session-1', payload: 'a' })).toBe('applied');
    expect(gate.accept({ version: 1, generation: 2, sequence: 1, kind: 'session.output', sessionId: 'session-1', payload: 'a' })).toBe('duplicate');
    expect(gate.accept({ version: 1, generation: 2, sequence: 3, kind: 'session.output', sessionId: 'session-1', payload: 'c' })).toBe('resync-required');
    expect(gate.accept({ version: 1, generation: 3, sequence: 1, kind: 'session.output', sessionId: 'session-1', payload: 'new' })).toBe('generation-changed');
    expect(gate.accept({ version: 1, generation: 3, sequence: 1, kind: 'session.output', sessionId: 'session-1', payload: 'new' })).toBe('applied');
  });
});
