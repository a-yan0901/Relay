import { describe, expect, it } from 'vitest';

import { HostKeyPolicy } from '../../../src/server/ssh/host-key-policy.js';

const challengeOptions = {
  hostId: 'host-1',
  address: '10.0.0.8',
  port: 22,
  knownHostKey: null as { algorithm: string; fingerprint: string } | null
};

describe('HostKeyPolicy', () => {
  it('pauses an unknown key and exposes a complete UI challenge', () => {
    const saved: Array<{ algorithm: string; fingerprint: string }> = [];
    const policy = new HostKeyPolicy({
      ...challengeOptions,
      saveHostKey: (_hostId, algorithm, fingerprint) => saved.push({ algorithm, fingerprint })
    });
    let verification: boolean | undefined;

    policy.verifyFingerprint('SHA256:fixture-key', 'ssh-ed25519', (accepted) => {
      verification = accepted;
    });

    expect(verification).toBeUndefined();
    expect(policy.pendingChallenge).toEqual({
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:fixture-key',
      address: '10.0.0.8',
      hostId: 'host-1',
      port: 22
    });
    expect(saved).toEqual([]);
  });

  it('accepts a matching fingerprint and hard-rejects a mismatch', () => {
    const matching = new HostKeyPolicy({
      ...challengeOptions,
      knownHostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:fixture-key' },
      saveHostKey: () => undefined
    });
    let accepted: boolean | undefined;
    matching.verifyFingerprint('SHA256:fixture-key', 'ssh-ed25519', (result) => {
      accepted = result;
    });
    expect(accepted).toBe(true);

    const mismatch = new HostKeyPolicy({
      ...challengeOptions,
      knownHostKey: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:old-key' },
      saveHostKey: () => undefined
    });
    let rejected: boolean | undefined;
    mismatch.verifyFingerprint('SHA256:new-key', 'ssh-ed25519', (result) => {
      rejected = result;
    });
    expect(rejected).toBe(false);
    expect(mismatch.pendingChallenge).toBeNull();
  });

  it('persists a trusted key only after a matching trust decision', () => {
    const saved: Array<{ hostId: string; algorithm: string; fingerprint: string }> = [];
    const policy = new HostKeyPolicy({
      ...challengeOptions,
      saveHostKey: (hostId, algorithm, fingerprint) => saved.push({ hostId, algorithm, fingerprint })
    });
    let accepted: boolean | undefined;
    policy.verifyFingerprint('SHA256:fixture-key', 'ssh-rsa', (result) => {
      accepted = result;
    });

    expect(policy.decide('trust', 'SHA256:other-key')).toBe(false);
    expect(saved).toEqual([]);
    expect(accepted).toBeUndefined();

    expect(policy.decide('trust', 'SHA256:fixture-key')).toBe(true);
    expect(saved).toEqual([{
      hostId: 'host-1',
      algorithm: 'ssh-rsa',
      fingerprint: 'SHA256:fixture-key'
    }]);
    expect(accepted).toBe(true);
    expect(policy.pendingChallenge).toBeNull();
  });

  it('never mutates the repository when the user rejects a key', () => {
    const saved: unknown[] = [];
    const policy = new HostKeyPolicy({
      ...challengeOptions,
      saveHostKey: (...args) => saved.push(args)
    });
    let accepted: boolean | undefined;
    policy.verifyFingerprint('SHA256:fixture-key', 'ssh-ed25519', (result) => {
      accepted = result;
    });

    expect(policy.decide('reject', 'SHA256:fixture-key')).toBe(false);
    expect(accepted).toBe(false);
    expect(saved).toEqual([]);
    expect(policy.pendingChallenge).toBeNull();
  });
});
