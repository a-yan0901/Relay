import { describe, expect, it } from 'vitest';

import { BoundedRelayHub, type RelayPeer } from '../../../src/cloud/relay.js';

const peer = () => {
  const received: Uint8Array[] = [];
  let closed = false;
  const value: RelayPeer & { received: Uint8Array[]; isClosed: () => boolean } = {
    received,
    bufferedBytes: 0,
    send(frame) { received.push(frame); },
    close() { closed = true; },
    isClosed: () => closed
  };
  return value;
};

describe('bounded live relay hub', () => {
  it('routes viewer input to the owner and owner output to every viewer', () => {
    const hub = new BoundedRelayHub({ maxFrameBytes: 64, maxBufferedBytes: 256, maxSubscribersPerWorkspace: 2 });
    const owner = peer();
    const viewerA = peer();
    const viewerB = peer();
    hub.registerOwner('workspace-1', 'device-owner', owner);
    const subscriptionA = hub.subscribeViewer('workspace-1', 'device-a', viewerA);
    const subscriptionB = hub.subscribeViewer('workspace-1', 'device-b', viewerB);

    expect(hub.forwardFromViewer('workspace-1', 'device-a', new Uint8Array([1, 2]))).toBe(true);
    expect(owner.received).toHaveLength(1);
    expect(viewerA.received).toHaveLength(0);
    expect(hub.forwardFromOwner('workspace-1', new Uint8Array([3, 4]))).toBe(2);
    expect(viewerA.received[0]).toEqual(new Uint8Array([3, 4]));
    expect(viewerB.received[0]).toEqual(new Uint8Array([3, 4]));
    subscriptionA.close();
    subscriptionB.close();
  });

  it('drops an oversized frame and removes a slow viewer before buffering grows', () => {
    const hub = new BoundedRelayHub({ maxFrameBytes: 4, maxBufferedBytes: 8, maxSubscribersPerWorkspace: 2 });
    const owner = peer();
    const slow = peer();
    slow.bufferedBytes = 8;
    hub.registerOwner('workspace-1', 'device-owner', owner);
    hub.subscribeViewer('workspace-1', 'device-slow', slow);

    expect(hub.forwardFromOwner('workspace-1', new Uint8Array([1, 2, 3, 4, 5]))).toBe(0);
    expect(hub.forwardFromOwner('workspace-1', new Uint8Array([1, 2, 3, 4]))).toBe(0);
    expect(slow.isClosed()).toBe(true);
  });

  it('closes every live route belonging to a revoked device', () => {
    const hub = new BoundedRelayHub({ maxFrameBytes: 64, maxBufferedBytes: 256, maxSubscribersPerWorkspace: 2 });
    const owner = peer();
    const viewer = peer();
    const otherOwner = peer();
    hub.registerOwner('workspace-1', 'device-owner', owner);
    hub.subscribeViewer('workspace-1', 'device-viewer', viewer);
    hub.registerOwner('workspace-2', 'device-owner', otherOwner);

    expect(hub.closeDevice('device-viewer')).toBe(1);
    expect(viewer.isClosed()).toBe(true);
    expect(hub.viewerCount('workspace-1')).toBe(0);
    expect(hub.closeDevice('device-owner')).toBe(2);
    expect(owner.isClosed()).toBe(true);
    expect(otherOwner.isClosed()).toBe(true);
    expect(hub.hasOwner('workspace-2')).toBe(false);
  });
});
