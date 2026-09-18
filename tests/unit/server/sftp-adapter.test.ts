import { Readable, Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createSftpResource } from '../../../src/server/sftp/sftp-adapter.js';

describe('sftp adapter streaming offsets', () => {
  it('opens resumed writes without truncating the remote prefix and reads a bounded range', async () => {
    const writeOptions: unknown[] = [];
    const readOptions: unknown[] = [];
    const written: Buffer[] = [];
    const raw = {
      readdir(_path: string, callback: (error: Error | undefined, entries: never[]) => void) { callback(undefined, []); },
      stat(_path: string, callback: (error: Error | undefined, attrs: { size: number; mode: number }) => void) { callback(undefined, { size: 9, mode: 0o100644 }); },
      mkdir(_path: string, callback: (error?: Error) => void) { callback(); },
      rename(_from: string, _to: string, callback: (error?: Error) => void) { callback(); },
      unlink(_path: string, callback: (error?: Error) => void) { callback(); },
      rmdir(_path: string, callback: (error?: Error) => void) { callback(); },
      createWriteStream(_path: string, options: unknown) {
        writeOptions.push(options);
        return new Writable({ write(chunk, _encoding, callback) { written.push(Buffer.from(chunk)); callback(); } });
      },
      createReadStream(_path: string, options: unknown) {
        readOptions.push(options);
        return Readable.from([Buffer.from('01234data').subarray(5, 9)]);
      }
    };
    const resource = createSftpResource(raw);

    await resource.writeFile('/remote-data', (async function* () { yield Buffer.from('data'); })(), undefined, undefined, { offset: 5, truncate: false });
    const chunks: Buffer[] = [];
    for await (const chunk of await resource.readFile('/remote-data', undefined, { offset: 5, end: 9 })) chunks.push(Buffer.from(chunk));

    expect(writeOptions).toEqual([{ flags: 'r+', start: 5 }]);
    expect(written).toEqual([Buffer.from('data')]);
    expect(readOptions).toEqual([{ start: 5, end: 8 }]);
    expect(Buffer.concat(chunks).toString()).toBe('data');
  });

  it('reads bounded directory pages through the SFTP handle without collecting the directory', async () => {
    const batches = [
      [
        { filename: '.', attrs: { mode: 0o040755 } },
        { filename: 'alpha', attrs: { mode: 0o100644, size: 1 } },
        { filename: 'apps', attrs: { mode: 0o040755, size: 0 } }
      ],
      [{ filename: 'z.log', attrs: { mode: 0o100644, size: 2 } }]
    ];
    let reads = 0;
    let closed = false;
    const raw = {
      readdir(_location: string | Buffer, callback: (error: Error | undefined, entries: never[]) => void) { callback(undefined, []); },
      opendir(_path: string, callback: (error: Error | undefined, handle: Buffer) => void) { callback(undefined, Buffer.from('handle')); },
      close(_handle: Buffer, callback: (error?: Error) => void) { closed = true; callback(); },
      stat(_path: string, callback: (error: Error | undefined, attrs: { size: number; mode: number }) => void) { callback(undefined, { size: 0, mode: 0o100644 }); },
      mkdir(_path: string, callback: (error?: Error) => void) { callback(); },
      rename(_from: string, _to: string, callback: (error?: Error) => void) { callback(); },
      unlink(_path: string, callback: (error?: Error) => void) { callback(); },
      rmdir(_path: string, callback: (error?: Error) => void) { callback(); },
      createWriteStream(_path: string, _options: unknown) { return new Writable({ write(_chunk, _encoding, callback) { callback(); } }); },
      createReadStream(_path: string, _options: unknown) { return Readable.from([]); },
      end() {}
    };
    raw.readdir = ((location: string | Buffer, callback: (error: Error | undefined, entries: never[]) => void) => {
      expect(Buffer.isBuffer(location)).toBe(true);
      const batch = batches[reads++];
      if (batch) callback(undefined, batch as never[]);
      else callback(Object.assign(new Error('end of file'), { code: 1 }), [] as never[]);
    }) as typeof raw.readdir;

    const page = await createSftpResource(raw).listPage?.('/', 0, 2);

    expect(page?.entries.map((entry) => entry.name)).toEqual(['alpha', 'apps']);
    expect(page?.hasMore).toBe(true);
    expect(reads).toBe(2);
    expect(closed).toBe(true);
  });
});
