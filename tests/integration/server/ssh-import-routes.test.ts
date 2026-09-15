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
  const app = await buildApp({ database, config: {
    nodeEnv: 'test', port: 3000, dataDir: ':memory:', trustedOrigins: ['http://localhost:4173'],
    sessionIdleTimeoutMs: 60_000, maxSessions: 4, logLevel: 'silent'
  } });
  apps.push(app);
  return app;
};

const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('expected session cookie');
  return value.split(';', 1)[0];
};

const setup = async (app: Awaited<ReturnType<typeof makeApp>>): Promise<string> => cookieFrom(await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } }));

const multipart = (filename: string, content: string): { body: Buffer; contentType: string } => {
  const boundary = '----ssh-import-test-boundary';
  const body = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`
  ].join(''), 'utf8');
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
};

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const database of databases.splice(0)) database.close();
});

describe('SSH interoperability import/export routes', () => {
  it('requires an unlocked Vault and lists supported formats', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/api/import/formats' })).statusCode).toBe(401);
    const cookie = await setup(app);
    const response = await app.inject({ method: 'GET', url: '/api/import/formats', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(json<Array<{ id: string }>>(response).map((item) => item.id)).toContain('mobaxterm');
  });

  it('previews a multipart file without returning the CSV password and applies it', async () => {
    const app = await makeApp();
    const cookie = await setup(app);
    const upload = multipart('connections.csv', 'name,host,user,password\napp,app.example.com,deploy,secret-route-password\n');
    const previewResponse = await app.inject({ method: 'POST', url: '/api/import/preview', headers: { cookie, 'content-type': upload.contentType }, payload: upload.body });
    expect(previewResponse.statusCode).toBe(200);
    expect(previewResponse.body).not.toContain('secret-route-password');
    const preview = json<{ previewId: string; connections: Array<{ sourceId: string; credentialState: string }> }>(previewResponse);
    expect(preview.connections[0]).toMatchObject({ credentialState: 'ready' });

    const applied = await app.inject({ method: 'POST', url: '/api/import/apply', headers: { cookie }, payload: {
      previewId: preview.previewId,
      selectedSourceIds: [preview.connections[0].sourceId],
      conflictPolicy: 'create'
    } });
    expect(applied.statusCode).toBe(200);
    expect(json<{ importedHosts: number }>(applied).importedHosts).toBe(1);
  });

  it('exports standard text with safe content-disposition and no password by default', async () => {
    const app = await makeApp();
    const cookie = await setup(app);
    const created = await app.inject({ method: 'POST', url: '/api/hosts', headers: { cookie }, payload: { name: 'app', address: 'app.example.com', username: 'ops', auth: { type: 'password', password: 'route-password' } } });
    expect(created.statusCode).toBe(201);
    const openSsh = await app.inject({ method: 'GET', url: '/api/export/openssh', headers: { cookie } });
    expect(openSsh.statusCode).toBe(200);
    expect(openSsh.headers['content-disposition']).toContain('ssh-config');
    expect(openSsh.body).not.toContain('route-password');
    const csv = await app.inject({ method: 'GET', url: '/api/export/csv', headers: { cookie } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).not.toContain('route-password');
    const deniedPasswordExport = await app.inject({ method: 'GET', url: '/api/export/csv?includePasswords=true', headers: { cookie } });
    expect(deniedPasswordExport.statusCode).toBe(400);
    const confirmedPasswordExport = await app.inject({ method: 'GET', url: '/api/export/csv?includePasswords=true&confirmPasswordExport=true', headers: { cookie } });
    expect(confirmedPasswordExport.statusCode).toBe(200);
    expect(confirmedPasswordExport.body).toContain('route-password');
  });
});
