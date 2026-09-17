import type { CloudLiveCloseEvent } from './live-client.js';
import { decodeLiveTransportEnvelope, decryptLiveTransportFrame, encryptLiveTransportFrame } from './live-transport.js';
import { LIVE_BROADCAST_RECIPIENT } from './live-transport.js';
import { parseLiveFrame, type LiveFrame } from './live-protocol.js';

export const LIVE_MAX_CHANNEL_PARTICIPANTS = 16;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface LiveRelayTransport {
  connect(): Promise<void>;
  send(frame: Uint8Array): void;
  onFrame(listener: (frame: Uint8Array) => void): () => void;
  onClose(listener: (event: CloudLiveCloseEvent) => void): () => void;
  close?(code?: number, reason?: string): void;
}

export interface LiveWorkspaceChannelOptions {
  relay: LiveRelayTransport;
  workspaceId: string;
  localDeviceId: string;
  ownerDeviceId: string;
  role: 'owner' | 'viewer';
  baseKey: Uint8Array;
  ownerEpoch?: number;
  maxParticipants?: number;
  onFrame?: (frame: LiveFrame, senderDeviceId: string) => void;
  onViewerJoin?: (deviceId: string) => void;
  onViewerLeave?: (deviceId: string) => void;
  onError?: (error: Error) => void;
}

const assertId = (value: string, message: string): void => {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(message);
};

const assertEpoch = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('invalid live channel owner epoch');
};

export class LiveWorkspaceChannel {
  private readonly relay: LiveRelayTransport;
  private readonly workspaceId: string;
  private readonly localDeviceId: string;
  private readonly ownerDeviceId: string;
  private readonly role: 'owner' | 'viewer';
  private readonly baseKey: Uint8Array;
  private readonly maxParticipants: number;
  private readonly viewers = new Set<string>();
  private readonly frameListeners = new Set<(frame: LiveFrame, senderDeviceId: string) => void>();
  private readonly onViewerJoin?: (deviceId: string) => void;
  private readonly onViewerLeave?: (deviceId: string) => void;
  private readonly onError?: (error: Error) => void;
  private readonly removeFrameListener: () => void;
  private readonly removeCloseListener: () => void;
  private connected = false;
  private closed = false;
  private broadcasting = false;
  private currentOwnerEpoch: number | null;

  constructor(options: LiveWorkspaceChannelOptions) {
    assertId(options.workspaceId, 'invalid live channel workspace id');
    assertId(options.localDeviceId, 'invalid live channel local device id');
    assertId(options.ownerDeviceId, 'invalid live channel owner device id');
    if (!(options.baseKey instanceof Uint8Array) || options.baseKey.byteLength !== 32) throw new Error('invalid live channel key');
    const maxParticipants = options.maxParticipants ?? LIVE_MAX_CHANNEL_PARTICIPANTS;
    if (!Number.isSafeInteger(maxParticipants) || maxParticipants < 1 || maxParticipants > LIVE_MAX_CHANNEL_PARTICIPANTS) throw new Error('invalid live channel participant limit');
    if (options.role === 'owner') {
      if (options.localDeviceId !== options.ownerDeviceId) throw new Error('owner device mismatch');
      this.currentOwnerEpoch = options.ownerEpoch ?? 1;
      assertEpoch(this.currentOwnerEpoch);
    } else {
      this.currentOwnerEpoch = null;
    }
    this.relay = options.relay;
    this.workspaceId = options.workspaceId;
    this.localDeviceId = options.localDeviceId;
    this.ownerDeviceId = options.ownerDeviceId;
    this.role = options.role;
    this.baseKey = new Uint8Array(options.baseKey);
    this.maxParticipants = maxParticipants;
    if (options.onFrame) this.frameListeners.add(options.onFrame);
    this.onViewerJoin = options.onViewerJoin;
    this.onViewerLeave = options.onViewerLeave;
    this.onError = options.onError;
    this.removeFrameListener = this.relay.onFrame((frame) => { void this.handleFrame(frame); });
    this.removeCloseListener = this.relay.onClose(() => {
      this.connected = false;
      for (const viewer of this.viewers) this.onViewerLeave?.(viewer);
      this.viewers.clear();
    });
  }

  get viewerCount(): number { return this.viewers.size; }
  get ownerEpoch(): number | null { return this.currentOwnerEpoch; }

  subscribe(listener: (frame: LiveFrame, senderDeviceId: string) => void): () => void {
    if (this.frameListeners.size >= LIVE_MAX_CHANNEL_PARTICIPANTS) throw new Error('live channel listener limit reached');
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('live channel is closed');
    if (this.connected) return;
    await this.relay.connect();
    this.connected = true;
    if (this.role === 'viewer') await this.sendControl('participant-hello');
  }

  async send(frame: LiveFrame): Promise<void> {
    this.assertUsable();
    if (this.role !== 'viewer') throw new Error('owner channel cannot send viewer frame');
    const validated = parseLiveFrame(frame);
    if (validated.workspaceId !== this.workspaceId) throw new Error('live channel workspace mismatch');
    if (validated.type === 'participant-hello' || validated.type === 'participant-leave') {
      await this.sendControl(validated.type);
      return;
    }
    if (validated.type !== 'terminal-input' && validated.type !== 'resync-request') throw new Error('viewer frame is not allowed');
    if (this.currentOwnerEpoch === null) throw new Error('live channel is waiting for snapshot');
    const wire = await encryptLiveTransportFrame({
      baseKey: this.baseKey,
      frame: validated,
      workspaceId: this.workspaceId,
      ownerDeviceId: this.ownerDeviceId,
      senderDeviceId: this.localDeviceId,
      recipientDeviceId: this.ownerDeviceId,
      ownerEpoch: this.currentOwnerEpoch,
      direction: 'viewer-to-owner'
    });
    this.relay.send(wire);
  }

  async broadcast(frame: LiveFrame): Promise<number> {
    this.assertUsable();
    if (this.role !== 'owner') throw new Error('viewer channel cannot broadcast owner frame');
    if (this.broadcasting) throw new Error('live broadcast busy');
    const validated = parseLiveFrame(frame);
    if (validated.workspaceId !== this.workspaceId) throw new Error('live channel workspace mismatch');
    if (validated.type !== 'workspace-snapshot' && validated.type !== 'terminal-output' && validated.type !== 'input-ack') throw new Error('owner frame is not allowed');
    if (validated.type === 'workspace-snapshot' || validated.type === 'terminal-output') {
      this.currentOwnerEpoch = validated.ownerEpoch;
      assertEpoch(this.currentOwnerEpoch);
    }
    const recipients = [...this.viewers];
    this.broadcasting = true;
    let sent = 0;
    try {
      for (const recipientDeviceId of recipients) {
        const wire = await encryptLiveTransportFrame({
          baseKey: this.baseKey,
          frame: validated,
          workspaceId: this.workspaceId,
          ownerDeviceId: this.ownerDeviceId,
          senderDeviceId: this.localDeviceId,
          recipientDeviceId,
          ownerEpoch: this.currentOwnerEpoch ?? 1,
          direction: 'owner-to-viewer'
        });
        this.relay.send(wire);
        sent += 1;
      }
      return sent;
    } finally {
      this.broadcasting = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (this.role === 'viewer' && this.connected) {
      try {
        await this.sendControl('participant-leave');
      } catch (error) {
        this.report(error);
      }
    }
    this.closed = true;
    this.connected = false;
    this.removeFrameListener();
    this.removeCloseListener();
    this.relay.close?.();
    this.viewers.clear();
    this.baseKey.fill(0);
  }

  private assertUsable(): void {
    if (this.closed) throw new Error('live channel is closed');
    if (!this.connected) throw new Error('live channel is not connected');
  }

  private async sendControl(type: 'participant-hello' | 'participant-leave'): Promise<void> {
    const frame: LiveFrame = {
      protocolVersion: 1,
      type,
      workspaceId: this.workspaceId,
      participantDeviceId: this.localDeviceId
    };
    const wire = await encryptLiveTransportFrame({
      baseKey: this.baseKey,
      frame,
      workspaceId: this.workspaceId,
      ownerDeviceId: this.ownerDeviceId,
      senderDeviceId: this.localDeviceId,
      recipientDeviceId: this.ownerDeviceId,
      ownerEpoch: 0,
      direction: 'viewer-to-owner'
    });
    this.relay.send(wire);
  }

  private async handleFrame(bytes: Uint8Array): Promise<void> {
    if (this.closed) return;
    try {
      const envelope = decodeLiveTransportEnvelope(bytes);
      if (envelope.workspaceId !== this.workspaceId) return;
      if (envelope.recipientDeviceId !== LIVE_BROADCAST_RECIPIENT && envelope.recipientDeviceId !== this.localDeviceId) return;
      if (envelope.senderDeviceId === this.localDeviceId) return;
      if (this.role === 'owner' && envelope.ownerEpoch !== 0 && !this.viewers.has(envelope.senderDeviceId)) return;
      if (this.role === 'viewer' && envelope.senderDeviceId !== this.ownerDeviceId) return;
      const frame = await decryptLiveTransportFrame({
        baseKey: this.baseKey,
        envelope,
        localDeviceId: this.localDeviceId,
        ownerDeviceId: this.ownerDeviceId,
        role: this.role
      });
      if (!frame) return;
      if (this.role === 'owner' && envelope.ownerEpoch === 0) {
        this.handleParticipantFrame(frame, envelope.senderDeviceId);
        return;
      }
      if (this.role === 'viewer' && (frame.type === 'workspace-snapshot' || frame.type === 'terminal-output')) {
        this.currentOwnerEpoch = frame.ownerEpoch;
      }
      if (this.role === 'owner' && frame.type === 'terminal-input' && frame.participantDeviceId !== envelope.senderDeviceId) {
        this.report(new Error('live input participant mismatch'));
        return;
      }
      for (const listener of this.frameListeners) listener(frame, envelope.senderDeviceId);
    } catch (error) {
      this.report(error);
    }
  }

  private handleParticipantFrame(frame: LiveFrame, senderDeviceId: string): void {
    if ((frame.type !== 'participant-hello' && frame.type !== 'participant-leave') || frame.participantDeviceId !== senderDeviceId) return;
    if (frame.type === 'participant-leave') {
      if (this.viewers.delete(senderDeviceId)) this.onViewerLeave?.(senderDeviceId);
      return;
    }
    if (this.viewers.has(senderDeviceId)) return;
    if (this.viewers.size >= this.maxParticipants) {
      this.report(new Error('live channel participant limit reached'));
      return;
    }
    this.viewers.add(senderDeviceId);
    this.onViewerJoin?.(senderDeviceId);
  }

  private report(error: unknown): void {
    this.onError?.(error instanceof Error ? error : new Error('live channel error', { cause: error }));
  }
}
