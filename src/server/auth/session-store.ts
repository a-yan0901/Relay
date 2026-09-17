import { randomBytes } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import { VAULT_KEY_LENGTH } from '../vault/types.js';
import { DEFAULT_OWNER_ID } from './owner-context.js';

export interface SessionStoreOptions {
  idleTimeoutMs?: number;
  now?: () => number;
}

export interface SessionRecord {
  id: string;
  ownerId: string;
  vaultKey: Buffer;
  createdAt: number;
  lastUsedAt: number;
  activeConnections: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

export class SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly idleTimeoutMs: number;
  private readonly clock: () => number;

  constructor(options: SessionStoreOptions = {}) {
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1 || idleTimeoutMs > 24 * 60 * 60 * 1000) {
      throw new AppError('SESSION_INVALID');
    }

    this.idleTimeoutMs = idleTimeoutMs;
    this.clock = options.now ?? Date.now;
  }

  create(vaultKey: Buffer, ownerId = DEFAULT_OWNER_ID): string {
    if (!Buffer.isBuffer(vaultKey) || vaultKey.length !== VAULT_KEY_LENGTH) {
      throw new AppError('VAULT_CRYPTO_FAILED');
    }

    let id: string;
    do {
      id = randomBytes(32).toString('base64url');
    } while (this.sessions.has(id));

    const timestamp = this.clock();
    this.sessions.set(id, {
      id,
      ownerId,
      vaultKey,
      createdAt: timestamp,
      lastUsedAt: timestamp,
      activeConnections: 0
    });
    return id;
  }

  get(id: string, at = this.clock()): SessionRecord | null {
    const session = this.sessions.get(id);
    if (!session) {
      return null;
    }

    if (at - session.lastUsedAt >= this.idleTimeoutMs) {
      this.revoke(id);
      return null;
    }

    session.lastUsedAt = at;
    return session;
  }

  revoke(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }

    session.vaultKey.fill(0);
    this.sessions.delete(id);
    return true;
  }

  /** Bind an existing local vault session to the signed-in account once. */
  bindOwner(id: string, ownerId: string): boolean {
    const session = this.sessions.get(id);
    if (!session || typeof ownerId !== 'string' || ownerId.length === 0) return false;
    if (session.ownerId !== DEFAULT_OWNER_ID && session.ownerId !== ownerId) return false;
    session.ownerId = ownerId;
    return true;
  }

  revokeAll(): number {
    let revoked = 0;
    for (const id of this.sessions.keys()) {
      if (this.revoke(id)) {
        revoked += 1;
      }
    }
    return revoked;
  }

  sweep(at = this.clock()): number {
    let swept = 0;
    for (const [id, session] of this.sessions) {
      if (at - session.lastUsedAt >= this.idleTimeoutMs && this.revoke(id)) {
        swept += 1;
      }
    }
    return swept;
  }

  addConnection(id: string): boolean {
    const session = this.get(id);
    if (!session) {
      return false;
    }

    session.activeConnections += 1;
    return true;
  }

  removeConnection(id: string): boolean {
    const session = this.get(id);
    if (!session) {
      return false;
    }

    session.activeConnections = Math.max(0, session.activeConnections - 1);
    return true;
  }

  get size(): number {
    return this.sessions.size;
  }
}
