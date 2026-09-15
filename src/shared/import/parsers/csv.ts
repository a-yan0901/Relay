import type { ImportDocument, ImportedConnection } from '../types.js';
import { credentialStateForFields, inferAuthType, normalizeHeader, normalizePath, normalizeTags, parsePort, redactSourceFields } from '../normalize.js';
import { documentFromConnections, splitReferenceList } from './common.js';

const parseCsvRows = (content: string): string[][] => {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        value += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        value += character;
      }
    } else if (character === '"' && value.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(value);
      value = '';
    } else if (character === '\n') {
      row.push(value.endsWith('\r') ? value.slice(0, -1) : value);
      if (row.some((item) => item.length > 0)) rows.push(row);
      row = [];
      value = '';
    } else {
      value += character;
    }
  }
  if (value.length > 0 || row.length > 0) {
    row.push(value.endsWith('\r') ? value.slice(0, -1) : value);
    if (row.some((item) => item.length > 0)) rows.push(row);
  }
  return rows;
};

const aliases = {
  name: ['name', 'label', 'title', 'session', 'sessionname', 'connection'],
  address: ['host', 'address', 'hostname', 'remotehost', 'ip', 'server'],
  port: ['port', 'sshport', 'portnumber'],
  username: ['user', 'username', 'login'],
  password: ['password', 'pass'],
  passphrase: ['passphrase', 'keypassphrase'],
  privateKey: ['privatekey', 'key', 'privatekeycontent', 'keycontent'],
  identityFile: ['identityfile', 'identity', 'keypath', 'privatekeypath', 'keyfile', 'keyfilepath'],
  group: ['group', 'folder', 'folderpath', 'foldername', 'path'],
  tags: ['tags', 'tag', 'labels'],
  jump: ['jumphost', 'jumphosts', 'jump', 'proxyjump', 'bastion', 'gatewayhost'],
  authType: ['authtype', 'authentication', 'authenticationtype', 'authmethod'],
  sessionType: ['sessiontype', 'protocol', 'protocolname', 'type']
} as const;

const findValue = (record: Map<string, string>, names: readonly string[]): string => {
  for (const name of names) {
    const value = record.get(name);
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return '';
};

export const parseSshCsv = (content: string, filename = 'connections.csv'): ImportDocument => {
  const rows = parseCsvRows(content.replace(/^\uFEFF/u, ''));
  const [headerRow, ...dataRows] = rows;
  if (!headerRow) return documentFromConnections('ssh-csv', filename, [], ['CSV 没有表头']);
  const headers = headerRow.map(normalizeHeader);
  const warnings: string[] = [];
  const connections: ImportedConnection[] = [];

  for (const [rowIndex, values] of dataRows.entries()) {
    const record = new Map(headers.map((header, index) => [header, values[index] ?? '']));
    const sessionType = findValue(record, aliases.sessionType);
    if (sessionType && !/(?:ssh|sftp)/iu.test(sessionType)) {
      warnings.push(`${filename}:row ${rowIndex + 2} 协议 ${sessionType} 不是 SSH/SFTP，已跳过`);
      continue;
    }
    const name = findValue(record, aliases.name);
    const address = findValue(record, aliases.address);
    const username = findValue(record, aliases.username);
    const password = findValue(record, aliases.password);
    const privateKey = findValue(record, aliases.privateKey);
    const passphrase = findValue(record, aliases.passphrase);
    const privateKeyContent = /^\s*-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/mu.test(privateKey) ? privateKey.trim() : '';
    const identityFile = findValue(record, aliases.identityFile) || (privateKeyContent ? '' : privateKey);
    const inferredAuthType = inferAuthType({ password, privateKey: privateKeyContent, identityFile });
    const declaredAuthType = findValue(record, aliases.authType).toLowerCase();
    const authType = inferredAuthType !== 'unknown'
      ? inferredAuthType
      : /(?:private|key|certificate)/u.test(declaredAuthType)
        ? 'private_key'
        : /(?:password|pass)/u.test(declaredAuthType)
          ? 'password'
          : 'unknown';
    const sourceFields = redactSourceFields(Object.fromEntries(record));
    const connection: ImportedConnection = {
      sourceId: `csv:${rowIndex + 1}`,
      name: name || address || `CSV row ${rowIndex + 2}`,
      address,
      port: parsePort(findValue(record, aliases.port)),
      username,
      authType,
      credentialState: credentialStateForFields({ authType, password, privateKey: privateKeyContent || undefined, referenceOnly: Boolean(identityFile && !privateKeyContent) }),
      ...(identityFile ? { credentialSource: identityFile, identityFile } : {}),
      ...(password ? { credential: { type: 'password', password } } : {}),
      ...(privateKeyContent ? { credential: { type: 'private_key', privateKey: privateKeyContent, ...(passphrase ? { passphrase } : {}) } } : {}),
      groupPath: normalizePath(findValue(record, aliases.group)),
      tags: normalizeTags(findValue(record, aliases.tags)),
      jumpHostSourceIds: splitReferenceList(findValue(record, aliases.jump)).map((reference) => `csv:${reference}`),
      notes: [],
      sourceFields
    };
    if (!address) {
      connection.notes.push('缺少主机地址');
      warnings.push(`${filename}:row ${rowIndex + 2} 缺少主机地址`);
    }
    if (!username) connection.notes.push('缺少用户名');
    connections.push(connection);
  }
  return documentFromConnections('ssh-csv', filename, connections, warnings);
};
