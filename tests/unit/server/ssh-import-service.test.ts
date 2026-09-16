import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { ImportSourceFile } from '../../../src/shared/import/types.js';
import { GroupRepository, HostRepository } from '../../../src/server/db/repositories.js';
import { migrate } from '../../../src/server/db/migrations.js';
import { VaultService } from '../../../src/server/vault/vault-service.js';
import { SshImportService } from '../../../src/server/workspace/ssh-import-service.js';

const createFixture = async (now = () => Date.now()) => {
  const database = new Database(':memory:');
  migrate(database);
  const created = await VaultService.create('correct horse battery staple');
  const hosts = new HostRepository(database, 'default');
  const groups = new GroupRepository(database, 'default');
  const service = new SshImportService({ ownerId: 'default', database, hostRepository: hosts, groupRepository: groups, vaultService: new VaultService(), now, previewTtlMs: 1000 });
  return { database, hosts, groups, service, sessionKey: created.vaultKey };
};

const csv: ImportSourceFile = {
  filename: 'connections.csv',
  content: 'group,name,host,port,user,password\nProduction,app,app.example.com,22,deploy,secret-password\n'
};

describe('SshImportService', () => {
  it('previews without exposing credentials and applies explicit credentials transactionally', async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.preview([csv]);

    expect(JSON.stringify(preview)).not.toContain('secret-password');
    expect(preview.connections[0]).toMatchObject({ credentialState: 'ready', applicable: true });
    const result = await fixture.service.apply(fixture.sessionKey, preview.previewId, {
      selectedSourceIds: [preview.connections[0].sourceId],
      conflictPolicy: 'create'
    });

    expect(result).toMatchObject({ importedHosts: 1, importedGroups: 1 });
    expect(fixture.hosts.listMetadata()[0]).toMatchObject({ name: 'app', address: 'app.example.com', groupId: expect.any(String) });
    fixture.database.close();
  });

  it('accepts a preview credential补录 without storing the incomplete record', async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.preview([{ filename: 'config', content: 'Host app\n  HostName app.example.com\n  User deploy\n' }]);
    expect(preview.connections[0]?.credentialState).toBe('needs-user-input');

    await fixture.service.apply(fixture.sessionKey, preview.previewId, {
      selectedSourceIds: [preview.connections[0].sourceId],
      conflictPolicy: 'create',
      credentials: [{ sourceId: preview.connections[0].sourceId, credential: { type: 'password', password: 'filled-at-apply' } }]
    });
    expect(fixture.hosts.listMetadata()).toHaveLength(1);
    fixture.database.close();
  });

  it('reports an existing group and reuses it during apply', async () => {
    const fixture = await createFixture();
    fixture.groups.create({ id: 'existing-group', name: 'Production' });
    const preview = await fixture.service.preview([csv]);
    expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'existing-group' })]));
    const result = await fixture.service.apply(fixture.sessionKey, preview.previewId, { selectedSourceIds: [preview.connections[0].sourceId], conflictPolicy: 'create' });
    expect(result).toMatchObject({ importedHosts: 1, importedGroups: 0, skippedGroups: 1 });
    fixture.database.close();
  });

  it('hydrates an uploaded OpenSSH private key next to its config', async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.preview([
      { filename: 'config', content: 'Host app\n  HostName app.example.com\n  User deploy\n  IdentityFile ~/.ssh/id_ed25519\n' },
      { filename: 'id_ed25519', content: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----\n' }
    ]);
    expect(preview.connections[0]).toMatchObject({ credentialState: 'ready', identityFile: '~/.ssh/id_ed25519', applicable: true });
    await fixture.service.apply(fixture.sessionKey, preview.previewId, { selectedSourceIds: [preview.connections[0].sourceId], conflictPolicy: 'create' });
    expect(await fixture.service.exportOpenSsh(fixture.sessionKey)).toContain('IdentityFile ~/.ssh/id_ed25519');
    fixture.database.close();
  });

  it('expires previews and imports records without credentials for later connection', async () => {
    let clock = 1000;
    const fixture = await createFixture(() => clock);
    const preview = await fixture.service.preview([csv]);
    clock = 2501;
    await expect(fixture.service.apply(fixture.sessionKey, preview.previewId, { selectedSourceIds: [], conflictPolicy: 'create' })).rejects.toMatchObject({ code: 'IMPORT_PREVIEW_EXPIRED' });

    const second = await fixture.service.preview([{ filename: 'two.csv', content: 'name,host,user,password\none,one.example.com,ops,ok\ntwo,two.example.com,ops,\n' }]);
    const result = await fixture.service.apply(fixture.sessionKey, second.previewId, {
      selectedSourceIds: second.connections.map((connection) => connection.sourceId),
      conflictPolicy: 'create'
    });
    expect(result.importedHosts).toBe(2);
    expect(fixture.hosts.listMetadata()).toHaveLength(2);
    fixture.database.close();
  });

  it('exports standard formats without password by default', async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.preview([csv]);
    await fixture.service.apply(fixture.sessionKey, preview.previewId, { selectedSourceIds: [preview.connections[0].sourceId], conflictPolicy: 'create' });
    const openSsh = await fixture.service.exportOpenSsh(fixture.sessionKey);
    const csvOutput = await fixture.service.exportCsv(fixture.sessionKey);
    expect(openSsh).toContain('Host app');
    expect(csvOutput).not.toContain('secret-password');
    fixture.database.close();
  });

  it('applies a target before its imported jump host without breaking dependency validation', async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.preview([{
      filename: 'chain.csv',
      content: 'name,host,user,password,jumphost\napp,app.example.com,deploy,app-secret,bastion\nbastion,bastion.example.com,ops,jump-secret,\n'
    }]);
    await fixture.service.apply(fixture.sessionKey, preview.previewId, {
      selectedSourceIds: preview.connections.map((connection) => connection.sourceId),
      conflictPolicy: 'create'
    });
    const hosts = fixture.hosts.listMetadata();
    const app = hosts.find((host) => host.name === 'app');
    const bastion = hosts.find((host) => host.name === 'bastion');
    expect(app?.jumpHostIds).toEqual([bastion?.id]);
    fixture.database.close();
  });

  it('rolls back groups and previously written hosts when a transaction write fails', async () => {
    const fixture = await createFixture();
    const preview = await fixture.service.preview([{
      filename: 'rollback.csv',
      content: 'group,name,host,port,user,password\nProduction,app,app.example.com,22,deploy,app-secret\nProduction,api,api.example.com,22,deploy,api-secret\n'
    }]);
    const createHost = fixture.hosts.createHost.bind(fixture.hosts);
    let writes = 0;
    const createHostSpy = vi.spyOn(fixture.hosts, 'createHost').mockImplementation((input) => {
      writes += 1;
      if (writes === 2) throw new Error('simulated host write failure');
      return createHost(input);
    });

    await expect(fixture.service.apply(fixture.sessionKey, preview.previewId, {
      selectedSourceIds: preview.connections.map((connection) => connection.sourceId),
      conflictPolicy: 'create'
    })).rejects.toThrow('simulated host write failure');

    expect(fixture.hosts.listMetadata()).toEqual([]);
    expect(fixture.groups.list()).toEqual([]);
    createHostSpy.mockRestore();
    fixture.database.close();
  });
});
