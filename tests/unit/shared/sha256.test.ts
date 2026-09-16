import { describe, expect, it } from 'vitest';

import { Sha256 } from '../../../src/shared/crypto/sha256.js';

describe('Sha256', () => {
  it('matches standard digests for empty and chunked input', () => {
    expect(new Sha256().digestHex()).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    const hash = new Sha256();
    hash.update(new TextEncoder().encode('a'));
    hash.update(new TextEncoder().encode('bc'));
    expect(hash.digestHex()).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(hash.clone().digestHex()).toBe(hash.digestHex());
  });
});
