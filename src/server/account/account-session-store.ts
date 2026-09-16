import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '../../shared/errors.js';

export interface AccountSessionRecord {
  id: string;
  accountId: string;
  deviceId: string;
  expiresAt: number;
  lastUsedAt: number;
}

export interface AccountSessionStoreOptions {
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  now?: () => number;
}

interface StoredAccountSession {
  record: AccountSessionRecord;
  createdAt: number;
  reauthenticatedAt: number | null;
}

const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;
const MAX_SESSION_ID_LENGTH = 128;
export const ACCOUNT_REAUTH_TTL_MS = 10 * 60 * 1000;

const assertReference = (value: string): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SESSION_ID_LENGTH ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === '\u007f')
  ) {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }
};

const hashToken = (token: string): string | null => {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) return null;
  return createHash('sha256').update(token, 'utf8').digest('hex');
};

export class AccountSessionStore {
  private readonly sessions = new Map<string, StoredAccountSession>();
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly clock: () => number;

  constructor(options: AccountSessionStoreOptions = {}) {
    const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const absoluteTimeoutMs = options.absoluteTimeoutMs ?? DEFAULT_ABSOLUTE_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(idleTimeoutMs) ||
      idleTimeoutMs < 60_000 ||
      idleTimeoutMs > DEFAULT_ABSOLUTE_TIMEOUT_MS ||
      !Number.isSafeInteger(absoluteTimeoutMs) ||
      absoluteTimeoutMs < idleTimeoutMs ||
      absoluteTimeoutMs > 365 * 24 * 60 * 60 * 1000
    ) {
      throw new AppError('ACCOUNT_SESSION_INVALID');
    }

    this.idleTimeoutMs = idleTimeoutMs;
    this.absoluteTimeoutMs = absoluteTimeoutMs;
    this.clock = options.now ?? Date.now;
  }

  create(accountId: string, deviceId: string, at = this.clock()): string {
    assertReference(accountId);
    assertReference(deviceId);
    if (!Number.isSafeInteger(at)) throw new AppError('ACCOUNT_SESSION_INVALID');

    let token: string;
    let tokenHash: string;
    do {
      token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
      tokenHash = hashToken(token)!;
    } while (this.sessions.has(tokenHash));

    this.sessions.set(tokenHash, {
      record: {
        id: tokenHash,
        accountId,
        deviceId,
        expiresAt: at + this.absoluteTimeoutMs,
        lastUsedAt: at
      },
      createdAt: at,
      reauthenticatedAt: null
    });
    return token;
  }

  get(token: string, at = this.clock()): AccountSessionRecord | null {
    const tokenHash = hashToken(token);
    if (!tokenHash || !Number.isSafeInteger(at)) return null;
    const stored = this.sessions.get(tokenHash);
    if (!stored) return null;

    if (this.isExpired(stored, at)) {
      this.sessions.delete(tokenHash);
      return null;
    }

    stored.record.lastUsedAt = at;
    return { ...stored.record };
  }

  revoke(token: string): boolean {
    const tokenHash = hashToken(token);
    return tokenHash !== null && this.sessions.delete(tokenHash);
  }

  revokeDevice(accountId: string, deviceId: string): number {
    assertReference(accountId);
    assertReference(deviceId);
    let revoked = 0;
    for (const [tokenHash, stored] of this.sessions) {
      if (stored.record.accountId === accountId && stored.record.deviceId === deviceId) {
        this.sessions.delete(tokenHash);
        revoked += 1;
      }
    }
    return revoked;
  }

  revokeAccount(accountId: string): number {
    assertReference(accountId);
    let revoked = 0;
    for (const [tokenHash, stored] of this.sessions) {
      if (stored.record.accountId === accountId) {
        this.sessions.delete(tokenHash);
        revoked += 1;
      }
    }
    return revoked;
  }

  markReauthenticated(token: string, at = this.clock()): boolean {
    const tokenHash = hashToken(token);
    if (!tokenHash || !Number.isSafeInteger(at)) return false;
    const stored = this.sessions.get(tokenHash);
    if (!stored || this.isExpired(stored, at)) {
      if (stored) this.sessions.delete(tokenHash);
      return false;
    }
    stored.record.lastUsedAt = at;
    stored.reauthenticatedAt = at;
    return true;
  }

  isReauthenticated(token: string, at = this.clock()): boolean {
    const tokenHash = hashToken(token);
    if (!tokenHash || !Number.isSafeInteger(at)) return false;
    const stored = this.sessions.get(tokenHash);
    if (!stored || this.isExpired(stored, at)) {
      if (stored) this.sessions.delete(tokenHash);
      return false;
    }
    if (stored.reauthenticatedAt === null || at - stored.reauthenticatedAt >= ACCOUNT_REAUTH_TTL_MS) {
      stored.reauthenticatedAt = null;
      return false;
    }
    return true;
  }

  sweep(at = this.clock()): number {
    if (!Number.isSafeInteger(at)) return 0;
    let swept = 0;
    for (const [tokenHash, stored] of this.sessions) {
      if (this.isExpired(stored, at)) {
        this.sessions.delete(tokenHash);
        swept += 1;
      }
    }
    return swept;
  }

  sessionExpiresAt(at = this.clock()): number {
    if (!Number.isSafeInteger(at)) throw new AppError('ACCOUNT_SESSION_INVALID');
    return at + this.absoluteTimeoutMs;
  }

  get size(): number {
    return this.sessions.size;
  }

  private isExpired(stored: StoredAccountSession, at: number): boolean {
    return at >= stored.record.expiresAt || at - stored.record.lastUsedAt >= this.idleTimeoutMs;
  }
}
