import type { CommandTargetStatus, TransferStatus } from './models.js';

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
    case 'cancelled':
      if (state.status !== 'queued' && state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'cancelled' };
    case 'retry':
      if (state.status !== 'failed') throw invalidTransition(state.status, event.type);
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
    case 'cancelled':
      if (state.status !== 'queued' && state.status !== 'running') throw invalidTransition(state.status, event.type);
      return { ...state, status: 'cancelled' };
  }
};
