import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { SessionStore } from '../auth/session-store.js';
import { AuditRepository } from '../db/repositories.js';
import { CommandRunner } from '../automation/command-runner.js';
import { SnippetService } from '../automation/snippet-service.js';
import { requireUnlockedSession } from './route-helpers.js';

export interface CommandRouteDependencies {
  ownerId: string;
  sessionStore: SessionStore;
  snippetService: SnippetService;
  commandRunner: CommandRunner;
  auditRepository: AuditRepository;
}

const idSchema = z.object({ id: z.string().min(1).max(128) }).strict();
const runIdSchema = z.object({ runId: z.string().min(1).max(128) }).strict();

const parseId = (value: unknown, code: 'SNIPPET_NOT_FOUND' | 'COMMAND_RUN_NOT_FOUND'): string => {
  if (code === 'SNIPPET_NOT_FOUND') {
    const parsed = idSchema.safeParse(value);
    if (!parsed.success) throw new AppError(code);
    return parsed.data.id;
  }
  const parsed = runIdSchema.safeParse(value);
  if (!parsed.success) throw new AppError(code);
  return parsed.data.runId;
};

export const registerCommandRoutes = async (app: FastifyInstance, dependencies: CommandRouteDependencies): Promise<void> => {
  app.get('/api/snippets', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(await dependencies.snippetService.list());
  });

  app.post('/api/snippets', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const snippet = await dependencies.snippetService.create(request.body, session.record.vaultKey);
    dependencies.auditRepository.insert({ eventType: 'snippet_created', requestId: request.id });
    reply.code(201).send(snippet);
  });

  app.get('/api/snippets/:id', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(await dependencies.snippetService.get(parseId(request.params, 'SNIPPET_NOT_FOUND'), session.record.vaultKey));
  });

  app.patch('/api/snippets/:id', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const snippet = await dependencies.snippetService.update(parseId(request.params, 'SNIPPET_NOT_FOUND'), request.body, session.record.vaultKey);
    dependencies.auditRepository.insert({ eventType: 'snippet_updated', requestId: request.id });
    reply.send(snippet);
  });

  app.delete('/api/snippets/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const id = parseId(request.params, 'SNIPPET_NOT_FOUND');
    await dependencies.snippetService.delete(id);
    dependencies.auditRepository.insert({ eventType: 'snippet_deleted', requestId: request.id });
    reply.code(204).send();
  });

  app.post('/api/command-runs', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const run = await dependencies.commandRunner.start(request.body, session.record.vaultKey);
    dependencies.auditRepository.insert({ eventType: 'command_run_queued', requestId: request.id });
    reply.code(202).send(run);
  });

  app.get('/api/command-runs/:runId', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const run = await dependencies.commandRunner.get(parseId(request.params, 'COMMAND_RUN_NOT_FOUND'));
    if (!run) throw new AppError('COMMAND_RUN_NOT_FOUND');
    reply.send(run);
  });

  app.delete('/api/command-runs/:runId', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const runId = parseId(request.params, 'COMMAND_RUN_NOT_FOUND');
    await dependencies.commandRunner.cancel(runId);
    dependencies.auditRepository.insert({ eventType: 'command_run_cancelled', requestId: request.id });
    reply.code(204).send();
  });
};
