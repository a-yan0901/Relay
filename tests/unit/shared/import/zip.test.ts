import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';

import { extractImportZip } from '@shared/import/zip';

describe('bounded import ZIP extraction', () => {
  it('rejects path traversal and unsupported binary entries', async () => {
    await expect(extractImportZip(new Uint8Array([1, 2, 3]), { maxEntries: 2 })).rejects.toThrow();
    await expect(extractImportZip(zipSync({ '../config': new TextEncoder().encode('Host app') }))).rejects.toMatchObject({ code: 'IMPORT_RECORD_INVALID' });
  });

  it('extracts configuration and private-key filenames in memory', async () => {
    const files = await extractImportZip(zipSync({ config: new TextEncoder().encode('Host app'), id_ed25519: new TextEncoder().encode('key') }));
    expect(files.map((file) => file.filename)).toEqual(['config', 'id_ed25519']);
  });
});
