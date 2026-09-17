import { afterEach, describe, expect, it, vi } from 'vitest';

import { applySyncRecovery, confirmRecoveryKey, exportConflict, getAccountDeletion, getAccountSession, getCloudAccountSession, getSetupStatus, getSyncState, issueRecoveryKey, listCloudDevices, listCloudWorkspaces, previewSyncRecovery, reauthenticate, requestAccountDeletion, requestCloudDeletion, restoreAccountDeletion, restoreCloudDeletion, signIn, signInCloud, syncCloudAccount } from '../../../src/web/api';

type FetchInit = { method?: string; body?: string };

const createConflictExportResponse = () => {
  const envelope = (aad: string) => ({
    version: 1,
    nonce: Buffer.alloc(12).toString('base64'),
    ciphertext: Buffer.alloc(32).toString('base64'),
    authTag: Buffer.alloc(16).toString('base64'),
    aad: Buffer.from(aad).toString('base64')
  });
  const localAad = 'relay-sync-conflict:v1:conflict-api-1:local';
  const remoteAad = 'relay-sync-conflict:v1:conflict-api-1:remote';
  return {
    format: 'relay-sync-conflict',
    version: 1,
    conflictId: 'conflict-api-1',
    createdAt: '2026-09-17T10:00:00.000Z',
    copies: [
      { copy: 'local', revision: 3, payloadHash: 'a'.repeat(64), kdf: { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32, salt: Buffer.alloc(16).toString('base64') }, wrappedBundleKey: envelope(localAad), payload: envelope(localAad) },
      { copy: 'remote', revision: 4, payloadHash: 'b'.repeat(64), kdf: { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32, salt: Buffer.alloc(16, 1).toString('base64') }, wrappedBundleKey: envelope(remoteAad), payload: envelope(remoteAad) }
    ]
  };
};

describe('web API request lifecycle', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('converts a stalled request into an actionable timeout error', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: unknown, init?: { signal?: AbortSignal }) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const pending = getSetupStatus();
    const rejection = expect(pending).rejects.toMatchObject({ message: '请求超时，请稍后重试', statusCode: 408 });
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledWith('/api/setup/status', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('uses same-origin credentials for account calls and keeps the session opaque', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ account: {
      accountId: 'account-1',
      deviceId: 'device-1',
      state: 'signed-in',
      expiresAt: '2026-09-17T00:00:00.000Z'
    } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await signIn('user@example.com', 'one-time-password', '办公室浏览器');
    expect(response.account.accountId).toBe('account-1');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/account/session');
    expect(init).toEqual(expect.objectContaining({ credentials: 'same-origin', method: 'POST' }));
    expect(JSON.parse((init as { body?: string }).body as string)).toEqual({ email: 'user@example.com', password: 'one-time-password', deviceLabel: '办公室浏览器' });
    expect(JSON.stringify(response)).not.toContain('one-time-password');
    expect(JSON.stringify(response)).not.toMatch(/token|privateKey|passphrase/iu);
  });

  it('parses cloud account metadata and workspace presence without accepting bearer tokens', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/cloud/account/session') {
        return new Response(JSON.stringify({ account: {
          accountId: 'account-1',
          deviceId: 'device-1',
          state: 'signed-in',
          expiresAt: '2026-09-17T00:00:00.000Z',
          trusted: true,
          token: 'must-not-cross-boundary'
        } }), { status: 200 });
      }
      if (input === '/api/cloud/devices') {
        return new Response(JSON.stringify([{ id: 'device-1', label: 'Browser', platform: 'web', lastSeenAt: null, current: true, revokedAt: null, trustedAt: '2026-09-17T00:00:00.000Z' }]), { status: 200 });
      }
      if (input === '/api/cloud/workspaces') {
        return new Response(JSON.stringify([{ id: 'workspace-1', accountId: 'account-1', ownerDeviceId: 'device-1', encryptedTitle: 'v1:', createdAt: '2026-09-17T00:00:00.000Z', updatedAt: '2026-09-17T00:00:00.000Z', deletedAt: null, online: true, activeViewerCount: 2 }]), { status: 200 });
      }
      if (input === '/api/cloud/sync/account') {
        return new Response(JSON.stringify({ status: 'pushed', head: { domain: 'account-data', resourceId: 'account-1', revision: 2, payloadHash: 'b'.repeat(64), keyVersion: 1, updatedAt: '2026-09-17T00:00:00.000Z' } }), { status: 200 });
      }
      return new Response(JSON.stringify({ account: { accountId: 'account-1', deviceId: 'device-1', state: 'signed-in', expiresAt: '2026-09-17T00:00:00.000Z', trusted: true } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getCloudAccountSession()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ account: { accountId: 'account-1', deviceId: 'device-1', state: 'signed-in', expiresAt: '2026-09-17T00:00:00.000Z', trusted: true } }), { status: 200 }));
    await expect(getCloudAccountSession()).resolves.toEqual({ account: expect.objectContaining({ trusted: true }) });
    await expect(listCloudDevices()).resolves.toEqual([expect.objectContaining({ id: 'device-1', trusted: true })]);
    await expect(listCloudWorkspaces()).resolves.toEqual([expect.objectContaining({ id: 'workspace-1', online: true, activeViewerCount: 2 })]);
    await expect(syncCloudAccount()).resolves.toEqual(expect.objectContaining({ status: 'pushed', head: expect.objectContaining({ revision: 2 }) }));
    const syncCall = fetchMock.mock.calls.find(([input]) => input === '/api/cloud/sync/account');
    expect(syncCall?.[1]).toEqual(expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    expect(JSON.parse((syncCall?.[1] as { body?: string }).body as string)).toEqual({});

    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ account: { accountId: 'account-1', deviceId: 'device-1', state: 'signed-in', expiresAt: '2026-09-17T00:00:00.000Z', trusted: true } }), { status: 200 }));
    await signInCloud('user@example.com', 'one-time-password', '办公室浏览器');
    const signInCall = fetchMock.mock.calls.at(-1);
    expect(signInCall?.[0]).toBe('/api/cloud/account/session');
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('must-not-cross-boundary');
  });

  it('sends only explicit re-auth and deletion confirmations and parses redacted lifecycle state', async () => {
    let accountDeletionReads = 0;
    const fetchMock = vi.fn(async (input: string, init?: FetchInit) => {
      if (input === '/api/account/session/reauth') return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      if (input === '/api/account/deletion') {
        accountDeletionReads += 1;
        return accountDeletionReads === 1
          ? new Response(JSON.stringify({ deletion: { kind: 'account', requestedAt: '2026-09-17T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', remainingMs: 2_592_000_000 } }), { status: 202 })
          : new Response(JSON.stringify({ deletion: null }), { status: 200 });
      }
      if (input === '/api/sync/v1/vault/delete') return new Response(JSON.stringify({ kind: 'cloud-sync', requestedAt: '2026-09-17T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', remainingMs: 2_592_000_000 }), { status: 202 });
      if (input === '/api/account/deletion/restore' || input === '/api/sync/v1/vault/restore') return new Response(null, { status: 204 });
      throw new Error(`unexpected request ${input} ${(init?.method ?? 'GET')}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    await reauthenticate('long enough password');
    await expect(requestAccountDeletion('DELETE MY ACCOUNT')).resolves.toEqual(expect.objectContaining({ deletion: expect.objectContaining({ kind: 'account' }) }));
    await expect(requestCloudDeletion('DELETE MY CLOUD VAULT')).resolves.toEqual(expect.objectContaining({ kind: 'cloud-sync' }));
    await restoreAccountDeletion();
    await restoreCloudDeletion();
    const accountDeletion = await getAccountDeletion();
    expect(accountDeletion).toEqual(expect.objectContaining({ deletion: null }));

    const reauthBody = JSON.parse((fetchMock.mock.calls[0]?.[1] as FetchInit).body as string);
    const accountDeleteBody = JSON.parse((fetchMock.mock.calls[1]?.[1] as FetchInit).body as string);
    const cloudDeleteBody = JSON.parse((fetchMock.mock.calls[2]?.[1] as FetchInit).body as string);
    expect(reauthBody).toEqual({ password: 'long enough password' });
    expect(accountDeleteBody).toEqual({ confirmDelete: 'DELETE MY ACCOUNT' });
    expect(cloudDeleteBody).toEqual({ confirmDelete: 'DELETE MY CLOUD VAULT' });
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('reauthenticated');
  });

  it('rejects deletion state fields outside the declared DTO', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ deletion: { kind: 'account', requestedAt: '2026-09-17T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', remainingMs: 1, token: 'must-not-cross-boundary' } }), { status: 200 })));

    await expect(getAccountDeletion()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
  });

  it('rejects account and sync response fields outside the declared DTOs', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input === '/api/account/session') return new Response(JSON.stringify({ account: {
        accountId: 'account-1',
        deviceId: 'device-1',
        state: 'signed-in',
        expiresAt: '2026-09-17T00:00:00.000Z',
        token: 'must-not-cross-boundary'
      } }), { status: 200 });
      return new Response(JSON.stringify({ sync: 'synced', head: null, pendingCount: 0, command: 'must-not-cross-boundary' }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(getAccountSession()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
    await expect(getSyncState()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
  });

  it('validates recovery key issue and safe recovery state responses', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/recovery-key/issue')) {
        return new Response(JSON.stringify({ recoveryKey: 'RLY-RK1-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', keyVersion: 1, status: 'pending-confirmation', recovery: { status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 } }), { status: 201 });
      }
      if (input.endsWith('/recovery-key/confirm')) {
        return new Response(JSON.stringify({ status: 'configured', activeKeyVersion: 1, pendingKeyVersion: null }), { status: 200 });
      }
      return new Response(JSON.stringify({
        sync: 'synced',
        head: null,
        pendingCount: 0,
        recovery: { status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 }
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(issueRecoveryKey()).resolves.toEqual(expect.objectContaining({ keyVersion: 1, status: 'pending-confirmation' }));
    await expect(getSyncState()).resolves.toEqual(expect.objectContaining({
      recovery: { status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 }
    }));
    await expect(confirmRecoveryKey('RLY-RK1-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA')).resolves.toEqual({
      status: 'configured',
      activeKeyVersion: 1,
      pendingKeyVersion: null
    });
  });

  it('keeps new-device recovery payloads strict and sends secrets only in the explicit request', async () => {
    const preview = {
      previewId: 'preview-1',
      vaultId: 'vault-1',
      revision: 2,
      payloadHash: 'a'.repeat(64),
      hostCount: 1,
      groupCount: 0,
      identityCount: 0,
      snippetCount: 2,
      workspaceIncluded: true,
      conflictTypes: [],
      expiresAt: '2026-09-17T00:10:00.000Z'
    };
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith('/preview')) return new Response(JSON.stringify(preview), { status: 200 });
      return new Response(JSON.stringify({ initialized: true, locked: false }), { status: 201 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(previewSyncRecovery({ method: 'recovery-key', secret: 'one-time-recovery-key' })).resolves.toEqual(preview);
    await expect(applySyncRecovery('preview-1', { method: 'recovery-key', secret: 'one-time-recovery-key' })).resolves.toEqual({ initialized: true, locked: false });
    expect(JSON.parse((fetchMock.mock.calls[0]?.[1] as { body?: string }).body as string)).toEqual({ method: 'recovery-key', secret: 'one-time-recovery-key' });
    expect(JSON.parse((fetchMock.mock.calls[1]?.[1] as { body?: string }).body as string)).toEqual({ previewId: 'preview-1', method: 'recovery-key', secret: 'one-time-recovery-key' });

    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ...preview, secret: 'must-not-cross-boundary' }), { status: 200 }));
    await expect(previewSyncRecovery({ method: 'master-password', secret: 'master-password' })).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });

    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ...preview, conflictTypes: ['host', 'group', 'identity', 'snippet', 'workspace', 'host-key', 'host'] }), { status: 200 }));
    await expect(previewSyncRecovery({ method: 'master-password', secret: 'master-password' })).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
  });

  it('posts only the explicit conflict export password and parses the encrypted package strictly', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(createConflictExportResponse()), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await exportConflict('conflict-api-1', 'one-time export password');

    expect(result.conflictId).toBe('conflict-api-1');
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/sync/v1/conflicts/conflict-api-1/export');
    expect(init).toEqual(expect.objectContaining({ method: 'POST', credentials: 'same-origin' }));
    expect(JSON.parse((init as { body?: string }).body as string)).toEqual({ exportPassword: 'one-time export password' });

    fetchMock.mockImplementationOnce(async () => new Response(JSON.stringify({ ...createConflictExportResponse(), leaked: 'plaintext' }), { status: 200 }));
    await expect(exportConflict('conflict-api-1', 'one-time export password')).rejects.toMatchObject({ code: 'PROTOCOL_INVALID_MESSAGE' });
  });
});
