import type { ExistingImportHost, ImportConflict, ImportedConnection } from './types.js';

export interface ResolvedImportedConnection extends ImportedConnection {
  conflicts: ImportConflict[];
  applicable: boolean;
}

export interface ImportResolutionResult {
  connections: ResolvedImportedConnection[];
  conflicts: ImportConflict[];
  warnings: string[];
}

const normalizePart = (value: string): string => value.trim().toLowerCase();

export const stableImportKey = (connection: Pick<ImportedConnection, 'address' | 'port' | 'username'>): string => (
  `${normalizePart(connection.address).replace(/^\[|\]$/gu, '')}|${connection.port}|${normalizePart(connection.username)}`
);

const uniqueConflicts = (conflicts: ImportConflict[]): ImportConflict[] => {
  const seen = new Set<string>();
  return conflicts.filter((conflict) => {
    const key = `${conflict.kind}:${conflict.sourceIds.join(',')}:${conflict.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const jumpReferenceMatches = (reference: string, connection: ImportedConnection): boolean => {
  if (reference === connection.sourceId) return true;
  const normalizedReference = normalizePart(reference);
  const normalizedName = normalizePart(connection.name);
  if (normalizedReference === normalizedName || normalizedReference.endsWith(`:${normalizedName}`)) return true;
  const endpoint = /^([^@]+)@(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/u.exec(reference);
  if (endpoint) {
    const address = endpoint[2] ?? endpoint[3] ?? '';
    const port = endpoint[4] ? Number(endpoint[4]) : 22;
    if (stableImportKey({ address, port, username: endpoint[1] }) === stableImportKey(connection)) return true;
  }
  const gateway = /:gateway:([^:]+):(\d+):(.*)$/u.exec(reference);
  if (gateway) {
    return stableImportKey({ address: gateway[1], port: Number(gateway[2]), username: gateway[3] }) === stableImportKey(connection);
  }
  return false;
};

export const resolveImportConnections = (
  input: readonly ImportedConnection[],
  existingHosts: readonly ExistingImportHost[] = []
): ImportResolutionResult => {
  const allConflicts: ImportConflict[] = [];
  const deduplicated: ImportedConnection[] = [];
  const byKey = new Map<string, ImportedConnection>();
  for (const connection of input) {
    const key = connection.address.trim() ? stableImportKey(connection) : `invalid:${connection.sourceId}`;
    const existing = byKey.get(key);
    if (existing) {
      allConflicts.push({ kind: 'same-batch', sourceIds: [existing.sourceId, connection.sourceId], message: `与 ${existing.name} 指向同一主机` });
      continue;
    }
    byKey.set(key, connection);
    deduplicated.push(connection);
  }

  const sourceIndex = new Map(deduplicated.map((connection) => [connection.sourceId, connection]));
  const nameIndex = new Map(deduplicated.map((connection) => [normalizePart(connection.name), connection]));
  const resolved: ResolvedImportedConnection[] = deduplicated.map((connection) => {
    const conflicts: ImportConflict[] = [];
    const resolvedJumps: string[] = [];
    for (const reference of connection.jumpHostSourceIds) {
      const target = sourceIndex.get(reference) ?? nameIndex.get(normalizePart(reference.replace(/^.*?:gateway:/u, '').split(':')[0])) ?? deduplicated.find((candidate) => jumpReferenceMatches(reference, candidate));
      if (!target || target.sourceId === connection.sourceId) {
        const conflict = { kind: 'unresolved-jump' as const, sourceIds: [connection.sourceId, reference], message: `找不到跳板机 ${reference}` };
        conflicts.push(conflict);
        allConflicts.push(conflict);
      } else {
        resolvedJumps.push(target.sourceId);
      }
    }
    const existing = existingHosts.find((candidate) => stableImportKey(candidate) === stableImportKey(connection));
    if (existing) {
      const conflict = { kind: 'existing-host' as const, sourceIds: [connection.sourceId, existing.id], message: `已存在同地址、端口和用户的服务器 ${existing.name}` };
      conflicts.push(conflict);
      allConflicts.push(conflict);
    }
    return {
      ...connection,
      jumpHostSourceIds: [...new Set(resolvedJumps)],
      conflicts,
      applicable: connection.credentialState === 'ready' && !conflicts.some((conflict) => conflict.kind === 'unresolved-jump')
    };
  });

  return {
    connections: resolved,
    conflicts: uniqueConflicts(allConflicts),
    warnings: resolved.flatMap((connection) => connection.conflicts.map((conflict) => conflict.message))
  };
};
