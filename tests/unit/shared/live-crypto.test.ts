import { describe, expect, it } from 'vitest';

import { decryptLiveFrame, encryptLiveFrame } from '../../../src/shared/cloud/live-crypto.js';

const frame = {
  protocolVersion: 1 as const,
  type: 'terminal-output' as const,
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  ownerEpoch: 1,
  sequence: 1,
  payload: 'secret output'
};

describe('live frame encryption', () => {
  it('encrypts a frame without exposing the terminal payload and round-trips it', async () => {
    const key = new Uint8Array(32).fill(7);
    const encrypted = await encryptLiveFrame(key, frame);

    expect(new TextDecoder().decode(encrypted)).not.toContain('secret output');
    await expect(decryptLiveFrame(key, encrypted)).resolves.toEqual(frame);
  });

  it('rejects a wrong key or tampered ciphertext', async () => {
    const key = new Uint8Array(32).fill(7);
    const encrypted = await encryptLiveFrame(key, frame);
    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 2] = tampered[tampered.length - 2] ^ 1;

    await expect(decryptLiveFrame(new Uint8Array(32).fill(8), encrypted)).rejects.toThrow();
    await expect(decryptLiveFrame(key, tampered)).rejects.toThrow();
  });

  it('requires a 256-bit session key', async () => {
    await expect(encryptLiveFrame(new Uint8Array(16), frame)).rejects.toThrow();
  });
});
