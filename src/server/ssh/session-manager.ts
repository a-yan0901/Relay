import { AppError } from '../../shared/errors.js';
import type {
  SshChannel,
  SshConnectCallbacks,
  SshConnectConfig,
  SshSessionManagerPort,
  SshAdapterPort,
  SshHostKeyChallenge
} from './types.js';

export interface SshSessionManagerOptions {
  adapter: SshAdapterPort;
  maxSessions: number;
  detachGraceMs?: number;
  outputBufferBytes?: number;
}

interface ManagedSession {
  id: string;
  hostId: string;
  channel: SshChannel;
  detached: boolean;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
  outputBuffer: Buffer[];
  outputBufferBytes: number;
}

const DEFAULT_DETACH_GRACE_MS = 30_000;
const DEFAULT_OUTPUT_BUFFER_BYTES = 256 * 1024;

export class SshSessionManager implements SshSessionManagerPort {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly adapter: SshAdapterPort;
  private readonly maxSessions: number;
  private readonly detachGraceMs: number;
  private readonly outputBufferLimit: number;
  private pendingConnections = 0;

  constructor(options: SshSessionManagerOptions) {
    if (!Number.isInteger(options.maxSessions) || options.maxSessions < 1) {
      throw new AppError('SSH_SESSION_LIMIT');
    }
    const detachGraceMs = options.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS;
    if (!Number.isInteger(detachGraceMs) || detachGraceMs < 1 || detachGraceMs > 5 * 60 * 1000) {
      throw new AppError('SSH_CONNECTION_FAILED');
    }
    const outputBufferBytes = options.outputBufferBytes ?? DEFAULT_OUTPUT_BUFFER_BYTES;
    if (!Number.isInteger(outputBufferBytes) || outputBufferBytes < 1 || outputBufferBytes > 10 * 1024 * 1024) {
      throw new AppError('SSH_CONNECTION_FAILED');
    }

    this.adapter = options.adapter;
    this.maxSessions = options.maxSessions;
    this.detachGraceMs = detachGraceMs;
    this.outputBufferLimit = outputBufferBytes;
  }

  async open(sessionId: string, config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshChannel> {
    if (this.sessions.has(sessionId)) {
      throw new AppError('SSH_CONNECTION_FAILED');
    }
    if (this.sessions.size + this.pendingConnections >= this.maxSessions) {
      throw new AppError('SSH_SESSION_LIMIT');
    }

    this.pendingConnections += 1;
    try {
      const channel = await this.adapter.connect(config, callbacks);
      const managed: ManagedSession = {
        id: sessionId,
        hostId: config.hostId,
        channel,
        detached: false,
        closed: false,
        outputBuffer: [],
        outputBufferBytes: 0
      };
      this.sessions.set(sessionId, managed);
      channel.on('data', (data) => this.appendOutput(managed, data));
      channel.on('stderr', (data) => this.appendOutput(managed, data));
      channel.on('close', () => this.release(sessionId, managed));
      return channel;
    } finally {
      this.pendingConnections -= 1;
    }
  }

  testConnection(
    config: SshConnectConfig,
    callbacks: SshConnectCallbacks
  ): Promise<{ ok: boolean; hostKey?: SshHostKeyChallenge }> {
    return this.adapter.testConnection(config, callbacks);
  }

  detach(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.closed) {
      return;
    }
    managed.detached = true;
    if (managed.timer) {
      clearTimeout(managed.timer);
    }
    managed.timer = setTimeout(() => this.close(sessionId), this.detachGraceMs);
    managed.timer.unref?.();
  }

  reattach(sessionId: string, expectedHostId?: string): SshChannel | null {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.closed || (expectedHostId !== undefined && managed.hostId !== expectedHostId)) {
      return null;
    }
    managed.detached = false;
    if (managed.timer) {
      clearTimeout(managed.timer);
      managed.timer = undefined;
    }
    return managed.channel;
  }

  getBufferedOutput(sessionId: string, expectedHostId?: string): Buffer | null {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.closed || (expectedHostId !== undefined && managed.hostId !== expectedHostId)) {
      return null;
    }
    return managed.outputBufferBytes === 0 ? Buffer.alloc(0) : Buffer.concat(managed.outputBuffer);
  }

  close(sessionId: string): void {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.closed) {
      return;
    }
    managed.closed = true;
    this.sessions.delete(sessionId);
    if (managed.timer) {
      clearTimeout(managed.timer);
      managed.timer = undefined;
    }
    managed.channel.close();
  }

  closeAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.close(sessionId);
    }
  }

  private release(sessionId: string, managed: ManagedSession): void {
    if (this.sessions.get(sessionId) !== managed) {
      return;
    }
    managed.closed = true;
    this.sessions.delete(sessionId);
    if (managed.timer) {
      clearTimeout(managed.timer);
      managed.timer = undefined;
    }
  }

  private appendOutput(managed: ManagedSession, data: Buffer): void {
    if (managed.closed || data.length === 0) return;

    const chunk = Buffer.from(data);
    if (chunk.length >= this.outputBufferLimit) {
      managed.outputBuffer = [chunk.subarray(chunk.length - this.outputBufferLimit)];
      managed.outputBufferBytes = this.outputBufferLimit;
      return;
    }

    managed.outputBuffer.push(chunk);
    managed.outputBufferBytes += chunk.length;
    while (managed.outputBufferBytes > this.outputBufferLimit) {
      const first = managed.outputBuffer[0];
      const excess = managed.outputBufferBytes - this.outputBufferLimit;
      if (first.length <= excess) {
        managed.outputBuffer.shift();
        managed.outputBufferBytes -= first.length;
      } else {
        managed.outputBuffer[0] = first.subarray(excess);
        managed.outputBufferBytes -= excess;
      }
    }
  }
}
