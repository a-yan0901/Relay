import { z } from 'zod';

import { APP_ERROR_CODES, AppError, type AppErrorCode } from './errors.js';
import type { CommandRun, OperationDiagnostic, TransferJob } from './core/models.js';
import { hostCredentialSchema } from './validation.js';

const dimensionSchema = z.number().int().min(1).max(500);
const identifierSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const requestIdSchema = z.string().min(1).max(128).regex(/^[a-z0-9][a-z0-9._:-]*$/iu);
const fingerprintSchema = z.string().min(1).max(255).regex(/^SHA256:[A-Za-z0-9+/=_-]+$/u);

export const PROTOCOL_VERSION = 1 as const;

export const terminalOpenSchema = z.object({
  type: z.literal('open'),
  hostId: identifierSchema,
  cols: dimensionSchema,
  rows: dimensionSchema,
  requestId: requestIdSchema,
  knownServiceInstanceId: requestIdSchema.optional(),
  reattachOnly: z.boolean().optional(),
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

const terminalCredentialSchema = z.object({
  type: z.literal('credential'),
  hostId: identifierSchema,
  credential: hostCredentialSchema
}).strict();

export const terminalClientMessageSchema = z.discriminatedUnion('type', [
  terminalOpenSchema,
  terminalResizeSchema,
  terminalInputSchema,
  terminalPingSchema,
  terminalCloseSchema,
  terminalHostKeyDecisionSchema,
  terminalCredentialSchema
]);

export type TerminalOpenMessage = z.infer<typeof terminalOpenSchema>;
export type TerminalResizeMessage = z.infer<typeof terminalResizeSchema>;
export type TerminalInputMessage = z.infer<typeof terminalInputSchema>;
export type TerminalPingMessage = z.infer<typeof terminalPingSchema>;
export type TerminalCloseMessage = z.infer<typeof terminalCloseSchema>;
export type TerminalHostKeyDecisionMessage = z.infer<typeof terminalHostKeyDecisionSchema>;
export type TerminalCredentialMessage = z.infer<typeof terminalCredentialSchema>;
export type TerminalClientMessage = z.infer<typeof terminalClientMessageSchema>;
export type TerminalControlMessage = TerminalClientMessage;

export const terminalEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  message: terminalClientMessageSchema
}).strict();

export type TerminalEnvelope = z.infer<typeof terminalEnvelopeSchema>;

export const operationDiagnosticSchema = z.object({
  operationId: identifierSchema,
  hostId: identifierSchema,
  kind: z.enum(['terminal', 'transfer', 'command']),
  stage: z.enum(['dns', 'tcp', 'jump-host', 'host-key', 'auth', 'pty', 'sftp', 'command']),
  state: z.enum(['running', 'completed', 'failed', 'cancelled', 'interrupted', 'needs-reopen']),
  retryable: z.boolean(),
  nextAction: z.enum(['wait', 'retry', 'edit-credentials', 'confirm-host-key', 'reopen', 'none']),
  errorCode: identifierSchema.optional(),
  requestId: requestIdSchema.optional(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }).optional()
}).strict();

export const parseOperationDiagnostic = (input: unknown): OperationDiagnostic => {
  try {
    return operationDiagnosticSchema.parse(input) as OperationDiagnostic;
  } catch {
    throw new AppError('PROTOCOL_INVALID_MESSAGE');
  }
};

export type TerminalStatus = 'connecting' | 'awaiting-host-key' | 'awaiting-credential' | 'connected' | 'reconnecting' | 'interrupted' | 'needs-reopen' | 'closed' | 'failed';

export interface TerminalStatusEvent {
  type: 'status';
  state: TerminalStatus;
  serviceInstanceId: string;
  requestId?: string;
}

export interface TerminalHostKeyEvent {
  type: 'host-key';
  algorithm: string;
  fingerprint: string;
  address: string;
  port: number;
  hostId?: string;
  hopIndex?: number;
}

export interface TerminalCredentialRequiredEvent {
  type: 'credential-required';
  hostId: string;
  authType: 'password' | 'private_key';
  name: string;
  address: string;
  port: number;
  username: string;
}

export interface TerminalDiagnosticEvent {
  type: 'diagnostic';
  diagnostic: OperationDiagnostic;
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
  | TerminalCredentialRequiredEvent
  | TerminalDiagnosticEvent
  | TerminalErrorEvent
  | TerminalExitEvent
  | TerminalPongEvent;

export type OperationKind = 'connection' | 'transfer' | 'command-run' | 'workspace';
export type OperationStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface OperationEvent {
  type: 'operation';
  operationId: string;
  operation: OperationKind;
  status: OperationStatus;
  hostId?: string;
  progress?: { completedBytes: number; totalBytes: number | null };
  code?: AppErrorCode;
  message?: string;
  at: string;
}

export interface TransferOperationEvent {
  type: 'transfer';
  job: TransferJob;
}

export interface CommandRunOperationEvent {
  type: 'command-run';
  run: CommandRun;
}

export interface OperationDiagnosticEvent {
  type: 'diagnostic';
  diagnostic: OperationDiagnostic;
}

export type OperationServerEvent = OperationEvent | TransferOperationEvent | CommandRunOperationEvent | OperationDiagnosticEvent;

export interface PendingHostKeyDecision {
  pendingFingerprint?: string;
}

export const parseTerminalEnvelope = (input: unknown): TerminalEnvelope => {
  try {
    return terminalEnvelopeSchema.parse(input);
  } catch {
    throw new AppError('PROTOCOL_INVALID_MESSAGE');
  }
};

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
