import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import type { Snippet, SnippetMetadata } from '../../shared/core/models.js';
import {
  extractCommandVariables,
  parseSnippetInput,
  parseSnippetPatchInput,
  type SnippetInput,
} from '../../shared/validation.js';
import { SnippetRepository, type SnippetPatchRow } from '../db/repositories.js';
import type { SqliteDatabase } from '../db/database.js';
import { VAULT_KEY_LENGTH, type EncryptedJson } from '../vault/types.js';
import { VaultService } from '../vault/vault-service.js';

const payloadAad = (id: string): string => `snippet:${id}:payload:v1`;

interface SnippetPayload {
  command: string;
  variables: string[];
}

const assertSessionKey = (key: Buffer): void => {
  if (!Buffer.isBuffer(key) || key.length !== VAULT_KEY_LENGTH) throw new AppError('VAULT_LOCKED');
};

const parseEncrypted = (value: string): EncryptedJson => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('blob expected');
    const candidate = parsed as Record<string, unknown>;
    if (candidate.version !== 1 || typeof candidate.nonce !== 'string' || typeof candidate.ciphertext !== 'string' || typeof candidate.authTag !== 'string' || typeof candidate.aad !== 'string') throw new Error('invalid blob');
    return candidate as unknown as EncryptedJson;
  } catch {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const parsePayload = (value: SnippetPayload): SnippetPayload => {
  if (typeof value !== 'object' || value === null || typeof value.command !== 'string' || !Array.isArray(value.variables) || !value.variables.every((item) => typeof item === 'string')) {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
  return { command: value.command, variables: [...value.variables] };
};

const validateSnippet = <T extends SnippetInput>(input: T): T => {
  const referenced = extractCommandVariables(input.command);
  if (referenced.some((name) => !input.variables.includes(name))) throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
  return input;
};

export interface SnippetServiceOptions {
  ownerId: string;
  database?: SqliteDatabase;
  repository?: SnippetRepository;
  vaultService: VaultService;
}

export class SnippetService {
  private readonly repository: SnippetRepository;

  constructor(private readonly options: SnippetServiceOptions) {
    if (options.repository) this.repository = options.repository;
    else if (options.database) this.repository = new SnippetRepository(options.database, options.ownerId);
    else throw new Error('SnippetService requires a database or repository');
  }

  async create(input: unknown, sessionKey: Buffer): Promise<Snippet> {
    assertSessionKey(sessionKey);
    const parsed = validateSnippet(parseSnippetInput(input));
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    const encrypted = await this.options.vaultService.encryptJson(sessionKey, payloadAad(id), { command: parsed.command, variables: parsed.variables } satisfies SnippetPayload);
    const row = this.repository.create({
      ownerId: this.options.ownerId,
      id,
      name: parsed.name,
      description: parsed.description ?? null,
      tags: [...parsed.tags],
      commandCiphertext: JSON.stringify(encrypted),
      variables: [...parsed.variables],
      createdAt: timestamp,
      updatedAt: timestamp
    });
    return this.toSnippet(row, sessionKey);
  }

  async list(): Promise<SnippetMetadata[]> {
    return this.repository.list().map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description,
      tags: [...row.tags],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  async get(id: string, sessionKey: Buffer): Promise<Snippet> {
    assertSessionKey(sessionKey);
    const row = this.repository.get(id);
    if (!row) throw new AppError('SNIPPET_NOT_FOUND');
    return this.toSnippet(row, sessionKey);
  }

  async update(id: string, input: unknown, sessionKey: Buffer): Promise<Snippet> {
    assertSessionKey(sessionKey);
    const current = this.repository.get(id);
    if (!current) throw new AppError('SNIPPET_NOT_FOUND');
    const existing = await this.toSnippet(current, sessionKey);
    const patch = parseSnippetPatchInput(input);
    const parsed = validateSnippet({
      name: patch.name ?? existing.name,
      description: patch.description === undefined ? existing.description : patch.description,
      tags: patch.tags ?? [...existing.tags],
      command: patch.command ?? existing.command,
      variables: patch.variables ?? [...existing.variables]
    });
    const encrypted = await this.options.vaultService.encryptJson(sessionKey, payloadAad(id), { command: parsed.command, variables: parsed.variables } satisfies SnippetPayload);
    const rowPatch: SnippetPatchRow = {
      name: parsed.name,
      description: parsed.description ?? null,
      tags: [...parsed.tags],
      commandCiphertext: JSON.stringify(encrypted),
      variables: [...parsed.variables],
      updatedAt: new Date().toISOString()
    };
    return this.toSnippet(this.repository.update(id, rowPatch), sessionKey);
  }

  async delete(id: string): Promise<void> {
    this.repository.delete(id);
  }

  private async toSnippet(row: ReturnType<SnippetRepository['get']> extends infer T ? Exclude<T, null> : never, sessionKey: Buffer): Promise<Snippet> {
    const payload = parsePayload(await this.options.vaultService.decryptJson<SnippetPayload>(sessionKey, payloadAad(row.id), parseEncrypted(row.commandCiphertext)));
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      tags: [...row.tags],
      command: payload.command,
      variables: [...payload.variables],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }
}
