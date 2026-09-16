import { expect } from 'vitest';

import type { Capability, ClientPlatform } from '../../src/shared/core/models.js';
import type { CoreRuntime } from '../../src/shared/core/runtime.js';
import type { CommandTransport, FileTransport, SessionTransport } from '../../src/shared/core/ports.js';
import type { CommandRunRequest, TransferRequest } from '../../src/shared/core/models.js';

export interface CoreRuntimeContractOptions {
  platform: ClientPlatform;
  requiredCapabilities?: readonly Capability[];
}

export const assertSessionTransportContract = async (transport: SessionTransport): Promise<void> => {
  const handle = await transport.openShell({
    sessionId: 'session-1',
    profile: {
      hostId: 'host-1',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authType: 'password',
      jumpHostIds: [],
      keepaliveIntervalMs: 10_000,
      keepaliveCountMax: 3,
      reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      hostKeyAlgorithm: null,
      hostKeyFingerprint: null
    },
    cols: 80,
    rows: 24
  });
  expect(handle.id).toBe('session-1');
  expect(handle.hostId).toBe('host-1');
  expect(typeof handle.write).toBe('function');
  expect(typeof handle.resize).toBe('function');
  expect(typeof handle.subscribe).toBe('function');
  const unsubscribe = handle.subscribe(() => undefined);
  expect(typeof unsubscribe).toBe('function');
  unsubscribe();
  const reconnected = await transport.reconnect('session-1');
  expect(reconnected.id).toBe('session-1');
  await transport.close('session-1');
};

export const assertFileTransportContract = async (transport: FileTransport): Promise<void> => {
  const request: TransferRequest = { kind: 'download', hostId: 'host-1', sourcePath: '/var/log/app.log', targetPath: 'app.log' };
  const job = await transport.createTransfer(request);
  expect(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']).toContain(job.status);
  expect(job.hostId).toBe(request.hostId);
  expect((await transport.getTransfer(job.id))?.id).toBe(job.id);
  expect(await transport.list('host-1', '/var/log')).toBeInstanceOf(Array);
  await transport.createDirectory('host-1', '/tmp/new');
  await transport.rename('host-1', '/tmp/new', '/tmp/renamed');
  await transport.remove('host-1', '/tmp/renamed');
  await transport.upload(job.id, {
    name: 'app.log',
    size: 0,
    async *stream() {
      yield new Uint8Array([0x6f, 0x6b]);
    }
  });
  const chunks: Uint8Array[] = [];
  for await (const chunk of await transport.download(job.id)) chunks.push(chunk);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.every((chunk) => chunk instanceof Uint8Array)).toBe(true);
  await transport.pauseTransfer(job.id);
  await transport.cancelTransfer(job.id);
  const retried = await transport.retryTransfer(job.id);
  expect(['queued', 'running', 'paused', 'completed', 'failed', 'cancelled', 'interrupted']).toContain(retried.status);
};

export const assertCommandTransportContract = async (transport: CommandTransport): Promise<void> => {
  const request: CommandRunRequest = {
    command: 'uname -a',
    hostIds: ['host-1', 'host-2'],
    variables: {},
    concurrency: 2,
    timeoutMs: 1_000,
    persistOutput: false,
    confirmed: true
  };
  const run = await transport.start(request);
  const loaded = await transport.get(run.id);
  expect(loaded?.id).toBe(run.id);
  expect(new Set(loaded?.targets.map((target) => target.hostId))).toEqual(new Set(request.hostIds));
  await transport.cancel(run.id);
};

/**
 * The optional account/sync ports must expose the same state transitions on
 * every client adapter. The envelope assertions deliberately inspect only
 * opaque metadata; a contract fake must never contain a Vault plaintext.
 */
export const assertAccountSyncContract = async (runtime: CoreRuntime): Promise<void> => {
  expect(runtime.capabilities.supports('account.auth')).toBe(true);
  expect(runtime.capabilities.supports('device.trust')).toBe(true);
  expect(runtime.capabilities.supports('sync.encrypted')).toBe(true);
  expect(runtime.account).toBeDefined();
  expect(runtime.devices).toBeDefined();
  expect(runtime.sync).toBeDefined();

  const account = runtime.account!;
  const devicesPort = runtime.devices!;
  const sync = runtime.sync!;
  const session = await account.signIn('contract@example.com', 'opaque-account-password', 'Contract device');
  expect(session).toEqual(expect.objectContaining({ state: 'signed-in', accountId: expect.any(String), deviceId: expect.any(String) }));
  expect(await account.status()).toEqual(session);

  const devices = await devicesPort.listDevices();
  expect(devices.some((device) => device.current && device.id === session.deviceId)).toBe(true);
  const secondary = devices.find((device) => !device.current);
  expect(secondary).toBeDefined();

  const initialSync = await sync.status();
  expect(['local-only', 'synced']).toContain(initialSync.sync);
  const head = await sync.enable();
  expect(head).toEqual(expect.objectContaining({ revision: 1, keyVersion: 1, vaultId: expect.any(String) }));
  expect((await sync.status()).sync).toBe('synced');

  const descriptor = await sync.descriptor();
  expect(descriptor).toEqual(expect.objectContaining({ vaultId: head.vaultId, wrappedSyncKey: expect.any(Object) }));
  const envelope = await sync.pull();
  expect(envelope).toEqual(expect.objectContaining({
    schemaVersion: 1,
    vaultId: head.vaultId,
    revision: 1,
    ciphertext: expect.any(String),
    nonce: expect.any(String),
    authTag: expect.any(String),
    payloadHash: expect.any(String)
  }));
  let revealedRecoveryKey: string | undefined;
  let revealedRecoveryKeyVersion: number | undefined;
  const recoveryState = await sync.issueRecoveryKey((recoveryKey, keyVersion) => {
    revealedRecoveryKey = recoveryKey;
    revealedRecoveryKeyVersion = keyVersion;
  });
  expect(revealedRecoveryKey).toEqual(expect.any(String));
  expect(revealedRecoveryKeyVersion).toBe(1);
  expect(recoveryState).toEqual({ status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 });
  expect((await sync.status()).recovery).toEqual({ status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 });
  await expect(sync.confirmRecoveryKey(revealedRecoveryKey!)).resolves.toEqual({ status: 'configured', activeKeyVersion: 1, pendingKeyVersion: null });
  const opaqueWireData = JSON.stringify({ descriptor, envelope });
  expect(opaqueWireData).not.toMatch(/opaque-account-password|master password|private key|passphrase/iu);
  await sync.push(envelope!, 'contract-idempotency-key');
  const preview = await sync.previewPull();
  expect(preview.conflictTypes.length).toBeGreaterThan(0);
  await sync.resolveConflict(preview.conflictId, 'keep-local');
  await sync.retry();

  await devicesPort.revokeDevice(secondary!.id);
  expect((await devicesPort.listDevices()).find((device) => device.id === secondary!.id)?.revokedAt).not.toBeNull();
  await account.signOut();
  expect(await account.status()).toBeNull();
};

export const assertCoreRuntimeContract = async (
  runtime: CoreRuntime,
  options: CoreRuntimeContractOptions
): Promise<void> => {
  expect(runtime.platform).toBe(options.platform);
  expect(runtime.capabilities.client).toBe(options.platform);
  const negotiated = await runtime.negotiateCapabilities();
  expect(negotiated).toBe(runtime.capabilities);
  expect(negotiated.capabilities).toBe(negotiated.intersection);
  expect(negotiated.clientCapabilities.length).toBeGreaterThanOrEqual(negotiated.intersection.length);
  expect(negotiated.serverCapabilities.length).toBeGreaterThanOrEqual(negotiated.intersection.length);
  for (const capability of options.requiredCapabilities ?? ['workspace.persistence']) {
    expect(runtime.capabilities.supports(capability)).toBe(true);
  }

  expect(runtime.vault).toBeDefined();
  expect(runtime.connection).toBeDefined();
  expect(runtime.hosts).toBeDefined();
  expect(runtime.identities).toBeDefined();
  expect(runtime.groups).toBeDefined();
  expect(runtime.workspace).toBeDefined();
  expect(runtime.secrets).toBeDefined();
  expect(runtime.sessions).toBeDefined();
  expect(runtime.files).toBeDefined();
  expect(runtime.commands).toBeDefined();
  expect(runtime.snippets).toBeDefined();
  expect(runtime.activity).toBeDefined();
  expect(runtime.imports).toBeDefined();

  await runtime.vault.status();
  const connectionResult = await runtime.connection.test('host-1');
  expect(typeof connectionResult.ok).toBe('boolean');
  if (connectionResult.hostKey) {
    expect(typeof connectionResult.hostKey.algorithm).toBe('string');
    expect(typeof connectionResult.hostKey.fingerprint).toBe('string');
    expect(typeof connectionResult.hostKey.address).toBe('string');
    expect(Number.isInteger(connectionResult.hostKey.port)).toBe(true);
  }
  await runtime.hosts.list();
  await runtime.identities.list();
  await runtime.groups.list();
  await runtime.workspace.load();
  await runtime.secrets.get({ kind: 'host', id: 'host-1' });
  await runtime.snippets.list();
  await runtime.activity.list();
  await assertSessionTransportContract(runtime.sessions);
  await assertFileTransportContract(runtime.files);
  await assertCommandTransportContract(runtime.commands);

  const openSshConfig = await runtime.imports.exportOpenSshConfig();
  const csv = await runtime.imports.exportCsv();
  const vaultBundle = await runtime.imports.exportVaultBundle('export-password');
  expect(openSshConfig).toBeInstanceOf(Uint8Array);
  expect(csv).toBeInstanceOf(Uint8Array);
  expect(typeof vaultBundle).toBe('string');
};
