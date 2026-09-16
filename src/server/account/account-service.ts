import { randomUUID } from 'node:crypto';

import type { AccountDeletionState, AccountSession, ClientPlatform, DeviceDescriptor } from '../../shared/core/models.js';
import { ACCOUNT_DELETION_CONFIRMATION } from '../../shared/core/account-sync.js';
import { AppError } from '../../shared/errors.js';
import {
  ACCOUNT_PASSWORD_MAX_LENGTH,
  hashAccountPassword,
  verifyAccountPassword,
  verifyAccountPasswordOrDummy
} from './account-crypto.js';
import { AccountSessionStore, type AccountSessionRecord } from './account-session-store.js';
import { AccountRepository } from '../db/repositories.js';
import type { AccountDeletionRequestRow } from '../db/types.js';

const ACCOUNT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DEVICE_LABEL_MAX_LENGTH = 128;
const DEVICE_PLATFORM_LABELS: Record<ClientPlatform, string> = {
  web: 'Web browser',
  desktop: 'Desktop app',
  android: 'Android app'
};

export const ACCOUNT_DELETION_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export interface AccountDeviceInput {
  label?: string;
  platform: ClientPlatform;
}

export interface AccountServiceDependencies {
  accountRepository: AccountRepository;
  sessionStore: AccountSessionStore;
  now?: () => number;
}

export const normalizeAccountEmail = (email: string): string => {
  if (typeof email !== 'string') throw new AppError('ACCOUNT_EMAIL_INVALID');
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || !ACCOUNT_EMAIL.test(normalized)) {
    throw new AppError('ACCOUNT_EMAIL_INVALID');
  }
  return normalized;
};

const assertRegistrationPassword = (password: string): void => {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > ACCOUNT_PASSWORD_MAX_LENGTH
  ) {
    throw new AppError('ACCOUNT_PASSWORD_INVALID');
  }
};

const normalizeDevice = (device: AccountDeviceInput): { label: string; platform: ClientPlatform } => {
  if (
    typeof device !== 'object' ||
    device === null ||
    !Object.prototype.hasOwnProperty.call(DEVICE_PLATFORM_LABELS, device.platform)
  ) {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }

  if (device.label !== undefined && typeof device.label !== 'string') {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }
  const label = device.label?.trim() || DEVICE_PLATFORM_LABELS[device.platform];
  if (
    label.length === 0 ||
    label.length > DEVICE_LABEL_MAX_LENGTH ||
    [...label].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === '\u007f')
  ) {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }
  return { label, platform: device.platform };
};

const toAccountSession = (
  record: Pick<AccountSessionRecord, 'accountId' | 'deviceId' | 'expiresAt'>
): AccountSession => ({
  accountId: record.accountId,
  deviceId: record.deviceId,
  state: 'signed-in',
  expiresAt: new Date(record.expiresAt).toISOString()
});

const toAccountDeletionState = (request: AccountDeletionRequestRow, at: number): AccountDeletionState => ({
  kind: 'account',
  requestedAt: request.requestedAt,
  deleteAfter: request.deleteAfter,
  remainingMs: Math.max(0, Date.parse(request.deleteAfter) - at)
});

export class AccountService {
  private readonly accountRepository: AccountRepository;
  private readonly sessionStore: AccountSessionStore;
  private readonly clock: () => number;

  constructor(dependencies: AccountServiceDependencies) {
    this.accountRepository = dependencies.accountRepository;
    this.sessionStore = dependencies.sessionStore;
    this.clock = dependencies.now ?? Date.now;
  }

  async register(
    email: string,
    password: string,
    device: AccountDeviceInput
  ): Promise<AccountSession> {
    this.purgeExpiredDeletions();
    const normalizedEmail = normalizeAccountEmail(email);
    assertRegistrationPassword(password);
    const normalizedDevice = normalizeDevice(device);
    if (this.accountRepository.getAccountByEmail(normalizedEmail)) {
      throw new AppError('ACCOUNT_EXISTS');
    }

    const passwordHash = await hashAccountPassword(password);
    const accountId = randomUUID();
    const created = this.accountRepository.createAccountWithDevice(
      {
        id: accountId,
        email: normalizedEmail,
        passwordHash
      },
      {
        id: randomUUID(),
        accountId,
        label: normalizedDevice.label,
        platform: normalizedDevice.platform
      }
    );
    return toAccountSession({
      accountId: created.account.id,
      deviceId: created.device.id,
      expiresAt: this.sessionStore.sessionExpiresAt()
    });
  }

  async signIn(
    email: string,
    password: string,
    device: AccountDeviceInput
  ): Promise<AccountSession> {
    this.purgeExpiredDeletions();
    const normalizedEmail = normalizeAccountEmail(email);
    const normalizedDevice = normalizeDevice(device);
    const account = this.accountRepository.getAccountByEmail(normalizedEmail);
    const passwordMatches = await verifyAccountPasswordOrDummy(password, account?.passwordHash ?? null);
    if (!account || !passwordMatches) {
      throw new AppError('ACCOUNT_AUTH_FAILED');
    }

    const createdDevice = this.accountRepository.createDevice({
      id: randomUUID(),
      accountId: account.id,
      label: normalizedDevice.label,
      platform: normalizedDevice.platform
    });
    return toAccountSession({
      accountId: account.id,
      deviceId: createdDevice.id,
      expiresAt: this.sessionStore.sessionExpiresAt()
    });
  }

  /** Issue the opaque token for the HTTP cookie layer; never include it in an AccountSession DTO. */
  issueSessionToken(session: AccountSession): string {
    if (session.state !== 'signed-in') throw new AppError('ACCOUNT_SESSION_INVALID');
    const device = this.accountRepository.getDevice(session.accountId, session.deviceId);
    if (!device || device.revokedAt !== null) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    const token = this.sessionStore.create(session.accountId, session.deviceId);
    this.accountRepository.touchDevice(session.accountId, session.deviceId);
    return token;
  }

  status(sessionId: string): AccountSession | null {
    this.purgeExpiredDeletions();
    const record = this.sessionStore.get(sessionId);
    if (!record) return null;
    const device = this.accountRepository.getDevice(record.accountId, record.deviceId);
    if (!device || device.revokedAt !== null) {
      this.sessionStore.revoke(sessionId);
      return null;
    }
    this.accountRepository.touchDevice(record.accountId, record.deviceId);
    return toAccountSession(record);
  }

  async signOut(sessionId: string): Promise<void> {
    this.sessionStore.revoke(sessionId);
  }

  async reauthenticate(sessionId: string, password: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const account = this.accountRepository.getAccount(session.accountId);
    const valid = await verifyAccountPassword(password, account?.passwordHash ?? '');
    if (!account || !valid || !this.sessionStore.markReauthenticated(sessionId)) {
      throw new AppError('ACCOUNT_REAUTH_FAILED');
    }
  }

  assertReauthenticated(sessionId: string): AccountSessionRecord {
    const session = this.requireSession(sessionId);
    if (!this.sessionStore.isReauthenticated(sessionId)) {
      throw new AppError('ACCOUNT_REAUTH_REQUIRED');
    }
    return session;
  }

  clearReauthentication(sessionId: string): void {
    this.requireSession(sessionId);
    this.sessionStore.clearReauthentication(sessionId);
  }

  getDeletion(sessionId: string): AccountDeletionState | null {
    const session = this.requireSession(sessionId);
    const request = this.accountRepository.getAccountDeletionRequest(session.accountId);
    return request ? toAccountDeletionState(request, this.clock()) : null;
  }

  requestDeletion(sessionId: string, confirmDelete: string): AccountDeletionState {
    const session = this.assertReauthenticated(sessionId);
    if (confirmDelete !== ACCOUNT_DELETION_CONFIRMATION) {
      throw new AppError('ACCOUNT_DELETION_CONFIRMATION_REQUIRED');
    }
    if (this.accountRepository.getAccountDeletionRequest(session.accountId)) {
      throw new AppError('ACCOUNT_DELETION_PENDING');
    }
    const requestedAt = new Date(this.clock()).toISOString();
    const request = this.accountRepository.requestAccountDeletion(
      session.accountId,
      new Date(this.clock() + ACCOUNT_DELETION_GRACE_MS).toISOString(),
      requestedAt
    );
    // The database transaction above is the source of truth. Only after it
    // succeeds do we revoke the in-memory sessions and make the cookie stale.
    this.sessionStore.revokeAccount(session.accountId);
    return toAccountDeletionState(request, this.clock());
  }

  restoreDeletion(sessionId: string): void {
    const session = this.assertReauthenticated(sessionId);
    const request = this.accountRepository.getAccountDeletionRequest(session.accountId);
    if (!request) throw new AppError('ACCOUNT_DELETION_NOT_PENDING');
    if (Date.parse(request.deleteAfter) <= this.clock()) {
      this.purgeExpiredDeletions();
      throw new AppError('ACCOUNT_DELETION_NOT_PENDING');
    }
    this.accountRepository.restoreAccountDeletion(session.accountId, new Date(this.clock()).toISOString());
    this.sessionStore.clearReauthentication(sessionId);
  }

  isDeletionPending(accountId: string): boolean {
    this.purgeExpiredDeletions();
    return this.accountRepository.getAccountDeletionRequest(accountId) !== null;
  }

  purgeExpiredDeletions(): readonly string[] {
    const purged = this.accountRepository.purgeExpiredAccountDeletions(new Date(this.clock()).toISOString());
    for (const accountId of purged) this.sessionStore.revokeAccount(accountId);
    return purged;
  }

  async listDevices(sessionId: string): Promise<readonly DeviceDescriptor[]> {
    const session = this.requireSession(sessionId);
    return this.accountRepository.listDevices(session.accountId).map((device) => ({
      id: device.id,
      label: device.label,
      platform: device.platform,
      lastSeenAt: device.lastSeenAt,
      current: device.id === session.deviceId,
      revokedAt: device.revokedAt
    }));
  }

  async revokeDevice(sessionId: string, deviceId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    const device = this.accountRepository.getDevice(session.accountId, deviceId);
    if (!device || device.revokedAt !== null) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    if (!this.accountRepository.revokeDevice(session.accountId, deviceId)) {
      throw new AppError('ACCOUNT_DEVICE_REVOKED');
    }
    this.sessionStore.revokeDevice(session.accountId, deviceId);
  }

  private requireSession(sessionId: string): AccountSessionRecord {
    const record = this.sessionStore.get(sessionId);
    if (!record) throw new AppError('ACCOUNT_SESSION_INVALID');
    const device = this.accountRepository.getDevice(record.accountId, record.deviceId);
    if (!device || device.revokedAt !== null) {
      this.sessionStore.revoke(sessionId);
      throw new AppError('ACCOUNT_SESSION_INVALID');
    }
    this.accountRepository.touchDevice(record.accountId, record.deviceId);
    return record;
  }
}
