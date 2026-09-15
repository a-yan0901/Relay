import { XMLParser } from 'fast-xml-parser';

import { documentFromConnections } from './common.js';
import type { ImportDocument, ImportedConnection } from '../types.js';
import { credentialStateForFields, inferAuthType, normalizeHeader, normalizePath, parsePort, redactSourceFields } from '../normalize.js';

const toScalar = (value: unknown): string => {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  if (typeof value === 'object' && value !== null && '#text' in value) return toScalar((value as Record<string, unknown>)['#text']);
  return '';
};

const fileStem = (filename: string): string => filename.split(/[\\/]/u).at(-1)?.replace(/\.(?:ini|xml)$/iu, '') || 'SecureCRT session';

const parseSecurePort = (value: string): number => /^[0-9a-f]{8}$/iu.test(value) ? parsePort(String(Number.parseInt(value, 16))) : parsePort(value);

const normalizedRecordKey = (key: string): string => normalizeHeader(key.replace(/^@_/u, '').replace(/^.*[":]/u, ''));

const flattenRecord = (value: unknown, output: Record<string, string>, currentKey = ''): void => {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenRecord(item, output, currentKey));
    return;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    if (currentKey) output[currentKey] = String(value).trim();
    return;
  }
  if (typeof value !== 'object' || value === null) return;
  const record = value as Record<string, unknown>;
  const namedKey = toScalar(record['@_name'] ?? record['@_key'] ?? record['@_property'] ?? record['@_id']);
  const textValue = toScalar(record['#text']);
  if (namedKey && textValue) output[namedKey] = textValue;
  for (const [key, child] of Object.entries(record)) {
    if (key.startsWith('@_') || key === '#text') continue;
    flattenRecord(child, output, key);
  }
};

const flattenedRecord = (record: Record<string, unknown>): Record<string, string> => {
  const output: Record<string, string> = {};
  flattenRecord(record, output);
  return output;
};

const pick = (record: Record<string, unknown>, keys: string[]): string => {
  const normalized = new Map(Object.entries(flattenedRecord(record)).map(([key, value]) => [normalizedRecordKey(key), value]));
  for (const key of keys) {
    const value = normalized.get(normalizeHeader(key));
    if (value) return value;
  }
  return '';
};

const toConnection = (record: Record<string, unknown>, filename: string, sourceId: string, fallbackName: string): ImportedConnection | null => {
  const protocol = pick(record, ['Protocol Name', 'Protocol', 'Protocol Type']);
  if (protocol && !/(?:ssh|sftp)/iu.test(protocol)) return null;
  const address = pick(record, ['Hostname', 'Host', 'Address']);
  if (!address) return null;
  const sessionName = pick(record, ['SessionName', 'Name']) || fallbackName;
  const sessionPath = normalizePath(sessionName);
  const name = sessionPath.at(-1) ?? fallbackName;
  const identityFile = pick(record, ['IdentityFile', 'Identity File', 'PublicKeyFile', 'PublicKey', 'KeyFile']);
  const password = pick(record, ['Password', 'PasswordV2', 'Password V2', 'EncryptedPassword']);
  const authType = inferAuthType({ identityFile, password });
  const firewallValue = pick(record, ['Firewall', 'Firewall Name', 'JumpHost', 'ProxyServer', 'Proxy Server']);
  const firewall = /^(?:none|no|disabled)$/iu.test(firewallValue) ? '' : firewallValue;
  const firewallPort = parseSecurePort(pick(record, ['FirewallPort', 'Firewall Port', 'JumpPort', 'ProxyPort']));
  const firewallUser = pick(record, ['FirewallUsername', 'Firewall Username', 'JumpUser', 'ProxyUsername', 'Proxy Username']);
  const fileParts = filename.split(/[\\/]/u).filter(Boolean);
  const directoryParts = fileParts.slice(0, -1);
  const sessionDirectory = directoryParts[0]?.toLowerCase() === 'sessions' ? directoryParts.slice(1) : directoryParts;
  const fileGroupPath = normalizePath(sessionDirectory.join('/'));
  const explicitGroupPath = normalizePath(pick(record, ['Folder', 'Group']));
  const connection: ImportedConnection = {
    sourceId,
    name,
    address,
    port: parseSecurePort(pick(record, ['Port', 'Port Number', 'SSH2 Port', '[SSH2] Port'])),
    username: pick(record, ['Username', 'User']),
    authType,
    credentialState: credentialStateForFields({ authType, identityFile, protectedCredential: Boolean(password), referenceOnly: Boolean(identityFile) }),
    ...(identityFile ? { credentialSource: identityFile, identityFile } : {}),
    groupPath: sessionPath.length > 1 ? sessionPath.slice(0, -1) : [...fileGroupPath, ...explicitGroupPath],
    tags: [],
    jumpHostSourceIds: firewall ? [`securecrt:gateway:${firewall}:${firewallPort}:${firewallUser}`] : [],
    notes: [],
    sourceFields: redactSourceFields(flattenedRecord(record))
  };
  if (password) connection.notes.push('SecureCRT 密码受保护，未尝试解密');
  return connection;
};

export const parseSecureCrtIni = (content: string, filename = 'session.ini'): ImportDocument => {
  const values: Record<string, unknown> = {};
  for (const line of content.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const match = /^\s*[A-Z]:"([^"]+)"=(.*)\s*$/u.exec(line);
    if (match) {
      values[match[1]] = match[2];
      continue;
    }
    const simple = /^\s*([^=:#]+?)=(.*)\s*$/u.exec(line);
    if (simple && !simple[1].trim().startsWith(';')) values[simple[1].trim()] = simple[2].trim();
  }
  const protocol = pick(values, ['Protocol Name', 'Protocol', 'Protocol Type']);
  if (protocol && !/(?:ssh|sftp)/iu.test(protocol)) {
    return documentFromConnections('securecrt', filename, [], [`${filename} 的协议 ${protocol} 不是 SSH/SFTP，已跳过`]);
  }
  const connection = toConnection(values, filename, `securecrt:${fileStem(filename)}`, fileStem(filename));
  return documentFromConnections('securecrt', filename, connection ? [connection] : [], connection ? [] : [`${filename} 未找到 SecureCRT 主机字段`]);
};

export const parseSecureCrtXml = (content: string, filename = 'settings.xml'): ImportDocument => {
  let parsed: unknown;
  try {
    parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: true }).parse(content);
  } catch {
    return documentFromConnections('securecrt', filename, [], [`${filename} XML 无法解析`]);
  }
  const connections: ImportedConnection[] = [];
  const warnings: string[] = [];
  const walk = (value: unknown, path: string[]): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, [...path, String(index)]));
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    const protocol = pick(record, ['Protocol Name', 'Protocol', 'Protocol Type']);
    if (protocol && !/(?:ssh|sftp)/iu.test(protocol)) {
      warnings.push(`${filename}:${path.join('.')} 的协议 ${protocol} 不是 SSH/SFTP，已跳过`);
      return;
    }
    const directKeys = new Set(Object.keys(record).map(normalizedRecordKey));
    const hasDirectAddress = ['hostname', 'host', 'address'].some((key) => directKeys.has(key));
    const isSessionNode = path.some((part) => /session/iu.test(part));
    const connection = hasDirectAddress || isSessionNode
      ? toConnection(record, filename, `securecrt:${path.join('.')}`, fileStem(filename))
      : null;
    if (connection) connections.push(connection);
    for (const [key, child] of Object.entries(record)) walk(child, [...path, key]);
  };
  walk(parsed, ['root']);
  return documentFromConnections('securecrt', filename, connections, [...new Set(warnings)]);
};
