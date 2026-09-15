import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { ConnectionPathResolver } from '../../../src/server/ssh/connection-path.js';

interface Node {
  id: string;
  ownerId: string;
  address: string;
  port: number;
  username: string;
  jumpHostIds: string[];
}

const node = (id: string, jumpHostIds: string[] = [], ownerId = 'owner-a'): Node => ({
  id,
  ownerId,
  address: `${id}.internal`,
  port: 22,
  username: 'ops',
  jumpHostIds
});

const resolver = (nodes: Node[]): ConnectionPathResolver => new ConnectionPathResolver({
  get: (id: string, ownerId: string) => nodes.find((candidate) => candidate.id === id && candidate.ownerId === ownerId) ?? null,
  list: (ownerId: string) => nodes.filter((candidate) => candidate.ownerId === ownerId)
});

describe('ConnectionPathResolver', () => {
  it('resolves direct and multi-hop paths in transport order', () => {
    const direct = resolver([node('target')]).resolve('target', 'owner-a');
    expect(direct.hops.map((hop) => hop.id)).toEqual(['target']);

    const multiHop = resolver([node('target', ['jump-1']), node('jump-1', ['jump-2']), node('jump-2')])
      .resolve('target', 'owner-a');
    expect(multiHop.hops.map((hop) => hop.id)).toEqual(['jump-2', 'jump-1', 'target']);
    expect(multiHop.hopCount).toBe(2);
  });

  it('accepts at most four jump hosts and rejects a missing host', () => {
    const nodes = [
      node('target', ['jump-1']),
      node('jump-1', ['jump-2']),
      node('jump-2', ['jump-3']),
      node('jump-3', ['jump-4']),
      node('jump-4')
    ];
    expect(resolver(nodes).resolve('target', 'owner-a').hops).toHaveLength(5);
    expect(() => resolver([node('target', ['missing'])]).resolve('target', 'owner-a'))
      .toThrowError(new AppError('HOST_NOT_FOUND'));
  });

  it('rejects self references, indirect cycles, and a sixth path host', () => {
    expect(() => resolver([node('target', ['target'])]).resolve('target', 'owner-a'))
      .toThrowError(new AppError('HOST_VALIDATION_FAILED'));
    expect(() => resolver([node('target', ['jump']), node('jump', ['target'])]).resolve('target', 'owner-a'))
      .toThrowError(new AppError('HOST_VALIDATION_FAILED'));
    expect(() => resolver([
      node('target', ['j1']), node('j1', ['j2']), node('j2', ['j3']), node('j3', ['j4']), node('j4', ['j5']), node('j5')
    ]).resolve('target', 'owner-a')).toThrowError(new AppError('HOST_VALIDATION_FAILED'));
  });

  it('enforces owner isolation before resolving jump metadata', () => {
    expect(() => resolver([node('target', [], 'owner-b')]).resolve('target', 'owner-a'))
      .toThrowError(new AppError('HOST_NOT_FOUND'));
  });
});
