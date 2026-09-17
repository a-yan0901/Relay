import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { requireUnlockedSession } from './route-helpers.js';
import { SessionStore } from '../auth/session-store.js';
import { TerminalProfileService } from '../terminal/terminal-profile-service.js';
import type { SyncCoordinatorPort } from '../sync/sync-service.js';

const id = (params: unknown): string => {
  if (typeof params !== 'object' || params === null || !('id' in params) || typeof params.id !== 'string' || !params.id) throw new AppError('NOT_FOUND');
  return params.id;
};
export const registerTerminalProfileRoutes = async (app: FastifyInstance, dependencies: { ownerId: string; sessionStore: SessionStore; terminalProfileService: TerminalProfileService; syncCoordinator?: SyncCoordinatorPort }): Promise<void> => {
  app.get('/api/terminal-profiles', async (request, reply) => { requireUnlockedSession(request, dependencies.sessionStore); reply.send({ profiles: dependencies.terminalProfileService.list(dependencies.ownerId), defaultProfile: dependencies.terminalProfileService.getDefault(dependencies.ownerId) }); });
  app.post('/api/terminal-profiles', async (request, reply) => { requireUnlockedSession(request, dependencies.sessionStore); const created=dependencies.terminalProfileService.create(dependencies.ownerId, request.body); dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId); reply.code(201).send(created); });
  app.patch('/api/terminal-profiles/:id', async (request, reply) => { requireUnlockedSession(request, dependencies.sessionStore); const updated = dependencies.terminalProfileService.update(dependencies.ownerId, id(request.params), request.body); dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId); reply.send(updated); });
  app.put('/api/terminal-profiles/default', async (request, reply) => { requireUnlockedSession(request, dependencies.sessionStore); const profileId=typeof request.body === 'object' && request.body !== null && 'profileId' in request.body && typeof request.body.profileId === 'string' ? request.body.profileId : ''; if(!profileId) throw new AppError('HOST_VALIDATION_FAILED'); const profile=dependencies.terminalProfileService.setDefault(dependencies.ownerId, profileId); dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId); reply.send(profile); });
  app.delete('/api/terminal-profiles/:id', async (request, reply) => { requireUnlockedSession(request, dependencies.sessionStore); dependencies.terminalProfileService.delete(dependencies.ownerId, id(request.params)); dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId); reply.code(204).send(); });
};
