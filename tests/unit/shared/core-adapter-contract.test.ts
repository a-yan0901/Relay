import { describe, expect, it } from 'vitest';

import {
  assertCommandTransportContract,
  assertCoreRuntimeContract,
  assertFileTransportContract,
  assertSessionTransportContract
} from '../../fixtures/core-runtime-contract.js';
import { createInMemoryCoreRuntime } from '../../fixtures/native-runtime.js';
import type {
  CommandRun,
  GroupNode,
  IdentityMetadata,
  Snippet,
  TransferJob,
  WorkspaceState,
  WorkspaceTemplate
} from '../../../src/shared/core/models.js';
import type { CommandTransport, FileTransport, SessionTransport } from '../../../src/shared/core/ports.js';

const fakeTransfer = (id: string): TransferJob => ({
  id,
  kind: 'download',
  hostId: 'host-1',
  sourcePath: '/source',
  targetPath: 'target',
  status: 'queued',
  completedBytes: 0,
  totalBytes: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

const fakeRun = (id: string): CommandRun => ({
  id,
  command: 'uname -a',
  hostIds: ['host-1', 'host-2'],
  persistOutput: false,
  status: 'queued',
  targets: ['host-1', 'host-2'].map((hostId) => ({
    hostId,
    status: 'queued',
    exitCode: null,
    output: '',
    outputBytes: 0
  })),
  createdAt: new Date().toISOString()
});

describe('shared core adapter contracts', () => {
  it('defines the lifecycle contract for session, file and command transports', async () => {
    let closed = false;
    const sessions = new Map<string, { id: string; hostId: string }>();
    const sessionTransport: SessionTransport = {
      async openShell(request) {
        const value = { id: request.sessionId, hostId: request.profile.hostId };
        sessions.set(value.id, value);
        return {
          ...value,
          write: () => {},
          resize: () => {},
          close: () => { closed = true; },
          subscribe: () => () => {}
        };
      },
      async reconnect(sessionId) {
        const value = sessions.get(sessionId);
        if (!value) throw new Error('missing');
        return { ...value, write: () => {}, resize: () => {}, close: () => {}, subscribe: () => () => {} };
      },
      async close() { closed = true; }
    };
    await assertSessionTransportContract(sessionTransport);
    expect(closed).toBe(true);

    let cancelled = '';
    const fileTransport: FileTransport = {
      async list() { return []; },
      async createDirectory() {},
      async rename() {},
      async remove() {},
      async createTransfer() { return fakeTransfer('transfer-1'); },
      async listTransfers() { return []; },
      async getTransfer(id) { return fakeTransfer(id); },
      async upload(id) { return { ...fakeTransfer(id), status: 'completed' }; },
      async download() {
        return (async function* () {
          yield new Uint8Array([0x6f, 0x6b]);
        })();
      },
      async pauseTransfer() {},
      async cancelTransfer(id) { cancelled = id; },
      async retryTransfer(id) { return fakeTransfer(id); }
    };
    await assertFileTransportContract(fileTransport);
    expect(cancelled).toBe('transfer-1');

    let cancelledRun = '';
    const runs = new Map<string, CommandRun>();
    const commandTransport: CommandTransport = {
      async start() {
        const run = fakeRun('run-1');
        runs.set(run.id, run);
        return run;
      },
      async get(id) { return runs.get(id); },
      async cancel(id) { cancelledRun = id; }
    };
    await assertCommandTransportContract(commandTransport);
    expect(cancelledRun).toBe('run-1');

    const state: WorkspaceState = {
      version: 0,
      tabs: [],
      activeTabId: null,
      layout: { mode: 'single', ratio: 0.5 },
      filters: { query: '', groupId: null, favoriteOnly: false }
    };
    const identity: IdentityMetadata = {
      id: 'identity-1',
      name: 'Deploy key',
      type: 'private_key',
      username: 'deploy',
      keyFingerprint: null,
      usageCount: 0,
      createdAt: '',
      updatedAt: ''
    };
    const group: GroupNode = {
      id: 'group-1',
      name: 'Production',
      parentId: null,
      sortOrder: 0,
      defaultIdentityId: null,
      connectionProfile: null
    };
    const snippet: Snippet = {
      id: 'snippet-1',
      name: 'Health',
      description: null,
      tags: [],
      command: 'uptime',
      variables: [],
      createdAt: '',
      updatedAt: ''
    };
    const template: WorkspaceTemplate = {
      id: 'template-1',
      name: 'Default',
      state,
      createdAt: '',
      updatedAt: ''
    };
    expect(identity.id).toBe('identity-1');
    expect(group.id).toBe('group-1');
    expect(snippet.id).toBe('snippet-1');
    expect(template.id).toBe('template-1');
  });

  it('composes every store and transport behind one CoreRuntime contract', async () => {
    await assertCoreRuntimeContract(createInMemoryCoreRuntime('web', ['workspace.persistence']), { platform: 'web' });
  });

  it('degrades to a stable Local-only capability set when account and sync are absent', async () => {
    const runtime = createInMemoryCoreRuntime('web', ['workspace.persistence', 'ssh.shell']);
    const negotiated = await runtime.negotiateCapabilities();

    expect(negotiated.supports('account.auth')).toBe(false);
    expect(negotiated.supports('device.trust')).toBe(false);
    expect(negotiated.supports('sync.encrypted')).toBe(false);
    expect(negotiated.supports('workspace.persistence')).toBe(true);
  });
});
