import { describe, expect, it } from 'vitest';

import {
  accountSyncCapabilities,
  describeAccountSyncState,
  isSafeSyncEnvelopeMetadata
} from '../../../src/shared/core/account-sync.js';
import type { AccountSession, SyncEnvelope } from '../../../src/shared/core/models.js';
import { createInMemoryCoreRuntime } from '../../fixtures/native-runtime.js';

describe('account and sync shared contract', () => {
  it('keeps signed-out users in a fully usable Local-only state', () => {
    expect(describeAccountSyncState('signed-out', 'local-only')).toEqual({
      label: '仅本地，不同步',
      nextAction: 'sign-in'
    });
  });

  it('requires Vault unlock before a signed-in device can sync', () => {
    expect(describeAccountSyncState('signed-in', 'needs-unlock')).toEqual({
      label: '账号已登录，请先解锁 Vault',
      nextAction: 'unlock-vault'
    });
  });

  it('does not present a revoked device as a recoverable sync state', () => {
    expect(describeAccountSyncState('revoked', 'device-revoked')).toEqual({
      label: '设备已撤销，仅保留本地数据',
      nextAction: 'use-local'
    });
  });

  it('advertises account capabilities only when the optional service is enabled', () => {
    expect(accountSyncCapabilities(false)).toEqual([]);
    expect(accountSyncCapabilities(true)).toEqual([
      'account.auth',
      'device.trust',
      'sync.encrypted'
    ]);
  });

  it('accepts only opaque sync envelope metadata and rejects secret fields', () => {
    const envelope: SyncEnvelope = {
      schemaVersion: 1,
      vaultId: 'vault-1',
      revision: 1,
      parentRevision: null,
      deviceId: 'device-1',
      keyVersion: 1,
      nonce: 'nonce',
      ciphertext: 'ciphertext',
      authTag: 'auth-tag',
      aad: 'aad',
      payloadHash: 'hash',
      byteLength: 128
    };
    const account: AccountSession = {
      accountId: 'account-1',
      deviceId: 'device-1',
      state: 'signed-in',
      expiresAt: new Date().toISOString()
    };

    expect(isSafeSyncEnvelopeMetadata(envelope)).toBe(true);
    expect(isSafeSyncEnvelopeMetadata(account)).toBe(false);
    expect(isSafeSyncEnvelopeMetadata({ ...envelope, password: 'master password' })).toBe(false);
    expect(isSafeSyncEnvelopeMetadata({ ...envelope, privateKey: 'secret key' })).toBe(false);
  });

  it('keeps account and sync ports optional for an existing native-like Local runtime', () => {
    const runtime = createInMemoryCoreRuntime('desktop');
    expect(runtime.account).toBeUndefined();
    expect(runtime.devices).toBeUndefined();
    expect(runtime.sync).toBeUndefined();
    expect(runtime.vault).toBeDefined();
    expect(runtime.sessions).toBeDefined();
  });
});
