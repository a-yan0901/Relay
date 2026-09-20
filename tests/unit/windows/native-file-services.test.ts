import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BrowserWindow } from 'electron';

import { createWindowsFileSource, createWindowsFileWriter, type NativeFileDialog } from '../../../apps/windows/native-file-services.js';

const activeWindow = { isDestroyed: () => false } as unknown as BrowserWindow;

describe('Windows native file services', () => {
  const tempDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  it('returns no source when the native open dialog is canceled', async () => {
    const dialog: NativeFileDialog = {
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
      showSaveDialog: vi.fn()
    };

    await expect(createWindowsFileSource(activeWindow, dialog)).resolves.toBeNull();
    expect(dialog.showOpenDialog).toHaveBeenCalledOnce();
  });

  it('streams the selected file and keeps its path out of the source metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-native-file-source-'));
    tempDirectories.push(directory);
    const selectedPath = join(directory, 'selected.bin');
    await writeFile(selectedPath, Buffer.from('selected-content'));
    const dialog: NativeFileDialog = {
      showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: [selectedPath] })),
      showSaveDialog: vi.fn()
    };

    const source = await createWindowsFileSource(activeWindow, dialog);
    expect(source).toMatchObject({ name: 'selected.bin', size: 16 });
    expect(source).not.toHaveProperty('path');
    const chunks: Uint8Array[] = [];
    for await (const chunk of source!.stream()) chunks.push(chunk);
    await source!.close();

    expect(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')).toBe('selected-content');
  });

  it('cancels a native save without leaving a target or partial file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-native-file-writer-'));
    tempDirectories.push(directory);
    const targetPath = join(directory, 'cancelled.bin');
    const dialog: NativeFileDialog = {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: targetPath }))
    };

    const writer = await createWindowsFileWriter(activeWindow, directory, { name: 'cancelled.bin', mimeType: 'application/octet-stream' }, dialog);
    await writer!.write(new Uint8Array([1, 2, 3]));
    await writer!.cancel();

    await expect(readFile(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(directory)).resolves.toEqual([]);
  });

  it('commits a selected save atomically after the writer closes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'relay-native-file-writer-'));
    tempDirectories.push(directory);
    const targetPath = join(directory, 'saved.bin');
    const dialog: NativeFileDialog = {
      showOpenDialog: vi.fn(),
      showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: targetPath }))
    };

    const writer = await createWindowsFileWriter(activeWindow, directory, { name: 'saved.bin', mimeType: 'application/octet-stream' }, dialog);
    await writer!.write(new Uint8Array([1, 2, 3]));
    await expect(readFile(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await writer!.close();

    await expect(readFile(targetPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(readdir(directory)).resolves.toEqual(['saved.bin']);
  });
});
