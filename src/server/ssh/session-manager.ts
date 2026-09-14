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
}

interface ManagedSession {
  id: string;
  channel: SshChannel;
  detached: boolean;
  timer?: ReturnType<typeof setTimeout>;
  closed: boolean;
}

const DEFAULT_DETACH_GRACE_MS = 30_000;

export class SshSessionManager implements SshSessionManagerPort {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly adapter: SshAdapterPort;
  private readonly maxSessions: number;
  private readonly detachGraceMs: number;
  private pendingConnections = 0;

  constructor(options: SshSessionManagerOptions) {
    if (!Number.isInteger(options.maxSessions) || options.maxSessions < 1) {
      throw new AppError('SSH_SESSION_LIMIT');
    }
    const detachGraceMs = options.detachGraceMs ?? DEFAULT_DETACH_GRACE_MS;
    if (!Number.isInteger(detachGraceMs) || detachGraceMs < 1 || detachGraceMs > 5 * 60 * 1000) {
      throw new AppError('SSH_CONNECTION_FAILED');
    }

    this.adapter = options.adapter;
    this.maxSessions = options.maxSessions;
    this.detachGraceMs = detachGraceMs;
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
        channel,
        detached: false,
        closed: false
      };
      this.sessions.set(sessionId, managed);
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

  reattach(sessionId: string): SshChannel | null {
    const managed = this.sessions.get(sessionId);
    if (!managed || managed.closed) {
      return null;
    }
    managed.detached = false;
    if (managed.timer) {
      clearTimeout(managed.timer);
      managed.timer = undefined;
    }
    return managed.channel;
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
}
