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
  /**
   * Negotiates client capabilities with the server/peer. Consumers must use
   * `capabilities.supports()` or `capabilities.intersection`; the client set
   * is descriptive and never grants permission by itself.
   */
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
