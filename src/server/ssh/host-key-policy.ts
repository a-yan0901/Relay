import { createHash } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import type { SshHostKeyChallenge } from './types.js';

export interface KnownHostKey {
  algorithm: string;
  fingerprint: string;
}

export interface HostKeyPolicyOptions {
  hostId: string;
  address: string;
  port: number;
  knownHostKey: KnownHostKey | null;
  saveHostKey: (hostId: string, algorithm: string, fingerprint: string) => void;
}

type VerifyCallback = (accepted: boolean) => void;

interface PendingVerification {
  challenge: SshHostKeyChallenge;
  verify: VerifyCallback;
}

const stripBase64Padding = (value: string): string => value.replace(/=+$/u, '');

export const normalizeFingerprint = (value: string | Buffer): string => {
  if (Buffer.isBuffer(value)) {
    return `SHA256:${stripBase64Padding(createHash('sha256').update(value).digest('base64'))}`;
  }

  if (/^SHA256:[A-Za-z0-9+/=_-]+$/u.test(value)) {
    return `SHA256:${stripBase64Padding(value.slice('SHA256:'.length))}`;
  }

  if (/^[a-f0-9]{64}$/iu.test(value)) {
    return `SHA256:${stripBase64Padding(Buffer.from(value, 'hex').toString('base64'))}`;
  }

  throw new AppError('HOST_KEY_MISMATCH');
};

export class HostKeyPolicy {
  private readonly options: HostKeyPolicyOptions;
  private knownHostKey: KnownHostKey | null;
  private pending: PendingVerification | null = null;
  private mismatch = false;

  constructor(options: HostKeyPolicyOptions) {
    this.options = options;
    this.knownHostKey = options.knownHostKey;
  }

  get pendingChallenge(): SshHostKeyChallenge | null {
    return this.pending?.challenge ?? null;
  }

  get hasMismatch(): boolean {
    return this.mismatch;
  }

  verifyFingerprint(value: string | Buffer, algorithm: string, verify: VerifyCallback): void {
    let fingerprint: string;
    try {
      fingerprint = normalizeFingerprint(value);
    } catch {
      verify(false);
      return;
    }

    if (this.knownHostKey !== null) {
      this.mismatch = fingerprint !== normalizeFingerprint(this.knownHostKey.fingerprint);
      verify(!this.mismatch);
      return;
    }

    this.mismatch = false;
    if (this.pending !== null) {
      this.pending.verify(false);
    }
    this.pending = {
      challenge: {
        algorithm,
        fingerprint,
        address: this.options.address,
        port: this.options.port
      },
      verify
    };
  }

  decide(decision: 'trust' | 'reject', fingerprint: string): boolean {
    if (this.pending === null) {
      return false;
    }

    const normalized = normalizeFingerprint(fingerprint);
    if (normalized !== this.pending.challenge.fingerprint) {
      return false;
    }

    const pending = this.pending;
    this.pending = null;
    if (decision === 'reject') {
      this.mismatch = false;
      pending.verify(false);
      return false;
    }

    try {
      this.options.saveHostKey(
        this.options.hostId,
        pending.challenge.algorithm,
        pending.challenge.fingerprint
      );
      this.knownHostKey = {
        algorithm: pending.challenge.algorithm,
        fingerprint: pending.challenge.fingerprint
      };
      this.mismatch = false;
      pending.verify(true);
      return true;
    } catch {
      pending.verify(false);
      throw new AppError('HOST_KEY_MISMATCH');
    }
  }
}
