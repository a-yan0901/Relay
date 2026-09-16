import type { AccountState, Capability, SyncEnvelope, SyncStatus } from './models.js';

export type AccountSyncNextAction = 'sign-in' | 'unlock-vault' | 'retry' | 'resolve-conflict' | 'use-local' | 'none';

export interface AccountSyncStateDescription {
  label: string;
  nextAction: AccountSyncNextAction;
}

const ACCOUNT_SYNC_CAPABILITIES: readonly Capability[] = [
  'account.auth',
  'device.trust',
  'sync.encrypted'
];

export const accountSyncCapabilities = (enabled: boolean): readonly Capability[] => (
  enabled ? [...ACCOUNT_SYNC_CAPABILITIES] : []
);

export const describeAccountSyncState = (
  account: AccountState,
  sync: SyncStatus
): AccountSyncStateDescription => {
  if (account === 'revoked' || sync === 'device-revoked') {
    return { label: '设备已撤销，仅保留本地数据', nextAction: 'use-local' };
  }
  if (account === 'signed-out' || sync === 'local-only') {
    return { label: '仅本地，不同步', nextAction: 'sign-in' };
  }
  switch (sync) {
    case 'needs-unlock':
      return { label: '账号已登录，请先解锁 Vault', nextAction: 'unlock-vault' };
    case 'syncing':
      return { label: '正在同步加密数据', nextAction: 'none' };
    case 'synced':
      return { label: '已同步', nextAction: 'none' };
    case 'pending':
      return { label: '有待同步变更', nextAction: 'retry' };
    case 'offline':
      return { label: '同步服务离线，本地仍可用', nextAction: 'retry' };
    case 'conflict':
      return { label: '存在同步冲突，需要处理', nextAction: 'resolve-conflict' };
    case 'local-only':
      return { label: '仅本地，不同步', nextAction: 'sign-in' };
    case 'device-revoked':
      return { label: '设备已撤销，仅保留本地数据', nextAction: 'use-local' };
  }
};

const SAFE_ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'vaultId',
  'revision',
  'parentRevision',
  'deviceId',
  'keyVersion',
  'nonce',
  'ciphertext',
  'authTag',
  'aad',
  'payloadHash',
  'byteLength'
]);

/** Guard used at adapter boundaries; envelope metadata must not carry plaintext fields. */
export const isSafeSyncEnvelopeMetadata = (value: unknown): value is SyncEnvelope => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => !SAFE_ENVELOPE_KEYS.has(key))) return false;
  return keys.length === SAFE_ENVELOPE_KEYS.size
    && Number.isInteger(record.schemaVersion)
    && typeof record.vaultId === 'string'
    && Number.isInteger(record.revision)
    && (record.parentRevision === null || Number.isInteger(record.parentRevision))
    && typeof record.deviceId === 'string'
    && Number.isInteger(record.keyVersion)
    && typeof record.nonce === 'string'
    && typeof record.ciphertext === 'string'
    && typeof record.authTag === 'string'
    && typeof record.aad === 'string'
    && typeof record.payloadHash === 'string'
    && Number.isInteger(record.byteLength);
};
