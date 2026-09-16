import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import { operationNextAction } from '../../shared/core/state-machines.js';
import type { CommandRun, CommandTargetResult, OperationDiagnostic, TargetSelectionSnapshot } from '../../shared/core/models.js';
import { assessCommandRisk } from '../../shared/core/command-safety.js';
import { expandCommandTemplate as expandTemplate, parseCommandRunRequest } from '../../shared/validation.js';
import type { HostMetadata } from '../../shared/validation.js';
import type { CommandRunOperationEvent, OperationDiagnosticEvent } from '../../shared/protocol.js';
import type { SshConnectionResource } from '../ssh/types.js';
import { CommandRunStore } from './command-run-store.js';

export const expandCommandTemplate = expandTemplate;

export { assessCommandRisk, redactCommandPreview, type CommandRiskAssessment } from '../../shared/core/command-safety.js';

export interface CommandConnectionLease {
  resource: Pick<SshConnectionResource, 'exec'>;
  close(): void | Promise<void>;
}

export interface CommandResourceProvider {
  open(hostId: string, sessionKey?: Buffer): Promise<CommandConnectionLease>;
}

export interface CommandHostLookup {
  get(hostId: string, ownerId: string): HostMetadata | null;
}

export interface CommandRunEventPublisher {
  publish(ownerId: string, event: CommandRunOperationEvent | OperationDiagnosticEvent): void;
  publishDiagnostic?(ownerId: string, diagnostic: OperationDiagnostic): void;
}

export interface CommandRunnerOptions {
  ownerId: string;
  hostLookup: CommandHostLookup;
  resourceProvider: CommandResourceProvider;
  store?: CommandRunStore;
  operationBus?: CommandRunEventPublisher;
  maxOutputBytes?: number;
  now?: () => number;
  defaultConcurrency?: number;
  onCompleted?: (run: CommandRun) => void | Promise<void>;
}

interface RunControl {
  cancelRequested: boolean;
  controllers: Map<string, AbortController>;
  sessionKey?: Buffer;
  promise: Promise<void>;
}

const DEFAULT_OUTPUT_LIMIT = 256 * 1024;
const DEFAULT_CONCURRENCY = 4;

const asAppError = (error: unknown, fallback: 'COMMAND_RUN_TARGET_FAILED' | 'COMMAND_RUN_CANCELLED'): AppError => {
  if (error instanceof AppError) return error;
  return new AppError(fallback);
};

const nowIso = (now: () => number): string => new Date(now()).toISOString();

const openResource = async (provider: CommandResourceProvider, hostId: string, sessionKey?: Buffer): Promise<CommandConnectionLease> => (
  sessionKey === undefined ? provider.open(hostId) : provider.open(hostId, sessionKey)
);

const sameTargetIds = (left: readonly string[], right: readonly string[]): boolean => (
  left.length === right.length && left.every((hostId) => right.includes(hostId))
);

const cloneTargetSelection = (snapshot: TargetSelectionSnapshot): TargetSelectionSnapshot => ({
  hostIds: [...snapshot.hostIds],
  source: snapshot.source,
  capturedAt: snapshot.capturedAt,
  displayNames: [...snapshot.displayNames]
});

export class CommandRunner {
  private readonly store: CommandRunStore;
  private readonly operationBus?: CommandRunEventPublisher;
  private readonly maxOutputBytes: number;
  private readonly now: () => number;
  private readonly defaultConcurrency: number;
  private readonly controls = new Map<string, RunControl>();

  constructor(private readonly options: CommandRunnerOptions) {
    this.store = options.store ?? new CommandRunStore({ ownerId: options.ownerId });
    this.operationBus = options.operationBus;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
    this.now = options.now ?? Date.now;
    this.defaultConcurrency = options.defaultConcurrency ?? DEFAULT_CONCURRENCY;
    if (!Number.isInteger(this.maxOutputBytes) || this.maxOutputBytes < 1 || this.maxOutputBytes > 4 * 1024 * 1024) throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
    if (!Number.isInteger(this.defaultConcurrency) || this.defaultConcurrency < 1 || this.defaultConcurrency > 16) throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
  }

  async start(input: unknown, sessionKey?: Buffer, requestId?: string): Promise<CommandRun> {
    const request = parseCommandRunRequest(input);
    if (request.targetSelection && !sameTargetIds(request.hostIds, request.targetSelection.hostIds)) {
      throw new AppError('COMMAND_RUN_VALIDATION_FAILED', '目标主机列表已变化，请重新确认后再执行');
    }
    const hosts: HostMetadata[] = [];
    for (const hostId of request.hostIds) {
      const host = this.options.hostLookup.get(hostId, this.options.ownerId);
      if (!host) throw new AppError('HOST_NOT_FOUND');
      hosts.push(host);
    }
    const command = expandTemplate(request.command, request.variables);
    const risk = assessCommandRisk(command);
    if ((request.hostIds.length > 1 || risk.requiresConfirmation) && request.confirmed !== true) {
      throw new AppError('COMMAND_RUN_VALIDATION_FAILED', '请确认目标主机、命令和影响范围后再执行');
    }
    const timestamp = nowIso(this.now);
    const run: CommandRun = {
      id: randomUUID(),
      requestId: requestId ?? randomUUID(),
      command,
      hostIds: hosts.map((host) => host.id),
      persistOutput: request.persistOutput,
      status: 'queued',
      targets: hosts.map((host) => ({ hostId: host.id, status: 'queued', exitCode: null, output: '', outputBytes: 0, truncated: false })),
      createdAt: timestamp,
      ...(request.targetSelection === undefined ? {} : { targetSelection: cloneTargetSelection(request.targetSelection) })
    };
    await this.store.create(run, sessionKey);
    const control: RunControl = { cancelRequested: false, controllers: new Map(), sessionKey, promise: Promise.resolve() };
    this.controls.set(run.id, control);
    this.publish(run);
    control.promise = this.execute(run.id, request, sessionKey).catch(() => undefined);
    void control.promise.finally(() => {
      this.controls.delete(run.id);
    });
    return run;
  }

  async waitFor(runId: string): Promise<CommandRun> {
    const control = this.controls.get(runId);
    if (control) await control.promise;
    const run = await this.store.get(runId);
    if (!run) throw new AppError('COMMAND_RUN_NOT_FOUND');
    return run;
  }

  async get(runId: string, sessionKey?: Buffer): Promise<CommandRun | null> {
    return this.store.get(runId, sessionKey);
  }

  async cancel(runId: string): Promise<void> {
    const run = await this.store.get(runId);
    if (!run) throw new AppError('COMMAND_RUN_NOT_FOUND');
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(run.status)) return;
    const control = this.controls.get(runId);
    if (!control) throw new AppError('COMMAND_RUN_NOT_FOUND');
    control.cancelRequested = true;
    for (const controller of control.controllers.values()) controller.abort();
    for (const target of run.targets) {
      if (target.status === 'queued') {
        await this.updateTarget(runId, { ...target, status: 'cancelled', finishedAt: nowIso(this.now) });
      }
    }
  }

  private async execute(runId: string, request: ReturnType<typeof parseCommandRunRequest>, sessionKey?: Buffer): Promise<void> {
    const control = this.controls.get(runId);
    if (!control) return;
    await this.updateRun(runId, { status: 'running' });
    const run = await this.store.get(runId);
    if (!run) return;
    let nextIndex = 0;
    const workerCount = Math.min(request.concurrency || this.defaultConcurrency, run.hostIds.length);
    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= run.hostIds.length) return;
        const hostId = run.hostIds[index];
        const current = await this.store.get(runId);
        const target = current?.targets.find((item) => item.hostId === hostId);
        if (!target || target.status !== 'queued') continue;
        if (control.cancelRequested) {
          await this.updateTarget(runId, { ...target, status: 'cancelled', finishedAt: nowIso(this.now) });
          continue;
        }
        await this.executeTarget(runId, hostId, run.command, request.timeoutMs, sessionKey);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const finished = await this.store.get(runId);
    if (!finished) return;
    const hasFailed = finished.targets.some((target) => target.status === 'failed');
    const hasCancelled = finished.targets.some((target) => target.status === 'cancelled');
    const status = control.cancelRequested || hasCancelled ? 'cancelled' : hasFailed ? 'failed' : 'completed';
    const completed = await this.updateRun(runId, { status, finishedAt: nowIso(this.now) });
    await this.options.onCompleted?.(completed);
  }

  private async executeTarget(runId: string, hostId: string, command: string, timeoutMs: number, sessionKey?: Buffer): Promise<void> {
    const control = this.controls.get(runId);
    if (!control) return;
    const current = await this.store.get(runId);
    const queued = current?.targets.find((target) => target.hostId === hostId);
    if (!queued) return;
    const startedAt = nowIso(this.now);
    const running: CommandTargetResult = { ...queued, status: 'running', startedAt };
    await this.updateTarget(runId, running);
    const controller = new AbortController();
    control.controllers.set(hostId, controller);
    let lease: CommandConnectionLease | undefined;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outputBytes = 0;
    let truncated = false;
    const output: Buffer[] = [];
    const append = (data: Buffer): void => {
      if (outputBytes >= this.maxOutputBytes) {
        truncated = true;
        return;
      }
      const remaining = this.maxOutputBytes - outputBytes;
      const chunk = data.subarray(0, remaining);
      output.push(Buffer.from(chunk));
      outputBytes += chunk.byteLength;
      if (chunk.byteLength < data.byteLength) truncated = true;
    };
    const onOutput = (data: Buffer): void => append(data);
    try {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      lease = await openResource(this.options.resourceProvider, hostId, sessionKey);
      if (control.cancelRequested) throw new AppError('COMMAND_RUN_CANCELLED');
      const result = await lease.resource.exec(command, {
        timeoutMs,
        signal: controller.signal,
        onStdout: onOutput,
        onStderr: onOutput
      });
      if (control.cancelRequested || controller.signal.aborted) throw new AppError('COMMAND_RUN_CANCELLED');
      const finishedAt = nowIso(this.now);
      const value = Buffer.concat(output).toString('utf8');
      if (result.exitCode === 0) {
        await this.updateTarget(runId, { ...running, status: 'completed', exitCode: result.exitCode, output: value, outputBytes, truncated, finishedAt });
      } else {
        await this.updateTarget(runId, { ...running, status: 'failed', exitCode: result.exitCode, output: value, outputBytes, truncated, errorCode: 'COMMAND_RUN_TARGET_FAILED', finishedAt });
      }
    } catch (error) {
      const cancelled = !timedOut && (control.cancelRequested || (error instanceof AppError && error.code === 'COMMAND_RUN_CANCELLED'));
      const code = cancelled ? 'COMMAND_RUN_CANCELLED' : timedOut ? 'COMMAND_RUN_TIMEOUT' : asAppError(error, 'COMMAND_RUN_TARGET_FAILED').code;
      const finishedAt = nowIso(this.now);
      const value = Buffer.concat(output).toString('utf8');
      await this.updateTarget(runId, {
        ...running,
        status: cancelled ? 'cancelled' : 'failed',
        exitCode: null,
        output: value,
        outputBytes,
        truncated,
        errorCode: code,
        finishedAt
      });
    } finally {
      if (timer) clearTimeout(timer);
      control.controllers.delete(hostId);
      try { await lease?.close(); } catch { /* cleanup is best effort */ }
    }
  }

  private async updateTarget(runId: string, target: CommandTargetResult): Promise<void> {
    const run = await this.store.updateTarget(runId, target.hostId, target, this.controls.get(runId)?.sessionKey);
    this.publish(run);
  }

  private async updateRun(runId: string, patch: Partial<Pick<CommandRun, 'status' | 'finishedAt'>>): Promise<CommandRun> {
    const run = await this.store.updateRun(runId, patch);
    this.publish(run);
    return run;
  }

  private publish(run: CommandRun): void {
    if (!this.operationBus) return;
    this.operationBus.publish(this.options.ownerId, { type: 'command-run', run });
    for (const target of run.targets) {
      if (target.status === 'queued') continue;
      const state: OperationDiagnostic['state'] = target.status;
      const retryable = target.status === 'interrupted';
      const diagnostic: OperationDiagnostic = {
        operationId: run.id,
        hostId: target.hostId,
        kind: 'command',
        stage: 'command',
        state,
        retryable,
        nextAction: operationNextAction(state, retryable, target.errorCode),
        ...(target.errorCode === undefined ? {} : { errorCode: target.errorCode }),
        startedAt: target.startedAt ?? run.createdAt,
        ...(target.finishedAt === undefined ? {} : { endedAt: target.finishedAt })
      };
      if (this.operationBus.publishDiagnostic) this.operationBus.publishDiagnostic(this.options.ownerId, diagnostic);
      else this.operationBus.publish(this.options.ownerId, { type: 'diagnostic', diagnostic });
    }
  }
}
