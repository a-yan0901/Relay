import { documentFromConnections, splitReferenceList } from './common.js';
import type { ImportDocument, ImportedConnection } from '../types.js';
import { credentialStateForFields, normalizePath, normalizeScalar, parsePort } from '../normalize.js';

const MOBA_FIELDS = [
  'sessionType', 'remoteHost', 'port', 'username', 'empty1', 'x11Forward', 'compression', 'command',
  'gatewayHost', 'gatewayPort', 'gatewayUser', 'noExit', 'useUsername', 'remoteEnv', 'privateKeyPath',
  'gatewayPrivateKeyPath', 'sshBrowserType', 'followSshPath', 'empty2', 'proxyType', 'proxyHost', 'proxyPort',
  'proxyLogin', 'adaptRemoteLocals', 'fileBrowser', 'fileBrowserProtocol', 'localProxyCommand', 'sshVersion',
  'keyExchangeAlgorithm', 'hostKeyTypes', 'ciphers', 'disconnectNoAuth', 'preferredHostKeyAlgorithm',
  'useSshAgentAuth', 'allowAgentForwarding'
] as const;

const decodeMobaText = (content: string | Uint8Array): string => {
  if (typeof content === 'string') return content;
  return new globalThis.TextDecoder('windows-1252', { fatal: false }).decode(content);
};

const parseSections = (content: string): Array<{ name: string; values: Map<string, string> }> => {
  const sections: Array<{ name: string; values: Map<string, string> }> = [];
  let current: { name: string; values: Map<string, string> } | undefined;
  for (const line of content.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const section = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (section) {
      current = { name: section[1], values: new Map() };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    current.values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return sections;
};

const parseSession = (value: string): Map<string, string> | null => {
  const groups = value.split('#');
  if (groups.length < 3) return null;
  const fields = groups[2].split('%');
  if (fields.length < 4) return null;
  return new Map(MOBA_FIELDS.map((field, index) => [field, fields[index] ?? '']));
};

const sessionTypeIsSsh = (value: string): boolean => value === '0' || value === '7';

const gatewaySourceId = (host: string, port: number, username: string): string => `mobaxterm:gateway:${host}:${port}:${username}`;

export const parseMobaXterm = (content: string | Uint8Array, filename = 'MobaXterm.mxtsessions'): ImportDocument => {
  const decoded = decodeMobaText(content);
  const sections = parseSections(decoded);
  const connections: ImportedConnection[] = [];
  const warnings: string[] = [];
  let bookmarkIndex = 0;
  for (const section of sections) {
    if (!/^Bookmarks(?:_\d+)?$/iu.test(section.name)) continue;
    const groupPath = normalizePath(section.values.get('SubRep') ?? '');
    for (const [name, rawValue] of section.values) {
      if (name === 'SubRep' || name === 'ImgNum') continue;
      const fields = parseSession(rawValue);
      if (!fields) {
        warnings.push(`${filename}:${name} 会话编码无效`);
        continue;
      }
      if (!sessionTypeIsSsh(fields.get('sessionType') ?? '')) {
        warnings.push(`${filename}:${name} 不是 SSH/SFTP 会话，已跳过`);
        continue;
      }
      const address = normalizeScalar(fields.get('remoteHost'));
      const username = normalizeScalar(fields.get('username'));
      if (!address || !username) {
        warnings.push(`${filename}:${name} 缺少远程主机或用户名，已跳过`);
        continue;
      }
      const identityFile = normalizeScalar(fields.get('privateKeyPath'));
      const gatewayHosts = splitReferenceList(normalizeScalar(fields.get('gatewayHost')));
      const gatewayPorts = splitReferenceList(normalizeScalar(fields.get('gatewayPort')));
      const gatewayUsers = splitReferenceList(normalizeScalar(fields.get('gatewayUser')));
      const authType = identityFile ? 'private_key' : 'unknown';
      const connection: ImportedConnection = {
        sourceId: `mobaxterm:${bookmarkIndex}:${name}`,
        name,
        address,
        port: parsePort(fields.get('port')),
        username,
        authType,
        credentialState: credentialStateForFields({ authType, identityFile, referenceOnly: Boolean(identityFile) }),
        ...(identityFile ? { credentialSource: identityFile, identityFile } : {}),
        groupPath,
        tags: [],
        jumpHostSourceIds: gatewayHosts.map((gatewayHost, index) => gatewaySourceId(gatewayHost, parsePort(gatewayPorts[index]), gatewayUsers[index] ?? '')),
        notes: [],
        sourceFields: {
          SessionType: fields.get('sessionType') ?? '',
          Host: address,
          Port: fields.get('port') ?? '',
          Username: username,
          ...(identityFile ? { IdentityFile: identityFile } : {}),
          ...(gatewayHosts.length > 0 ? { GatewayHost: gatewayHosts.join(','), GatewayPort: gatewayPorts.join(','), GatewayUser: gatewayUsers.join(',') } : {})
        }
      };
      if (fields.get('localProxyCommand')) {
        connection.notes.push('MobaXterm 本地代理命令未转换');
      }
      connections.push(connection);
      bookmarkIndex += 1;
    }
  }
  if (connections.length === 0 && (/\.mobaconf$/iu.test(filename) || /mobaconf|encrypted/iu.test(decoded))) {
    warnings.push(`${filename} 可能是受保护的 MobaXterm 配置，无法在没有源密码时读取`);
  }
  return documentFromConnections('mobaxterm', filename, connections, warnings);
};
