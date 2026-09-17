import { decodeLiveTransportEnvelope, encodeLiveTransportEnvelope } from '../shared/cloud/live-transport.js';

export interface RelayPeer {
  /** Current socket buffered amount; the hub never creates an unbounded queue. */
  readonly bufferedBytes: number;
  /** The frame is immutable and may be shared between peers. */
  send(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export interface RelayHubLimits {
  maxFrameBytes: number;
  maxBufferedBytes: number;
  maxSubscribersPerWorkspace: number;
}

export interface RelaySubscription {
  close(): void;
}

interface OwnerRoute {
  deviceId: string;
  peer: RelayPeer;
  viewers: Map<string, RelayPeer>;
}

const assertFrame = (frame: Uint8Array, maxFrameBytes: number): boolean => (
  frame.byteLength <= maxFrameBytes
);

/**
 * The relay does not inspect encrypted content. It does, however, bind the
 * visible sender metadata to the already-authenticated WebSocket session so a
 * client cannot impersonate another device in the end-to-end envelope.
 */
const bindAuthenticatedSender = (workspaceId: string, deviceId: string, frame: Uint8Array, maxFrameBytes: number): Uint8Array | null => {
  if (!assertFrame(frame, maxFrameBytes)) return null;
  try {
    const envelope = decodeLiveTransportEnvelope(frame);
    if (envelope.workspaceId !== workspaceId || envelope.senderDeviceId === deviceId) return frame;
    const bound = encodeLiveTransportEnvelope({
      workspaceId: envelope.workspaceId,
      ownerEpoch: envelope.ownerEpoch,
      senderDeviceId: deviceId,
      recipientDeviceId: envelope.recipientDeviceId,
      encrypted: envelope.ciphertext
    });
    return assertFrame(bound, maxFrameBytes) ? bound : null;
  } catch {
    // Keep the hub transport-agnostic for callers that use opaque test or
    // future protocol frames; the channel boundary will reject malformed data.
    return frame;
  }
};

export class BoundedRelayHub {
  private readonly routes = new Map<string, OwnerRoute>();

  constructor(private readonly limits: RelayHubLimits) {}

  registerOwner(workspaceId: string, deviceId: string, peer: RelayPeer): RelaySubscription {
    const previous = this.routes.get(workspaceId);
    if (previous) {
      previous.peer.close(4001, 'owner replaced');
      for (const viewer of previous.viewers.values()) viewer.close(4001, 'owner replaced');
    }
    const route: OwnerRoute = { deviceId, peer, viewers: new Map() };
    this.routes.set(workspaceId, route);
    return {
      close: () => {
        if (this.routes.get(workspaceId) !== route) return;
        this.routes.delete(workspaceId);
        for (const viewer of route.viewers.values()) viewer.close(4001, 'owner disconnected');
      }
    };
  }

  subscribeViewer(workspaceId: string, deviceId: string, peer: RelayPeer): RelaySubscription {
    const route = this.routes.get(workspaceId);
    if (!route) throw new Error('relay owner unavailable');
    if (route.viewers.size >= this.limits.maxSubscribersPerWorkspace && !route.viewers.has(deviceId)) {
      throw new Error('relay subscriber limit reached');
    }
    const previous = route.viewers.get(deviceId);
    previous?.close(4002, 'viewer replaced');
    route.viewers.set(deviceId, peer);
    return {
      close: () => {
        if (route.viewers.get(deviceId) === peer) route.viewers.delete(deviceId);
      }
    };
  }

  forwardFromViewer(workspaceId: string, deviceId: string, frame: Uint8Array): boolean {
    const route = this.routes.get(workspaceId);
    if (!route || !route.viewers.has(deviceId)) return false;
    const bound = bindAuthenticatedSender(workspaceId, deviceId, frame, this.limits.maxFrameBytes);
    if (!bound || route.peer.bufferedBytes + bound.byteLength > this.limits.maxBufferedBytes) return false;
    route.peer.send(bound);
    return true;
  }

  forwardFromOwner(workspaceId: string, frame: Uint8Array): number {
    const route = this.routes.get(workspaceId);
    if (!route) return 0;
    const bound = bindAuthenticatedSender(workspaceId, route.deviceId, frame, this.limits.maxFrameBytes);
    if (!bound) return 0;
    let forwarded = 0;
    for (const [deviceId, viewer] of route.viewers) {
      if (viewer.bufferedBytes + bound.byteLength > this.limits.maxBufferedBytes) {
        viewer.close(4003, 'relay buffer limit');
        route.viewers.delete(deviceId);
        continue;
      }
      viewer.send(bound);
      forwarded += 1;
    }
    return forwarded;
  }

  hasOwner(workspaceId: string, deviceId?: string): boolean {
    const route = this.routes.get(workspaceId);
    return route !== undefined && (deviceId === undefined || route.deviceId === deviceId);
  }

  viewerCount(workspaceId: string): number {
    return this.routes.get(workspaceId)?.viewers.size ?? 0;
  }

  closeDevice(deviceId: string, code = 4004, reason = 'device revoked'): number {
    let closed = 0;
    for (const [workspaceId, route] of this.routes) {
      if (route.deviceId === deviceId) {
        route.peer.close(code, reason);
        closed += 1;
        for (const viewer of route.viewers.values()) {
          viewer.close(code, reason);
          closed += 1;
        }
        this.routes.delete(workspaceId);
        continue;
      }
      const viewer = route.viewers.get(deviceId);
      if (viewer) {
        viewer.close(code, reason);
        route.viewers.delete(deviceId);
        closed += 1;
      }
    }
    return closed;
  }
}
