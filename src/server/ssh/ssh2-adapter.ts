import { EventEmitter } from 'node:events';

import { Client, type ConnectConfig, type PseudoTtyOptions } from 'ssh2';

import { AppError } from '../../shared/errors.js';
import { normalizeFingerprint } from './host-key-policy.js';
import type {
  SshAdapterPort,
  SshChannel,
  SshConnectCallbacks,
  SshConnectConfig,
  SshHostKeyChallenge
} from './types.js';

interface Ssh2ChannelLike extends EventEmitter {
  stderr: EventEmitter;
  write(data: string | Buffer): void;
  setWindow(rows: number, cols: number): void;
  close(): void;
}

interface Ssh2ClientLike extends EventEmitter {
  connect(options: ConnectConfig): void;
  shell(options: PseudoTtyOptions, callback: (error: Error | undefined, channel: Ssh2ChannelLike) => void): void;
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
  if (value instanceof AppError) {
    return value;
  }

  const message = asError(value).message.toLowerCase();
  return new AppError(
    message.includes('auth') || message.includes('authentication')
      ? 'SSH_AUTH_FAILED'
      : 'SSH_CONNECTION_FAILED'
  );
};

const createClientOptions = (
  config: SshConnectConfig,
  options: Required<Pick<Ssh2AdapterOptions, 'readyTimeout' | 'keepaliveInterval' | 'keepaliveCountMax'>>,
  hostVerifier: NonNullable<ConnectConfig['hostVerifier']>
): ConnectConfig => {
  const base: ConnectConfig = {
    host: config.address,
    port: config.port || 22,
    username: config.username,
    readyTimeout: options.readyTimeout,
    keepaliveInterval: options.keepaliveInterval,
    keepaliveCountMax: options.keepaliveCountMax,
    hostHash: 'sha256',
    hostVerifier
  };

  if (config.auth.type === 'password') {
    return { ...base, password: config.auth.password };
  }

  return {
    ...base,
    privateKey: config.auth.privateKey,
    ...(config.auth.passphrase === undefined ? {} : { passphrase: config.auth.passphrase })
  };
};

class SshChannelBridge extends EventEmitter implements SshChannel {
  private closed = false;

  constructor(
    private readonly rawChannel: Ssh2ChannelLike,
    private readonly client: Ssh2ClientLike
  ) {
    super();
    rawChannel.on('data', (data: Buffer | string) => {
      this.emit('data', Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    rawChannel.stderr.on('data', (data: Buffer | string) => {
      this.emit('stderr', Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    rawChannel.on('exit', (code: number | null, signal?: string) => {
      this.emit('exit', code, signal);
    });
    rawChannel.on('close', () => this.emitClosed());
    rawChannel.on('error', (error: Error) => this.emitChannelError(error));
    client.on('close', () => this.emitClosed());
    client.on('error', (error: Error) => this.emitChannelError(error));
  }

  write(data: string | Buffer): void {
    if (!this.closed) {
      this.rawChannel.write(data);
    }
  }

  resize(cols: number, rows: number): void {
    if (!this.closed) {
      this.rawChannel.setWindow(rows, cols);
    }
  }

  close(): void {
    if (this.closed) {
      return;
    }

    try {
      this.rawChannel.close();
    } finally {
      try {
        this.client.end();
      } finally {
        this.emitClosed();
      }
    }
  }

  private emitClosed(): void {
    if (!this.closed) {
      this.closed = true;
      this.emit('close');
    }
  }

  private emitChannelError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
    }
  }
}

export class Ssh2Adapter implements SshAdapterPort {
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

  connect(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshChannel> {
    callbacks.onStatus?.('connecting');
    const client = this.clientFactory();

    return new Promise<SshChannel>((resolve, reject) => {
      let ready = false;
      let settled = false;

      const cleanup = (): void => {
        client.removeListener('ready', onReady);
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
      };
      const fail = (error: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        callbacks.onStatus?.('failed');
        try {
          client.end();
        } catch {
          // The connection may already be closed.
        }
        reject(mapError(error));
      };
      const onError = (error: Error): void => fail(error);
      const onClose = (): void => {
        if (!ready) {
          fail(new Error('SSH connection closed before ready'));
        }
      };
      const onReady = (): void => {
        ready = true;
        const pty: PseudoTtyOptions = {
          term: config.term ?? 'xterm-256color',
          cols: config.cols ?? 120,
          rows: config.rows ?? 36,
          width: 0,
          height: 0
        };

        try {
          client.shell(pty, (error, rawChannel) => {
            if (settled) {
              return;
            }
            if (error) {
              fail(error);
              return;
            }

            const channel = new SshChannelBridge(rawChannel, client);
            settled = true;
            cleanup();
            callbacks.onStatus?.('connected');
            resolve(channel);
          });
        } catch (error) {
          fail(error);
        }
      };

      const hostVerifier = (
        value: string | Buffer,
        verify: (accepted: boolean) => void
      ): void => {
        let fingerprint: string;
        try {
          fingerprint = normalizeFingerprint(value);
        } catch {
          verify(false);
          return;
        }

        const challenge: SshHostKeyChallenge = {
          algorithm: config.hostKeyAlgorithm ?? 'ssh-unknown',
          fingerprint,
          address: config.address,
          port: config.port || 22
        };
        void callbacks.onHostKey(challenge)
          .then((accepted) => verify(accepted), () => verify(false));
      };

      client.once('ready', onReady);
      client.once('error', onError);
      client.once('close', onClose);

      try {
        client.connect(createClientOptions(config, this.options, hostVerifier));
      } catch (error) {
        fail(error);
      }
    });
  }

  async testConnection(
    config: SshConnectConfig,
    callbacks: SshConnectCallbacks
  ): Promise<{ ok: boolean; hostKey?: SshHostKeyChallenge }> {
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
      if (challenge) {
        return { ok: false, hostKey: challenge };
      }
      throw error;
    }
  }
}
