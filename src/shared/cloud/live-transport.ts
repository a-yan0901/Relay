import {
  decryptLiveCipherEnvelope,
  encryptLiveFrameEnvelope,
  parseLiveCipherEnvelope,
  type LiveCipherEnvelope,
  deriveLiveSessionKey
} from './live-crypto.js';
import { LIVE_MAX_FRAME_BYTES, parseLiveFrame, type LiveFrame } from './live-protocol.js';

export const LIVE_TRANSPORT_PROTOCOL_VERSION = 1 as const;
export const LIVE_BROADCAST_RECIPIENT = '*' as const;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface LiveTransportEnvelope {
  protocolVersion: typeof LIVE_TRANSPORT_PROTOCOL_VERSION;
  workspaceId: string;
  ownerEpoch: number;
  senderDeviceId: string;
  recipientDeviceId: string;
  ciphertext: LiveCipherEnvelope;
}

interface EncodeLiveTransportEnvelopeInput {
  workspaceId: string;
  ownerEpoch: number;
  senderDeviceId: string;
  recipientDeviceId: string;
  encrypted: Uint8Array | LiveCipherEnvelope;
}

export interface EncryptLiveTransportFrameInput {
  baseKey: Uint8Array;
  frame: LiveFrame;
  workspaceId: string;
  ownerDeviceId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  ownerEpoch: number;
  direction: 'owner-to-viewer' | 'viewer-to-owner';
}

export interface DecryptLiveTransportFrameInput {
  baseKey: Uint8Array;
  envelope: LiveTransportEnvelope;
  localDeviceId: string;
  ownerDeviceId: string;
  role: 'owner' | 'viewer';
}

const assertId = (value: string, allowBroadcast = false): void => {
  if (allowBroadcast && value === LIVE_BROADCAST_RECIPIENT) return;
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error('invalid live transport device id');
};

const assertEnvelopeFields = (value: unknown): LiveTransportEnvelope => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid live transport envelope');
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate);
  if (keys.length !== 6 || keys.some((key) => !['protocolVersion', 'workspaceId', 'ownerEpoch', 'senderDeviceId', 'recipientDeviceId', 'ciphertext'].includes(key))) {
    throw new Error('invalid live transport envelope');
  }
  if (
    candidate.protocolVersion !== LIVE_TRANSPORT_PROTOCOL_VERSION
    || typeof candidate.workspaceId !== 'string'
    || !SAFE_ID.test(candidate.workspaceId)
    || typeof candidate.ownerEpoch !== 'number'
    || !Number.isSafeInteger(candidate.ownerEpoch)
    || candidate.ownerEpoch < 0
    || typeof candidate.senderDeviceId !== 'string'
    || typeof candidate.recipientDeviceId !== 'string'
  ) throw new Error('invalid live transport envelope');
  assertId(candidate.senderDeviceId);
  assertId(candidate.recipientDeviceId, true);
  const ciphertext = parseLiveCipherEnvelope(candidate.ciphertext);
  return {
    protocolVersion: LIVE_TRANSPORT_PROTOCOL_VERSION,
    workspaceId: candidate.workspaceId,
    ownerEpoch: candidate.ownerEpoch,
    senderDeviceId: candidate.senderDeviceId,
    recipientDeviceId: candidate.recipientDeviceId,
    ciphertext
  };
};

const decodeCipherObject = (bytes: Uint8Array): LiveCipherEnvelope => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('live transport frame too large');
  try {
    return parseLiveCipherEnvelope(JSON.parse(new globalThis.TextDecoder().decode(bytes)));
  } catch {
    throw new Error('invalid live transport ciphertext');
  }
};

export const encodeLiveTransportEnvelope = (input: EncodeLiveTransportEnvelopeInput): Uint8Array => {
  if (typeof input.workspaceId !== 'string' || !SAFE_ID.test(input.workspaceId)) throw new Error('invalid live transport workspace id');
  if (!Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 0) throw new Error('invalid live transport owner epoch');
  assertId(input.senderDeviceId);
  assertId(input.recipientDeviceId, true);
  const ciphertext = input.encrypted instanceof Uint8Array
    ? decodeCipherObject(input.encrypted)
    : parseLiveCipherEnvelope(input.encrypted);
  const envelope = assertEnvelopeFields({
    protocolVersion: LIVE_TRANSPORT_PROTOCOL_VERSION,
    workspaceId: input.workspaceId,
    ownerEpoch: input.ownerEpoch,
    senderDeviceId: input.senderDeviceId,
    recipientDeviceId: input.recipientDeviceId,
    ciphertext
  });
  const bytes = new globalThis.TextEncoder().encode(JSON.stringify(envelope));
  if (bytes.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('live transport frame too large');
  return bytes;
};

export const decodeLiveTransportEnvelope = (bytes: Uint8Array): LiveTransportEnvelope => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('live transport frame too large');
  try {
    return assertEnvelopeFields(JSON.parse(new globalThis.TextDecoder().decode(bytes)));
  } catch (error) {
    if (error instanceof Error && error.message === 'live transport frame too large') throw error;
    throw new Error('invalid live transport envelope', { cause: error });
  }
};

const sessionKey = async (
  input: Pick<EncryptLiveTransportFrameInput, 'baseKey' | 'workspaceId' | 'ownerDeviceId' | 'senderDeviceId' | 'recipientDeviceId' | 'ownerEpoch' | 'direction'>
): Promise<Uint8Array> => {
  if (input.ownerEpoch === 0) return input.baseKey;
  const viewerDeviceId = input.direction === 'owner-to-viewer' ? input.recipientDeviceId : input.senderDeviceId;
  if (viewerDeviceId === LIVE_BROADCAST_RECIPIENT) throw new Error('targeted live encryption requires a viewer');
  return deriveLiveSessionKey(input.baseKey, {
    workspaceId: input.workspaceId,
    ownerDeviceId: input.ownerDeviceId,
    viewerDeviceId,
    ownerEpoch: input.ownerEpoch
  });
};

export const encryptLiveTransportFrame = async (input: EncryptLiveTransportFrameInput): Promise<Uint8Array> => {
  const frame = parseLiveFrame(input.frame);
  if (frame.workspaceId !== input.workspaceId) throw new Error('live transport workspace mismatch');
  if (!Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 0) throw new Error('invalid live transport owner epoch');
  if (input.direction === 'owner-to-viewer' && input.recipientDeviceId === LIVE_BROADCAST_RECIPIENT) throw new Error('owner live frames require a viewer');
  const key = await sessionKey(input);
  const ciphertext = await encryptLiveFrameEnvelope(key, frame);
  return encodeLiveTransportEnvelope({
    workspaceId: input.workspaceId,
    ownerEpoch: input.ownerEpoch,
    senderDeviceId: input.senderDeviceId,
    recipientDeviceId: input.recipientDeviceId,
    encrypted: ciphertext
  });
};

export const decryptLiveTransportFrame = async (input: DecryptLiveTransportFrameInput): Promise<LiveFrame | null> => {
  const { envelope } = input;
  assertId(input.localDeviceId);
  assertId(input.ownerDeviceId);
  if (envelope.recipientDeviceId !== LIVE_BROADCAST_RECIPIENT && envelope.recipientDeviceId !== input.localDeviceId) return null;
  if (envelope.senderDeviceId === input.localDeviceId) return null;
  const direction = input.role === 'viewer' ? 'owner-to-viewer' : 'viewer-to-owner';
  const key = await sessionKey({
    baseKey: input.baseKey,
    workspaceId: envelope.workspaceId,
    ownerDeviceId: input.ownerDeviceId,
    senderDeviceId: envelope.senderDeviceId,
    recipientDeviceId: envelope.recipientDeviceId,
    ownerEpoch: envelope.ownerEpoch,
    direction
  });
  const frame = await decryptLiveCipherEnvelope(key, envelope.ciphertext);
  if (frame.workspaceId !== envelope.workspaceId) throw new Error('live transport workspace mismatch');
  if ((frame.type === 'workspace-snapshot' || frame.type === 'terminal-output') && frame.ownerEpoch !== envelope.ownerEpoch) {
    throw new Error('live transport epoch mismatch');
  }
  return frame;
};
