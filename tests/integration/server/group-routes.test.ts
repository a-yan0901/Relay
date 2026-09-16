import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';

const MASTER_PASSWORD = 'correct horse battery staple';
const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

const makeApp = async () => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  const app = await buildApp({
    database,
    config: {
      nodeEnv: 'test',
      port: 3000,
      dataDir: ':memory:',
      trustedOrigins: ['http://localhost:4173'],
      sessionIdleTimeoutMs: 60_000,
      maxSessions: 4,
      logLevel: 'silent'
    }
  });
  apps.push(app);
  return app;
};

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    throw new Error('expected session cookie');
  }
  return value.split(';', 1)[0];
};

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('group routes', () => {
  it('creates, orders, rejects duplicate names, patches, and deletes groups safely', async () => {
    const app = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);

    const created = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie },
      payload: { name: 'Production', sortOrder: 2 }
    });
    expect(created.statusCode).toBe(201);
    const group = json<{ id: string; name: string; sortOrder: number }>(created);
    expect(group).toEqual(expect.objectContaining({ name: 'Production', sortOrder: 2 }));

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie },
      payload: { name: 'Production' }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(duplicate).error.code).toBe('GROUP_ALREADY_EXISTS');

    const host = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Grouped Host',
        address: '10.0.0.9',
        username: 'ops',
        groupId: group.id,
        auth: { type: 'password', password: 'fixture-password' }
      }
    });
    const hostId = json<{ id: string }>(host).id;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/groups/${group.id}`,
      headers: { cookie },
      payload: { name: 'Production Servers', sortOrder: 1 }
    });
    expect(patched.statusCode).toBe(200);
    expect(json(patched)).toEqual(expect.objectContaining({ name: 'Production Servers', sortOrder: 1 }));

    const listed = await app.inject({ method: 'GET', url: '/api/groups', headers: { cookie } });
    expect(json<Array<{ id: string }>>(listed)).toEqual([expect.objectContaining({ id: group.id })]);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/groups/${group.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(204);
    const hostAfterDelete = await app.inject({ method: 'GET', url: `/api/hosts/${hostId}`, headers: { cookie } });
    expect(json<{ groupId: string | null }>(hostAfterDelete).groupId).toBeNull();
  });

  it('supports bounded nesting, inherited defaults, cycle rejection, and safe reparenting', async () => {
    const app = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);

    const identity = await app.inject({
      method: 'POST',
      url: '/api/identities',
      headers: { cookie },
      payload: {
        name: 'Operations',
        type: 'password',
        username: 'ops',
        auth: { type: 'password', password: 'identity-password' }
      }
    });
    const identityId = json<{ id: string }>(identity).id;
    const root = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie },
      payload: {
        name: 'Production',
        defaultIdentityId: identityId,
        connectionProfile: { keepaliveIntervalMs: 4_000 }
      }
    });
    const rootNode = json<{ id: string }>(root);
    const child = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie },
      payload: { name: 'API', parentId: rootNode.id }
    });
    const childNode = json<{ id: string; parentId: string | null; defaultIdentityId: string | null; connectionProfile: unknown }>(child);
    expect(childNode).toEqual(expect.objectContaining({
      parentId: rootNode.id,
      defaultIdentityId: null,
      connectionProfile: null
    }));

    const groupedHost = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Inherited API',
        address: '10.0.0.10',
        username: 'ops',
        groupId: childNode.id,
        credentialSource: { type: 'group' }
      }
    });
    expect(groupedHost.statusCode).toBe(201);
    expect(json<{ authType: string; identityName: string | null; identitySource: string; resolvedConnectionProfile: { keepaliveIntervalMs: number } }>(groupedHost)).toEqual(expect.objectContaining({
      authType: 'password',
      identityName: 'Operations',
      identitySource: 'group',
      resolvedConnectionProfile: expect.objectContaining({ keepaliveIntervalMs: 4_000 })
    }));

    const patchedHost = await app.inject({
      method: 'PATCH',
      url: `/api/hosts/${json<{ id: string }>(groupedHost).id}`,
      headers: { cookie },
      payload: { connectionProfile: { keepaliveCountMax: 7 } }
    });
    expect(patchedHost.statusCode).toBe(200);
    expect(json<{ connectionProfileOverrides: unknown; resolvedConnectionProfile: { keepaliveIntervalMs: number; keepaliveCountMax: number } }>(patchedHost)).toEqual(expect.objectContaining({
      connectionProfileOverrides: { keepaliveCountMax: 7 },
      resolvedConnectionProfile: expect.objectContaining({ keepaliveIntervalMs: 4_000, keepaliveCountMax: 7 })
    }));

    const cycle = await app.inject({
      method: 'PATCH',
      url: `/api/groups/${rootNode.id}`,
      headers: { cookie },
      payload: { parentId: childNode.id }
    });
    expect(cycle.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(cycle).error.code).toBe('GROUP_CYCLE');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/groups/${rootNode.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(204);
    const childAfterDelete = await app.inject({ method: 'GET', url: `/api/groups/${childNode.id}`, headers: { cookie } });
    expect(json<{ parentId: string | null }>(childAfterDelete).parentId).toBeNull();

    const blocked = await app.inject({ method: 'DELETE', url: `/api/groups/${childNode.id}`, headers: { cookie } });
    expect(blocked.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(blocked).error.code).toBe('GROUP_IN_USE');
    const groupedHostAfterBlockedDelete = await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie } });
    expect(json<Array<{ groupId: string | null }>>(groupedHostAfterBlockedDelete)[0]?.groupId).toBe(childNode.id);
  });
});
