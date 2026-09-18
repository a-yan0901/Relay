import { describe, expect, it, vi } from 'vitest';

import type { NativeEventFrame } from '../../../src/shared/native/bridge.js';
import type { NativeOperationPort } from '../../../src/shared/native/core-runtime.js';
import { createNativeTerminalSocket } from '../../../src/web/platform/native-terminal-socket.js';

describe('native terminal socket adapter', () => {
  it('maps the shared terminal control protocol onto bounded native operations', async () => {
    const calls: Array<{ operation: string; payload: unknown }> = [];
    let emit: ((event: NativeEventFrame) => void) | undefined;
    const port: NativeOperationPort = {
      invoke: vi.fn(async <T,>(operation: string, payload: unknown): Promise<T> => {
        calls.push({ operation, payload });
        if (operation === 'sessions.openShell') return { sessionId: 'session-1', hostId: 'host-1' } as T;
        return undefined as T;
      }),
      subscribe(listener) { emit = listener; return () => { emit = undefined; }; }
    };
    const output = vi.fn();
    const socket = createNativeTerminalSocket(port, 'native://terminal');
    socket.onopen = () => socket.send(JSON.stringify({ type: 'open', hostId: 'host-1', cols: 80, rows: 24, requestId: 'terminal-1' }));
    socket.onmessage = (event) => {
      if (event.data instanceof Uint8Array) output(event.data);
    };
    await vi.waitFor(() => expect(calls.some(({ operation }) => operation === 'sessions.openShell')).toBe(true));

    socket.send(new TextEncoder().encode('pwd\n'));
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    socket.send(JSON.stringify({ type: 'host-key-decision', decision: 'trust', fingerprint: 'SHA256:abc' }));
    socket.send(JSON.stringify({ type: 'credential', hostId: 'host-1', credential: { type: 'password', password: 'secret' } }));
    emit?.({ version: 1, generation: 1, sequence: 1, kind: 'terminal.output', sessionId: 'session-1', payload: { stream: 'stdout', data: 'b2s' } });

    await vi.waitFor(() => expect(output).toHaveBeenCalledWith(new Uint8Array([0x6f, 0x6b])));
    expect(calls.map(({ operation }) => operation)).toEqual(expect.arrayContaining([
      'sessions.write', 'sessions.resize', 'sessions.hostKeyDecision', 'sessions.credential'
    ]));
  });

  it('converts an unexpected native close into a reconnectable socket close', async () => {
    let emit: ((event: NativeEventFrame) => void) | undefined;
    const onclose = vi.fn();
    const port: NativeOperationPort = {
      invoke: vi.fn(async <T,>(operation: string): Promise<T> => (operation === 'sessions.openShell' ? { sessionId: 'session-1', hostId: 'host-1' } as T : undefined as T)),
      subscribe(listener) { emit = listener; return () => { emit = undefined; }; }
    };
    const socket = createNativeTerminalSocket(port, 'native://terminal');
    socket.onclose = onclose;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'open', hostId: 'host-1', cols: 80, rows: 24, requestId: 'terminal-1' }));
    await vi.waitFor(() => expect(socket.readyState).toBe(1));
    emit?.({ version: 1, generation: 1, sequence: 1, kind: 'terminal.close', sessionId: 'session-1', payload: { clean: false } });
    expect(onclose).toHaveBeenCalledWith(expect.objectContaining({ code: 1011 }));
  });

  it('marks a lifecycle-closed native session as an explicit reopen instead of a retry', async () => {
    let emit: ((event: NativeEventFrame) => void) | undefined;
    const onclose = vi.fn();
    const port: NativeOperationPort = {
      invoke: vi.fn(async <T,>(operation: string): Promise<T> => (operation === 'sessions.openShell' ? { sessionId: 'session-1', hostId: 'host-1' } as T : undefined as T)),
      subscribe(listener) { emit = listener; return () => { emit = undefined; }; }
    };
    const socket = createNativeTerminalSocket(port, 'native://terminal');
    socket.onclose = onclose;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'open', hostId: 'host-1', cols: 80, rows: 24, requestId: 'terminal-1' }));
    await vi.waitFor(() => expect(socket.readyState).toBe(1));
    emit?.({ version: 1, generation: 1, sequence: 1, kind: 'terminal.status', sessionId: 'session-1', payload: { state: 'needs-reopen', serviceInstanceId: 'android-local' } });
    emit?.({ version: 1, generation: 1, sequence: 2, kind: 'terminal.close', sessionId: 'session-1', payload: { clean: false } });

    expect(onclose).toHaveBeenCalledWith(expect.objectContaining({ code: 1000 }));
  });

  it('bounds rapid native input and reports an explicit backpressure error', async () => {
    const pendingWrites: Array<() => void> = [];
    const writes: string[] = [];
    let opened = false;
    const onerror = vi.fn();
    const port: NativeOperationPort = {
      invoke: vi.fn(async <T,>(operation: string, payload: unknown): Promise<T> => {
        if (operation === 'sessions.openShell') {
          opened = true;
          return { sessionId: 'session-1', hostId: 'host-1' } as T;
        }
        if (operation === 'sessions.write') {
          writes.push((payload as { data: string }).data);
          await new Promise<void>((resolve) => pendingWrites.push(resolve));
        }
        return undefined as T;
      }),
      subscribe() { return () => undefined; }
    };
    const socket = createNativeTerminalSocket(port, 'native://terminal');
    socket.onerror = onerror;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'open', hostId: 'host-1', cols: 80, rows: 24, requestId: 'terminal-1' }));
    await vi.waitFor(() => expect(opened).toBe(true));

    for (let index = 0; index < 8; index += 1) socket.send(new TextEncoder().encode(`input-${index}`));
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    socket.send(new TextEncoder().encode('overflow'));

    expect(onerror).toHaveBeenCalledWith(expect.objectContaining({ code: 'SSH_CONNECTION_FAILED' }));
    for (let index = 0; index < 8; index += 1) {
      await vi.waitFor(() => expect(pendingWrites.length).toBeGreaterThan(0));
      pendingWrites.shift()?.();
    }
    await vi.waitFor(() => expect(writes).toHaveLength(8));
    socket.close();
  });
});
