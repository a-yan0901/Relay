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
  clearHostKey?: (hostId: string) => void;
  hopIndex?: number;
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
      let knownFingerprint: string;
      try {
        knownFingerprint = normalizeFingerprint(this.knownHostKey.fingerprint);
      } catch {
        this.mismatch = true;
        verify(false);
        return;
      }

      const changed = algorithm !== this.knownHostKey.algorithm || fingerprint !== knownFingerprint;
      this.mismatch = changed;
      if (!changed) {
        verify(true);
        return;
      }

      if (this.pending !== null) {
        this.pending.verify(false);
      }
      this.pending = {
        challenge: {
          algorithm,
          fingerprint,
          address: this.options.address,
          port: this.options.port,
          hostId: this.options.hostId,
          reason: 'changed',
          previous: {
            algorithm: this.knownHostKey.algorithm,
            fingerprint: knownFingerprint
          },
          ...(this.options.hopIndex === undefined ? {} : { hopIndex: this.options.hopIndex })
        },
        verify
      };
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
        port: this.options.port,
        hostId: this.options.hostId,
        reason: 'first-seen',
        ...(this.options.hopIndex === undefined ? {} : { hopIndex: this.options.hopIndex })
      },
      verify
    };
  }

  decide(decision: 'trust' | 'reject', fingerprint: string): boolean {
    if (this.pending === null) {
      return false;
    }

    let normalized: string;
    try {
      normalized = normalizeFingerprint(fingerprint);
    } catch {
      return false;
    }
    if (normalized !== this.pending.challenge.fingerprint) {
      return false;
    }

    const pending = this.pending;
    this.pending = null;
    if (decision === 'reject') {
      this.mismatch = pending.challenge.reason === 'changed';
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

  clearKnownHostKey(): void {
    if (!this.options.clearHostKey) {
      throw new AppError('INTERNAL_ERROR', '当前 Host Key policy 未配置清除信任操作');
    }

    const pending = this.pending;
    this.pending = null;
    pending?.verify(false);
    try {
      this.options.clearHostKey(this.options.hostId);
      this.knownHostKey = null;
      this.mismatch = false;
    } catch {
      throw new AppError('HOST_KEY_MISMATCH');
    }
  }
}
