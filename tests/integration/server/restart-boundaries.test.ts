import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createServerApp, type ServerHandle } from '../../../src/server/index.js';

const MASTER_PASSWORD = 'correct horse battery staple';
const EXPORT_PASSWORD = 'separate export password';
const handles: ServerHandle[] = [];
const dataDirectories: string[] = [];

const configFor = (dataDir: string) => ({
  nodeEnv: 'test' as const,
  port: 0,
  dataDir,
  trustedOrigins: ['http://localhost:4173'],
  sessionIdleTimeoutMs: 60_000,
  maxSessions: 4,
  logLevel: 'silent' as const
});

const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('expected session cookie');
  return value.split(';', 1)[0];
};

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
  for (const directory of dataDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('restart and lock boundaries', () => {
  it('keeps host/workspace data across restart and rejects operations after lock', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'webssh-restart-boundary-'));
    dataDirectories.push(dataDir);
    const first = await createServerApp(configFor(dataDir));
    handles.push(first);

    const setup = await first.app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const firstCookie = cookieFrom(setup);
    const host = await first.app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie: firstCookie },
      payload: { name: 'Restart fixture', address: '127.0.0.1', username: 'fixture', auth: { type: 'password', password: 'fixture-password' } }
    });
    expect(host.statusCode).toBe(201);
    const hostId = (host.json() as { id: string }).id;
    const workspace = {
      version: 0,
      tabs: [{ id: 'tab-restart', hostId }],
      activeTabId: 'tab-restart',
      layout: { mode: 'vertical', ratio: 0.65 },
      filters: { query: 'restart', groupId: null, favoriteOnly: false }
    };
    const saved = await first.app.inject({ method: 'PUT', url: '/api/workspace', headers: { cookie: firstCookie }, payload: { expectedVersion: 0, state: workspace } });
    expect(saved.statusCode).toBe(200);
    const exported = await first.app.inject({ method: 'POST', url: '/api/vault/export', headers: { cookie: firstCookie }, payload: { exportPassword: EXPORT_PASSWORD } });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(EXPORT_PASSWORD);
    expect(exported.body).not.toContain('fixture-password');

    const locked = await first.app.inject({ method: 'POST', url: '/api/session/lock', headers: { cookie: firstCookie } });
    expect(locked.statusCode).toBe(204);
    expect((await first.app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie: firstCookie } })).json().error.code).toBe('SESSION_INVALID');
    await first.close();

    const second = await createServerApp(configFor(dataDir));
    handles.push(second);
    expect((await second.app.inject({ method: 'GET', url: '/api/setup/status' })).json()).toEqual({ initialized: true, locked: true });
    expect(second.sshSessionManager.reattach('default:terminal-after-restart')).toBeNull();
    const unlocked = await second.app.inject({ method: 'POST', url: '/api/session/unlock', payload: { masterPassword: MASTER_PASSWORD } });
    const secondCookie = cookieFrom(unlocked);
    const hosts = await second.app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie: secondCookie } });
    expect(hosts.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: hostId, name: 'Restart fixture' })]));
    const restored = await second.app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie: secondCookie } });
    expect(restored.json()).toMatchObject({ tabs: workspace.tabs, activeTabId: workspace.activeTabId, layout: workspace.layout });

    const wrongBundlePassword = await second.app.inject({ method: 'POST', url: '/api/vault/import/preview', headers: { cookie: secondCookie }, payload: { exportPassword: 'wrong export password', bundle: exported.json().bundle } });
    expect(wrongBundlePassword.statusCode).toBe(400);
    expect(wrongBundlePassword.json().error.code).toBe('VAULT_BUNDLE_INVALID');
    const preview = await second.app.inject({ method: 'POST', url: '/api/vault/import/preview', headers: { cookie: secondCookie }, payload: { exportPassword: EXPORT_PASSWORD, bundle: exported.json().bundle } });
    expect(preview.statusCode).toBe(200);
    expect((await second.app.inject({ method: 'POST', url: '/api/vault/import/apply', headers: { cookie: secondCookie }, payload: { previewId: preview.json().previewId, resolution: { hostConflicts: 'skip', groupConflicts: 'reuse' } } })).statusCode).toBe(200);
  });
});
