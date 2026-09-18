import { describe, expect, it } from 'vitest';

import { BoundedBundleParts } from '../../../apps/windows/bounded-bundle.js';

describe('bounded desktop bundle parts', () => {
  it('reassembles UTF-8 when a code point crosses chunk boundaries', () => {
    const value = Buffer.from('{"name":"继"}');
    const parts = new BoundedBundleParts(value.byteLength);

    parts.append(value.subarray(0, 10));
    parts.append(value.subarray(10, 11));
    parts.append(value.subarray(11));

    expect(parts.takeText()).toBe(value.toString('utf8'));
    expect(parts.byteLength).toBe(0);
  });

  it('rejects data beyond the configured bound and clears retained bytes', () => {
    const parts = new BoundedBundleParts(3);

    parts.append(new Uint8Array([1, 2]));
    expect(() => parts.append(new Uint8Array([3, 4]))).toThrow('bundle too large');
    expect(parts.byteLength).toBe(2);
    parts.clear();
    expect(parts.byteLength).toBe(0);
  });
});
