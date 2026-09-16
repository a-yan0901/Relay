import type { ConnectionProfileSettings, HostCredentialInput } from '../../shared/validation.js';

export interface SshConnectConfig {
  hostId: string;
  address: string;
  port: number;
  username: string;
  auth: HostCredentialInput;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
  reconnect?: ConnectionProfileSettings['reconnect'];
  cols?: number;
  rows?: number;
  term?: string;
  jumpHosts?: readonly SshConnectConfig[];
}

export interface SshHostKeyChallenge {
  algorithm: string;
  fingerprint: string;
  address: string;
  port: number;
  hostId?: string;
  hopIndex?: number;
  reason?: 'first-seen' | 'changed';
  previous?: {
    algorithm: string;
    fingerprint: string;
  };
}

export interface SshChannel {
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  close(): void;
  on(event: 'data', listener: (data: Buffer) => void): this;
  on(event: 'stderr', listener: (data: Buffer) => void): this;
  on(event: 'exit', listener: (code: number | null, signal?: string) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
}

export interface SshConnectCallbacks {
  onHostKey(challenge: SshHostKeyChallenge): Promise<boolean>;
  onStatus?(state: 'connecting' | 'awaiting-host-key' | 'connected' | 'closed' | 'failed'): void;
  onDiagnostic?(event: import('../../shared/core/models.js').ConnectionDiagnostic): void;
}

export interface SshShellOptions {
  cols?: number;
  rows?: number;
  term?: string;
}

export interface SshExecOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  onStdout?: (data: Buffer) => void;
  onStderr?: (data: Buffer) => void;
}

export interface SshExecResult {
  exitCode: number | null;
  signal?: string;
}

export interface SshSftpResource {
  raw?: unknown;
  close(): void;
}

export interface SshConnectionResource {
  openShell(options?: SshShellOptions): Promise<SshChannel>;
  exec(command: string, options?: SshExecOptions): Promise<SshExecResult>;
  openSftp(): Promise<SshSftpResource>;
  close(): void;
}

export interface SshAdapterPort {
  connect(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshChannel | SshConnectionResource>;
  testConnection(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<{
    ok: boolean;
    hostKey?: SshHostKeyChallenge;
  }>;
}

export interface SshResourceAdapter {
  connect(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshConnectionResource>;
}

export interface SshSessionManagerPort {
  open(sessionId: string, config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshChannel>;
  testConnection(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<{
    ok: boolean;
    hostKey?: SshHostKeyChallenge;
  }>;
  detach(sessionId: string): void;
  reattach(sessionId: string, expectedHostId?: string): SshChannel | null;
  getBufferedOutput(sessionId: string, expectedHostId?: string): Buffer | null;
  close(sessionId: string): void;
  closeAll?(): void;
  closeForHost?(hostId: string): void;
}
