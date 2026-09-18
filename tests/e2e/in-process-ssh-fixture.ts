import { mkdir, mkdtemp, open, readdir, rename, rm, stat, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative } from 'node:path';
import { randomUUID } from 'node:crypto';

import ssh2, {
  type Attributes,
  type Connection,
  type FileEntry,
  type SFTPWrapper,
  type ServerChannel
} from 'ssh2';

import type { E2eSshFixture } from './ssh-fixture.js';

const FIXTURE_PASSWORD = 'webssh-e2e-password';
const FIXTURE_USERNAME = 'fixture';
const { Server: SshServer, utils } = ssh2;
const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4
} as const;

type FileHandleState = {
  kind: 'file';
  file: FileHandle;
};

type DirectoryEntry = {
  name: string;
  localPath: string;
  attrs: Attributes;
};

type DirectoryHandleState = {
  kind: 'directory';
  entries: DirectoryEntry[];
  offset: number;
};

type HandleState = FileHandleState | DirectoryHandleState;
type HandleOfKind<K extends HandleState['kind']> = Extract<HandleState, { kind: K }>;

const findFreePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error('could not allocate in-process e2e SSH port');
  return port;
};

const normalizeRemotePath = (value: string): string => {
  const normalized = posix.normalize(value.replaceAll('\\', '/'));
  return normalized === '.' ? '/' : normalized;
};

const errorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
};

const statusForError = (error: unknown): number => {
  switch (errorCode(error)) {
    case 'ENOENT': return STATUS_CODE.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM': return STATUS_CODE.PERMISSION_DENIED;
    default: return STATUS_CODE.FAILURE;
  }
};

const toAttributes = (value: { mode: number; size: number; atimeMs: number; mtimeMs: number }): Attributes => ({
  mode: value.mode,
  uid: 1000,
  gid: 1000,
  size: value.size,
  atime: Math.floor(value.atimeMs / 1000),
  mtime: Math.floor(value.mtimeMs / 1000)
});

const handleKey = (handle: Buffer): string => handle.toString('hex');

const createHandle = (id: number): Buffer => {
  const handle = Buffer.alloc(4);
  handle.writeUInt32BE(id, 0);
  return handle;
};

const decodePrintf = (value: string): string => value
  .replaceAll('\\033', '\u001b')
  .replaceAll('\\n', '\n')
  .replaceAll('\\r', '\r')
  .replaceAll('\\t', '\t')
  .replaceAll('\\\\', '\\')
  .replaceAll("\\'", "'");

const commandOutput = (command: string): string => {
  const match = command.match(/printf\s+(['"])([\s\S]*?)\1/u);
  if (!match) return command.startsWith('stty size') ? '30 100\n' : '';
  return decodePrintf(match[2]);
};

const openModeForFlags = (flags: number): string | null => {
  const read = (flags & 0x00000001) !== 0;
  const write = (flags & 0x00000002) !== 0;
  const append = (flags & 0x00000004) !== 0;
  const create = (flags & 0x00000008) !== 0;
  const truncate = (flags & 0x00000010) !== 0;
  const exclusive = (flags & 0x00000020) !== 0;
  if (!read && !write) return null;
  if (append) return read ? (exclusive ? 'ax+' : 'a+') : (exclusive ? 'ax' : 'a');
  if (create || truncate) return read ? (exclusive ? 'wx+' : 'w+') : (exclusive ? 'wx' : 'w');
  return read && write ? 'r+' : 'r';
};

const finishChannel = (channel: ServerChannel): void => {
  channel.exit(0);
  channel.end();
};

const runCommand = (channel: ServerChannel, command: string, closeWhenDone = true): void => {
  const output = commandOutput(command);
  if (output) channel.write(output.replaceAll('\n', '\r\n'));
  const sleepMatch = command.match(/(?:^|[;|])\s*sleep\s+(\d+(?:\.\d+)?)/u);
  const delay = sleepMatch ? Math.max(0, Number(sleepMatch[1]) * 1000) : 0;
  if (delay > 0 && closeWhenDone) {
    const timer = setTimeout(() => finishChannel(channel), delay);
    timer.unref();
  } else if (closeWhenDone) {
    finishChannel(channel);
  }
};

const attachInteractiveShell = (channel: ServerChannel): void => {
  let pending = '';
  channel.on('data', (chunk: Buffer | string) => {
    pending += chunk.toString('utf8');
    let lineEnd = pending.search(/[\r\n]/u);
    while (lineEnd >= 0) {
      const command = pending.slice(0, lineEnd);
      const lineEnding = pending[lineEnd] === '\r' && pending[lineEnd + 1] === '\n' ? 2 : 1;
      pending = pending.slice(lineEnd + lineEnding);
      runCommand(channel, command, false);
      lineEnd = pending.search(/[\r\n]/u);
    }
  });
};

const startSftp = (channel: SFTPWrapper, remoteDirectory: string, localDirectory: string): void => {
  const handles = new Map<string, HandleState>();
  let nextHandle = 1;

  const localPathFor = (remotePath: string): string | null => {
    const normalized = normalizeRemotePath(remotePath);
    const remoteRoot = normalizeRemotePath(remoteDirectory);
    if (normalized === remoteRoot || normalized === '/' || normalized === '/home/fixture') return localDirectory;
    if (!normalized.startsWith(`${remoteRoot}/`)) return null;
    const relativePath = normalized.slice(remoteRoot.length + 1);
    if (!relativePath || relativePath.split('/').includes('..')) return null;
    return join(localDirectory, ...relativePath.split('/'));
  };

  const remotePathFor = (localPath: string): string => {
    const relativePath = relative(localDirectory, localPath).replaceAll('\\', '/');
    return relativePath ? posix.join(remoteDirectory, relativePath) : remoteDirectory;
  };

  const attrsFor = async (localPath: string): Promise<Attributes> => toAttributes(await stat(localPath));
  const fail = (requestId: number, error: unknown): void => channel.status(requestId, statusForError(error));
  const lookup = <K extends HandleState['kind']>(handle: Buffer, kind: K): HandleOfKind<K> | undefined => {
    const value = handles.get(handleKey(handle));
    return value?.kind === kind ? value as HandleOfKind<K> : undefined;
  };

  channel.on('OPEN', (requestId, filename, flags) => {
    void (async () => {
      const localPath = localPathFor(filename);
      const mode = openModeForFlags(flags);
      if (!localPath || !mode) {
        channel.status(requestId, STATUS_CODE.FAILURE);
        return;
      }
      try {
        await mkdir(dirname(localPath), { recursive: true });
        const file = await open(localPath, mode);
        const handle = createHandle(nextHandle++);
        handles.set(handleKey(handle), { kind: 'file', file });
        channel.handle(requestId, handle);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('READ', (requestId, handle, offset, length) => {
    void (async () => {
      const state = lookup(handle, 'file');
      if (!state) {
        channel.status(requestId, STATUS_CODE.FAILURE);
        return;
      }
      try {
        const buffer = Buffer.alloc(Math.min(length, 32 * 1024));
        const result = await state.file.read(buffer, 0, buffer.length, offset);
        if (result.bytesRead === 0) channel.status(requestId, STATUS_CODE.EOF);
        else channel.data(requestId, buffer.subarray(0, result.bytesRead));
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('WRITE', (requestId, handle, offset, data) => {
    void (async () => {
      const state = lookup(handle, 'file');
      if (!state) {
        channel.status(requestId, STATUS_CODE.FAILURE);
        return;
      }
      try {
        await state.file.write(data, 0, data.length, offset);
        channel.status(requestId, STATUS_CODE.OK);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('CLOSE', (requestId, handle) => {
    void (async () => {
      const key = handleKey(handle);
      const state = handles.get(key);
      if (!state) {
        channel.status(requestId, STATUS_CODE.FAILURE);
        return;
      }
      handles.delete(key);
      try {
        if (state.kind === 'file') await state.file.close();
        channel.status(requestId, STATUS_CODE.OK);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('OPENDIR', (requestId, path) => {
    void (async () => {
      const localPath = localPathFor(path);
      if (!localPath) {
        channel.status(requestId, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      try {
        const entries = await readdir(localPath, { withFileTypes: true });
        const directoryEntries: DirectoryEntry[] = [];
        for (const entry of entries) {
          const entryPath = join(localPath, entry.name);
          directoryEntries.push({ name: entry.name, localPath: entryPath, attrs: await attrsFor(entryPath) });
        }
        const handle = createHandle(nextHandle++);
        handles.set(handleKey(handle), { kind: 'directory', entries: directoryEntries, offset: 0 });
        channel.handle(requestId, handle);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('READDIR', (requestId, handle) => {
    const state = lookup(handle, 'directory');
    if (!state) {
      channel.status(requestId, STATUS_CODE.FAILURE);
      return;
    }
    if (state.offset >= state.entries.length) {
      channel.status(requestId, STATUS_CODE.EOF);
      return;
    }
    const entries = state.entries.slice(state.offset, state.offset + 64).map((entry): FileEntry => ({
      filename: entry.name,
      longname: entry.name,
      attrs: entry.attrs
    }));
    state.offset += entries.length;
    channel.name(requestId, entries);
  });

  const respondWithAttrs = (requestId: number, path: string): void => {
    void (async () => {
      const localPath = localPathFor(path);
      if (!localPath) {
        channel.status(requestId, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      try {
        channel.attrs(requestId, await attrsFor(localPath));
      } catch (error) {
        fail(requestId, error);
      }
    })();
  };

  channel.on('STAT', (requestId, path) => respondWithAttrs(requestId, path));
  channel.on('LSTAT', (requestId, path) => respondWithAttrs(requestId, path));

  channel.on('REALPATH', (requestId, path) => {
    void (async () => {
      const localPath = localPathFor(path);
      if (!localPath) {
        channel.status(requestId, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      try {
        const remotePath = remotePathFor(localPath);
        channel.name(requestId, [{ filename: remotePath, longname: remotePath, attrs: await attrsFor(localPath) }]);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('REMOVE', (requestId, path) => {
    void (async () => {
      const localPath = localPathFor(path);
      if (!localPath) {
        channel.status(requestId, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      try {
        await unlink(localPath);
        channel.status(requestId, STATUS_CODE.OK);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('MKDIR', (requestId, path) => {
    void (async () => {
      const localPath = localPathFor(path);
      if (!localPath) {
        channel.status(requestId, STATUS_CODE.FAILURE);
        return;
      }
      try {
        await mkdir(localPath, { recursive: false });
        channel.status(requestId, STATUS_CODE.OK);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('RMDIR', (requestId, path) => {
    void (async () => {
      const localPath = localPathFor(path);
      if (!localPath) {
        channel.status(requestId, STATUS_CODE.NO_SUCH_FILE);
        return;
      }
      try {
        await rm(localPath, { recursive: false });
        channel.status(requestId, STATUS_CODE.OK);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('RENAME', (requestId, oldPath, newPath) => {
    void (async () => {
      const oldLocalPath = localPathFor(oldPath);
      const newLocalPath = localPathFor(newPath);
      if (!oldLocalPath || !newLocalPath) {
        channel.status(requestId, STATUS_CODE.FAILURE);
        return;
      }
      try {
        await mkdir(dirname(newLocalPath), { recursive: true });
        await rename(oldLocalPath, newLocalPath);
        channel.status(requestId, STATUS_CODE.OK);
      } catch (error) {
        fail(requestId, error);
      }
    })();
  });

  channel.on('SETSTAT', (requestId) => channel.status(requestId, STATUS_CODE.OK));
  channel.on('FSETSTAT', (requestId) => channel.status(requestId, STATUS_CODE.OK));
};

const startClientSession = (client: Connection, remoteDirectory: string, localDirectory: string): void => {
  client.on('session', (accept, reject) => {
    const session = accept();
    session.on('pty', (acceptPty) => acceptPty());
    session.on('shell', (acceptShell) => attachInteractiveShell(acceptShell()));
    session.on('exec', (acceptExec, _reject, info) => runCommand(acceptExec(), info.command));
    session.on('sftp', (acceptSftp) => startSftp(acceptSftp(), remoteDirectory, localDirectory));
    session.on('subsystem', (_accept, rejectSubsystem) => rejectSubsystem());
    session.on('x11', (_accept, rejectX11) => rejectX11());
    void reject;
  });
};

export const startInProcessE2eSshFixture = async (): Promise<E2eSshFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'webssh-e2e-node-ssh-'));
  const localDirectory = join(root, 'remote');
  const remoteDirectory = `/tmp/webssh-e2e-files-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const knownFileName = 'fixture-known.txt';
  const knownFilePath = posix.join(remoteDirectory, knownFileName);
  const localKnownFilePath = join(localDirectory, knownFileName);
  await mkdir(localDirectory, { recursive: true });
  await writeFile(localKnownFilePath, 'fixture-known-file\n');

  const port = await findFreePort();
  const hostKey = utils.generateKeyPairSync('ed25519').private;
  const clients = new Set<Connection>();
  const server = new SshServer({ hostKeys: [hostKey] }, (client) => {
    clients.add(client);
    client.on('authentication', (context) => {
      if (context.method === 'password' && context.username === FIXTURE_USERNAME && context.password === FIXTURE_PASSWORD) context.accept();
      else context.reject();
    });
    client.on('ready', () => startClientSession(client, remoteDirectory, localDirectory));
    client.on('close', () => clients.delete(client));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const client of clients) (client as unknown as { end(): void }).end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };

  return {
    username: FIXTURE_USERNAME,
    password: FIXTURE_PASSWORD,
    port,
    remoteDirectory,
    knownFileName,
    knownFilePath,
    close
  };
};
