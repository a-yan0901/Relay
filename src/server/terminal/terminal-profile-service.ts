import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import { BUILTIN_TERMINAL_PROFILES, isBuiltinTerminalProfileId, resolveTerminalProfile, terminalProfileInputSchema, type TerminalProfile } from '../../shared/terminal-appearance.js';
import { HostRepository, TerminalPreferenceRepository, TerminalProfileRepository } from '../db/repositories.js';
import type { SqliteDatabase } from '../db/database.js';

export class TerminalProfileService {
  constructor(private readonly options: { database: SqliteDatabase }) {}
  private profiles(ownerId: string) { return new TerminalProfileRepository(this.options.database, ownerId); }
  private preferences(ownerId: string) { return new TerminalPreferenceRepository(this.options.database, ownerId); }
  private hosts(ownerId: string) { return new HostRepository(this.options.database, ownerId); }
  private find(ownerId: string, id: string): TerminalProfile | undefined { return BUILTIN_TERMINAL_PROFILES.find((profile) => profile.id === id) ?? this.profiles(ownerId).get(id) ?? undefined; }
  list(ownerId: string): TerminalProfile[] { return [...BUILTIN_TERMINAL_PROFILES, ...this.profiles(ownerId).list()]; }
  get(ownerId: string, id: string): TerminalProfile | null { return this.find(ownerId, id) ?? null; }
  getDefault(ownerId: string): TerminalProfile { return resolveTerminalProfile(null, this.profiles(ownerId).list(), this.preferences(ownerId).getDefaultProfileId()); }
  create(ownerId: string, input: unknown): TerminalProfile {
    const parsed=terminalProfileInputSchema.safeParse(input); if (!parsed.success) throw new AppError('HOST_VALIDATION_FAILED');
    const timestamp=new Date().toISOString(); const profile={id: randomUUID(), ...parsed.data, createdAt: timestamp, updatedAt: timestamp};
    return this.profiles(ownerId).create(profile);
  }
  setDefault(ownerId: string, id: string): TerminalProfile { const profile=this.find(ownerId,id); if(!profile) throw new AppError('NOT_FOUND'); this.preferences(ownerId).setDefaultProfileId(id); return profile; }
  delete(ownerId: string, id: string): void {
    if(isBuiltinTerminalProfileId(id) || !this.profiles(ownerId).get(id)) throw new AppError('NOT_FOUND');
    if(this.preferences(ownerId).getDefaultProfileId()===id || this.hosts(ownerId).countTerminalProfileReferences(id)>0) throw new AppError('TERMINAL_PROFILE_IN_USE');
    this.profiles(ownerId).delete(id);
  }
}
