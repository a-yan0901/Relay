import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { parseSyncConflictExport } from '../../../src/shared/core/sync-conflict-export.js';
import {
  assembleSyncConflictExport,
  createSyncConflictExportCopy,
  decryptSyncConflictExportCopy
} from '../../../src/server/sync/sync-conflict-export.js';

const PASSWORD = 'conflict export password';
const conflictId = 'conflict-crypto-1';

const expectPayloadInvalid = async (operation: () => Promise<unknown>): Promise<void> => {
  await expect(operation()).rejects.toEqual(expect.objectContaining({ code: 'SYNC_PAYLOAD_INVALID' }));
};

describe('encrypted sync conflict export format', () => {
  it('creates independent local and remote copies with exact AAD', async () => {
    const localPlaintext = Buffer.from('{"side":"local","marker":"local-snapshot"}', 'utf8');
    const remotePlaintext = Buffer.from('{"side":"remote","marker":"remote-snapshot"}', 'utf8');
    const local = await createSyncConflictExportCopy({
      conflictId,
      copy: 'local',
      revision: 3,
      payloadHash: 'a'.repeat(64),
      plaintext: localPlaintext,
      exportPassword: PASSWORD
    });
    const remote = await createSyncConflictExportCopy({
      conflictId,
      copy: 'remote',
      revision: 4,
      payloadHash: 'b'.repeat(64),
      plaintext: remotePlaintext,
      exportPassword: PASSWORD
    });

    expect(local.kdf.salt).not.toBe(remote.kdf.salt);
    expect(local.wrappedBundleKey.ciphertext).not.toBe(remote.wrappedBundleKey.ciphertext);
    expect(local.payload.ciphertext).not.toBe(remote.payload.ciphertext);
    expect(Buffer.from(local.payload.aad, 'base64').toString('utf8')).toBe('relay-sync-conflict:v1:conflict-crypto-1:local');
    expect(Buffer.from(remote.payload.aad, 'base64').toString('utf8')).toBe('relay-sync-conflict:v1:conflict-crypto-1:remote');

    const exported = assembleSyncConflictExport({ conflictId, createdAt: '2026-09-17T10:00:00.000Z', local, remote });
    expect(parseSyncConflictExport(exported)).toEqual(exported);
    await expect(decryptSyncConflictExportCopy(conflictId, local, PASSWORD)).resolves.toEqual(localPlaintext);
    await expect(decryptSyncConflictExportCopy(conflictId, remote, PASSWORD)).resolves.toEqual(remotePlaintext);
  });

  it('does not decrypt with a wrong password or after a copy is tampered', async () => {
    const copy = await createSyncConflictExportCopy({
      conflictId,
      copy: 'local',
      revision: 3,
      payloadHash: 'a'.repeat(64),
      plaintext: Buffer.from('opaque snapshot bytes', 'utf8'),
      exportPassword: PASSWORD
    });

    await expectPayloadInvalid(() => decryptSyncConflictExportCopy(conflictId, copy, 'wrong password'));
    await expectPayloadInvalid(() => decryptSyncConflictExportCopy(conflictId, {
      ...copy,
      payload: { ...copy.payload, ciphertext: `${copy.payload.ciphertext.slice(0, -2)}AA` }
    }, PASSWORD));
    await expectPayloadInvalid(() => decryptSyncConflictExportCopy(conflictId, {
      ...copy,
      copy: 'remote'
    }, PASSWORD));
  });

  it('rejects export passwords outside the supported bound', async () => {
    const input = {
      conflictId,
      copy: 'local' as const,
      revision: 1,
      payloadHash: 'a'.repeat(64),
      plaintext: Buffer.from('snapshot', 'utf8')
    };

    await expect(createSyncConflictExportCopy({ ...input, exportPassword: 'short' })).rejects.toEqual(expect.objectContaining({ code: 'SYNC_PAYLOAD_INVALID' } satisfies Partial<AppError>));
    await expect(createSyncConflictExportCopy({ ...input, exportPassword: 'x'.repeat(4_097) })).rejects.toEqual(expect.objectContaining({ code: 'SYNC_PAYLOAD_INVALID' } satisfies Partial<AppError>));
  });
});
