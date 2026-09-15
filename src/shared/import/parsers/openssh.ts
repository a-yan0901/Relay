import type { ImportDocument, ImportedConnection } from '../types.js';
import { credentialStateForFields, inferAuthType, normalizeScalar, parsePort } from '../normalize.js';
import { documentFromConnections, splitReferenceList } from './common.js';

interface SshConfigBlock {
  patterns: string[];
  values: Map<string, string[]>;
}

const stripComment = (line: string): string => {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (character === '#' && !quoted) return line.slice(0, index);
  }
  return line;
};

const tokenize = (value: string): string[] => {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of value.trim()) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += character;
    }
  }
  if (escaped) current += '\\';
  if (current) tokens.push(current);
  return tokens;
};

const addValue = (map: Map<string, string[]>, key: string, value: string): void => {
  const normalizedKey = key.toLowerCase();
  const values = map.get(normalizedKey) ?? [];
  values.push(value);
  map.set(normalizedKey, values);
};

const first = (map: Map<string, string[]>, key: string): string | undefined => map.get(key.toLowerCase())?.at(-1);

const hasWildcard = (pattern: string): boolean => /[*?!]/u.test(pattern);

const mergeValues = (...maps: Map<string, string[]>[]): Map<string, string[]> => {
  const result = new Map<string, string[]>();
  for (const map of maps) {
    for (const [key, values] of map) result.set(key, [...values]);
  }
  return result;
};

const sourceFieldsFor = (values: Map<string, string[]>, alias: string): Record<string, string> => {
  const fields: Record<string, string> = { Host: alias };
  for (const key of ['hostname', 'port', 'user', 'identityfile', 'proxyjump', 'proxycommand']) {
    const value = first(values, key);
    if (value) fields[key] = key === 'proxycommand' ? '[unsupported]' : value;
  }
  return fields;
};

export const parseOpenSshConfig = (content: string, filename = 'config'): ImportDocument => {
  const blocks: SshConfigBlock[] = [];
  const global = new Map<string, string[]>();
  let current: SshConfigBlock | undefined;
  const warnings: string[] = [];

  for (const [lineIndex, originalLine] of content.split(/\r?\n/u).entries()) {
    const line = stripComment(originalLine).trim();
    if (!line) continue;
    const separator = line.search(/[=\s]/u);
    if (separator <= 0) {
      warnings.push(`${filename}:${lineIndex + 1} 无法解析配置行`);
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator).replace(/^\s*=?\s*/u, '').trim();
    if (key.toLowerCase() === 'host') {
      current = { patterns: tokenize(value), values: new Map() };
      blocks.push(current);
    } else if (current) {
      addValue(current.values, key, value);
    } else {
      addValue(global, key, value);
    }
  }

  const wildcardDefaults = blocks
    .filter((block) => block.patterns.some(hasWildcard))
    .reduce((result, block) => mergeValues(result, block.values), new Map<string, string[]>());
  const concreteBlocks = blocks.filter((block) => block.patterns.some((pattern) => !hasWildcard(pattern)));
  const connections: ImportedConnection[] = [];

  for (const block of concreteBlocks) {
    for (const alias of block.patterns.filter((pattern) => !hasWildcard(pattern))) {
      const values = mergeValues(global, wildcardDefaults, block.values);
      const hostNameTemplate = first(values, 'hostname') ?? alias;
      const address = hostNameTemplate.replaceAll('%h', alias);
      const identityFile = first(values, 'identityfile');
      const proxyJump = first(values, 'proxyjump');
      const proxyCommand = first(values, 'proxycommand');
      const jumpHostSourceIds = proxyJump ? splitReferenceList(proxyJump).map((reference) => `openssh:${reference}`) : [];
      const authType = inferAuthType({ identityFile });
      const connection: ImportedConnection = {
        sourceId: `openssh:${alias}`,
        name: alias,
        address,
        port: parsePort(first(values, 'port')),
        username: normalizeScalar(first(values, 'user')),
        authType,
        credentialState: credentialStateForFields({ authType, identityFile, referenceOnly: Boolean(identityFile) }),
        ...(identityFile ? { credentialSource: identityFile, identityFile } : {}),
        groupPath: [],
        tags: [],
        jumpHostSourceIds,
        notes: [],
        sourceFields: sourceFieldsFor(values, alias)
      };
      if (proxyCommand) {
        connection.notes.push('ProxyCommand 未转换为跳板机');
        warnings.push(`${filename}:${alias} 使用了不支持的 ProxyCommand`);
      }
      if (hostNameTemplate.includes('%')) {
        connection.notes.push('HostName 包含未解析的 OpenSSH token');
        warnings.push(`${filename}:${alias} 的 HostName 包含未解析 token`);
      }
      connections.push(connection);
    }
  }
  return documentFromConnections('openssh-config', filename, connections, warnings);
};
