import { describe, expect, it } from 'vitest';

import { parseSha256sum, shouldInstallDebugApk } from '../../apps/android/install-policy.mjs';

describe('Android debug install policy', () => {
  it('installs when the package is not present or the device cannot report a hash', () => {
    expect(shouldInstallDebugApk('a'.repeat(64), null)).toBe(true);
    expect(shouldInstallDebugApk('a'.repeat(64), 'not-readable')).toBe(true);
  });

  it('skips push and install when the installed APK has the same hash', () => {
    expect(shouldInstallDebugApk('A'.repeat(64), 'a'.repeat(64))).toBe(false);
  });

  it('installs when the installed APK is different', () => {
    expect(shouldInstallDebugApk('a'.repeat(64), 'b'.repeat(64))).toBe(true);
  });

  it('parses Android sha256sum output without trusting malformed output', () => {
    expect(parseSha256sum(`${'a'.repeat(64)}  /data/app/cn.ayan.relay/base.apk`)).toBe('a'.repeat(64));
    expect(parseSha256sum('permission denied')).toBeNull();
  });
});
