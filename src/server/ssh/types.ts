import type { HostCredentialInput } from '../../shared/validation.js';

export interface SshConnectConfig {
  hostId: string;
  address: string;
  port: number;
  username: string;
  auth: HostCredentialInput;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
  cols?: number;
  rows?: number;
  term?: string;
}

export interface SshHostKeyChallenge {
  algorithm: string;
  fingerprint: string;
  address: string;
  port: number;
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
}

export interface SshAdapterPort {
  connect(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshChannel>;
  testConnection(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<{
    ok: boolean;
    hostKey?: SshHostKeyChallenge;
  }>;
}

export interface SshSessionManagerPort {
  open(sessionId: string, config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshChannel>;
  testConnection(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<{
    ok: boolean;
    hostKey?: SshHostKeyChallenge;
  }>;
  detach(sessionId: string): void;
  reattach(sessionId: string): SshChannel | null;
  close(sessionId: string): void;
  closeAll?(): void;
}
