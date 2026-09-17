import { z } from 'zod';

import type { DeviceDescriptor } from '../core/models.js';

export const CLOUD_PROTOCOL_VERSION = 1 as const;
const MAX_CLOUD_PAYLOAD_BYTES = 32 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export type CloudDataDomain = 'account-data' | 'workspace';

export type CloudDeviceDescriptor = DeviceDescriptor & { publicKey?: string | null };

export const CLOUD_KEY_PROTOCOL_VERSION = 1 as const;
export const CLOUD_WRAPPED_KEY_MAX_BYTES = 16 * 1024;

export interface CloudKeyGrantInput {
  protocolVersion: typeof CLOUD_KEY_PROTOCOL_VERSION;
  domain: CloudDataDomain;
  accountId: string;
  resourceId: string;
  recipientDeviceId: string;
  keyVersion: number;
  wrappedKey: Record<string, unknown>;
}

export interface CloudKeyGrant extends CloudKeyGrantInput {
  createdAt: string;
  revokedAt: string | null;
}

export interface CloudDataEnvelope {
  protocolVersion: typeof CLOUD_PROTOCOL_VERSION;
  domain: CloudDataDomain;
  accountId: string;
  workspaceId?: string;
  revision: number;
  parentRevision: number | null;
  writerDeviceId: string;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
  aad: string;
  payloadHash: string;
  byteLength: number;
}

export interface CloudDataAadInput {
  domain: CloudDataDomain;
  accountId: string;
  workspaceId?: string;
  revision: number;
  parentRevision: number | null;
  keyVersion: number;
  writerDeviceId: string;
}

const envelopeFields = {
  protocolVersion: z.literal(CLOUD_PROTOCOL_VERSION),
  accountId: z.string().regex(SAFE_ID),
  revision: z.number().int().min(1).max(1_000_000_000),
  parentRevision: z.number().int().min(0).max(1_000_000_000).nullable(),
  writerDeviceId: z.string().regex(SAFE_ID),
  keyVersion: z.number().int().min(1).max(32),
  nonce: z.string().min(1).max(256),
  ciphertext: z.string().min(1).max(MAX_CLOUD_PAYLOAD_BYTES * 2),
  authTag: z.string().min(1).max(256),
  aad: z.string().min(1).max(2_048),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/iu),
  byteLength: z.number().int().min(0).max(MAX_CLOUD_PAYLOAD_BYTES)
} as const;

const accountDataEnvelopeSchema = z.object({
  ...envelopeFields,
  domain: z.literal('account-data')
}).strict();

const workspaceEnvelopeSchema = z.object({
  ...envelopeFields,
  domain: z.literal('workspace'),
  workspaceId: z.string().regex(SAFE_ID)
}).strict();

const cloudDataEnvelopeSchema = z.union([accountDataEnvelopeSchema, workspaceEnvelopeSchema]);

const cloudKeyGrantSchema = z.object({
  protocolVersion: z.literal(CLOUD_KEY_PROTOCOL_VERSION),
  domain: z.enum(['account-data', 'workspace']),
  accountId: z.string().regex(SAFE_ID),
  resourceId: z.string().regex(SAFE_ID),
  recipientDeviceId: z.string().regex(SAFE_ID),
  keyVersion: z.number().int().min(1).max(32),
  wrappedKey: z.record(z.string(), z.unknown()).refine((value) => {
    try {
      return new globalThis.TextEncoder().encode(JSON.stringify(value)).byteLength <= CLOUD_WRAPPED_KEY_MAX_BYTES;
    } catch {
      return false;
    }
  }, 'wrapped key too large')
}).strict();

const invalidEnvelope = (): never => {
  throw new Error('invalid cloud data envelope');
};

export const parseCloudDataEnvelope = (value: unknown): CloudDataEnvelope => {
  const parsed = cloudDataEnvelopeSchema.safeParse(value);
  if (!parsed.success) return invalidEnvelope();
  return parsed.data as CloudDataEnvelope;
};

export const parseCloudKeyGrant = (value: unknown): CloudKeyGrantInput => {
  const parsed = cloudKeyGrantSchema.safeParse(value);
  if (!parsed.success) return invalidEnvelope();
  return parsed.data as CloudKeyGrantInput;
};

export const createCloudDataAad = (input: CloudDataAadInput): string => (
  [
    'relay',
    `v${CLOUD_PROTOCOL_VERSION}`,
    input.domain,
    input.accountId,
    input.workspaceId ?? '-',
    input.revision,
    input.parentRevision ?? '-',
    input.keyVersion,
    input.writerDeviceId
  ].join(':')
);

export interface LiveInputRequest {
  participantDeviceId: string;
  inputId: string;
  sessionId: string;
  payload: string;
}

export type InputAcceptance =
  | { status: 'accepted' | 'duplicate'; inputSequence: number; request: LiveInputRequest }
  | { status: 'rejected'; reason: 'input-id-reuse' };

const sameInputRequest = (left: LiveInputRequest, right: LiveInputRequest): boolean => (
  left.participantDeviceId === right.participantDeviceId
  && left.inputId === right.inputId
  && left.sessionId === right.sessionId
  && left.payload === right.payload
);

export interface InputSequencer {
  accept(request: LiveInputRequest): InputAcceptance;
  size(): number;
}

export const createInputSequencer = (): InputSequencer => {
  let nextSequence = 1;
  const accepted = new Map<string, { sequence: number; request: LiveInputRequest }>();

  return {
    accept(request) {
      const previous = accepted.get(request.inputId);
      if (previous) {
        return sameInputRequest(previous.request, request)
          ? { status: 'duplicate', inputSequence: previous.sequence, request: previous.request }
          : { status: 'rejected', reason: 'input-id-reuse' };
      }

      const sequence = nextSequence++;
      accepted.set(request.inputId, { sequence, request });
      return { status: 'accepted', inputSequence: sequence, request };
    },
    size: () => accepted.size
  };
};

export type LiveSequenceEvent =
  | { kind: 'snapshot'; ownerEpoch: number; sequence: number }
  | { kind: 'output'; ownerEpoch: number; sequence: number };

export type LiveSequenceResult =
  | { status: 'applied'; nextSequence: number }
  | { status: 'duplicate'; nextSequence: number | null }
  | { status: 'resync-required'; nextSequence: number }
  | { status: 'epoch-changed'; nextSequence: null };

export interface LiveSequenceTracker {
  apply(event: LiveSequenceEvent): LiveSequenceResult;
}

export const trackLiveSequence = (): LiveSequenceTracker => {
  let ownerEpoch: number | null = null;
  let nextSequence: number | null = null;

  return {
    apply(event) {
      if (event.kind === 'snapshot') {
        ownerEpoch = event.ownerEpoch;
        nextSequence = event.sequence + 1;
        return { status: 'applied', nextSequence };
      }

      if (ownerEpoch !== event.ownerEpoch) {
        ownerEpoch = null;
        nextSequence = null;
        return { status: 'epoch-changed', nextSequence: null };
      }
      if (nextSequence === null) return { status: 'resync-required', nextSequence: event.sequence };
      if (event.sequence < nextSequence) return { status: 'duplicate', nextSequence };
      if (event.sequence > nextSequence) return { status: 'resync-required', nextSequence };

      nextSequence += 1;
      return { status: 'applied', nextSequence };
    }
  };
};
