import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { requireUnlockedSession } from './route-helpers.js';
import { SessionStore } from '../auth/session-store.js';
import { GroupRepository } from '../db/repositories.js';

export interface GroupRouteDependencies {
  groupRepository: GroupRepository;
  sessionStore: SessionStore;
}

const groupNameSchema = z.string().min(1).max(80).refine((value) => ![...value].some((character) => {
  const codePoint = character.codePointAt(0) ?? 0;
  return codePoint <= 0x1f || codePoint === 0x7f;
}));

const groupCreateSchema = z.object({
  name: groupNameSchema,
  sortOrder: z.number().int().min(0).max(1_000_000).default(0)
}).strict();

const groupPatchSchema = groupCreateSchema.partial();

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
    let input: z.infer<typeof groupCreateSchema>;
    try {
      input = groupCreateSchema.parse(request.body);
    } catch {
      throw new AppError('HOST_VALIDATION_FAILED');
    }

    reply.code(201).send(dependencies.groupRepository.create(input));
  });

  app.patch('/api/groups/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    let patch: z.infer<typeof groupPatchSchema>;
    try {
      patch = groupPatchSchema.parse(request.body);
    } catch {
      throw new AppError('HOST_VALIDATION_FAILED');
    }

    reply.send(dependencies.groupRepository.update(routeId(request.params), patch));
  });

  app.delete('/api/groups/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    dependencies.groupRepository.delete(routeId(request.params));
    reply.code(204).send();
  });
};
