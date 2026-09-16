import type { ImportFormat, SupportedImportFormat } from './types.js';
import { supportedImportFormats } from './types.js';

export interface DetectedImportFormat {
  format: ImportFormat;
  confidence: 'high' | 'medium' | 'low';
  reason: string;
}

const textFromContent = (content: string | Uint8Array): string => typeof content === 'string'
  ? content
  : new globalThis.TextDecoder('utf-8', { fatal: false }).decode(content);

const extensionOf = (filename: string): string => filename.split('.').at(-1)?.toLowerCase() ?? '';

const hasCsvHeader = (text: string): boolean => {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? '';
  const normalized = firstLine.replaceAll(/[^a-z0-9,;_ -]/giu, '').toLowerCase();
  return /(?:host|hostname|address|ip|username|user|port)/u.test(normalized) && /[,;]/u.test(normalized);
};

export const detectImportFormats = (content: string | Uint8Array, filename = ''): DetectedImportFormat[] => {
  const text = textFromContent(content).replace(/^\uFEFF/u, '');
  const extension = extensionOf(filename);
  const results: DetectedImportFormat[] = [];
  if (/^\s*Host\s+\S+/mu.test(text) && /(?:^|\n)\s*(?:HostName|User|Port|ProxyJump)\s+/mu.test(text)) {
    results.push({ format: 'openssh-config', confidence: 'high', reason: '包含 OpenSSH Host 指令' });
  }
  if (hasCsvHeader(text)) {
    results.push({ format: 'ssh-csv', confidence: extension === 'csv' ? 'high' : 'medium', reason: '首行包含 SSH CSV 字段' });
  }
  if (/^\s*\[Bookmarks(?:_\d+)?\]/mu.test(text) || /^\s*SubRep=/mu.test(text)) {
    results.push({ format: 'mobaxterm', confidence: 'high', reason: '包含 MobaXterm bookmarks 段' });
  }
  if (extension === 'mxtsessions' || extension === 'mobaconf') {
    results.push({ format: 'mobaxterm', confidence: 'high', reason: '扩展名符合 MobaXterm 会话/配置' });
  }
  if (/^\s*(?:Product\s*=\s*Xshell|Host\s*=|Xshell)/imu.test(text) || extension === 'xsh') {
    results.push({ format: 'xshell', confidence: extension === 'xsh' ? 'high' : 'medium', reason: '符合 Xshell session 结构' });
  }
  if (/^\s*<\?xml[\s\S]*?(?:VanDykeSoftware|SecureCRT)/iu.test(text) || /(?:VanDykeSoftware|SecureCRT|S:"Hostname")/iu.test(text)) {
    results.push({ format: 'securecrt', confidence: extension === 'xml' ? 'high' : 'medium', reason: '符合 SecureCRT XML/INI 结构' });
  }
  return results.sort((left, right) => {
    const rank = { high: 3, medium: 2, low: 1 };
    return rank[right.confidence] - rank[left.confidence];
  });
};

export const formatById = (format: ImportFormat): SupportedImportFormat => {
  const result = supportedImportFormats.find((candidate) => candidate.id === format);
  if (!result) throw new Error(`Unsupported import format: ${format}`);
  return result;
};
