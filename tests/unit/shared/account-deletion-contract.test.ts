import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_DELETION_CONFIRMATION,
  CLOUD_SYNC_DELETION_CONFIRMATION
} from '../../../src/shared/core/account-sync.js';
import type { AccountDeletionState, SyncDeletionState } from '../../../src/shared/core/models.js';
import { APP_ERROR_CODES, AppError } from '../../../src/shared/errors.js';

const requestedAt = '2026-09-17T00:00:00.000Z';
const deleteAfter = '2026-10-17T00:00:00.000Z';

describe('account deletion shared contract', () => {
  it('keeps account and cloud confirmations distinct', () => {
    expect(ACCOUNT_DELETION_CONFIRMATION).toBe('DELETE MY ACCOUNT');
    expect(CLOUD_SYNC_DELETION_CONFIRMATION).toBe('DELETE MY CLOUD VAULT');
    expect(ACCOUNT_DELETION_CONFIRMATION).not.toBe(CLOUD_SYNC_DELETION_CONFIRMATION);
  });

  it('models redacted pending state without credentials or session tokens', () => {
    const accountDeletion: AccountDeletionState = {
      kind: 'account',
      requestedAt,
      deleteAfter,
      remainingMs: 2_592_000_000
    };
    const cloudDeletion: SyncDeletionState = {
      kind: 'cloud-sync',
      requestedAt,
      deleteAfter,
      remainingMs: 2_592_000_000
    };

    expect(accountDeletion).toEqual(expect.objectContaining({ kind: 'account', requestedAt, deleteAfter }));
    expect(cloudDeletion).toEqual(expect.objectContaining({ kind: 'cloud-sync', requestedAt, deleteAfter }));
    expect(JSON.stringify({ accountDeletion, cloudDeletion })).not.toMatch(/password|token|secret|privateKey/iu);
  });

  it('assigns stable status codes to the deletion security errors', () => {
    expect(APP_ERROR_CODES).toEqual(expect.arrayContaining([
      'ACCOUNT_REAUTH_FAILED',
      'ACCOUNT_REAUTH_REQUIRED',
      'ACCOUNT_DELETION_CONFIRMATION_REQUIRED',
      'ACCOUNT_DELETION_PENDING',
      'ACCOUNT_DELETION_NOT_PENDING',
      'SYNC_DELETE_PENDING'
    ]));
    expect(new AppError('ACCOUNT_REAUTH_FAILED').statusCode).toBe(401);
    expect(new AppError('ACCOUNT_REAUTH_REQUIRED').statusCode).toBe(401);
    expect(new AppError('ACCOUNT_DELETION_CONFIRMATION_REQUIRED').statusCode).toBe(400);
    expect(new AppError('ACCOUNT_DELETION_PENDING').statusCode).toBe(409);
    expect(new AppError('ACCOUNT_DELETION_NOT_PENDING').statusCode).toBe(409);
    expect(new AppError('SYNC_DELETE_PENDING').statusCode).toBe(409);
  });
});
