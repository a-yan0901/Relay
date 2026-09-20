import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertReleaseManifestSigned } from '../../../apps/windows/verify-release-manifest.mjs';

const signedManifest = [
  { path: 'dist/releases/nsis/Relay-0.1.0-x64.exe', signatureStatus: 'Valid', signer: 'CN=Relay' },
  { path: 'dist/releases/portable/Relay-0.1.0-x64.exe', signatureStatus: 'Valid', signer: 'CN=Relay' }
];

describe('Windows release signature gate', () => {
  it('accepts a manifest whose release artifacts are authenticode-valid', () => {
    expect(assertReleaseManifestSigned(signedManifest)).toBe(true);
  });

  it('rejects a manifest when any release artifact is unsigned', () => {
    expect(() => assertReleaseManifestSigned([
      ...signedManifest.slice(0, 1),
      { ...signedManifest[1], signatureStatus: 'NotSigned', signer: null }
    ])).toThrow(/NotSigned/);
  });

  it('rejects a manifest when a valid status has no signer identity', () => {
    expect(() => assertReleaseManifestSigned([
      { ...signedManifest[0], signer: null },
      signedManifest[1]
    ])).toThrow(/signer/iu);
  });

  it('configures signing and enforces the signature gate for version tags', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/windows-package.yml'), 'utf8');
    expect(workflow).toContain('WINDOWS_CSC_LINK');
    expect(workflow).toContain('WINDOWS_CSC_KEY_PASSWORD');
    expect(workflow).toContain('apps/windows/verify-release-manifest.mjs');
  });
});
