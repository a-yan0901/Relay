import { afterEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';

import { createServerApp } from '../../../src/server/index.js';

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
});
