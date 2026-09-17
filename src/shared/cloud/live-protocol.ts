import { z } from 'zod';

export const LIVE_PROTOCOL_VERSION = 1 as const;
export const LIVE_MAX_FRAME_BYTES = 64 * 1024;
export const LIVE_MAX_PAYLOAD_BYTES = 48 * 1024;
export const LIVE_MAX_SCREEN_BYTES = 24 * 1024;
export const LIVE_MAX_TERMINALS = 32;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface LiveTerminalDescriptor {
  sessionId: string;
  hostId: string;
  title: string;
  status: 'connected' | 'needs-reopen' | 'closed';
  columns: number;
  rows: number;
  screen?: string;
}

export type LiveFrame =
  | {
    protocolVersion: typeof LIVE_PROTOCOL_VERSION;
    type: 'workspace-snapshot';
    workspaceId: string;
    ownerEpoch: number;
    sequence: number;
    terminals: readonly LiveTerminalDescriptor[];
  }
  | {
    protocolVersion: typeof LIVE_PROTOCOL_VERSION;
    type: 'participant-hello' | 'participant-leave';
    workspaceId: string;
    participantDeviceId: string;
  }
  | {
    protocolVersion: typeof LIVE_PROTOCOL_VERSION;
    type: 'terminal-output';
    workspaceId: string;
    sessionId: string;
    ownerEpoch: number;
    sequence: number;
    payload: string;
  }
  | {
    protocolVersion: typeof LIVE_PROTOCOL_VERSION;
    type: 'terminal-input';
    workspaceId: string;
    sessionId: string;
    participantDeviceId: string;
    inputId: string;
    payload: string;
  }
  | {
    protocolVersion: typeof LIVE_PROTOCOL_VERSION;
    type: 'input-ack';
    workspaceId: string;
    sessionId: string;
    inputId: string;
    inputSequence: number;
    outcome: 'accepted' | 'duplicate' | 'unknown';
  }
  | {
    protocolVersion: typeof LIVE_PROTOCOL_VERSION;
    type: 'resync-request';
    workspaceId: string;
    sessionId: string;
    afterSequence: number;
  };

const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const idSchema = z.string().regex(SAFE_ID);
const boundedPayloadSchema = z.string().min(1).max(LIVE_MAX_PAYLOAD_BYTES);
const boundedScreenSchema = z.string().refine((value) => new globalThis.TextEncoder().encode(value).byteLength <= LIVE_MAX_SCREEN_BYTES, 'screen too large');

const terminalDescriptorSchema = z.object({
  sessionId: idSchema,
  hostId: idSchema,
  title: z.string().min(1).max(256),
  status: z.enum(['connected', 'needs-reopen', 'closed']),
  columns: z.number().int().min(1).max(1_000),
  rows: z.number().int().min(1).max(1_000),
  screen: boundedScreenSchema.optional()
}).strict();

const commonSchema = {
  protocolVersion: z.literal(LIVE_PROTOCOL_VERSION),
  workspaceId: idSchema
} as const;

const liveFrameSchema = z.discriminatedUnion('type', [
  z.object({
    ...commonSchema,
    type: z.literal('workspace-snapshot'),
    ownerEpoch: sequenceSchema.min(1),
    sequence: sequenceSchema,
    terminals: z.array(terminalDescriptorSchema).max(LIVE_MAX_TERMINALS)
  }).strict(),
  z.object({
    ...commonSchema,
    type: z.enum(['participant-hello', 'participant-leave']),
    participantDeviceId: idSchema
  }).strict(),
  z.object({
    ...commonSchema,
    type: z.literal('terminal-output'),
    sessionId: idSchema,
    ownerEpoch: sequenceSchema.min(1),
    sequence: sequenceSchema,
    payload: boundedPayloadSchema
  }).strict(),
  z.object({
    ...commonSchema,
    type: z.literal('terminal-input'),
    sessionId: idSchema,
    participantDeviceId: idSchema,
    inputId: idSchema,
    payload: boundedPayloadSchema
  }).strict(),
  z.object({
    ...commonSchema,
    type: z.literal('input-ack'),
    sessionId: idSchema,
    inputId: idSchema,
    inputSequence: sequenceSchema,
    outcome: z.enum(['accepted', 'duplicate', 'unknown'])
  }).strict(),
  z.object({
    ...commonSchema,
    type: z.literal('resync-request'),
    sessionId: idSchema,
    afterSequence: sequenceSchema
  }).strict()
]);

const assertFrameSize = (value: LiveFrame): LiveFrame => {
  const encoded = new globalThis.TextEncoder().encode(JSON.stringify(value));
  if (encoded.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('live frame too large');
  return value;
};

export const parseLiveFrame = (value: unknown): LiveFrame => {
  const parsed = liveFrameSchema.safeParse(value);
  if (!parsed.success) throw new Error('invalid live frame');
  return assertFrameSize(parsed.data as LiveFrame);
};

/** Wire callers must encrypt this payload before sending it through the cloud relay. */
export const encodeLiveFrame = (frame: LiveFrame): Uint8Array => {
  const validated = parseLiveFrame(frame);
  return new globalThis.TextEncoder().encode(JSON.stringify(validated));
};

export const decodeLiveFrame = (bytes: Uint8Array): LiveFrame => {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > LIVE_MAX_FRAME_BYTES) throw new Error('live frame too large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new globalThis.TextDecoder().decode(bytes));
  } catch {
    throw new Error('invalid live frame');
  }
  return parseLiveFrame(parsed);
};
