import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { identityCreateSchema, identityUpdateSchema } from '../../shared/validation.js';
import { requireUnlockedSession } from './route-helpers.js';
import { SessionStore } from '../auth/session-store.js';
import { IdentityService } from '../identity/identity-service.js';
import type { SyncCoordinatorPort } from '../sync/sync-service.js';

export interface IdentityRouteDependencies {
  ownerId: string;
  sessionStore: SessionStore;
  identityService: IdentityService;
  syncCoordinator?: SyncCoordinatorPort;
}

const idFromParams = (params: unknown): string => {
  if (typeof params !== 'object' || params === null || !('id' in params) || typeof params.id !== 'string' || params.id.length === 0) {
    throw new AppError('IDENTITY_NOT_FOUND');
  }
  return params.id;
};

export const registerIdentityRoutes = async (app: FastifyInstance, dependencies: IdentityRouteDependencies): Promise<void> => {
  app.get('/api/identities', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(await dependencies.identityService.list(dependencies.ownerId));
  });

  app.get('/api/identities/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const identity = await dependencies.identityService.get(dependencies.ownerId, idFromParams(request.params));
    if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
    reply.send(identity);
  });

  app.post('/api/identities', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const parsed = identityCreateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('HOST_VALIDATION_FAILED');
    const created = await dependencies.identityService.create(dependencies.ownerId, parsed.data, session.record.vaultKey);
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.code(201).send(created);
  });

  app.patch('/api/identities/:id', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const parsed = identityUpdateSchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('HOST_VALIDATION_FAILED');
    const updated = await dependencies.identityService.update(dependencies.ownerId, idFromParams(request.params), parsed.data, session.record.vaultKey);
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.send(updated);
  });

  app.delete('/api/identities/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    await dependencies.identityService.delete(dependencies.ownerId, idFromParams(request.params));
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.code(204).send();
  });
};
