import { AppError } from '../../shared/errors.js';
import type { CommandRun, CommandTargetResult } from '../../shared/core/models.js';
import { CommandRunRepository } from '../db/repositories.js';
import type { SqliteDatabase } from '../db/database.js';
import { VAULT_KEY_LENGTH, type EncryptedJson } from '../vault/types.js';
import { VaultService } from '../vault/vault-service.js';

const commandAad = (id: string): string => `command-run:${id}:command:v1`;
const outputAad = (runId: string, hostId: string): string => `command-run:${runId}:host:${hostId}:output:v1`;

interface StoredRun {
  run: CommandRun;
  targets: Map<string, CommandTargetResult>;
  updatedAt: number;
}

export interface CommandRunStoreOptions {
  ownerId: string;
  database?: SqliteDatabase;
  repository?: CommandRunRepository;
  vaultService?: VaultService;
  ttlMs?: number;
  now?: () => number;
}

const cloneTarget = (target: CommandTargetResult): CommandTargetResult => ({
  ...target,
  ...(target.truncated === undefined ? {} : { truncated: target.truncated })
});

const cloneRun = (run: CommandRun, targets: Map<string, CommandTargetResult>): CommandRun => ({
  ...run,
  hostIds: [...run.hostIds],
  targets: run.hostIds.map((hostId) => cloneTarget(targets.get(hostId) as CommandTargetResult))
});

function assertSessionKey(key: Buffer | undefined): asserts key is Buffer {
  if (!key || !Buffer.isBuffer(key) || key.length !== VAULT_KEY_LENGTH) throw new AppError('VAULT_LOCKED');
}

export class CommandRunStore {
  private readonly repository?: CommandRunRepository;
  private readonly vaultService?: VaultService;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly runs = new Map<string, StoredRun>();

  constructor(private readonly options: CommandRunStoreOptions) {
    this.repository = options.repository ?? (options.database ? new CommandRunRepository(options.database, options.ownerId) : undefined);
    this.vaultService = options.vaultService;
    this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
    this.repository?.markActiveRunsInterrupted('SERVICE_RESTARTED', new Date(this.now()).toISOString());
    this.repository?.deleteExpiredFinishedRuns(new Date(this.now() - this.ttlMs).toISOString());
  }

  async create(run: CommandRun, sessionKey?: Buffer): Promise<CommandRun> {
    this.prune();
    if (this.repository) {
      assertSessionKey(sessionKey);
      if (!this.vaultService) throw new AppError('VAULT_CRYPTO_FAILED');
      const commandCiphertext = await this.encryptCommand(run.id, run.command, sessionKey);
      this.repository.createRun({
        ownerId: this.options.ownerId,
        id: run.id,
        commandCiphertext,
        hostIds: [...run.hostIds],
        status: run.status,
        persistOutput: run.persistOutput,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt ?? null
      });
      for (const target of run.targets) {
        this.repository.createTarget({
          ownerId: this.options.ownerId,
          runId: run.id,
          hostId: target.hostId,
          status: target.status,
          exitCode: target.exitCode,
          outputCiphertext: null,
          outputBytes: target.outputBytes,
          outputTruncated: target.truncated ?? false,
          errorCode: target.errorCode ?? null,
          startedAt: target.startedAt ?? null,
          finishedAt: target.finishedAt ?? null
        });
      }
    }
    const stored: StoredRun = {
      run: { ...run, hostIds: [...run.hostIds], targets: [] },
      targets: new Map(run.targets.map((target) => [target.hostId, cloneTarget(target)])),
      updatedAt: this.now()
    };
    this.runs.set(run.id, stored);
    return cloneRun(stored.run, stored.targets);
  }

  async get(id: string, sessionKey?: Buffer): Promise<CommandRun | null> {
    this.prune();
    const stored = this.runs.get(id);
    if (stored) return cloneRun(stored.run, stored.targets);
    if (!this.repository) return null;
    const row = this.repository.getRun(id);
    if (!row) return null;
    assertSessionKey(sessionKey);
    if (!this.vaultService) throw new AppError('VAULT_CRYPTO_FAILED');
    const command = await this.decryptCommand(row.id, row.commandCiphertext, sessionKey);
    const targets = new Map<string, CommandTargetResult>();
    for (const target of this.repository.listTargets(row.id)) {
      const output = row.persistOutput && target.outputCiphertext
        ? await this.decryptOutput(row.id, target.hostId, target.outputCiphertext, sessionKey)
        : '';
      targets.set(target.hostId, {
        hostId: target.hostId,
        status: target.status,
        exitCode: target.exitCode,
        output,
        outputBytes: target.outputBytes,
        ...(target.outputTruncated ? { truncated: true } : {}),
        ...(target.errorCode === null ? {} : { errorCode: target.errorCode }),
        ...(target.startedAt === null ? {} : { startedAt: target.startedAt }),
        ...(target.finishedAt === null ? {} : { finishedAt: target.finishedAt })
      });
    }
    for (const hostId of row.hostIds) {
      if (!targets.has(hostId)) targets.set(hostId, { hostId, status: 'interrupted', exitCode: null, output: '', outputBytes: 0, errorCode: 'SERVICE_RESTARTED' });
    }
    const run: CommandRun = {
      id: row.id,
      command,
      hostIds: [...row.hostIds],
      persistOutput: row.persistOutput,
      status: row.status,
      targets: [],
      createdAt: row.createdAt,
      ...(row.finishedAt === null ? {} : { finishedAt: row.finishedAt })
    };
    const restored: StoredRun = { run, targets, updatedAt: Date.parse(row.finishedAt ?? row.createdAt) || this.now() };
    this.runs.set(id, restored);
    return cloneRun(restored.run, restored.targets);
  }

  async listTargets(id: string): Promise<CommandTargetResult[]> {
    const run = await this.get(id);
    return run ? run.targets.map(cloneTarget) : [];
  }

  async updateRun(id: string, patch: Partial<Pick<CommandRun, 'status' | 'finishedAt'>>): Promise<CommandRun> {
    this.prune();
    const stored = this.runs.get(id);
    if (!stored) throw new AppError('COMMAND_RUN_NOT_FOUND');
    stored.run = { ...stored.run, ...patch };
    stored.updatedAt = this.now();
    if (this.repository) this.repository.updateRun(id, { status: patch.status, finishedAt: patch.finishedAt ?? null });
    return cloneRun(stored.run, stored.targets);
  }

  async updateTarget(id: string, hostId: string, target: CommandTargetResult, sessionKey?: Buffer): Promise<CommandRun> {
    this.prune();
    const stored = this.runs.get(id);
    if (!stored || !stored.targets.has(hostId)) throw new AppError('COMMAND_RUN_NOT_FOUND');
    stored.targets.set(hostId, cloneTarget(target));
    stored.updatedAt = this.now();
    if (this.repository) {
      const outputCiphertext = stored.run.persistOutput
        ? await this.encryptOutput(id, hostId, target.output, target.truncated ?? false, sessionKey)
        : null;
      this.repository.updateTarget(id, hostId, {
        status: target.status,
        exitCode: target.exitCode,
        outputCiphertext,
        outputBytes: target.outputBytes,
        outputTruncated: target.truncated ?? false,
        errorCode: target.errorCode ?? null,
        startedAt: target.startedAt ?? null,
        finishedAt: target.finishedAt ?? null
      });
    }
    return cloneRun(stored.run, stored.targets);
  }

  async delete(id: string): Promise<void> {
    this.runs.delete(id);
    this.repository?.deleteRun(id);
  }

  private async encryptCommand(id: string, command: string, sessionKey: Buffer): Promise<string> {
    if (!this.vaultService) throw new AppError('VAULT_CRYPTO_FAILED');
    const encrypted = await this.vaultService.encryptJson(sessionKey, commandAad(id), { command });
    return JSON.stringify(encrypted);
  }

  private async decryptCommand(id: string, ciphertext: string, sessionKey: Buffer): Promise<string> {
    if (!this.vaultService) throw new AppError('VAULT_CRYPTO_FAILED');
    let encrypted: EncryptedJson;
    try {
      encrypted = JSON.parse(ciphertext) as EncryptedJson;
    } catch {
      throw new AppError('VAULT_CRYPTO_FAILED');
    }
    const payload = await this.vaultService.decryptJson<{ command?: unknown }>(sessionKey, commandAad(id), encrypted);
    if (typeof payload.command !== 'string') throw new AppError('VAULT_CRYPTO_FAILED');
    return payload.command;
  }

  private async decryptOutput(runId: string, hostId: string, ciphertext: string, sessionKey: Buffer): Promise<string> {
    if (!this.vaultService) throw new AppError('VAULT_CRYPTO_FAILED');
    let encrypted: EncryptedJson;
    try {
      encrypted = JSON.parse(ciphertext) as EncryptedJson;
    } catch {
      throw new AppError('VAULT_CRYPTO_FAILED');
    }
    const payload = await this.vaultService.decryptJson<{ output?: unknown }>(sessionKey, outputAad(runId, hostId), encrypted);
    if (typeof payload.output !== 'string') throw new AppError('VAULT_CRYPTO_FAILED');
    return payload.output;
  }

  private async encryptOutput(id: string, hostId: string, output: string, truncated: boolean, sessionKey?: Buffer): Promise<string> {
    assertSessionKey(sessionKey);
    if (!this.vaultService) throw new AppError('VAULT_CRYPTO_FAILED');
    const encrypted = await this.vaultService.encryptJson(sessionKey, outputAad(id, hostId), { output, truncated });
    return JSON.stringify(encrypted);
  }

  private prune(): void {
    const cutoff = this.now() - this.ttlMs;
    for (const [id, stored] of this.runs) if (stored.updatedAt <= cutoff) this.runs.delete(id);
    this.repository?.deleteExpiredFinishedRuns(new Date(cutoff).toISOString());
  }
}
