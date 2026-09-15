import type { ImportDocument, ImportedConnection } from '../types.js';

export const documentFromConnections = (
  format: ImportDocument['source']['format'],
  filename: string,
  connections: ImportedConnection[],
  warnings: string[] = []
): ImportDocument => {
  const groups = new Map<string, { path: string[]; sourceId: string }>();
  for (const connection of connections) {
    if (connection.groupPath.length === 0) continue;
    const key = connection.groupPath.join('\u001f');
    if (!groups.has(key)) {
      groups.set(key, { path: [...connection.groupPath], sourceId: `group:${connection.groupPath.join('/')}` });
    }
  }
  return {
    format: 'ssh-connection-exchange',
    version: 1,
    source: { format, filename },
    groups: [...groups.values()],
    connections,
    warnings
  };
};

export const splitReferenceList = (value: string): string[] => value
  .split(/\s*,\s*|\s*;\s*/u)
  .map((item) => item.trim())
  .filter((item) => item.length > 0 && item.toLowerCase() !== 'none');
