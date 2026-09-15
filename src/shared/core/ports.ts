import type {
  CommandRun,
  CommandRunRequest,
  ConnectionDiagnostic,
  ConnectionProfile,
  SftpEntry,
  TransferJob,
  TransferRequest
} from './models.js';

export interface SessionEvent {
  type: 'data' | 'stderr' | 'exit' | 'close' | 'diagnostic';
  data?: string;
  code?: number | null;
  signal?: string;
  diagnostic?: ConnectionDiagnostic;
}

export interface OpenShellRequest {
  sessionId: string;
  profile: ConnectionProfile;
  cols: number;
  rows: number;
  term?: string;
}

export interface SessionHandle {
  id: string;
  hostId: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

export interface HostStore {
  listProfiles(): Promise<readonly ConnectionProfile[]>;
  getProfile(hostId: string): Promise<ConnectionProfile | null>;
}

export interface SecretStore<Secret = unknown> {
  get(hostId: string): Promise<Secret | null>;
  set(hostId: string, secret: Secret): Promise<void>;
  remove(hostId: string): Promise<void>;
}

export interface SessionTransport {
  openShell(request: OpenShellRequest): Promise<SessionHandle>;
  reconnect(sessionId: string): Promise<SessionHandle>;
  close(sessionId: string): Promise<void>;
}

export interface FileTransport {
  list(hostId: string, path: string): Promise<readonly SftpEntry[]>;
  createTransfer(request: TransferRequest): Promise<TransferJob>;
  cancelTransfer(transferId: string): Promise<void>;
}

export interface CommandTransport {
  start(request: CommandRunRequest): Promise<CommandRun>;
  get(runId: string): Promise<CommandRun | null>;
  cancel(runId: string): Promise<void>;
}
