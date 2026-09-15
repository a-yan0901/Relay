import { AppError } from '../errors.js';
import type { ExportOptions, ImportedConnection } from './types.js';

const safeAlias = (value: string, fallback: string): string => {
  const normalized = value.trim().replaceAll(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return normalized || fallback;
};

const aliasesFor = (connections: readonly ImportedConnection[]): Map<string, string> => {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  connections.forEach((connection, index) => {
    const base = safeAlias(connection.name, `host-${index + 1}`);
    let alias = base;
    let suffix = 2;
    while (used.has(alias.toLowerCase())) alias = `${base}-${suffix++}`;
    used.add(alias.toLowerCase());
    aliases.set(connection.sourceId, alias);
  });
  return aliases;
};

const quoteOpenSsh = (value: string): string => /^[A-Za-z0-9._:@/~+%-]+$/u.test(value) ? value : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export const exportOpenSshConfig = (connections: readonly ImportedConnection[]): string => {
  const aliases = aliasesFor(connections);
  return connections.map((connection, index) => {
    const alias = aliases.get(connection.sourceId) ?? `host-${index + 1}`;
    const lines = [`Host ${quoteOpenSsh(alias)}`, `  HostName ${quoteOpenSsh(connection.address)}`];
    if (connection.port !== 22) lines.push(`  Port ${connection.port}`);
    if (connection.username) lines.push(`  User ${quoteOpenSsh(connection.username)}`);
    if (connection.identityFile) lines.push(`  IdentityFile ${quoteOpenSsh(connection.identityFile)}`);
    const jumps = connection.jumpHostSourceIds.map((sourceId) => aliases.get(sourceId) ?? sourceId.replace(/^.*?:/u, '')).filter(Boolean);
    if (jumps.length > 0) lines.push(`  ProxyJump ${jumps.map(quoteOpenSsh).join(',')}`);
    return lines.join('\n');
  }).join('\n\n') + (connections.length > 0 ? '\n' : '');
};

const csvValue = (value: string): string => /[,"\r\n]/u.test(value) ? `"${value.replaceAll('"', '""')}"` : value;

export const exportGenericCsv = (connections: readonly ImportedConnection[], options: ExportOptions = {}): string => {
  if (options.includePasswords && !options.confirmPasswordExport) {
    throw new AppError('IMPORT_APPLY_INVALID', '导出密码需要二次确认');
  }
  const aliases = aliasesFor(connections);
  const columns = ['name', 'address', 'port', 'username', 'authType', 'identityFile', 'group', 'tags', 'jumpHosts'];
  if (options.includePasswords) columns.push('password');
  const rows = [columns.join(',')];
  for (const connection of connections) {
    const jumps = connection.jumpHostSourceIds.map((sourceId) => aliases.get(sourceId) ?? sourceId).join(';');
    const values = [
      connection.name,
      connection.address,
      String(connection.port),
      connection.username,
      connection.authType,
      connection.identityFile ?? '',
      connection.groupPath.join('/'),
      connection.tags.join(';'),
      jumps
    ];
    if (options.includePasswords) values.push(connection.credential?.type === 'password' ? connection.credential.password : '');
    rows.push(values.map(csvValue).join(','));
  }
  return `${rows.join('\r\n')}\r\n`;
};
