import { execFile as execFileCallback, spawn, type ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const execFile = promisify(execFileCallback);
const SSHD_PATH = '/usr/sbin/sshd';
const FIXTURE_PASSWORD = 'webssh-e2e-password';

export interface E2eSshFixture {
  username: string;
  password: string;
  port: number;
  remoteDirectory: string;
  knownFileName: string;
  knownFilePath: string;
  close: () => Promise<void>;
}

const findFreePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('could not allocate e2e SSH port');
  return port;
};

const setPassword = async (username: string): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/sbin/chpasswd', [], { stdio: ['pipe', 'ignore', 'pipe'] });
    let errorOutput = '';
    child.stderr?.on('data', (chunk: Buffer) => { errorOutput += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(errorOutput || 'could not set e2e fixture password')));
    child.stdin.end(`${username}:${FIXTURE_PASSWORD}\n`);
  });
};

const waitForSshd = async (child: ChildProcess, port: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port });
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', reject);
      });
      if (child.exitCode === null) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
  }
  throw new Error('e2e SSH fixture did not start');
};

export const startE2eSshFixture = async (): Promise<E2eSshFixture> => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('the local e2e SSH fixture requires Linux root privileges');
  }
  const fixtureUser = `webssh_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const root = await mkdtemp(join(tmpdir(), 'webssh-e2e-ssh-'));
  await chmod(root, 0o755);
  const home = join(root, 'home');
  await mkdir(home, { mode: 0o700 });
  const remoteDirectory = join('/tmp', `webssh-e2e-files-${randomUUID().replaceAll('-', '').slice(0, 12)}`);
  const knownFileName = 'fixture-known.txt';
  const knownFilePath = join(remoteDirectory, knownFileName);
  const port = await findFreePort();
  const hostKey = join(root, 'host_ed25519');
  const configPath = join(root, 'sshd_config');
  await execFile('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  await writeFile(configPath, [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKey}`,
    'PasswordAuthentication yes',
    'PubkeyAuthentication no',
    'KbdInteractiveAuthentication no',
    'UsePAM no',
    'PermitRootLogin no',
    `AllowUsers ${fixtureUser}`,
    'StrictModes no',
    `PidFile ${join(root, 'sshd.pid')}`,
    'X11Forwarding no',
    'AllowTcpForwarding no',
    'PermitTunnel no',
    'PrintMotd no',
    'UseDNS no',
    'Subsystem sftp /usr/lib/openssh/sftp-server',
    'LogLevel QUIET'
  ].join('\n'));
  await execFile('/usr/sbin/useradd', ['--no-create-home', '--shell', '/bin/sh', '--home-dir', home, fixtureUser]);
  await execFile('/usr/bin/chown', [`${fixtureUser}:${fixtureUser}`, home]);
  await setPassword(fixtureUser);
  await mkdir(remoteDirectory, { mode: 0o700 });
  await writeFile(knownFilePath, 'fixture-known-file\n', { mode: 0o600 });
  await execFile('/usr/bin/chown', [`${fixtureUser}:${fixtureUser}`, remoteDirectory, knownFilePath]);
  await execFile(SSHD_PATH, ['-t', '-f', configPath]);
  const child = spawn(SSHD_PATH, ['-D', '-e', '-f', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr?.resume();

  try {
    await waitForSshd(child, port);
  } catch (error) {
    child.kill('SIGTERM');
    await execFile('/usr/sbin/userdel', ['--remove', fixtureUser]).catch(() => undefined);
    await rm(remoteDirectory, { recursive: true, force: true });
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
      setTimeout(resolve, 1_000).unref();
    });
    await execFile('/usr/sbin/userdel', ['--remove', fixtureUser]).catch(() => undefined);
    await rm(remoteDirectory, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  };

  return { username: fixtureUser, password: FIXTURE_PASSWORD, port, remoteDirectory, knownFileName, knownFilePath, close };
};
