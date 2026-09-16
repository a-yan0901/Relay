import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../shared/errors.js';
import type { WorkspaceState } from '../../shared/core/models.js';
import { SessionStore } from '../auth/session-store.js';
import { AuditRepository } from '../db/repositories.js';
import { WorkspaceService } from '../workspace/workspace-service.js';
import { requireUnlockedSession } from './route-helpers.js';
import type { SyncCoordinatorPort } from '../sync/sync-service.js';

export interface WorkspaceRouteDependencies {
  ownerId: string;
  workspaceService: WorkspaceService;
  sessionStore: SessionStore;
  auditRepository: AuditRepository;
  syncCoordinator?: SyncCoordinatorPort;
}

const saveSchema = z.object({
  expectedVersion: z.number().int().min(0).max(1_000_000_000),
  state: z.unknown()
}).strict();
const templateSchema = z.object({
  name: z.string().min(1).max(120),
  state: z.unknown()
}).strict();
const templateParamsSchema = z.object({ id: z.string().min(1).max(128) }).strict();

const parseBody = <T>(schema: z.ZodType<T>, body: unknown): T => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new AppError('WORKSPACE_INVALID');
  return parsed.data;
};

export const registerWorkspaceRoutes = async (app: FastifyInstance, dependencies: WorkspaceRouteDependencies): Promise<void> => {
  app.get('/api/workspace', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(dependencies.workspaceService.load(dependencies.ownerId));
  });

  app.put('/api/workspace', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const body = parseBody(saveSchema, request.body);
    const saved = dependencies.workspaceService.save(dependencies.ownerId, body.expectedVersion, body.state as WorkspaceState);
    dependencies.auditRepository.insert({ eventType: 'workspace_saved', requestId: request.id });
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.send(saved.state);
  });

  app.get('/api/workspace/templates', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(dependencies.workspaceService.listTemplates(dependencies.ownerId));
  });

  app.post('/api/workspace/templates', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const body = parseBody(templateSchema, request.body);
    const created = dependencies.workspaceService.createTemplate(dependencies.ownerId, body.name, body.state as WorkspaceState);
    dependencies.auditRepository.insert({ eventType: 'workspace_template_created', requestId: request.id });
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.code(201).send(created);
  });

  app.delete('/api/workspace/templates/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const params = templateParamsSchema.safeParse(request.params);
    if (!params.success) throw new AppError('NOT_FOUND');
    dependencies.workspaceService.deleteTemplate(dependencies.ownerId, params.data.id);
    dependencies.auditRepository.insert({ eventType: 'workspace_template_deleted', requestId: request.id });
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.code(204).send();
  });
};
