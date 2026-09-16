import { randomUUID } from 'node:crypto';

import type { AccountSession, ClientPlatform, DeviceDescriptor } from '../../shared/core/models.js';
import { AppError } from '../../shared/errors.js';
import {
  ACCOUNT_PASSWORD_MAX_LENGTH,
  hashAccountPassword,
  verifyAccountPasswordOrDummy
} from './account-crypto.js';
import { AccountSessionStore, type AccountSessionRecord } from './account-session-store.js';
import { AccountRepository } from '../db/repositories.js';

const ACCOUNT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DEVICE_LABEL_MAX_LENGTH = 128;
const DEVICE_PLATFORM_LABELS: Record<ClientPlatform, string> = {
  web: 'Web browser',
  desktop: 'Desktop app',
  android: 'Android app'
};

export interface AccountDeviceInput {
  label?: string;
  platform: ClientPlatform;
}

export interface AccountServiceDependencies {
  accountRepository: AccountRepository;
  sessionStore: AccountSessionStore;
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

export class AccountService {
  private readonly accountRepository: AccountRepository;
  private readonly sessionStore: AccountSessionStore;

  constructor(dependencies: AccountServiceDependencies) {
    this.accountRepository = dependencies.accountRepository;
    this.sessionStore = dependencies.sessionStore;
  }

  async register(
    email: string,
    password: string,
    device: AccountDeviceInput
  ): Promise<AccountSession> {
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
