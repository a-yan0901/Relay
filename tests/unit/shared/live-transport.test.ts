import { describe, expect, it } from 'vitest';

import { encryptLiveFrame } from '../../../src/shared/cloud/live-crypto.js';
import {
  decodeLiveTransportEnvelope,
  decryptLiveTransportFrame,
  encodeLiveTransportEnvelope,
  encryptLiveTransportFrame
} from '../../../src/shared/cloud/live-transport.js';

const baseKey = new Uint8Array(32).fill(7);
const outputFrame = {
  protocolVersion: 1 as const,
  type: 'terminal-output' as const,
  workspaceId: 'workspace-1',
  sessionId: 'session-1',
  ownerEpoch: 3,
  sequence: 1,
  payload: 'secret output'
};

describe('targeted live transport envelope', () => {
  it('keeps recipient metadata visible but protects the terminal payload', async () => {
    const encrypted = await encryptLiveTransportFrame({
      baseKey,
      frame: outputFrame,
      workspaceId: 'workspace-1',
      ownerDeviceId: 'device-owner',
      senderDeviceId: 'device-owner',
      recipientDeviceId: 'device-viewer',
      ownerEpoch: 3,
      direction: 'owner-to-viewer'
    });
    const decoded = decodeLiveTransportEnvelope(encrypted);

    expect(decoded.senderDeviceId).toBe('device-owner');
    expect(decoded.recipientDeviceId).toBe('device-viewer');
    expect(new TextDecoder().decode(encrypted)).not.toContain('secret output');
    await expect(decryptLiveTransportFrame({
      baseKey,
      envelope: decoded,
      localDeviceId: 'device-viewer',
      ownerDeviceId: 'device-owner',
      role: 'viewer'
    })).resolves.toEqual(outputFrame);
  });

  it('does not make a targeted frame available to another viewer', async () => {
    const encrypted = await encryptLiveFrame(baseKey, outputFrame);
    const wire = encodeLiveTransportEnvelope({
      workspaceId: 'workspace-1',
      ownerEpoch: 3,
      senderDeviceId: 'device-owner',
      recipientDeviceId: 'device-viewer-a',
      encrypted
    });
    const envelope = decodeLiveTransportEnvelope(wire);

    await expect(decryptLiveTransportFrame({
      baseKey,
      envelope,
      localDeviceId: 'device-viewer-b',
      ownerDeviceId: 'device-owner',
      role: 'viewer'
    })).resolves.toBeNull();
  });

  it('binds the derived key to the recipient instead of trusting visible metadata', async () => {
    const wire = await encryptLiveTransportFrame({
      baseKey,
      frame: outputFrame,
      workspaceId: 'workspace-1',
      ownerDeviceId: 'device-owner',
      senderDeviceId: 'device-owner',
      recipientDeviceId: 'device-viewer-a',
      ownerEpoch: 3,
      direction: 'owner-to-viewer'
    });
    const original = decodeLiveTransportEnvelope(wire);
    const retargeted = decodeLiveTransportEnvelope(encodeLiveTransportEnvelope({
      workspaceId: original.workspaceId,
      ownerEpoch: original.ownerEpoch,
      senderDeviceId: original.senderDeviceId,
      recipientDeviceId: 'device-viewer-b',
      encrypted: original.ciphertext
    }));

    await expect(decryptLiveTransportFrame({
      baseKey,
      envelope: retargeted,
      localDeviceId: 'device-viewer-b',
      ownerDeviceId: 'device-owner',
      role: 'viewer'
    })).rejects.toThrow();
  });

  it('rejects a transport envelope that exceeds the relay frame bound', () => {
    expect(() => encodeLiveTransportEnvelope({
      workspaceId: 'workspace-1',
      ownerEpoch: 3,
      senderDeviceId: 'device-owner',
      recipientDeviceId: 'device-viewer',
      encrypted: new TextEncoder().encode(JSON.stringify({
        protocolVersion: 1,
        aad: 'relay-live:v1:workspace-1',
        nonce: 'a'.repeat(16),
        ciphertext: 'a'.repeat(64 * 1024)
      }))
    })).toThrow('live transport frame too large');
  });
});
