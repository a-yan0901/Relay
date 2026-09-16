import { Readable } from 'node:stream';
import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../shared/errors.js';
import type { TransferJob } from '../../shared/core/models.js';
import { parseTransferRequest } from '../../shared/validation.js';
import { SessionStore } from '../auth/session-store.js';
import { AuditRepository } from '../db/repositories.js';
import { requireUnlockedSession } from './route-helpers.js';
import { SftpService } from '../sftp/sftp-service.js';
import { TransferManager } from '../sftp/transfer-manager.js';
import { OperationEventBus } from '../ws/operation-gateway.js';

export interface SftpRouteDependencies {
  ownerId: string;
  sessionStore: SessionStore;
  sftpService: SftpService;
  transferManager: TransferManager;
  operationBus: OperationEventBus;
  auditRepository: AuditRepository;
}

const hostParamsSchema = z.object({ hostId: z.string().min(1).max(128) }).strict();
const transferParamsSchema = z.object({ transferId: z.string().min(1).max(128) }).strict();
const listQuerySchema = z.object({ path: z.string().min(1).max(4096).default('/') }).strict();
const entryBodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('mkdir'), path: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('rename'), from: z.string().min(1).max(4096), to: z.string().min(1).max(4096) }).strict(),
  z.object({ action: z.literal('delete'), path: z.string().min(1).max(4096), confirmed: z.boolean() }).strict()
]);

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError('SFTP_PATH_INVALID');
  return result.data;
};

const readHostId = (params: unknown): string => parse(hostParamsSchema, params).hostId;
const readTransferId = (params: unknown): string => parse(transferParamsSchema, params).transferId;

export const registerSftpRoutes = async (app: FastifyInstance, dependencies: SftpRouteDependencies): Promise<void> => {
  const publishTransferUpdate = (requestId: string, job: TransferJob): void => {
    dependencies.operationBus.publish(dependencies.ownerId, { type: 'transfer', job });
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(job.status)) {
      dependencies.auditRepository.insert({
        eventType: `sftp_transfer_${job.status}`,
        hostId: job.hostId,
        requestId,
        metadata: { transferId: job.id }
      });
    }
  };

  app.get('/api/sftp/:hostId/list', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const hostId = readHostId(request.params);
    const query = parse(listQuerySchema, request.query);
    reply.send(await dependencies.sftpService.listEntries(hostId, query.path, session.record.vaultKey));
  });

  app.post('/api/sftp/:hostId/entries', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const hostId = readHostId(request.params);
    const body = parse(entryBodySchema, request.body);
    if (body.action === 'mkdir') await dependencies.sftpService.createDirectory(hostId, body.path, session.record.vaultKey);
    else if (body.action === 'rename') await dependencies.sftpService.renameEntry(hostId, body.from, body.to, session.record.vaultKey);
    else await dependencies.sftpService.removeEntry(hostId, body.path, body.confirmed, session.record.vaultKey);
    dependencies.auditRepository.insert({ eventType: `sftp_${body.action}`, hostId, requestId: request.id });
    reply.code(204).send();
  });

  app.post('/api/sftp/:hostId/transfers', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const hostId = readHostId(request.params);
    const input = parseTransferRequest(request.body);
    if (input.hostId !== hostId) throw new AppError('HOST_VALIDATION_FAILED');
    dependencies.sftpService.assertHost(hostId);
    const job = await dependencies.transferManager.create(input);
    dependencies.operationBus.publish(dependencies.ownerId, { type: 'transfer', job });
    dependencies.auditRepository.insert({ eventType: `sftp_${job.kind}_queued`, hostId, requestId: request.id, metadata: { transferId: job.id } });
    reply.code(202).send(job);
  });

  const uploadTransferContent = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const transferId = readTransferId(request.params);
    const multipartRequest = request as typeof request & { isMultipart?: () => boolean; file?: () => Promise<{ file: AsyncIterable<Uint8Array> }> };
    let source: AsyncIterable<Uint8Array>;
    if (multipartRequest.isMultipart?.()) {
      if (!multipartRequest.file) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      const multipartFile = await multipartRequest.file();
      if (!multipartFile?.file) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      source = multipartFile.file;
    } else {
      source = request.raw as unknown as AsyncIterable<Uint8Array>;
    }
    const job = await dependencies.transferManager.consumeUpload(transferId, source, (updated) => publishTransferUpdate(request.id, updated), session.record.vaultKey);
    reply.send(job);
  };

  app.post('/api/transfers/:transferId/content', uploadTransferContent);
  app.put('/api/transfers/:transferId/content', uploadTransferContent);

  app.get('/api/transfers/:transferId/content', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const transferId = readTransferId(request.params);
    const job = await dependencies.transferManager.get(transferId);
    if (!job) throw new AppError('TRANSFER_NOT_FOUND');
    const stream = await dependencies.transferManager.streamDownload(transferId, session.record.vaultKey, (updated) => publishTransferUpdate(request.id, updated));
    const filename = (job.sourcePath.split('/').at(-1) || 'download').replace(/[\r\n"\\]/gu, '_');
    return reply.header('content-disposition', `attachment; filename="${filename}"`).type('application/octet-stream').send(Readable.from(stream));
  });

  app.get('/api/transfers', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(await dependencies.transferManager.list());
  });

  app.get('/api/transfers/:transferId', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const job = await dependencies.transferManager.get(readTransferId(request.params));
    if (!job) throw new AppError('TRANSFER_NOT_FOUND');
    reply.send(job);
  });

  app.delete('/api/transfers/:transferId', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const transferId = readTransferId(request.params);
    const before = await dependencies.transferManager.get(transferId);
    await dependencies.transferManager.cancel(transferId);
    const job = await dependencies.transferManager.get(transferId);
    if (before?.status === 'queued' && job?.status === 'cancelled') publishTransferUpdate(request.id, job);
    reply.code(204).send();
  });

  app.post('/api/transfers/:transferId/retry', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const transferId = readTransferId(request.params);
    const job = await dependencies.transferManager.retry(transferId);
    dependencies.operationBus.publish(dependencies.ownerId, { type: 'transfer', job });
    dependencies.auditRepository.insert({ eventType: `sftp_${job.kind}_retry`, hostId: job.hostId, requestId: request.id, metadata: { transferId: job.id } });
    reply.send(job);
  });
};
