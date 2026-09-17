import { describe, expect, it } from 'vitest';

import { generateCloudDeviceKeyPair, unwrapCloudDataKey, wrapCloudDataKey } from '../../../src/shared/cloud/key-crypto.js';

describe('cloud device key wrapping', () => {
  it('wraps and unwraps a data key with portable ECDH/AES-GCM fields', async () => {
    const recipient = await generateCloudDeviceKeyPair();
    const key = Uint8Array.from({ length: 32 }, (_, index) => index);
    const wrapper = await wrapCloudDataKey(key, recipient.publicKey, 'relay:account-data:account-1:v1');

    expect(wrapper.scheme).toBe('ecdh-p256-aesgcm-v1');
    expect(JSON.stringify(wrapper).length).toBeLessThan(16 * 1024);
    await expect(unwrapCloudDataKey(wrapper, recipient.privateKey, 'relay:account-data:account-1:v1')).resolves.toEqual(key);
  });

  it('rejects a changed aad or malformed wrapper without exposing plaintext', async () => {
    const recipient = await generateCloudDeviceKeyPair();
    const wrapper = await wrapCloudDataKey(new Uint8Array(32).fill(7), recipient.publicKey, 'aad-v1');

    await expect(unwrapCloudDataKey(wrapper, recipient.privateKey, 'aad-v2')).rejects.toThrow();
    await expect(unwrapCloudDataKey({ ...wrapper, authTag: 'bad' }, recipient.privateKey, 'aad-v1')).rejects.toThrow();
  });
});
