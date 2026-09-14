import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Ssh2Adapter } from '../../../src/server/ssh/ssh2-adapter.js';
import type { SshChannel, SshConnectConfig } from '../../../src/server/ssh/types.js';

const execFile = promisify(execFileCallback);
const FIXTURE_PASSWORD = 'webssh-fixture-password';
const FIXTURE_USER = `webssh_fixture_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const SSHD_PATH = '/usr/sbin/sshd';
const USERADD_PATH = '/usr/sbin/useradd';
const USERDEL_PATH = '/usr/sbin/userdel';
const CHPASSWD_PATH = '/usr/sbin/chpasswd';
const SSH_KEYGEN_PATH = '/usr/bin/ssh-keygen';
const canRunLocalFixture = process.platform === 'linux' && process.getuid?.() === 0;

interface LocalFixture {
  port: number;
  privateKey: string;
  close: () => Promise<void>;
}

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('could not allocate fixture port');
  return port;
};

const setPassword = async (username: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(CHPASSWD_PATH, [], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || 'chpasswd failed')));
    child.stdin.end(`${username}:${FIXTURE_PASSWORD}\n`);
  });
};

const waitForReady = async (child: ChildProcess, port: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  let lastError = 'sshd did not start';
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => {
          socket.destroy();
          resolve();
        });
        socket.once('error', reject);
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : lastError;
      await new Promise((resolve) => setTimeout(resolve, 30));
      continue;
    }
    if (child.exitCode !== null) throw new Error('sshd exited before becoming ready');
    return;
  }
  throw new Error(lastError);
};

const startLocalFixture = async (): Promise<LocalFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'webssh-openssh-'));
  await chmod(root, 0o755);
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  const port = await freePort();
  const hostKey = join(root, 'host_ed25519');
  const clientKeyPath = join(process.cwd(), 'tests/fixtures/openssh/test_client_ed25519');
  const privateKey = await readFile(clientKeyPath, 'utf8');
  const authorizedKeys = await readFile(`${clientKeyPath}.pub`, 'utf8');
  await execFile(SSH_KEYGEN_PATH, ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  await writeFile(join(root, 'authorized_keys'), authorizedKeys, { mode: 0o600 });
  await writeFile(join(root, 'sshd_config'), [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKey}`,
    'PasswordAuthentication yes',
    'PubkeyAuthentication yes',
    'KbdInteractiveAuthentication no',
    'UsePAM no',
    'PermitRootLogin no',
    `AllowUsers ${FIXTURE_USER}`,
    `AuthorizedKeysFile ${join(root, 'authorized_keys')}`,
    'StrictModes no',
    `PidFile ${join(root, 'sshd.pid')}`,
    'X11Forwarding no',
    'AllowTcpForwarding no',
    'PermitTunnel no',
    'PrintMotd no',
    'UseDNS no',
    'LogLevel QUIET'
  ].join('\n'));
  await execFile(USERADD_PATH, ['--no-create-home', '--shell', '/bin/sh', '--home-dir', home, FIXTURE_USER]);
  await execFile('/usr/bin/chown', [`${FIXTURE_USER}:${FIXTURE_USER}`, home, join(root, 'authorized_keys')]);
  await setPassword(FIXTURE_USER);
  await execFile(SSHD_PATH, ['-t', '-f', join(root, 'sshd_config')]);
  const child = spawn(SSHD_PATH, ['-D', '-e', '-f', join(root, 'sshd_config')], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.resume();
  try {
    await waitForReady(child, port);
  } catch (error) {
    child.kill('SIGTERM');
    await execFile(USERDEL_PATH, ['--remove', FIXTURE_USER]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(() => resolve(), 1_000).unref();
    });
    await execFile(USERDEL_PATH, ['--remove', FIXTURE_USER]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  };

  return { port, privateKey, close };
};

const waitForOutput = (channel: SshChannel, matcher: RegExp): Promise<string> => new Promise((resolve, reject) => {
  let output = '';
  const timer = setTimeout(() => reject(new Error('timed out waiting for SSH output')), 5_000);
  channel.on('data', (data) => {
    output += data.toString('utf8');
    if (matcher.test(output)) {
      clearTimeout(timer);
      resolve(output);
    }
  });
});

const config = (fixture: LocalFixture, auth: SshConnectConfig['auth']): SshConnectConfig => ({
  hostId: 'openssh-fixture',
  address: '127.0.0.1',
  port: fixture.port,
  username: FIXTURE_USER,
  auth,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  cols: 100,
  rows: 30
});

const fixtureDescribe = canRunLocalFixture ? describe : describe.skip;

fixtureDescribe('real OpenSSH fixture', () => {
  it('supports password, private-key, interactive PTY, resize, and rejects bad credentials', async () => {
    const fixture = await startLocalFixture();
    try {
      const adapter = new Ssh2Adapter();
      const acceptHostKey = { onHostKey: async () => true };
      const passwordChannel = await adapter.connect(config(fixture, { type: 'password', password: FIXTURE_PASSWORD }), acceptHostKey);
      const passwordOutput = waitForOutput(passwordChannel, /password-check/u);
      passwordChannel.write("printf 'password-check\\n'\n");
      expect(await passwordOutput).toContain('password-check');
      const resizedOutput = waitForOutput(passwordChannel, /30 100/u);
      passwordChannel.resize(100, 30);
      passwordChannel.write('stty size\n');
      expect(await resizedOutput).toMatch(/30 100/u);
      passwordChannel.close();

      const keyChannel = await adapter.connect(config(fixture, { type: 'private_key', privateKey: fixture.privateKey }), acceptHostKey);
      const keyOutput = waitForOutput(keyChannel, /key-check/u);
      keyChannel.write("printf 'key-check\\n'\n");
      expect(await keyOutput).toContain('key-check');
      keyChannel.close();

      await expect(adapter.connect(config(fixture, { type: 'password', password: 'wrong-fixture-password' }), acceptHostKey))
        .rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
    } finally {
      await fixture.close();
    }
  });
});
