import { describe, expect, it } from 'vitest';

import { CloudLiveRelay, type CloudLiveSocket, type CloudLiveSocketFactory } from '../../../src/shared/cloud/live-client.js';

class FakeSocket implements CloudLiveSocket {
  static readonly OPEN = 1;
  readonly sent: Uint8Array[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  send(data: Uint8Array): void { this.sent.push(new Uint8Array(data)); }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open(): void { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(data: unknown): void { this.onmessage?.({ data }); }
}

const setup = (): { relay: CloudLiveRelay; socket: FakeSocket; factory: CloudLiveSocketFactory } => {
  const socket = new FakeSocket();
  const factory: CloudLiveSocketFactory = (_url, _protocols) => socket;
  return {
    relay: new CloudLiveRelay({
      baseUrl: 'https://api.example.test',
      token: 'a'.repeat(43),
      workspaceId: 'workspace-1',
      role: 'viewer',
      socketFactory: factory
    }),
    socket,
    factory
  };
};

describe('bounded cloud live relay client', () => {
  it('connects with the bearer subprotocol and sends without an unbounded queue', async () => {
    const { relay, socket } = setup();
    const connecting = relay.connect();
    expect(socket.readyState).toBe(0);
    socket.open();
    await connecting;
    expect(relay.url).toBe('wss://api.example.test/v2/relay/viewer?workspaceId=workspace-1');
    expect(relay.socketProtocols).toEqual([`relay-bearer.${'a'.repeat(43)}`]);

    relay.send(new Uint8Array([1, 2]));
    expect(socket.sent).toEqual([new Uint8Array([1, 2])]);
    socket.bufferedAmount = 256 * 1024;
    expect(() => relay.send(new Uint8Array([3]))).toThrow('relay send buffer limit');
  });

  it('rejects oversized inbound frames and closes the socket before retaining them', async () => {
    const { relay, socket } = setup();
    const received: Uint8Array[] = [];
    relay.onFrame((frame) => received.push(frame));
    const connecting = relay.connect();
    socket.open();
    await connecting;

    socket.receive(new Uint8Array(64 * 1024 + 1));
    expect(received).toHaveLength(0);
    expect(socket.readyState).toBe(3);
  });

  it('closes idempotently and reports the remote close once', async () => {
    const { relay, socket } = setup();
    const closes: Array<{ code: number; reason: string }> = [];
    relay.onClose((event) => closes.push(event));
    const connecting = relay.connect();
    socket.open();
    await connecting;
    relay.close();
    relay.close();
    expect(closes).toEqual([{ code: 1000, reason: '' }]);
  });
});
