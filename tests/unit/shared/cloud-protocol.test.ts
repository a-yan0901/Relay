import { describe, expect, it } from 'vitest';

import {
  CLOUD_PROTOCOL_VERSION,
  createCloudDataAad,
  createInputSequencer,
  parseCloudDataEnvelope,
  parseCloudKeyGrant,
  trackLiveSequence,
  type LiveInputRequest
} from '../../../src/shared/cloud/protocol.js';

describe('cloud protocol contract', () => {
  it('accepts account data and workspace envelopes without allowing plaintext fields', () => {
    const accountData = parseCloudDataEnvelope({
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      domain: 'account-data',
      accountId: 'account-1',
      revision: 3,
      parentRevision: 2,
      writerDeviceId: 'device-1',
      keyVersion: 1,
      nonce: 'nonce',
      ciphertext: 'ciphertext',
      authTag: 'tag',
      aad: createCloudDataAad({ domain: 'account-data', accountId: 'account-1', revision: 3, parentRevision: 2, keyVersion: 1, writerDeviceId: 'device-1' }),
      payloadHash: 'a'.repeat(64),
      byteLength: 12
    });

    expect(accountData.domain).toBe('account-data');
    expect(() => parseCloudDataEnvelope({ ...accountData, hosts: [{ password: 'secret' }] })).toThrow('invalid');
    expect(() => parseCloudDataEnvelope({ ...accountData, aad: 'relay:v1:wrong' })).toThrow('invalid');

    expect(parseCloudDataEnvelope({
      ...accountData,
      domain: 'workspace',
      workspaceId: 'workspace-1',
      aad: createCloudDataAad({ domain: 'workspace', accountId: 'account-1', workspaceId: 'workspace-1', revision: 3, parentRevision: 2, keyVersion: 1, writerDeviceId: 'device-1' })
    }).workspaceId).toBe('workspace-1');
  });

  it('rejects a workspace envelope without its workspace identity', () => {
    expect(() => parseCloudDataEnvelope({
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      domain: 'workspace',
      accountId: 'account-1',
      revision: 1,
      parentRevision: null,
      writerDeviceId: 'device-1',
      keyVersion: 1,
      nonce: 'nonce',
      ciphertext: 'ciphertext',
      authTag: 'tag',
      aad: 'aad',
      payloadHash: 'a'.repeat(64),
      byteLength: 12
    })).toThrow('invalid');
  });

  it('accepts a bounded opaque key grant and rejects oversized wrappers', () => {
    const grant = parseCloudKeyGrant({
      protocolVersion: 1,
      domain: 'account-data',
      accountId: 'account-1',
      resourceId: 'account-1',
      recipientDeviceId: 'device-1',
      keyVersion: 1,
      wrappedKey: { scheme: 'x25519-aes256gcm', ciphertext: 'wrapped' }
    });

    expect(grant.recipientDeviceId).toBe('device-1');
    expect(() => parseCloudKeyGrant({
      protocolVersion: 1,
      domain: 'account-data',
      accountId: 'account-1',
      resourceId: 'account-1',
      recipientDeviceId: 'device-1',
      keyVersion: 1,
      wrappedKey: { ciphertext: 'x'.repeat(17 * 1024) }
    })).toThrow();
  });

  it('orders concurrent input by owner sequence and de-duplicates retries', () => {
    const sequencer = createInputSequencer();
    const first: LiveInputRequest = {
      participantDeviceId: 'device-a',
      inputId: 'input-a',
      sessionId: 'session-1',
      payload: 'ls\n'
    };
    const second: LiveInputRequest = {
      participantDeviceId: 'device-b',
      inputId: 'input-b',
      sessionId: 'session-1',
      payload: 'pwd\n'
    };

    expect(sequencer.accept(first)).toMatchObject({ status: 'accepted', inputSequence: 1, request: first });
    expect(sequencer.accept(second)).toMatchObject({ status: 'accepted', inputSequence: 2, request: second });
    expect(sequencer.accept(first)).toMatchObject({ status: 'duplicate', inputSequence: 1, request: first });
  });

  it('keeps the input de-duplication window bounded for long-lived owners', () => {
    const sequencer = createInputSequencer(64);
    for (let index = 0; index < 64; index += 1) {
      expect(sequencer.accept({
        participantDeviceId: 'device-a',
        inputId: `input-${index}`,
        sessionId: 'session-1',
        payload: `${index}`
      }).status).toBe('accepted');
    }
    expect(sequencer.size()).toBe(64);
    expect(sequencer.accept({
      participantDeviceId: 'device-a',
      inputId: 'input-64',
      sessionId: 'session-1',
      payload: '64'
    }).status).toBe('accepted');
    expect(sequencer.size()).toBe(64);
    expect(sequencer.accept({
      participantDeviceId: 'device-a',
      inputId: 'input-0',
      sessionId: 'session-1',
      payload: '0'
    }).status).toBe('accepted');
  });

  it('requires a fresh snapshot when live output has a sequence gap or owner epoch changes', () => {
    const tracker = trackLiveSequence();
    expect(tracker.apply({ kind: 'snapshot', ownerEpoch: 7, sequence: 10 })).toEqual({ status: 'applied', nextSequence: 11 });
    expect(tracker.apply({ kind: 'output', ownerEpoch: 7, sequence: 11 })).toEqual({ status: 'applied', nextSequence: 12 });
    expect(tracker.apply({ kind: 'output', ownerEpoch: 7, sequence: 13 })).toEqual({ status: 'resync-required', nextSequence: 12 });
    expect(tracker.apply({ kind: 'output', ownerEpoch: 8, sequence: 1 })).toEqual({ status: 'epoch-changed', nextSequence: null });
  });
});
