import type {
  CommandTargetStatus,
  ConnectionDiagnostic,
  OperationDiagnostic,
  OperationDiagnosticKind,
  OperationDiagnosticState,
  OperationNextAction,
  OperationStage,
  TransferStatus
} from './models.js';

const connectionDiagnosticStage: Record<ConnectionDiagnostic['stage'], OperationStage> = {
  resolve: 'dns',
  tcp: 'tcp',
  jump: 'jump-host',
  'host-key': 'host-key',
  authentication: 'auth',
  channel: 'pty'
};

export const operationNextAction = (
  state: OperationDiagnosticState,
  retryable: boolean,
  errorCode?: string
): OperationNextAction => {
  if (state === 'running') return 'wait';
  if (state === 'completed' || state === 'cancelled') return 'none';
  if (state === 'interrupted' || state === 'needs-reopen') return state === 'needs-reopen' ? 'reopen' : 'retry';
  if (errorCode === 'SSH_AUTH_FAILED' || errorCode === 'IMPORT_RECORD_INVALID') return 'edit-credentials';
  if (errorCode === 'HOST_KEY_REQUIRED' || errorCode === 'HOST_KEY_MISMATCH') return 'confirm-host-key';
  return retryable ? 'retry' : 'none';
};

const terminalErrorStage = (errorCode: string): OperationStage => {
  if (['SSH_AUTH_FAILED', 'IMPORT_RECORD_INVALID'].includes(errorCode)) return 'auth';
  if (['HOST_KEY_REQUIRED', 'HOST_KEY_MISMATCH'].includes(errorCode)) return 'host-key';
  if (['SESSION_NEEDS_REOPEN', 'SERVICE_RESTARTED', 'OPERATION_NOT_FOUND'].includes(errorCode)) return 'pty';
  return 'tcp';
};

const terminalErrorRetryable = (errorCode: string): boolean => ![
  'PROTOCOL_INVALID_MESSAGE',
  'HOST_NOT_FOUND',
  'VAULT_LOCKED',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'IDENTITY_NOT_FOUND',
  'SSH_AUTH_FAILED',
  'HOST_KEY_REQUIRED',
  'HOST_KEY_MISMATCH',
  'IMPORT_RECORD_INVALID'
].includes(errorCode);

export interface OperationErrorContext {
  operationId: string;
  hostId: string;
  errorCode: string;
  at: string;
  state?: Extract<OperationDiagnosticState, 'failed' | 'needs-reopen'>;
  requestId?: string;
}

export const operationErrorToDiagnostic = (context: OperationErrorContext): OperationDiagnostic => {
  const state = context.state ?? 'failed';
  const retryable = state === 'needs-reopen' ? false : terminalErrorRetryable(context.errorCode);
  return {
    operationId: context.operationId,
    hostId: context.hostId,
    kind: 'terminal',
    stage: terminalErrorStage(context.errorCode),
    state,
    retryable,
    nextAction: operationNextAction(state, retryable, context.errorCode),
    errorCode: context.errorCode,
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    startedAt: context.at,
    endedAt: context.at
  };
};

export interface ConnectionDiagnosticContext {
  operationId: string;
  kind?: OperationDiagnosticKind;
  requestId?: string;
}

export const connectionDiagnosticToOperationDiagnostic = (
  diagnostic: ConnectionDiagnostic,
  context: ConnectionDiagnosticContext
): OperationDiagnostic => {
  const state: OperationDiagnosticState = diagnostic.status === 'started'
    ? 'running'
    : diagnostic.status === 'succeeded' ? 'completed' : 'failed';
  const endedAt = state === 'running' ? undefined : diagnostic.at;
  return {
    operationId: context.operationId,
    hostId: diagnostic.hostId,
    kind: context.kind ?? 'terminal',
    stage: connectionDiagnosticStage[diagnostic.stage],
    state,
    retryable: diagnostic.retryable,
    nextAction: operationNextAction(state, diagnostic.retryable, diagnostic.code),
    ...(diagnostic.code === undefined ? {} : { errorCode: diagnostic.code }),
    ...(context.requestId === undefined ? {} : { requestId: context.requestId }),
    startedAt: diagnostic.at,
    ...(endedAt === undefined ? {} : { endedAt })
  };
};

export type ConnectionStateName =
  | 'idle'
  | 'resolving'
  | 'connecting'
  | 'awaiting-host-key'
  | 'authenticating'
  | 'opening-channel'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

export interface ConnectionState {
  state: ConnectionStateName;
  attempt: number;
  hopCount: number;
  retryable: boolean;
  delayMs?: number;
  errorCode?: string;
}

export type ConnectionEvent =
  | { type: 'resolve-start' }
  | { type: 'resolve-complete'; hopCount: number }
  | { type: 'transport-start' }
  | { type: 'host-key-required' }
  | { type: 'host-key-approved' }
  | { type: 'authentication-succeeded' }
  | { type: 'channel-opened' }
  | { type: 'failed'; code: string; retryable: boolean }
  | { type: 'retry-scheduled'; delayMs: number }
  | { type: 'disconnected'; retryable: boolean }
  | { type: 'closed' };

export const initialConnectionState = (): ConnectionState => ({
  state: 'idle',
  attempt: 0,
  hopCount: 0,
  retryable: false
});

const invalidTransition = (state: string, event: string): Error => (
  new Error(`Invalid ${event} transition from ${state}`)
);

export const transitionConnection = (state: ConnectionState, event: ConnectionEvent): ConnectionState => {
  if (event.type === 'closed') {
    if (state.state === 'closed') {
      throw invalidTransition(state.state, event.type);
    }
    return { ...state, state: 'closed', retryable: false, delayMs: undefined };
  }

  if (state.state === 'closed') {
    throw invalidTransition(state.state, event.type);
  }

  switch (event.type) {
    case 'resolve-start':
      if (!['idle', 'reconnecting', 'failed'].includes(state.state) || (state.state === 'failed' && !state.retryable)) {
        throw invalidTransition(state.state, event.type);
      }
      return { ...state, state: 'resolving', delayMs: undefined, errorCode: undefined };
    case 'resolve-complete':
      if (state.state !== 'resolving' || !Number.isInteger(event.hopCount) || event.hopCount < 0 || event.hopCount > 4) {
        throw invalidTransition(state.state, event.type);
      }
      return { ...state, state: 'connecting', hopCount: event.hopCount };
    case 'transport-start':
      if (state.state !== 'connecting') {
        throw invalidTransition(state.state, event.type);
      }
      return state;
    case 'host-key-required':
      if (!['connecting', 'authenticating'].includes(state.state)) {
        throw invalidTransition(state.state, event.type);
      }
      return { ...state, state: 'awaiting-host-key' };
    case 'host-key-approved':
      if (state.state !== 'awaiting-host-key') {
        throw invalidTransition(state.state, event.type);
      }
      return { ...state, state: 'authenticating' };
    case 'authentication-succeeded':
      if (state.state !== 'authenticating') {
        throw invalidTransition(state.state, event.type);
      }
      return { ...state, state: 'opening-channel' };
    case 'channel-opened':
      if (state.state !== 'opening-channel') {
        throw invalidTransition(state.state, event.type);
      }
      return { ...state, state: 'connected', retryable: true, errorCode: undefined, delayMs: undefined };
    case 'failed':
      if (state.state === 'failed') {
        throw invalidTransition(state.state, event.type);
      }
      return { ...state, state: 'failed', errorCode: event.code, retryable: event.retryable, delayMs: undefined };
    case 'retry-scheduled':
      if (state.state !== 'failed' || !state.retryable || event.delayMs < 0) {
        throw invalidTransition(state.state, event.type);
      }
      return { ...state, state: 'reconnecting', attempt: state.attempt + 1, delayMs: event.delayMs };
    case 'disconnected':
      if (state.state !== 'connected') {
        throw invalidTransition(state.state, event.type);
      }
      if (!event.retryable) {
        return { ...state, state: 'failed', retryable: false, errorCode: 'CONNECTION_STAGE_FAILED' };
      }
      return { ...state, state: 'reconnecting', attempt: state.attempt + 1, retryable: true };
  }
};

export interface TransferState {
  id: string;
  status: TransferStatus;
  completedBytes: number;
  totalBytes: number | null;
  errorCode?: string;
}

export type TransferEvent =
  | { type: 'start'; totalBytes?: number | null }
  | { type: 'progress'; completedBytes: number }
  | { type: 'completed' }
  | { type: 'failed'; code: string }
  | { type: 'interrupted'; code: string }
  | { type: 'cancelled' }
  | { type: 'retry' };

export const initialTransferState = (id: string): TransferState => ({
  id,
  status: 'queued',
  completedBytes: 0,
  totalBytes: null
});

export const transitionTransfer = (state: TransferState, event: TransferEvent): TransferState => {
  switch (event.type) {
    case 'start':
      if (state.status !== 'queued') throw invalidTransition(state.status, event.type);
      if (event.totalBytes !== null && event.totalBytes !== undefined && (!Number.isFinite(event.totalBytes) || event.totalBytes < 0)) {
        throw invalidTransition(state.status, event.type);
      }
      return { ...state, status: 'running', totalBytes: event.totalBytes ?? state.totalBytes, errorCode: undefined };
    case 'progress':
      if (state.status !== 'running' || !Number.isFinite(event.completedBytes) || event.completedBytes < state.completedBytes) {
        throw invalidTransition(state.status, event.type);
      }
      return {
        ...state,
        completedBytes: state.totalBytes === null ? event.completedBytes : Math.min(state.totalBytes, event.completedBytes)
      };
    case 'completed':
      if (state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'completed', completedBytes: state.totalBytes ?? state.completedBytes };
    case 'failed':
      if (state.status !== 'running' && state.status !== 'queued') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'failed', errorCode: event.code };
    case 'interrupted':
      if (state.status !== 'queued' && state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'interrupted', errorCode: event.code };
    case 'cancelled':
      if (state.status !== 'queued' && state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'cancelled' };
    case 'retry':
      if (state.status !== 'failed' && state.status !== 'interrupted') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'queued', completedBytes: 0, errorCode: undefined };
  }
};

export interface CommandTargetState {
  hostId: string;
  status: CommandTargetStatus;
  exitCode: number | null;
  outputBytes: number;
  errorCode?: string;
}

export type CommandTargetEvent =
  | { type: 'start' }
  | { type: 'progress'; outputBytes: number }
  | { type: 'completed'; exitCode: number | null; outputBytes: number }
  | { type: 'failed'; code: string; outputBytes?: number }
  | { type: 'interrupted'; code: string }
  | { type: 'cancelled' };

export const initialCommandTargetState = (hostId: string): CommandTargetState => ({
  hostId,
  status: 'queued',
  exitCode: null,
  outputBytes: 0
});

export const transitionCommandTarget = (
  state: CommandTargetState,
  event: CommandTargetEvent
): CommandTargetState => {
  switch (event.type) {
    case 'start':
      if (state.status !== 'queued') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'running', errorCode: undefined };
    case 'progress':
      if (state.status !== 'running' || event.outputBytes < state.outputBytes) throw invalidTransition(state.status, event.type);
      return { ...state, outputBytes: event.outputBytes };
    case 'completed':
      if (state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'completed', exitCode: event.exitCode, outputBytes: event.outputBytes };
    case 'failed':
      if (state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'failed', errorCode: event.code, outputBytes: event.outputBytes ?? state.outputBytes };
    case 'interrupted':
      if (state.status !== 'queued' && state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'interrupted', errorCode: event.code };
    case 'cancelled':
      if (state.status !== 'queued' && state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'cancelled' };
  }
};
