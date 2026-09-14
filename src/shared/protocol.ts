import { z } from 'zod';

import { APP_ERROR_CODES, AppError, type AppErrorCode } from './errors.js';

const dimensionSchema = z.number().int().min(1).max(500);
const identifierSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const requestIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const fingerprintSchema = z.string().min(1).max(255).regex(/^SHA256:[A-Za-z0-9+/=_-]+$/u);

export const terminalOpenSchema = z.object({
  type: z.literal('open'),
  hostId: identifierSchema,
  cols: dimensionSchema,
  rows: dimensionSchema,
  requestId: requestIdSchema,
  term: z.string().min(1).max(64).regex(/^[a-z0-9._+-]+$/iu).optional()
}).strict();

const terminalResizeSchema = z.object({
  type: z.literal('resize'),
  cols: dimensionSchema,
  rows: dimensionSchema
}).strict();

const terminalInputSchema = z.object({
  type: z.literal('input'),
  data: z.string().max(65536)
}).strict();

const terminalPingSchema = z.object({
  type: z.literal('ping')
}).strict();

const terminalCloseSchema = z.object({
  type: z.literal('close')
}).strict();

const terminalHostKeyDecisionSchema = z.object({
  type: z.literal('host-key-decision'),
  decision: z.enum(['trust', 'reject']),
  fingerprint: fingerprintSchema
}).strict();

export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  terminalOpenSchema,
  terminalResizeSchema,
  terminalInputSchema,
  terminalPingSchema,
  terminalCloseSchema,
  terminalHostKeyDecisionSchema
]);

export type TerminalOpenMessage = z.infer<typeof terminalOpenSchema>;
export type TerminalResizeMessage = z.infer<typeof terminalResizeSchema>;
export type TerminalInputMessage = z.infer<typeof terminalInputSchema>;
export type TerminalPingMessage = z.infer<typeof terminalPingSchema>;
export type TerminalCloseMessage = z.infer<typeof terminalCloseSchema>;
export type TerminalHostKeyDecisionMessage = z.infer<typeof terminalHostKeyDecisionSchema>;
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalControlMessage = TerminalClientMessage;

export type TerminalStatus = 'connecting' | 'awaiting-host-key' | 'connected' | 'reconnecting' | 'closed' | 'failed';

export interface TerminalStatusEvent {
  type: 'status';
  state: TerminalStatus;
  requestId?: string;
}

export interface TerminalHostKeyEvent {
  type: 'host-key';
  algorithm: string;
  fingerprint: string;
  address: string;
  port: number;
}

export interface TerminalErrorEvent {
  type: 'error';
  code: AppErrorCode;
  message: string;
}

export interface TerminalExitEvent {
  type: 'exit';
  code: number | null;
  signal?: string;
}

export interface TerminalPongEvent {
  type: 'pong';
}

export type TerminalServerEvent =
  | TerminalStatusEvent
  | TerminalHostKeyEvent
  | TerminalErrorEvent
  | TerminalExitEvent
  | TerminalPongEvent;

export interface PendingHostKeyDecision {
  pendingFingerprint?: string;
}

export const parseTerminalClientMessage = (
  input: unknown,
  pending: PendingHostKeyDecision = {}
): TerminalClientMessage => {
  let message: TerminalClientMessage;
  try {
    message = terminalClientMessageSchema.parse(input);
  } catch {
    throw new AppError('PROTOCOL_INVALID_MESSAGE');
  }

  if (message.type === 'host-key-decision' && (
    pending.pendingFingerprint === undefined ||
    message.fingerprint !== pending.pendingFingerprint
  )) {
    throw new AppError('PROTOCOL_INVALID_MESSAGE');
  }

  return message;
};

export const isAppErrorCode = (value: string): value is AppErrorCode => (
  (APP_ERROR_CODES as readonly string[]).includes(value)
);
