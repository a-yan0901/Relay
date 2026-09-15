import { unzipSync } from 'fflate';

import { AppError } from '../errors.js';
import type { ImportSourceFile } from './types.js';

export interface ZipExtractionOptions {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

const allowedExtensions = new Set(['config', 'conf', 'ssh_config', 'csv', 'mxtsessions', 'mobaconf', 'ini', 'xsh', 'xml', 'key', 'pem', 'ppk', 'pub', 'known_hosts']);

const extensionOf = (name: string): string => name.split('.').at(-1)?.toLowerCase() ?? '';

const assertSafeName = (name: string): void => {
  if (!name || name.startsWith('/') || /^[A-Za-z]:/u.test(name) || name.split(/[\\/]/u).includes('..')) {
    throw new AppError('IMPORT_RECORD_INVALID', '压缩包包含不安全路径');
  }
  const basename = name.split(/[\\/]/u).at(-1) ?? name;
  const isOpenSshKey = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)|known_hosts)$/iu.test(basename);
  if (!allowedExtensions.has(extensionOf(name)) && !isOpenSshKey) throw new AppError('IMPORT_RECORD_INVALID', '压缩包包含不支持的文件类型');
};

export const extractImportZip = async (
  content: Uint8Array,
  options: ZipExtractionOptions = {}
): Promise<ImportSourceFile[]> => {
  const maxEntries = options.maxEntries ?? 64;
  const maxEntryBytes = options.maxEntryBytes ?? 2 * 1024 * 1024;
  const maxTotalBytes = options.maxTotalBytes ?? 8 * 1024 * 1024;
  let entries: Record<string, Uint8Array>;
  try {
    let entryCount = 0;
    let totalOriginalBytes = 0;
    entries = unzipSync(content, {
      filter: (file) => {
        entryCount += 1;
        if (entryCount > maxEntries) throw new AppError('IMPORT_RECORD_INVALID', '压缩包文件数量超过限制');
        if (file.name.endsWith('/')) return false;
        assertSafeName(file.name);
        if (file.originalSize > maxEntryBytes) throw new AppError('FILE_TOO_LARGE');
        totalOriginalBytes += file.originalSize;
        if (totalOriginalBytes > maxTotalBytes) throw new AppError('FILE_TOO_LARGE');
        return true;
      }
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('IMPORT_RECORD_INVALID', '压缩包无法读取');
  }
  const names = Object.keys(entries);
  if (names.length > maxEntries) throw new AppError('IMPORT_RECORD_INVALID', '压缩包文件数量超过限制');
  let total = 0;
  const result: ImportSourceFile[] = [];
  for (const name of names) {
    if (name.endsWith('/')) continue;
    assertSafeName(name);
    const data = entries[name];
    if (data.byteLength > maxEntryBytes) throw new AppError('FILE_TOO_LARGE');
    total += data.byteLength;
    if (total > maxTotalBytes) throw new AppError('FILE_TOO_LARGE');
    result.push({ filename: name, content: data });
  }
  return result;
};
