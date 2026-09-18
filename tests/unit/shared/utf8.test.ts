import { describe, expect, it } from 'vitest';

import { utf8ByteLength } from '../../../src/shared/utf8.js';

describe('utf8 byte length', () => {
  it('matches TextEncoder without allocating an encoded buffer', () => {
    for (const value of ['', 'ascii', '中文', 'emoji 🚀', '\ud800', '\udfff', 'a\ud800b']) {
      expect(utf8ByteLength(value)).toBe(new TextEncoder().encode(value).byteLength);
    }
  });
});
