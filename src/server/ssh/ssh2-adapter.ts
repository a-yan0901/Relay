import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { Client, type ConnectConfig, type PseudoTtyOptions } from 'ssh2';

import { AppError } from '../../shared/errors.js';
import type { ConnectionDiagnostic } from '../../shared/core/models.js';
import { normalizeFingerprint } from './host-key-policy.js';
import type {
  SshAdapterPort,
  SshChannel,
  SshConnectCallbacks,
  SshConnectConfig,
  SshConnectionResource,
  SshExecOptions,
  SshExecResult,
  SshHostKeyChallenge,
  SshResourceAdapter,
  SshShellOptions,
  SshSftpResource
} from './types.js';

interface Ssh2ChannelLike extends EventEmitter {
  stderr: EventEmitter;
  write(data: string | Buffer): void;
  setWindow(rows: number, cols: number): void;
  close(): void;
}

interface Ssh2ExecChannelLike extends EventEmitter {
  stderr?: EventEmitter;
  close?: () => void;
}

interface Ssh2SftpLike {
  end?: () => void;
}

interface Ssh2ClientLike extends EventEmitter {
  connect(options: ConnectConfig): void;
  shell(options: PseudoTtyOptions, callback: (error: Error | undefined, channel: Ssh2ChannelLike) => void): void;
  exec?: (command: string, callback: (error: Error | undefined, channel: Ssh2ExecChannelLike) => void) => void;
  sftp?: (callback: (error: Error | undefined, sftp: Ssh2SftpLike) => void) => void;
  forwardOut?: (srcIP: string, srcPort: number, dstIP: string, dstPort: number, callback: (error: Error | undefined, socket: unknown) => void) => void;
  end(): void;
}

export interface Ssh2AdapterOptions {
  clientFactory?: () => Ssh2ClientLike;
  readyTimeout?: number;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
}

const DEFAULT_OPTIONS = {
  readyTimeout: 60_000,
  keepaliveInterval: 10_000,
  keepaliveCountMax: 3
} as const;

const asError = (value: unknown): Error => value instanceof Error ? value : new Error('SSH operation failed');

const mapError = (value: unknown): AppError => {
  if (value instanceof AppError) return value;
  const message = asError(value).message.toLowerCase();
  return new AppError(
    message.includes('auth') || message.includes('authentication') ? 'SSH_AUTH_FAILED' : 'SSH_CONNECTION_FAILED'
  );
};

const createClientOptions = (
  config: SshConnectConfig,
  options: Required<Pick<Ssh2AdapterOptions, 'readyTimeout' | 'keepaliveInterval' | 'keepaliveCountMax'>>,
  hostVerifier: NonNullable<ConnectConfig['hostVerifier']>,
  socket?: unknown
): ConnectConfig => {
  const base: ConnectConfig = {
    host: config.address,
    port: config.port || 22,
    username: config.username,
    readyTimeout: options.readyTimeout,
    keepaliveInterval: config.keepaliveInterval ?? options.keepaliveInterval,
    keepaliveCountMax: config.keepaliveCountMax ?? options.keepaliveCountMax,
    hostHash: 'sha256',
    hostVerifier,
    ...(socket === undefined ? {} : { sock: socket as ConnectConfig['sock'] })
  };

  if (config.auth.type === 'password') return { ...base, password: config.auth.password };
  return {
    ...base,
    privateKey: config.auth.privateKey,
    ...(config.auth.passphrase === undefined ? {} : { passphrase: config.auth.passphrase })
  };
};

const diagnostic = (
  hostId: string,
  stage: ConnectionDiagnostic['stage'],
  status: ConnectionDiagnostic['status'],
  hopIndex: number,
  code?: string
): ConnectionDiagnostic => ({
  id: randomUUID(),
  hostId,
  stage,
  status,
  hopIndex,
  retryable: code !== 'HOST_KEY_MISMATCH',
  ...(code === undefined ? {} : { code }),
  at: new Date().toISOString()
});

class SshChannelBridge extends EventEmitter implements SshChannel {
  private closed = false;

  constructor(
    private readonly rawChannel: Ssh2ChannelLike,
    private readonly closeResource: () => void
  ) {
    super();
    rawChannel.on('data', (data: Buffer | string) => this.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data)));
    rawChannel.stderr.on('data', (data: Buffer | string) => this.emit('stderr', Buffer.isBuffer(data) ? data : Buffer.from(data)));
    rawChannel.on('exit', (code: number | null, signal?: string) => this.emit('exit', code, signal));
    rawChannel.on('close', () => this.emitClosed());
    rawChannel.on('error', (error: Error) => this.emitChannelError(error));
  }

  write(data: string | Buffer): void {
    if (!this.closed) this.rawChannel.write(data);
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) this.rawChannel.setWindow(rows, cols);
  }

  close(): void {
    if (this.closed) return;
    try {
      this.rawChannel.close();
    } finally {
      this.closeResource();
      this.emitClosed();
    }
  }

  private emitClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  private emitChannelError(error: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', error);
  }
}

class Ssh2ConnectionResource implements SshConnectionResource {
  private closed = false;

  constructor(
    private readonly clients: readonly Ssh2ClientLike[],
    private readonly finalClient: Ssh2ClientLike,
    private readonly callbacks: SshConnectCallbacks,
    private readonly targetConfig: SshConnectConfig,
    private readonly targetHopIndex: number
  ) {
    finalClient.on('close', () => callbacks.onStatus?.('closed'));
  }

  openShell(options: SshShellOptions = {}): Promise<SshChannel> {
    if (this.closed) return Promise.reject(new AppError('SSH_CONNECTION_FAILED'));
    const pty: PseudoTtyOptions = {
      term: options.term ?? this.targetConfig.term ?? 'xterm-256color',
      cols: options.cols ?? this.targetConfig.cols ?? 120,
      rows: options.rows ?? this.targetConfig.rows ?? 36,
      width: 0,
      height: 0
    };
    this.callbacks.onDiagnostic?.(diagnostic(this.targetConfig.hostId, 'channel', 'started', this.targetHopIndex));
    return new Promise<SshChannel>((resolve, reject) => {
      try {
        this.finalClient.shell(pty, (error, rawChannel) => {
          if (error) {
            const mapped = mapError(error);
            this.callbacks.onDiagnostic?.(diagnostic(this.targetConfig.hostId, 'channel', 'failed', this.targetHopIndex, mapped.code));
            reject(mapped);
            return;
          }
          this.callbacks.onDiagnostic?.(diagnostic(this.targetConfig.hostId, 'channel', 'succeeded', this.targetHopIndex));
          resolve(new SshChannelBridge(rawChannel, () => this.close()));
        });
      } catch (error) {
        const mapped = mapError(error);
        this.callbacks.onDiagnostic?.(diagnostic(this.targetConfig.hostId, 'channel', 'failed', this.targetHopIndex, mapped.code));
        reject(mapped);
      }
    });
  }

  exec(command: string, options: SshExecOptions = {}): Promise<SshExecResult> {
    const exec = this.finalClient.exec;
    if (this.closed || !exec) return Promise.reject(new AppError('SSH_CONNECTION_FAILED'));
    this.callbacks.onDiagnostic?.(diagnostic(this.targetConfig.hostId, 'channel', 'started', this.targetHopIndex));
    return new Promise<SshExecResult>((resolve, reject) => {
      let channel: Ssh2ExecChannelLike | undefined;
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, result?: SshExecResult): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener('abort', onAbort);
        if (error) {
          const mapped = mapError(error);
          this.callbacks.onDiagnostic?.(diagnostic(this.targetConfig.hostId, 'channel', 'failed', this.targetHopIndex, mapped.code));
          reject(mapped);
          return;
        }
        this.callbacks.onDiagnostic?.(diagnostic(this.targetConfig.hostId, 'channel', 'succeeded', this.targetHopIndex));
        resolve(result ?? { exitCode: 0 });
      };
      const onAbort = (): void => {
        try { channel?.close?.(); } finally { finish(new AppError('COMMAND_RUN_CANCELLED')); }
      };
      if (options.timeoutMs !== undefined) timeout = setTimeout(() => {
        try { channel?.close?.(); } finally { finish(new AppError('SSH_CONNECTION_FAILED')); }
      }, options.timeoutMs);
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener('abort', onAbort, { once: true });
      try {
        exec.call(this.finalClient, command, (error, nextChannel) => {
          if (error) {
            finish(error);
            return;
          }
          channel = nextChannel;
          nextChannel.on('data', (data: Buffer | string) => options.onStdout?.(Buffer.isBuffer(data) ? data : Buffer.from(data)));
          nextChannel.stderr?.on('data', (data: Buffer | string) => options.onStderr?.(Buffer.isBuffer(data) ? data : Buffer.from(data)));
          nextChannel.on('exit', (code: number | null, signal?: string) => finish(undefined, { exitCode: code, ...(signal === undefined ? {} : { signal }) }));
          nextChannel.on('close', () => { if (!settled) finish(undefined, { exitCode: 0 }); });
          nextChannel.on('error', (nextError: Error) => finish(nextError));
        });
      } catch (error) {
        finish(error);
      }
    });
  }

  openSftp(): Promise<SshSftpResource> {
    if (this.closed || !this.finalClient.sftp) return Promise.reject(new AppError('SFTP_CONNECTION_FAILED'));
    return new Promise<SshSftpResource>((resolve, reject) => {
      try {
        this.finalClient.sftp?.((error, sftp) => {
          if (error) {
            reject(new AppError('SFTP_CONNECTION_FAILED'));
            return;
          }
          resolve({ close: () => sftp.end?.(), raw: sftp } as SshSftpResource & { raw: Ssh2SftpLike });
        });
      } catch {
        reject(new AppError('SFTP_CONNECTION_FAILED'));
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const client of [...this.clients].reverse()) {
      try { client.end(); } catch { /* already closed */ }
    }
  }
}

export class Ssh2ResourceAdapter implements SshResourceAdapter {
  private readonly clientFactory: () => Ssh2ClientLike;
  private readonly options: Required<Pick<Ssh2AdapterOptions, 'readyTimeout' | 'keepaliveInterval' | 'keepaliveCountMax'>>;

  constructor(options: Ssh2AdapterOptions = {}) {
    this.clientFactory = options.clientFactory ?? (() => new Client() as unknown as Ssh2ClientLike);
    this.options = {
      readyTimeout: options.readyTimeout ?? DEFAULT_OPTIONS.readyTimeout,
      keepaliveInterval: options.keepaliveInterval ?? DEFAULT_OPTIONS.keepaliveInterval,
      keepaliveCountMax: options.keepaliveCountMax ?? DEFAULT_OPTIONS.keepaliveCountMax
    };
  }

  async connect(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshConnectionResource> {
    callbacks.onStatus?.('connecting');
    callbacks.onDiagnostic?.(diagnostic(config.hostId, 'resolve', 'started', 0));
    const path = [...(config.jumpHosts ?? []), config];
    callbacks.onDiagnostic?.(diagnostic(config.hostId, 'resolve', 'succeeded', path.length - 1));
    const clients: Ssh2ClientLike[] = [];
    let upstream: Ssh2ClientLike | undefined;
    let upstreamSocket: unknown;
    try {
      for (const [hopIndex, hop] of path.entries()) {
        if (upstream) {
          callbacks.onDiagnostic?.(diagnostic(hop.hostId, 'jump', 'started', hopIndex));
          upstreamSocket = await this.forwardOut(upstream, hop);
          callbacks.onDiagnostic?.(diagnostic(hop.hostId, 'jump', 'succeeded', hopIndex));
        }
        const client = await this.connectClient(hop, callbacks, hopIndex, upstreamSocket);
        clients.push(client);
        upstream = client;
      }
      const finalClient = clients.at(-1);
      if (!finalClient) throw new AppError('CONNECTION_STAGE_FAILED');
      callbacks.onStatus?.('connected');
      return new Ssh2ConnectionResource(clients, finalClient, callbacks, config, path.length - 1);
    } catch (error) {
      for (const client of [...clients].reverse()) {
        try { client.end(); } catch { /* best effort cleanup */ }
      }
      callbacks.onStatus?.('failed');
      throw mapError(error);
    }
  }

  private forwardOut(client: Ssh2ClientLike, hop: SshConnectConfig): Promise<unknown> {
    const forwardOut = client.forwardOut;
    if (!forwardOut) return Promise.reject(new AppError('CONNECTION_STAGE_FAILED'));
    return new Promise<unknown>((resolve, reject) => {
      try {
        forwardOut.call(client, '127.0.0.1', 0, hop.address, hop.port, (error, socket) => error ? reject(error) : resolve(socket));
      } catch (error) {
        reject(error);
      }
    });
  }

  private connectClient(config: SshConnectConfig, callbacks: SshConnectCallbacks, hopIndex: number, socket?: unknown): Promise<Ssh2ClientLike> {
    const client = this.clientFactory();
    callbacks.onDiagnostic?.(diagnostic(config.hostId, 'tcp', 'started', hopIndex));
    return new Promise<Ssh2ClientLike>((resolve, reject) => {
      let ready = false;
      let settled = false;
      const cleanup = (): void => {
        client.removeListener('ready', onReady);
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const mapped = mapError(error);
        callbacks.onDiagnostic?.(diagnostic(config.hostId, ready ? 'authentication' : 'tcp', 'failed', hopIndex, mapped.code));
        try { client.end(); } catch { /* connection may already be closed */ }
        reject(mapped);
      };
      const onError = (error: Error): void => fail(error);
      const onClose = (): void => { if (!ready) fail(new Error('SSH connection closed before ready')); };
      const onReady = (): void => {
        ready = true;
        callbacks.onDiagnostic?.(diagnostic(config.hostId, 'tcp', 'succeeded', hopIndex));
        callbacks.onDiagnostic?.(diagnostic(config.hostId, 'authentication', 'succeeded', hopIndex));
        settled = true;
        cleanup();
        resolve(client);
      };
      const hostVerifier = (value: string | Buffer, verify: (accepted: boolean) => void): void => {
        let fingerprint: string;
        try {
          fingerprint = normalizeFingerprint(value);
        } catch {
          callbacks.onDiagnostic?.(diagnostic(config.hostId, 'host-key', 'failed', hopIndex, 'HOST_KEY_MISMATCH'));
          verify(false);
          return;
        }
        const challenge: SshHostKeyChallenge = {
          algorithm: config.hostKeyAlgorithm ?? 'ssh-unknown',
          fingerprint,
          address: config.address,
          port: config.port || 22,
          hostId: config.hostId,
          hopIndex
        };
        callbacks.onDiagnostic?.(diagnostic(config.hostId, 'host-key', 'started', hopIndex));
        void callbacks.onHostKey(challenge).then((accepted) => {
          callbacks.onDiagnostic?.(diagnostic(config.hostId, 'host-key', accepted ? 'succeeded' : 'failed', hopIndex, accepted ? undefined : 'HOST_KEY_MISMATCH'));
          verify(accepted);
        }, () => {
          callbacks.onDiagnostic?.(diagnostic(config.hostId, 'host-key', 'failed', hopIndex, 'HOST_KEY_MISMATCH'));
          verify(false);
        });
      };
      client.once('ready', onReady);
      client.once('error', onError);
      client.once('close', onClose);
      try {
        client.connect(createClientOptions(config, this.options, hostVerifier, socket));
      } catch (error) {
        fail(error);
      }
    });
  }
}

/** Backward-compatible PTY adapter; new consumers should use Ssh2ResourceAdapter. */
export class Ssh2Adapter implements SshAdapterPort {
  private readonly resourceAdapter: Ssh2ResourceAdapter;

  constructor(options: Ssh2AdapterOptions = {}) {
    this.resourceAdapter = new Ssh2ResourceAdapter(options);
  }

  async connect(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshChannel> {
    const resource = await this.resourceAdapter.connect(config, callbacks);
    try {
      return await resource.openShell(config);
    } catch (error) {
      resource.close();
      throw error;
    }
  }

  async testConnection(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<{ ok: boolean; hostKey?: SshHostKeyChallenge }> {
    let challenge: SshHostKeyChallenge | undefined;
    try {
      const channel = await this.connect(config, {
        ...callbacks,
        onHostKey: async (nextChallenge) => {
          challenge = nextChallenge;
          return callbacks.onHostKey(nextChallenge);
        }
      });
      channel.close();
      return { ok: true };
    } catch (error) {
      if (challenge) return { ok: false, hostKey: challenge };
      throw error;
    }
  }
}
