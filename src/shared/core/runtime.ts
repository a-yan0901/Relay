import type { CapabilitySet } from './capabilities.js';
import type {
  ActivityStore,
  AccountSessionPort,
  CommandTransport,
  ConnectionProbe,
  DeviceTrustPort,
  FileTransport,
  GroupStore,
  HostStore,
  IdentityStore,
  ImportExportPort,
  PlatformServices,
  SecretStore,
  SessionTransport,
  SnippetStore,
  SyncPort,
  VaultRecoveryPort,
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
  /** Optional new-device recovery; Local-only runtimes do not need it. */
  vaultRecovery?: VaultRecoveryPort;
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
  /** System APIs are optional so Local-only runtimes remain fully usable. */
  platformServices?: PlatformServices;
  /** Account/sync remain optional so Local-only clients need no account service. */
  account?: AccountSessionPort;
  devices?: DeviceTrustPort;
  sync?: SyncPort;
}
