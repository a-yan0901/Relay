import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { AccountSession, ClientPlatform } from '../shared/core/models.js';
import type { CloudDeviceDescriptor } from '../shared/cloud/protocol.js';
import { AppError } from '../shared/errors.js';
import {
  ACCOUNT_PASSWORD_MAX_LENGTH,
  hashAccountPassword,
  verifyAccountPasswordOrDummy
} from '../server/account/account-crypto.js';
import type {
  CloudAccountRecord,
  CloudDeviceRecord,
  CloudSessionRecord,
  CreateCloudAccountInput,
  CreateCloudDeviceInput
} from './account-repository.js';

const ACCOUNT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const DEVICE_LABEL_MAX_LENGTH = 128;
const TOKEN_BYTES = 32;
const TOKEN_MIN_LENGTH = 43;

export interface CloudAuthRepositoryPort {
  getAccountByEmail(email: string): Promise<CloudAccountRecord | null>;
  createAccountWithDevice(account: CreateCloudAccountInput, device: CreateCloudDeviceInput): Promise<void>;
  createDevice(input: CreateCloudDeviceInput): Promise<void>;
  getDevice(accountId: string, deviceId: string): Promise<CloudDeviceRecord | null>;
  createSession(input: { tokenHash: string; accountId: string; deviceId: string; createdAt: string; expiresAt: string }): Promise<void>;
  getSession(tokenHash: string): Promise<CloudSessionRecord | null>;
  touchSession(tokenHash: string, at: string): Promise<void>;
  revokeSession(tokenHash: string, at: string): Promise<void>;
  revokeDevice(accountId: string, deviceId: string, at: string): Promise<boolean>;
  revokeDeviceSessions(accountId: string, deviceId: string, at: string): Promise<void>;
  trustDevice?(accountId: string, deviceId: string, at: string): Promise<boolean>;
  listDeviceDescriptors(accountId: string, currentDeviceId: string): Promise<readonly CloudDeviceDescriptor[]>;
}

export interface CloudAuthDeviceInput {
  platform: ClientPlatform;
  label?: string;
  publicKey?: string | null;
}

export interface CloudAuthResult {
  account: AccountSession;
  token: string;
}

export interface CloudAuthSessionConfig {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

export interface CloudDeviceCreatedHook {
  onDeviceCreated(accountId: string, deviceId: string, deviceLabel: string, at: string): Promise<void>;
}

export const normalizeCloudEmail = (email: string): string => {
  if (typeof email !== 'string') throw new AppError('ACCOUNT_EMAIL_INVALID');
  const normalized = email.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 320 || !ACCOUNT_EMAIL.test(normalized)) {
    throw new AppError('ACCOUNT_EMAIL_INVALID');
  }
  return normalized;
};

const normalizeDevice = (input: CloudAuthDeviceInput): { platform: ClientPlatform; label: string; publicKey: string | null } => {
  if (input === null || typeof input !== 'object' || !['web', 'desktop', 'android'].includes(input.platform)) {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }
  const fallback = input.platform === 'web' ? 'Web browser' : input.platform === 'desktop' ? 'Desktop app' : 'Android app';
  const label = input.label?.trim() || fallback;
  if (
    label.length === 0 ||
    label.length > DEVICE_LABEL_MAX_LENGTH ||
    [...label].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === '\u007f')
  ) {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }
  if (input.publicKey !== undefined && input.publicKey !== null && typeof input.publicKey !== 'string') {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }
  return { platform: input.platform, label, publicKey: input.publicKey ?? null };
};

const assertRegistrationPassword = (password: string): void => {
  if (typeof password !== 'string' || password.length < 8 || password.length > ACCOUNT_PASSWORD_MAX_LENGTH) {
    throw new AppError('ACCOUNT_PASSWORD_INVALID');
  }
};

const hashToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

const toSession = (record: Pick<CloudSessionRecord, 'accountId' | 'deviceId' | 'expiresAt'>, trusted?: boolean): AccountSession => ({
  accountId: record.accountId,
  deviceId: record.deviceId,
  state: 'signed-in',
  expiresAt: new Date(record.expiresAt).toISOString(),
  ...(trusted === undefined ? {} : { trusted })
});

export class CloudAuthService {
  constructor(
    private readonly repository: CloudAuthRepositoryPort,
    private readonly sessionConfig: CloudAuthSessionConfig,
    private readonly clock: () => number = Date.now,
    private readonly deviceCreatedHook?: CloudDeviceCreatedHook
  ) {}

  async register(email: string, password: string, input: CloudAuthDeviceInput): Promise<CloudAuthResult> {
    const normalizedEmail = normalizeCloudEmail(email);
    assertRegistrationPassword(password);
    const device = normalizeDevice(input);
    if (await this.repository.getAccountByEmail(normalizedEmail)) throw new AppError('ACCOUNT_EXISTS');

    const now = new Date(this.clock()).toISOString();
    const accountId = randomUUID();
    const deviceId = randomUUID();
    await this.repository.createAccountWithDevice(
      { id: accountId, email: normalizedEmail, passwordHash: await hashAccountPassword(password), createdAt: now },
      { id: deviceId, accountId, label: device.label, platform: device.platform, publicKey: device.publicKey, trustedAt: now, createdAt: now }
    );
    await this.deviceCreatedHook?.onDeviceCreated(accountId, deviceId, device.label, now);
    return this.issueSession(accountId, deviceId, now, true);
  }

  async signIn(email: string, password: string, input: CloudAuthDeviceInput): Promise<CloudAuthResult> {
    const normalizedEmail = normalizeCloudEmail(email);
    const device = normalizeDevice(input);
    const account = await this.repository.getAccountByEmail(normalizedEmail);
    const passwordMatches = await verifyAccountPasswordOrDummy(password, account?.passwordHash ?? null);
    if (!account || !passwordMatches) throw new AppError('ACCOUNT_AUTH_FAILED');

    const now = new Date(this.clock()).toISOString();
    const deviceId = randomUUID();
    await this.repository.createDevice({
      id: deviceId,
      accountId: account.id,
      label: device.label,
      platform: device.platform,
      publicKey: device.publicKey,
      trustedAt: null,
      createdAt: now
    });
    await this.deviceCreatedHook?.onDeviceCreated(account.id, deviceId, device.label, now);
    return this.issueSession(account.id, deviceId, now, false);
  }

  async authenticate(token: string): Promise<AccountSession> {
    if (typeof token !== 'string' || token.length < TOKEN_MIN_LENGTH || token.length > 128) {
      throw new AppError('ACCOUNT_SESSION_INVALID');
    }
    const tokenHash = hashToken(token);
    const session = await this.repository.getSession(tokenHash);
    const now = this.clock();
    if (!session || session.revokedAt !== null || Date.parse(session.expiresAt) <= now || now - Date.parse(session.lastUsedAt) >= this.sessionConfig.idleTimeoutMs) {
      throw new AppError('ACCOUNT_SESSION_INVALID');
    }
    const device = await this.repository.getDevice(session.accountId, session.deviceId);
    if (!device || device.revokedAt !== null) {
      await this.repository.revokeSession(tokenHash, new Date(now).toISOString());
      throw new AppError('ACCOUNT_SESSION_INVALID');
    }
    await this.repository.touchSession(tokenHash, new Date(now).toISOString());
    return toSession(session, device.trustedAt !== null);
  }

  async signOut(token: string): Promise<void> {
    if (typeof token !== 'string' || token.length < TOKEN_MIN_LENGTH) return;
    await this.repository.revokeSession(hashToken(token), new Date(this.clock()).toISOString());
  }

  async listDevices(token: string): Promise<readonly CloudDeviceDescriptor[]> {
    const session = await this.authenticate(token);
    return this.repository.listDeviceDescriptors(session.accountId, session.deviceId);
  }

  async revokeDevice(token: string, deviceId: string): Promise<void> {
    const session = await this.authenticate(token);
    const device = await this.repository.getDevice(session.accountId, deviceId);
    if (!device || device.revokedAt !== null) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    const now = new Date(this.clock()).toISOString();
    // Revoke the device before invalidating its sessions so a concurrent
    // request cannot create another usable session for the revoked device.
    const revoked = await this.repository.revokeDevice(session.accountId, deviceId, now);
    if (!revoked) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    await this.repository.revokeDeviceSessions(session.accountId, deviceId, now);
  }

  async trustDevice(token: string, deviceId: string): Promise<void> {
    const session = await this.authenticate(token);
    if (session.trusted !== true) throw new AppError('ACCOUNT_DEVICE_TRUST_REQUIRED');
    const device = await this.repository.getDevice(session.accountId, deviceId);
    if (!device || device.revokedAt !== null) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    if (device.trustedAt !== null) return;
    if (!this.repository.trustDevice || !(await this.repository.trustDevice(session.accountId, deviceId, new Date(this.clock()).toISOString()))) {
      throw new AppError('ACCOUNT_DEVICE_REVOKED');
    }
  }

  private async issueSession(accountId: string, deviceId: string, createdAt: string, trusted: boolean): Promise<CloudAuthResult> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = new Date(this.clock() + this.sessionConfig.absoluteTimeoutMs).toISOString();
    await this.repository.createSession({ tokenHash: hashToken(token), accountId, deviceId, createdAt, expiresAt });
    return { account: { accountId, deviceId, state: 'signed-in', expiresAt, trusted }, token };
  }
}
