import { randomBytes } from 'node:crypto';

import type { AccountSession } from '../../shared/core/models.js';
import type { CloudDeviceKeyPair } from '../../shared/cloud/key-crypto.js';
import { AppError } from '../../shared/errors.js';

export interface CloudSessionSyncCursor {
  remoteRevision: number;
  remotePayloadHash: string;
  localPayloadHash: string;
}

export interface CloudBrowserSession {
  token: string;
  account: AccountSession;
  deviceKeyPair?: CloudDeviceKeyPair;
  cloudSyncCursor?: CloudSessionSyncCursor | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  lastUsedAt: number;
}

export interface CloudBrowserSessionStoreOptions {
  maxSessions?: number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_ID_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/u;

const assertPositiveInteger = (value: number, message: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new AppError('ACCOUNT_SESSION_INVALID', message);
};

const assertSessionId = (value: string): void => {
  if (typeof value !== 'string' || !TOKEN_PATTERN.test(value)) throw new AppError('ACCOUNT_SESSION_INVALID');
};

const assertSyncCursor = (value: CloudSessionSyncCursor | null): void => {
  if (value === null) return;
  if (!Number.isSafeInteger(value.remoteRevision) || value.remoteRevision < 1 || value.remoteRevision > 1_000_000_000 || !/^[a-f0-9]{64}$/u.test(value.remotePayloadHash) || !/^[a-f0-9]{64}$/u.test(value.localPayloadHash)) {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }
};

const assertAccount = (account: AccountSession): void => {
  if (
    account === null ||
    typeof account !== 'object' ||
    typeof account.accountId !== 'string' ||
    typeof account.deviceId !== 'string' ||
    account.state !== 'signed-in' && account.state !== 'revoked' ||
    typeof account.expiresAt !== 'string'
  ) throw new AppError('ACCOUNT_SESSION_INVALID');
};

/**
 * Stores cloud bearer tokens behind an HttpOnly browser cookie reference.
 * This is intentionally process-local and bounded: a web restart requires
 * cloud re-authentication instead of persisting a bearer token in SQLite.
 */
export class CloudBrowserSessionStore {
  private readonly sessions = new Map<string, CloudBrowserSession>();
  private readonly maxSessions: number;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly clock: () => number;

  constructor(options: CloudBrowserSessionStoreOptions = {}) {
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const absoluteTimeoutMs = options.absoluteTimeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS;
    assertPositiveInteger(maxSessions, 'invalid cloud session capacity');
    assertPositiveInteger(idleTimeoutMs, 'invalid cloud session idle timeout');
    assertPositiveInteger(absoluteTimeoutMs, 'invalid cloud session absolute timeout');
    if (maxSessions > 4_096 || idleTimeoutMs > absoluteTimeoutMs || absoluteTimeoutMs > 365 * 24 * 60 * 60 * 1_000) {
      throw new AppError('ACCOUNT_SESSION_INVALID');
    }
    this.maxSessions = maxSessions;
    this.idleTimeoutMs = idleTimeoutMs;
    this.absoluteTimeoutMs = absoluteTimeoutMs;
    this.clock = options.now ?? Date.now;
  }

  create(token: string, account: AccountSession, at = this.clock(), deviceKeyPair?: CloudDeviceKeyPair): string {
    if (!TOKEN_PATTERN.test(token) || !Number.isSafeInteger(at)) throw new AppError('ACCOUNT_SESSION_INVALID');
    assertAccount(account);
    this.sweep(at);
    while (this.sessions.size >= this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.sessions.delete(oldest);
    }

    let id: string;
    do {
      id = randomBytes(SESSION_ID_BYTES).toString('base64url');
    } while (this.sessions.has(id));
    this.sessions.set(id, {
      token,
      account: { ...account },
      ...(deviceKeyPair === undefined ? {} : { deviceKeyPair: { ...deviceKeyPair } }),
      cloudSyncCursor: null,
      createdAt: at,
      expiresAt: at + this.absoluteTimeoutMs,
      lastUsedAt: at
    });
    return id;
  }

  get(id: string, at = this.clock()): CloudBrowserSession | null {
    assertSessionId(id);
    if (!Number.isSafeInteger(at)) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (at >= session.expiresAt || at - session.lastUsedAt >= this.idleTimeoutMs) {
      this.sessions.delete(id);
      return null;
    }
    session.lastUsedAt = at;
    return {
      ...session,
      account: { ...session.account },
      ...(session.deviceKeyPair === undefined ? {} : { deviceKeyPair: { ...session.deviceKeyPair } }),
      cloudSyncCursor: session.cloudSyncCursor === undefined || session.cloudSyncCursor === null ? session.cloudSyncCursor ?? null : { ...session.cloudSyncCursor }
    };
  }

  setCloudSyncCursor(id: string, cursor: CloudSessionSyncCursor | null): void {
    assertSessionId(id);
    assertSyncCursor(cursor);
    const session = this.sessions.get(id);
    if (!session) throw new AppError('ACCOUNT_SESSION_INVALID');
    session.cloudSyncCursor = cursor === null ? null : { ...cursor };
    session.lastUsedAt = this.clock();
  }

  replace(id: string, token: string, account: AccountSession, at = this.clock()): void {
    if (!TOKEN_PATTERN.test(token) || !Number.isSafeInteger(at)) throw new AppError('ACCOUNT_SESSION_INVALID');
    assertAccount(account);
    assertSessionId(id);
    const session = this.sessions.get(id);
    if (!session || at >= session.expiresAt || at - session.lastUsedAt >= this.idleTimeoutMs) {
      if (session) this.sessions.delete(id);
      throw new AppError('ACCOUNT_SESSION_INVALID');
    }
    session.token = token;
    session.account = { ...account };
    session.lastUsedAt = at;
  }

  revoke(id: string): boolean {
    assertSessionId(id);
    return this.sessions.delete(id);
  }

  sweep(at = this.clock()): number {
    if (!Number.isSafeInteger(at)) return 0;
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (at >= session.expiresAt || at - session.lastUsedAt >= this.idleTimeoutMs) {
        this.sessions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  get size(): number {
    return this.sessions.size;
  }
}
