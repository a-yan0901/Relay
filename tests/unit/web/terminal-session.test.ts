// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  TerminalSessionController,
  type TerminalSocketLike
} from '../../../src/web/hooks/use-terminal-session';

class FakeSocket implements TerminalSocketLike {
  static instances: FakeSocket[] = [];
  readonly sent: Array<string | Uint8Array> = [];
  readyState = 0;
  binaryType = 'arraybuffer';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closeCalls = 0;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 3;
    this.onclose?.();
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  message(data: unknown): void {
    this.onmessage?.({ data });
  }

  fail(): void {
    this.onerror?.();
  }
}

const lastSocket = (): FakeSocket => FakeSocket.instances.at(-1) as FakeSocket;

describe('TerminalSessionController', () => {
  it('opens with the terminal contract and sends raw input plus resize frames', () => {
    FakeSocket.instances = [];
    const factory = vi.fn((url: string) => new FakeSocket(url));
    const controller = new TerminalSessionController({
      hostId: 'host-1',
      terminalId: 'terminal-1',
      getSize: () => ({ cols: 100, rows: 30 }),
      webSocketFactory: factory
    });

    controller.connect();
    const socket = lastSocket();
    expect(socket.url).toBe(`ws://${window.location.host}/ws/terminal`);
    expect(controller.snapshot.state).toBe('connecting');

    socket.open();
    expect(JSON.parse(socket.sent[0] as string)).toEqual({
      type: 'open',
      hostId: 'host-1',
      cols: 100,
      rows: 30,
      requestId: 'terminal-1',
      term: 'xterm-256color'
    });

    controller.sendInput('printf "hello\\n"');
    expect(ArrayBuffer.isView(socket.sent[1])).toBe(true);
    expect(new TextDecoder().decode(socket.sent[1] as Uint8Array)).toBe('printf "hello\\n"');

    controller.resize(120, 42);
    expect(JSON.parse(socket.sent[2] as string)).toEqual({ type: 'resize', cols: 120, rows: 42 });
  });

  it('writes binary output and tracks status and host-key challenge events', () => {
    FakeSocket.instances = [];
    const onOutput = vi.fn();
    const controller = new TerminalSessionController({
      hostId: 'host-1',
      terminalId: 'terminal-1',
      onOutput,
      webSocketFactory: (url) => new FakeSocket(url)
    });
    controller.connect();
    const socket = lastSocket();
    socket.open();
    socket.message(new Uint8Array([27, 91, 50, 74]));
    socket.message(JSON.stringify({ type: 'status', state: 'connected' }));
    socket.message(JSON.stringify({
      type: 'host-key',
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:fixture',
      address: '10.0.0.8',
      port: 22
    }));

    expect(onOutput).toHaveBeenCalledWith(new Uint8Array([27, 91, 50, 74]));
    expect(controller.snapshot.state).toBe('awaiting-host-key');
    expect(controller.snapshot.hostKey?.fingerprint).toBe('SHA256:fixture');

    controller.decideHostKey('trust');
    expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({
      type: 'host-key-decision',
      decision: 'trust',
      fingerprint: 'SHA256:fixture'
    });
    socket.message(JSON.stringify({ type: 'status', state: 'connected' }));
    expect(controller.snapshot.hostKey).toBeNull();
  });

  it('reconnects after an unintentional close with a capped exponential backoff', () => {
    vi.useFakeTimers();
    try {
      FakeSocket.instances = [];
      const snapshots: Array<{ state: string; reconnectDelayMs: number }> = [];
      const controller = new TerminalSessionController({
        hostId: 'host-1',
        terminalId: 'terminal-1',
        webSocketFactory: (url) => new FakeSocket(url),
        onSnapshot: (snapshot) => snapshots.push({ state: snapshot.state, reconnectDelayMs: snapshot.reconnectDelayMs }),
        reconnectBaseMs: 250,
        reconnectMaxMs: 5_000
      });

      controller.connect();
      lastSocket().open();
      lastSocket().close();
      expect(controller.snapshot.state).toBe('reconnecting');
      expect(snapshots).toContainEqual({ state: 'reconnecting', reconnectDelayMs: 250 });
      expect(FakeSocket.instances).toHaveLength(1);

      vi.advanceTimersByTime(249);
      expect(FakeSocket.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeSocket.instances).toHaveLength(2);
      lastSocket().open();

      for (let attempt = 0; attempt < 6; attempt += 1) {
        lastSocket().close();
        vi.advanceTimersByTime(5_000);
        lastSocket().open();
      }
      expect(controller.snapshot.reconnectDelayMs).toBeLessThanOrEqual(5_000);
      controller.close();
      const countAfterClose = FakeSocket.instances.length;
      vi.advanceTimersByTime(20_000);
      expect(FakeSocket.instances).toHaveLength(countAfterClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not retry automatically after a permanent SSH error', () => {
    vi.useFakeTimers();
    try {
      FakeSocket.instances = [];
      const controller = new TerminalSessionController({
        hostId: 'host-1',
        terminalId: 'terminal-1',
        webSocketFactory: (url) => new FakeSocket(url),
        reconnectBaseMs: 250
      });

      controller.connect();
      const socket = lastSocket();
      socket.open();
      socket.message(JSON.stringify({ type: 'error', code: 'SSH_AUTH_FAILED', message: '远程服务器认证失败' }));
      expect(controller.snapshot.state).toBe('failed');

      socket.close();
      vi.advanceTimersByTime(10_000);

      expect(FakeSocket.instances).toHaveLength(1);
      expect(controller.snapshot.state).toBe('failed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps sanitized connection diagnostics for the status UI', () => {
    FakeSocket.instances = [];
    const controller = new TerminalSessionController({
      hostId: 'host-1',
      terminalId: 'terminal-1',
      webSocketFactory: (url) => new FakeSocket(url)
    });
    controller.connect();
    const socket = lastSocket();
    socket.open();
    socket.message(JSON.stringify({
      type: 'diagnostic',
      diagnostic: {
        id: 'diagnostic-1',
        hostId: 'host-1',
        stage: 'authentication',
        status: 'failed',
        hopIndex: 0,
        retryable: false,
        code: 'SSH_AUTH_FAILED',
        at: '2026-09-15T00:00:00.000Z'
      }
    }));

    expect(controller.snapshot.diagnostics).toEqual([expect.objectContaining({ stage: 'authentication', status: 'failed' })]);
  });

  it('closes explicitly and removes reconnect timers', () => {
    vi.useFakeTimers();
    try {
      FakeSocket.instances = [];
      const controller = new TerminalSessionController({
        hostId: 'host-1',
        terminalId: 'terminal-1',
        webSocketFactory: (url) => new FakeSocket(url)
      });
      controller.connect();
      const socket = lastSocket();
      socket.open();
      controller.close();

      expect(controller.snapshot.state).toBe('closed');
      expect(socket.closeCalls).toBe(1);
      expect(JSON.parse(socket.sent.at(-1) as string)).toEqual({ type: 'close' });
      vi.advanceTimersByTime(10_000);
      expect(FakeSocket.instances).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
