import type { CapabilitySet } from './capabilities.js';
import type {
  ActivityStore,
  CommandTransport,
  ConnectionProbe,
  FileTransport,
  GroupStore,
  HostStore,
  IdentityStore,
  ImportExportPort,
  SecretStore,
  SessionTransport,
  SnippetStore,
  VaultSessionPort,
  WorkspaceStore
} from './ports.js';
import type { ClientPlatform } from './models.js';

/** Platform-neutral application dependencies composed by one client adapter. */
export interface CoreRuntime {
  platform: ClientPlatform;
  capabilities: CapabilitySet;
  /** Negotiates the effective client/server feature intersection. */
  negotiateCapabilities(): Promise<CapabilitySet>;
  vault: VaultSessionPort;
  hosts: HostStore;
  connection: ConnectionProbe;
  identities: IdentityStore;
  groups: GroupStore;
  workspace: WorkspaceStore;
  secrets: SecretStore;
  sessions: SessionTransport;
  files: FileTransport;
  commands: CommandTransport;
  snippets: SnippetStore;
  activity: ActivityStore;
  imports: ImportExportPort;
}
