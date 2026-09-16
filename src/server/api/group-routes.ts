import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { parseGroupMutationInput, parseGroupPatchInput, type GroupMutationInput, type GroupPatchInput } from '../../shared/validation.js';
import { requireUnlockedSession } from './route-helpers.js';
import { SessionStore } from '../auth/session-store.js';
import { GroupRepository } from '../db/repositories.js';

export interface GroupRouteDependencies {
  groupRepository: GroupRepository;
  sessionStore: SessionStore;
}

const routeId = (params: unknown): string => {
  const parsed = z.object({ id: z.string().min(1).max(128) }).strict().safeParse(params);
  if (!parsed.success) {
    throw new AppError('GROUP_NOT_FOUND');
  }
  return parsed.data.id;
};

export const registerGroupRoutes = async (
  app: FastifyInstance,
  dependencies: GroupRouteDependencies
): Promise<void> => {
  app.get('/api/groups', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(dependencies.groupRepository.list());
  });

  app.get('/api/groups/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const group = dependencies.groupRepository.get(routeId(request.params));
    if (!group) {
      throw new AppError('GROUP_NOT_FOUND');
    }
    reply.send(group);
  });

  app.post('/api/groups', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const input: GroupMutationInput = parseGroupMutationInput(request.body);

    reply.code(201).send(dependencies.groupRepository.create(input));
  });

  app.patch('/api/groups/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const patch: GroupPatchInput = parseGroupPatchInput(request.body);

    reply.send(dependencies.groupRepository.update(routeId(request.params), patch));
  });

  app.delete('/api/groups/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    dependencies.groupRepository.delete(routeId(request.params));
    reply.code(204).send();
  });
};
