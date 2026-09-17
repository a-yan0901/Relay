import WebSocket from 'ws';

import type { CloudLiveSocket, CloudLiveSocketFactory } from '../../shared/cloud/live-client.js';

const asBytes = (data: WebSocket.RawData): Uint8Array => {
  if (Buffer.isBuffer(data)) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data as unknown as ArrayBuffer);
};

/** Adapts the ws EventEmitter API to the small shared cloud relay contract. */
class NodeCloudLiveSocket implements CloudLiveSocket {
  private readonly socket: WebSocket;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(url: string, protocols: readonly string[]) {
    this.socket = new WebSocket(url, [...protocols]);
    this.socket.on('open', () => this.onopen?.());
    this.socket.on('message', (data: WebSocket.RawData) => this.onmessage?.({ data: asBytes(data) }));
    this.socket.on('error', () => this.onerror?.());
    this.socket.on('close', (code: number, reason: Buffer) => this.onclose?.({ code, reason: reason.toString('utf8') }));
  }

  get readyState(): number { return this.socket.readyState; }
  get bufferedAmount(): number { return this.socket.bufferedAmount; }
  get binaryType(): string { return this.socket.binaryType; }
  set binaryType(value: string) { this.socket.binaryType = value as 'nodebuffer' | 'arraybuffer' | 'fragments'; }

  send(data: Uint8Array): void { this.socket.send(data); }
  close(code?: number, reason?: string): void { this.socket.close(code, reason); }
}

export const createNodeCloudLiveSocketFactory = (): CloudLiveSocketFactory => (
  (url, protocols) => new NodeCloudLiveSocket(url, protocols)
);
