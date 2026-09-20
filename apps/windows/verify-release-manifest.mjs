import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function assertReleaseManifestSigned(manifest) {
  const entries = Array.isArray(manifest) ? manifest : [manifest];
  if (entries.length === 0) throw new Error('Windows release manifest has no artifacts');

  const invalid = entries.filter((entry) => {
    if (!entry || typeof entry !== 'object') return true;
    return entry.signatureStatus !== 'Valid' || typeof entry.signer !== 'string' || entry.signer.trim() === '';
  });

  if (invalid.length > 0) {
    const details = invalid.map((entry) => {
      const path = entry && typeof entry === 'object' && typeof entry.path === 'string' ? entry.path : '<unknown artifact>';
      const status = entry && typeof entry === 'object' && typeof entry.signatureStatus === 'string'
        ? entry.signatureStatus
        : '<missing status>';
      const signer = entry && typeof entry === 'object' && typeof entry.signer === 'string' && entry.signer.trim() !== ''
        ? entry.signer
        : '<missing signer>';
      return `${path}: status=${status}, signer=${signer}`;
    });
    throw new Error(`Windows release signature gate failed: ${details.join('; ')}`);
  }

  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = resolve(process.argv[2] ?? 'dist/releases/release-manifest.json');
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assertReleaseManifestSigned(manifest);
    console.log(`Windows release signature gate passed: ${manifestPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
