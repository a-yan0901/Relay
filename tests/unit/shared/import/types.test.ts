import { describe, expect, it } from 'vitest';

import {
  credentialToPreviewState,
  redactSourceFields,
  toPreviewConnection,
} from '@shared/import/normalize';
import { supportedImportFormats, type ImportedConnection, type ImportedCredential } from '@shared/import/types';

const connection = (overrides: Partial<ImportedConnection> = {}): ImportedConnection => ({
  sourceId: 'csv:1',
  name: 'edge',
  address: 'edge.example.com',
  port: 22,
  username: 'ops',
  authType: 'password',
  credentialState: 'ready',
  groupPath: ['prod'],
  tags: ['critical'],
  jumpHostSourceIds: [],
  notes: [],
  sourceFields: { name: 'edge', host: 'edge.example.com' },
  ...overrides
});

describe('shared import types and redaction', () => {
  it('exposes the supported cross-product formats', () => {
    expect(supportedImportFormats.map((format) => format.id)).toEqual([
      'openssh-config',
      'ssh-csv',
      'mobaxterm',
      'xshell',
      'securecrt'
    ]);
  });

  it('maps internal credentials to a secret-free preview record', () => {
    const credential: ImportedCredential = { type: 'password', password: 'do-not-return' };
    const preview = toPreviewConnection(connection({ credential }), credentialToPreviewState(credential));

    expect(preview).not.toHaveProperty('credential');
    expect(JSON.stringify(preview)).not.toContain('do-not-return');
    expect(preview.credentialState).toBe('ready');
  });

  it('redacts sensitive source fields without mutating safe fields', () => {
    const result = redactSourceFields({
      Name: 'edge',
      Password: 'secret',
      private_key: '-----BEGIN PRIVATE KEY-----',
      passphrase: 'source-passphrase',
      Host: 'edge.example.com'
    });

    expect(result).toEqual({
      Name: 'edge',
      Password: '[redacted]',
      private_key: '[redacted]',
      passphrase: '[redacted]',
      Host: 'edge.example.com'
    });
  });
});
