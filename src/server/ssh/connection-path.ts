import { AppError } from '../../shared/errors.js';

export interface ConnectionPathHost {
  id: string;
  ownerId?: string;
  address: string;
  port: number;
  username: string;
  jumpHostIds?: readonly string[];
}

export interface ConnectionPathLookup {
  get(id: string, ownerId: string): ConnectionPathHost | null;
  list(ownerId: string): readonly ConnectionPathHost[];
}

export interface ConnectionPath {
  targetHostId: string;
  hopCount: number;
  hops: readonly ConnectionPathHost[];
}

export class ConnectionPathResolver {
  constructor(private readonly lookup: ConnectionPathLookup) {}

  resolve(targetHostId: string, ownerId: string): ConnectionPath {
    const profiles = new Map(this.lookup.list(ownerId).map((host) => [host.id, host]));
    const target = this.lookup.get(targetHostId, ownerId) ?? profiles.get(targetHostId) ?? null;
    if (!target) throw new AppError('HOST_NOT_FOUND');

    const chain: ConnectionPathHost[] = [];
    const active = new Set<string>();
    const visit = (hostId: string): void => {
      if (active.has(hostId)) throw new AppError('HOST_VALIDATION_FAILED');
      const host = profiles.get(hostId) ?? this.lookup.get(hostId, ownerId);
      if (!host) throw new AppError('HOST_NOT_FOUND');
      if (chain.length > 4) throw new AppError('HOST_VALIDATION_FAILED');
      active.add(hostId);
      for (const jumpHostId of host.jumpHostIds ?? []) visit(jumpHostId);
      active.delete(hostId);
      chain.push(host);
    };

    visit(target.id);
    if (chain.length > 5) throw new AppError('HOST_VALIDATION_FAILED');
    return {
      targetHostId: target.id,
      hopCount: chain.length - 1,
      hops: chain
    };
  }
}
