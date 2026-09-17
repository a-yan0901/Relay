import { describe, expect, it } from 'vitest';

import { CloudApiClient } from '../../../src/shared/cloud/client.js';
import type { CloudDataEnvelope } from '../../../src/shared/cloud/protocol.js';

const envelope: CloudDataEnvelope = {
  protocolVersion: 1,
  domain: 'account-data',
  accountId: 'account-1',
  revision: 1,
  parentRevision: null,
  writerDeviceId: 'device-1',
  keyVersion: 1,
  nonce: 'nonce',
  ciphertext: 'ciphertext',
  authTag: 'tag',
  aad: 'aad',
  payloadHash: 'a'.repeat(64),
  byteLength: 12
};

describe('cloud HTTP client', () => {
  it('sends bearer credentials in headers and never in request URLs', async () => {
    const requests: Request[] = [];
    const client = new CloudApiClient('https://api.example.test/', async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify(envelope), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await expect(client.getAccountDataSnapshot('token-value', 1)).resolves.toEqual(envelope);
    expect(requests[0].url).toBe('https://api.example.test/v2/account-data/snapshot?revision=1');
    expect(requests[0].headers.get('authorization')).toBe('Bearer token-value');
    expect(requests[0].url).not.toContain('token-value');
  });

  it('maps structured cloud errors to the shared AppError contract', async () => {
    const client = new CloudApiClient('https://api.example.test', async () => new Response(
      JSON.stringify({ error: { code: 'ACCOUNT_DEVICE_REVOKED', message: 'revoked' } }),
      { status: 403, headers: { 'content-type': 'application/json' } }
    ));

    await expect(client.getAccountDataHead('token-value')).rejects.toMatchObject({ code: 'ACCOUNT_DEVICE_REVOKED', statusCode: 403 });
  });
});
