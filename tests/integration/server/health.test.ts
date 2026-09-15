import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { createServerApp } from '../../../src/server/index.js';
import { loadConfig } from '../../../src/server/config.js';

const handles: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

describe('health and version endpoints', () => {
  it('returns stable non-sensitive health and version shapes', async () => {
    const handle = await createServerApp({
      nodeEnv: 'test',
      port: 0,
      dataDir: ':memory:',
      trustedOrigins: ['http://localhost:4173'],
      sessionIdleTimeoutMs: 60_000,
      maxSessions: 4,
      logLevel: 'silent'
    });
    handles.push(handle);

    const health = await handle.app.inject('/healthz');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok' });
    expect(health.body).not.toContain('database');
    expect(health.body).not.toContain('dataDir');

    const version = await handle.app.inject('/api/version');
    expect(version.statusCode).toBe(200);
    expect(version.json()).toEqual(expect.objectContaining({ name: 'web-ssh-workspace', version: expect.any(String) }));
    expect(version.body).not.toContain('TRUSTED_ORIGINS');

    const capabilities = await handle.app.inject('/api/capabilities');
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toEqual(expect.objectContaining({
      client: 'web',
      version: 1,
      capabilities: expect.arrayContaining(['ssh.shell', 'sftp.transfer', 'automation.batch-exec'])
    }));
  });

  it('serves the SPA entry point and falls back for browser routes', async () => {
    const handle = await createServerApp({
      nodeEnv: 'test',
      port: 0,
      dataDir: ':memory:',
      trustedOrigins: ['http://localhost:4173'],
      sessionIdleTimeoutMs: 60_000,
      maxSessions: 4,
      logLevel: 'silent'
    }, { webRoot: resolve('tests/fixtures/web') });
    handles.push(handle);

    const root = await handle.app.inject('/');
    expect(root.statusCode).toBe(200);
    expect(root.headers['content-type']).toContain('text/html');
    expect(root.body).toContain('webssh static fixture');

    const browserRoute = await handle.app.inject({
      method: 'GET',
      url: '/terminal/demo',
      headers: { accept: 'text/html' }
    });
    expect(browserRoute.statusCode).toBe(200);
    expect(browserRoute.body).toContain('webssh static fixture');
  });

  it('accepts the wildcard bind address as a development browser origin', async () => {
    const handle = await createServerApp(loadConfig({ NODE_ENV: 'development', DATA_DIR: ':memory:' }));
    handles.push(handle);

    const setup = await handle.app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { origin: 'http://0.0.0.0:5173' },
      payload: { masterPassword: 'development-origin-fixture-password' }
    });
    expect(setup.statusCode).toBe(201);
  });
});
