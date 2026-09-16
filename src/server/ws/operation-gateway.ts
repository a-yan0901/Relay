import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';

import { AppError } from '../../shared/errors.js';
import type { OperationDiagnostic } from '../../shared/core/models.js';
import type { OperationServerEvent } from '../../shared/protocol.js';
import { getSessionId } from '../auth/session-cookie.js';
import { SessionStore } from '../auth/session-store.js';
import type { AppRuntimeConfig } from '../api/setup-routes.js';

type Listener = (event: OperationServerEvent) => void;

export class OperationEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(ownerId: string, event: OperationServerEvent): void {
    for (const listener of this.listeners.get(ownerId) ?? []) listener(event);
  }

  publishDiagnostic(ownerId: string, diagnostic: OperationDiagnostic): void {
    this.publish(ownerId, { type: 'diagnostic', diagnostic });
  }

  subscribe(ownerId: string, listener: Listener): () => void {
    const listeners = this.listeners.get(ownerId) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(ownerId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(ownerId);
    };
  }
}

export interface OperationGatewayDependencies {
  ownerId: string;
  config: Pick<AppRuntimeConfig, 'trustedOrigins'>;
  sessionStore: SessionStore;
  eventBus: OperationEventBus;
}

const handshake = (request: FastifyRequest, dependencies: OperationGatewayDependencies): void => {
  const sessionId = getSessionId(request);
  if (!sessionId || !dependencies.sessionStore.get(sessionId)) throw new AppError('SESSION_INVALID');
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !dependencies.config.trustedOrigins.includes(origin)) throw new AppError('PROTOCOL_INVALID_MESSAGE', '来源不受信任', 403);
};

export const registerOperationGateway = async (app: FastifyInstance, dependencies: OperationGatewayDependencies): Promise<void> => {
  app.get('/ws/operations', { websocket: true, preValidation: async (request) => handshake(request, dependencies) }, (socket: WebSocket) => {
    let active = true;
    const unsubscribe = dependencies.eventBus.subscribe(dependencies.ownerId, (event) => {
      if (active && socket.readyState === 1) socket.send(JSON.stringify(event));
    });
    const close = (): void => {
      if (!active) return;
      active = false;
      unsubscribe();
    };
    socket.on('close', close);
    socket.on('error', close);
  });
};
