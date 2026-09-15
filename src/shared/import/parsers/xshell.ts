import { documentFromConnections, splitReferenceList } from './common.js';
import type { ImportDocument, ImportedConnection } from '../types.js';
import { credentialStateForFields, normalizePath, parsePort, normalizeHeader } from '../normalize.js';

const decodeText = (content: string | Uint8Array): string => {
  if (typeof content === 'string') return content;
  const bytes = content.byteLength >= 2 ? content.slice(0, 2) : content;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new globalThis.TextDecoder('utf-16le').decode(content);
  return new globalThis.TextDecoder('utf-8', { fatal: false }).decode(content);
};

const parseValues = (content: string): Map<string, string> => {
  const values = new Map<string, string>();
  for (const line of content.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    values.set(normalizeHeader(line.slice(0, separator)), line.slice(separator + 1).trim());
  }
  return values;
};

const first = (values: Map<string, string>, keys: string[]): string => {
  for (const key of keys) {
    const value = values.get(normalizeHeader(key));
    if (value) return value;
  }
  return '';
};

const fileStem = (filename: string): string => filename.split(/[\\/]/u).at(-1)?.replace(/\.xsh$/iu, '') || 'Xshell session';

export const parseXshell = (content: string | Uint8Array, filename = 'session.xsh'): ImportDocument => {
  const values = parseValues(decodeText(content));
  const protocol = first(values, ['Protocol']).toLowerCase();
  if (protocol && !protocol.includes('ssh')) {
    return documentFromConnections('xshell', filename, [], [`${filename} 的协议 ${protocol} 不是 SSH，已跳过`]);
  }
  const address = first(values, ['Host', 'Hostname', 'Address']);
  const username = first(values, ['UserName', 'Username', 'User']);
  const identityFile = first(values, ['UserKey', 'IdentityFile', 'PrivateKey']);
  const password = first(values, ['Password', 'PasswordV2', 'EncryptedPassword']);
  const authType = identityFile ? 'private_key' : (password || protocol.includes('ssh') ? 'password' : 'unknown');
  const proxyHostValue = first(values, ['ProxyServer', 'JumpHost', 'Firewall']);
  const proxyHost = /^(?:none|no|disabled)$/iu.test(proxyHostValue) ? '' : proxyHostValue;
  const proxyPort = parsePort(first(values, ['ProxyPort', 'JumpPort', 'FirewallPort']));
  const proxyUser = first(values, ['ProxyUsername', 'JumpUser', 'FirewallUsername']);
  const connection: ImportedConnection = {
    sourceId: `xshell:${fileStem(filename)}`,
    name: first(values, ['SessionName', 'Name']) || fileStem(filename),
    address,
    port: parsePort(first(values, ['Port'])),
    username,
    authType,
    credentialState: credentialStateForFields({ authType, identityFile, protectedCredential: Boolean(password), referenceOnly: Boolean(identityFile) }),
    ...(identityFile ? { credentialSource: identityFile, identityFile } : {}),
    groupPath: normalizePath(first(values, ['Directory', 'Folder', 'Group'])),
    tags: [],
    jumpHostSourceIds: proxyHost ? [`xshell:gateway:${proxyHost}:${proxyPort}:${proxyUser}`] : splitReferenceList(first(values, ['JumpHosts'])).map((item) => `xshell:${item}`),
    notes: [],
    sourceFields: Object.fromEntries([...values.entries()].filter(([key]) => !/(password|secret|credential)/iu.test(key)))
  };
  if (password) connection.notes.push('Xshell 密码受保护，未尝试解密');
  if (!address) connection.notes.push('缺少远程主机');
  return documentFromConnections('xshell', filename, [connection], []);
};
