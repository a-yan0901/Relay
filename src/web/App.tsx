import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { AppError } from '@shared/errors';
import type { HostCreateInput, HostPatchInput, IdentityCreateInput, IdentityUpdateInput, SnippetInput } from '@shared/validation';

import { HostForm } from './components/HostForm';
import { HostWorkspace } from './components/HostWorkspace';
import { SetupGate } from './components/SetupGate';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { UnlockView } from './components/UnlockView';
import { WorkspaceSettings } from './components/WorkspaceSettings';
import { CommandRunDialog } from './components/CommandRunDialog';
import { CommandRunResults } from './components/CommandRunResults';
import { ActivityPanel } from './components/ActivityPanel';
import { IdentityManager } from './components/IdentityManager';
import { SnippetManager } from './components/SnippetManager';
import { SnippetPalette } from './components/SnippetPalette';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import type { AuditEvent, CommandRun, CommandRunRequest, IdentityMetadata, OperationDiagnostic, Snippet, SnippetMetadata, TransferJob, WorkspaceTemplate } from '../shared/core/models';
import type { CapabilitySet } from '../shared/core/capabilities';
import type { BinarySource } from '../shared/core/ports';
import type { CoreRuntime } from '../shared/core/runtime';
import type { TerminalSessionSnapshot } from './hooks/use-terminal-session';
import { useDialogFocus } from './hooks/use-dialog-focus';
import {
  appReducer,
  clearTerminalDescriptors,
  defaultWorkspaceState,
  initialAppState,
  loadTerminalDescriptors,
  saveTerminalDescriptors,
  type HostMetadataState
} from './state/app-state';
import { createFreshTerminalIds, workspaceStateFromAppState } from './state/workspace-state';
import type { WorkspaceState } from '../shared/core/models';
import {
  applyPreferences,
  fontSizeOptions,
  loadPreferences,
  savePreferences,
  themeOptions,
  type TerminalFontSize,
  type ThemeName,
  type UiPreferences
} from './theme';

const messageFromError = (error: unknown): string => (
  error instanceof AppError ? error.message : '服务暂时不可用，请稍后重试'
);

type ConnectionFeedback = {
  tone: 'success' | 'info';
  message: string;
};

interface DownloadWriter {
  write(data: Uint8Array): Promise<void> | void;
  seek?(position: number): Promise<void> | void;
  close(): Promise<void> | void;
}

interface SaveFileHandle {
  createWritable(): Promise<DownloadWriter>;
}

type FilePickerWindow = Window & {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<SaveFileHandle>;
};

const createTerminalId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `terminal-${globalThis.crypto.randomUUID()}`;
  return `terminal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const createWorkspaceTabId = (): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') return `tab-${globalThis.crypto.randomUUID()}`;
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const LoadingView = ({ errorMessage, onRetry }: { errorMessage: string | null; onRetry: () => void }) => (
  <main className="center-stage" aria-label="正在加载 Web SSH">
    <div className="loading-card">
      <span className="brand-mark" aria-hidden="true">⌁</span>
      <p className="eyebrow">SECURE WORKSPACE</p>
      <h1>{errorMessage ? '工作区暂时无法加载' : '正在准备工作区'}</h1>
      {errorMessage ? <><p className="form-error" role="alert">{errorMessage}</p><button className="button button-primary" type="button" onClick={onRetry}>重试</button></> : <span className="loading-line" aria-hidden="true" />}
    </div>
  </main>
);

const Brand = () => (
  <div className="brand-lockup">
    <span className="brand-mark" aria-hidden="true">⌁</span>
    <span>
      <strong>Relay</strong>
      <small>WEB SSH WORKSPACE</small>
    </span>
  </div>
);

const WorkspaceHeader = ({ onLock, terminalCount, onOpenTerminals, onSettings, onActivity, onIdentities, onSnippets, onWorkspaces, compact = false }: { onLock: () => void; terminalCount: number; onOpenTerminals: () => void; onSettings: () => void; onActivity?: () => void; onIdentities?: () => void; onSnippets?: () => void; onWorkspaces?: () => void; compact?: boolean }) => (
  <header className={`app-header ${compact ? 'app-header-embedded' : ''}`}>
    <Brand />
    <div className="app-header-actions">
      <span className="secure-pill"><span className="status-dot status-dot-green" />Vault 已解锁</span>
      <button className="button button-ghost button-small" type="button" onClick={onLock}>
        <span aria-hidden="true">↥</span> 锁定
      </button>
      {terminalCount > 0 && !compact && <button className="button button-ghost button-small" type="button" onClick={onOpenTerminals}>终端 <span className="header-count">{terminalCount}</span></button>}
      {onActivity && <button className="button button-ghost button-small" type="button" onClick={onActivity}>活动</button>}
      {onIdentities && <button className="button button-ghost button-small" type="button" onClick={onIdentities}>身份</button>}
      {onSnippets && <button className="button button-ghost button-small" type="button" onClick={onSnippets}>片段</button>}
      {onWorkspaces && <button className="button button-ghost button-small" type="button" onClick={onWorkspaces}>工作区</button>}
      <button className="button button-ghost button-small" type="button" aria-label="偏好设置" onClick={onSettings}>⚙<span className="settings-label">偏好</span></button>
      <span className="avatar" aria-label="本地用户">L</span>
    </div>
  </header>
);

const PreferencesPanel = ({ preferences, onChange, onClose }: { preferences: UiPreferences; onChange: (preferences: UiPreferences) => void; onClose: () => void }) => {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, true, onClose, '#theme-select');

  return (
  <div className="preferences-backdrop" role="presentation" onMouseDown={onClose}>
    <aside ref={dialogRef} className="preferences-panel" role="dialog" aria-modal="true" aria-labelledby="preferences-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="form-heading">
        <div><p className="eyebrow">WORKSPACE PREFERENCES</p><h2 id="preferences-title">偏好设置</h2></div>
        <button className="icon-button" type="button" aria-label="关闭偏好设置" onClick={onClose}>×</button>
      </div>
      <div className="preferences-fields">
        <label htmlFor="theme-select">色彩主题</label>
        <select id="theme-select" aria-label="色彩主题" value={preferences.theme} onChange={(event) => onChange({ ...preferences, theme: event.target.value as ThemeName })}>
          {themeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
        <label htmlFor="font-size-select">终端字号</label>
        <select id="font-size-select" aria-label="终端字号" value={preferences.fontSize} onChange={(event) => onChange({ ...preferences, fontSize: Number(event.target.value) as TerminalFontSize })}>
          {fontSizeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </div>
      <p className="preferences-note">偏好只保存在当前浏览器，不包含主密码、服务器密码或私钥。</p>
    </aside>
  </div>
  );
};

export interface AppProps {
  runtime: CoreRuntime;
}

export const App = ({ runtime }: AppProps) => {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<HostMetadataState | null>(null);
  const [identities, setIdentities] = useState<IdentityMetadata[]>([]);
  const [terminalView, setTerminalView] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [preferences, setPreferences] = useState<UiPreferences>(() => loadPreferences());
  const [capabilities, setCapabilities] = useState<CapabilitySet>(() => runtime.capabilities);
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [snippetManagerOpen, setSnippetManagerOpen] = useState(false);
  const [snippetPaletteOpen, setSnippetPaletteOpen] = useState(false);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [workspaceTemplates, setWorkspaceTemplates] = useState<WorkspaceTemplate[]>([]);
  const [workspaceSettingsMode, setWorkspaceSettingsMode] = useState<'import' | 'export' | null>(null);
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [commandTargetHostIds, setCommandTargetHostIds] = useState<string[]>([]);
  const [commandInitialCommand, setCommandInitialCommand] = useState('');
  const [commandInitialVariables, setCommandInitialVariables] = useState<Record<string, string>>({});
  const [commandRun, setCommandRun] = useState<CommandRun | null>(null);
  const [snippetCount, setSnippetCount] = useState(0);
  const [snippets, setSnippets] = useState<SnippetMetadata[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityEvents, setActivityEvents] = useState<AuditEvent[]>([]);
  const [operationDiagnostics, setOperationDiagnostics] = useState<OperationDiagnostic[]>([]);
  const [expiredRunIds, setExpiredRunIds] = useState<Set<string>>(new Set());
  const [transferJobs, setTransferJobs] = useState<TransferJob[]>([]);
  const transferFilesRef = useRef(new Map<string, File>());
  const downloadWritersRef = useRef(new Map<string, DownloadWriter>());
  const refreshedHostForTerminalRef = useRef(new Set<string>());
  const lockedFromCurrentAppRef = useRef(false);
  const [connectionFeedback, setConnectionFeedback] = useState<ConnectionFeedback | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const lastSavedWorkspaceRef = useRef<string | null>(null);
  const workspaceVersionRef = useRef(0);
  const workspaceSaveQueueRef = useRef(Promise.resolve());

  const enqueueWorkspaceSave = useCallback((requestWorkspace: WorkspaceState): void => {
    const requestComparable = JSON.stringify({ ...requestWorkspace, version: undefined });
    if (lastSavedWorkspaceRef.current === requestComparable) return;
    const saveTask = workspaceSaveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (lastSavedWorkspaceRef.current === requestComparable) return;
        const expectedVersion = workspaceVersionRef.current;
        const saved = await runtime.workspace.save(expectedVersion, { ...requestWorkspace, version: expectedVersion });
        workspaceVersionRef.current = saved.version;
        const latestWorkspace = workspaceStateFromAppState(latestStateRef.current);
        const latestComparable = JSON.stringify({ ...latestWorkspace, version: undefined });
        if (latestStateRef.current.phase !== 'ready' || latestComparable !== requestComparable) return;
        lastSavedWorkspaceRef.current = requestComparable;
        dispatch({ type: 'workspaceSynced', workspace: saved });
      })
      .catch((error: unknown) => {
        if (latestStateRef.current.phase === 'ready') dispatch({ type: 'error', message: messageFromError(error) });
      });
    workspaceSaveQueueRef.current = saveTask.then(() => undefined, () => undefined);
  }, [runtime]);

  useEffect(() => {
    applyPreferences(preferences);
    savePreferences(preferences);
  }, [preferences]);

  const loadWorkspace = useCallback(async (options: { openTerminalView?: boolean } = {}): Promise<void> => {
    try {
      const negotiatedCapabilities = await runtime.negotiateCapabilities().catch(() => runtime.capabilities);
      setCapabilities(negotiatedCapabilities);
      const [hosts, groups, loadedIdentities] = await Promise.all([
        runtime.hosts.list(),
        runtime.groups.list(),
        runtime.identities.list().catch(() => [] as readonly IdentityMetadata[])
      ]);
      let workspace: WorkspaceState;
      try {
        workspace = await runtime.workspace.load();
      } catch {
        workspace = defaultWorkspaceState;
      }
      dispatch({ type: 'hostsLoaded', hosts: [...hosts] });
      dispatch({ type: 'groupsLoaded', groups: [...groups].map((group) => ({ ...group })) });
      setIdentities([...loadedIdentities]);
      void runtime.workspace.listTemplates().then((templates) => setWorkspaceTemplates([...templates])).catch(() => setWorkspaceTemplates([]));
      void runtime.files.listTransfers().then((jobs) => setTransferJobs([...jobs])).catch(() => setTransferJobs([]));
      const availableHostIds = new Set(hosts.map((host) => host.id));
      const descriptors = loadTerminalDescriptors().filter((descriptor) => availableHostIds.has(descriptor.hostId));
      const descriptorByTabId = new Map(descriptors.map((descriptor) => [descriptor.workspaceTabId ?? `tab-${descriptor.terminalId}`, descriptor.terminalId]));
      const terminalIds = createFreshTerminalIds(workspace, availableHostIds, () => createTerminalId());
      for (const tab of workspace.tabs) {
        const previousTerminalId = descriptorByTabId.get(tab.id);
        if (previousTerminalId && availableHostIds.has(tab.hostId)) terminalIds[tab.id] = previousTerminalId;
      }
      saveTerminalDescriptors(workspace.tabs.flatMap((tab) => {
        const terminalId = terminalIds[tab.id];
        return terminalId ? [{ terminalId, hostId: tab.hostId, workspaceTabId: tab.id }] : [];
      }));
      dispatch({ type: 'workspaceLoaded', workspace, terminalIds });
      if ((options.openTerminalView ?? true) && workspace.tabs.some((tab) => terminalIds[tab.id])) setTerminalView(true);
      workspaceVersionRef.current = workspace.version;
      lastSavedWorkspaceRef.current = JSON.stringify({ ...workspace, version: undefined });
      setWorkspaceHydrated(true);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  }, [enqueueWorkspaceSave, runtime]);

  useEffect(() => {
    if (!workspaceHydrated || state.phase !== 'ready') return;
    const workspace = workspaceStateFromAppState(state);
    const comparable = JSON.stringify({ ...workspace, version: undefined });
    if (lastSavedWorkspaceRef.current === comparable) return;
    const timer = window.setTimeout(() => {
      const requestWorkspace = workspaceStateFromAppState(latestStateRef.current);
      enqueueWorkspaceSave(requestWorkspace);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [state, workspaceHydrated, enqueueWorkspaceSave]);

  useEffect(() => {
    let cancelled = false;
    void runtime.vault.status()
      .then((status) => {
        if (cancelled) return;
        dispatch({ type: 'setup', initialized: status.phase !== 'uninitialized', locked: status.phase !== 'unlocked' });
        if (status.phase === 'unlocked') {
          void loadWorkspace();
        } else if (status.phase === 'uninitialized') {
          clearTerminalDescriptors();
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) dispatch({ type: 'error', message: messageFromError(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [bootAttempt, loadWorkspace]);

  useEffect(() => {
    if (!workspaceHydrated || state.phase !== 'ready') return;
    saveTerminalDescriptors(state.terminals.map(({ terminalId, hostId }) => ({ terminalId, hostId, workspaceTabId: state.workspaceTabIdByTerminalId[terminalId] })));
  }, [state.phase, state.terminals, workspaceHydrated]);

  const retryBoot = (): void => {
    dispatch({ type: 'error', message: null });
    setBootAttempt((attempt) => attempt + 1);
  };

  const completeSetup = async (masterPassword: string): Promise<void> => {
    try {
      await runtime.vault.setup(masterPassword);
      dispatch({ type: 'setup', initialized: true, locked: false });
      await loadWorkspace();
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const completeUnlock = async (masterPassword: string): Promise<void> => {
    try {
      await runtime.vault.unlock(masterPassword);
      dispatch({ type: 'unlock' });
      const openTerminalView = !lockedFromCurrentAppRef.current;
      lockedFromCurrentAppRef.current = false;
      await loadWorkspace({ openTerminalView });
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleCreateHost = async (input: HostCreateInput): Promise<void> => {
    try {
      const host = await runtime.hosts.create(input);
      dispatch({ type: 'hostCreated', host });
      setHostFormOpen(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleCreateIdentity = async (input: IdentityCreateInput): Promise<void> => {
    try {
      const created = await runtime.identities.create(input);
      setIdentities((current) => [...current, created].sort((left, right) => left.name.localeCompare(right.name)));
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleUpdateIdentity = async (id: string, input: IdentityUpdateInput): Promise<void> => {
    try {
      const updated = await runtime.identities.update(id, input);
      setIdentities((current) => current.map((identity) => identity.id === id ? updated : identity));
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleDeleteIdentity = async (id: string): Promise<void> => {
    try {
      await runtime.identities.delete(id);
      setIdentities((current) => current.filter((identity) => identity.id !== id));
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleUpdateHost = async (input: HostPatchInput): Promise<void> => {
    if (!editingHost) return;
    try {
      const host = await runtime.hosts.update(editingHost.id, input);
      dispatch({ type: 'hostUpdated', host });
      setEditingHost(null);
      setHostFormOpen(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleFavoriteToggle = async (host: HostMetadataState): Promise<void> => {
    const nextFavorite = !host.isFavorite;
    dispatch({ type: 'favoriteOptimistic', hostId: host.id, isFavorite: nextFavorite });
    try {
      const updated = await runtime.hosts.update(host.id, { isFavorite: nextFavorite });
      dispatch({ type: 'hostUpdated', host: updated });
      dispatch({ type: 'favoriteCommitted', hostId: host.id });
    } catch (error) {
      dispatch({ type: 'favoriteRollback', hostId: host.id });
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  const handleOpenTerminal = (host: HostMetadataState): void => {
    const action = { type: 'terminalOpened' as const, terminalId: createTerminalId(), workspaceTabId: createWorkspaceTabId(), hostId: host.id };
    const projectedState = appReducer(latestStateRef.current, action);
    dispatch(action);
    enqueueWorkspaceSave(workspaceStateFromAppState(projectedState));
    setTerminalView(true);
  };

  const loadSnippets = async (): Promise<readonly SnippetMetadata[]> => {
    try {
      const loaded = await runtime.snippets.list();
      setSnippets([...loaded]);
      setSnippetCount(loaded.length);
      return loaded;
    } catch {
      setSnippets([]);
      setSnippetCount(0);
      return [];
    }
  };

  const handleOpenSnippetManager = (): void => {
    setSnippetManagerOpen(true);
    void loadSnippets();
  };

  const handleOpenSnippetPalette = (): void => {
    setSnippetPaletteOpen(true);
    void loadSnippets();
  };

  const handleOpenWorkspaceSwitcher = (): void => {
    setWorkspaceSwitcherOpen(true);
    void runtime.workspace.listTemplates().then((templates) => setWorkspaceTemplates([...templates])).catch(() => setWorkspaceTemplates([]));
  };

  const handleSaveWorkspaceTemplate = async (name: string): Promise<void> => {
    const template = await runtime.workspace.createTemplate({ name, state: workspaceStateFromAppState(latestStateRef.current) });
    setWorkspaceTemplates((current) => [template, ...current.filter((candidate) => candidate.id !== template.id)]);
  };

  const handleDeleteWorkspaceTemplate = async (id: string): Promise<void> => {
    await runtime.workspace.deleteTemplate(id);
    setWorkspaceTemplates((current) => current.filter((template) => template.id !== id));
  };

  const handleOpenWorkspaceTemplate = (template: WorkspaceTemplate): void => {
    const availableHostIds = new Set(latestStateRef.current.hosts.map((host) => host.id));
    const terminalIds = createFreshTerminalIds(template.state, availableHostIds, () => createTerminalId());
    dispatch({ type: 'workspaceLoaded', workspace: template.state, terminalIds });
    const nextWorkspace: WorkspaceState = { ...template.state, version: workspaceVersionRef.current };
    enqueueWorkspaceSave(nextWorkspace);
    setWorkspaceSwitcherOpen(false);
    setTerminalView(Object.keys(terminalIds).length > 0);
  };

  const handleOpenBatchCommand = (hostIds: readonly string[] = state.terminals.map((terminal) => terminal.hostId)): void => {
    const uniqueHostIds = [...new Set(hostIds)];
    if (uniqueHostIds.length === 0) return;
    setCommandInitialCommand('');
    setCommandInitialVariables({});
    setCommandTargetHostIds(uniqueHostIds);
    setCommandDialogOpen(true);
    void loadSnippets();
  };

  const handleSelectSnippetFromPalette = (id: string): void => {
    void runtime.snippets.get(id).then((snippet) => {
      if (!snippet) throw new AppError('SNIPPET_NOT_FOUND');
      setSnippetPaletteOpen(false);
      setWorkspaceSwitcherOpen(false);
      setCommandInitialCommand(snippet.command);
      setCommandInitialVariables(Object.fromEntries(snippet.variables.map((name) => [name, ''])));
      setCommandTargetHostIds([...new Set(state.terminals.map((terminal) => terminal.hostId))]);
      setCommandDialogOpen(true);
    }).catch((error: unknown) => dispatch({ type: 'error', message: messageFromError(error) }));
  };

  const handleCreateSnippet = async (input: SnippetInput): Promise<void> => {
    const created = await runtime.snippets.create(input);
    setSnippets((current) => [...current, {
      id: created.id,
      name: created.name,
      description: created.description,
      tags: [...created.tags],
      createdAt: created.createdAt,
      updatedAt: created.updatedAt
    }].sort((left, right) => left.name.localeCompare(right.name)));
    setSnippetCount((count) => count + 1);
  };

  const handleUpdateSnippet = async (id: string, input: SnippetInput): Promise<void> => {
    const updated = await runtime.snippets.update(id, input);
    setSnippets((current) => current.map((snippet) => snippet.id === id ? {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      tags: [...updated.tags],
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt
    } : snippet).sort((left, right) => left.name.localeCompare(right.name)));
  };

  const handleDeleteSnippet = async (id: string): Promise<void> => {
    await runtime.snippets.delete(id);
    setSnippets((current) => current.filter((snippet) => snippet.id !== id));
    setSnippetCount((count) => Math.max(0, count - 1));
  };

  const updateTransferJob = (job: TransferJob): void => {
    setTransferJobs((current) => current.some((candidate) => candidate.id === job.id)
      ? current.map((candidate) => candidate.id === job.id ? job : candidate)
      : [...current, job]);
  };

  const refreshTransferJob = async (id: string): Promise<TransferJob | null> => {
    try {
      const job = await runtime.files.getTransfer(id);
      if (!job) return null;
      updateTransferJob(job);
      return job;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    const activeJobs = transferJobs.filter((job) => job.status === 'queued' || job.status === 'running');
    if (activeJobs.length === 0) return;
    const timer = window.setTimeout(() => {
      void Promise.all(activeJobs.map((job) => refreshTransferJob(job.id)));
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [transferJobs]);

  const fileToBinarySource = (file: File): BinarySource => ({
    name: file.name,
    size: file.size,
    async *stream() {
      const reader = file.stream().getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) return;
          yield next.value;
        }
      } finally {
        reader.releaseLock();
      }
    }
  });

  const triggerNativeDownload = (transferId: string, name: string): void => {
    const anchor = document.createElement('a');
    anchor.href = `/api/transfers/${encodeURIComponent(transferId)}/content?offset=0`;
    anchor.download = name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  };

  const openDownloadWriter = async (name: string): Promise<DownloadWriter | null> => {
    const picker = (window as FilePickerWindow).showSaveFilePicker;
    if (!picker) return null;
    try {
      return await (await picker({ suggestedName: name })).createWritable();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotAllowedError') return null;
      throw error;
    }
  };

  const saveDownloadStream = async (transferId: string, stream: AsyncIterable<Uint8Array>, name: string, offset: number, preparedWriter?: DownloadWriter | null): Promise<void> => {
    let writer: DownloadWriter | null | undefined = preparedWriter ?? downloadWritersRef.current.get(transferId);
    if (!writer) {
      writer = await openDownloadWriter(name);
      if (!writer) throw new AppError('CAPABILITY_UNAVAILABLE', '当前浏览器不支持流式保存，请使用原生下载');
      downloadWritersRef.current.set(transferId, writer);
    } else {
      downloadWritersRef.current.set(transferId, writer);
    }
    if (offset > 0) {
      if (!writer.seek) throw new AppError('CAPABILITY_UNAVAILABLE', '当前浏览器不支持断点写入，请重新选择下载位置');
      await writer.seek(offset);
    }
    for await (const chunk of stream) await writer.write(chunk);
    await writer.close();
    downloadWritersRef.current.delete(transferId);
  };

  const resumeRequestForJob = (job: TransferJob) => {
    const checkpoint = job.checkpoint;
    return checkpoint && checkpoint.offset > 0
      ? { transferId: job.id, expectedOffset: checkpoint.offset, checksum: checkpoint.checksum }
      : undefined;
  };

  const handleUploadSftp = async (hostId: string, file: File, path: string): Promise<void> => {
    const targetPath = path === '/' ? `/${file.name}` : `${path}/${file.name}`;
    const job = await runtime.files.createTransfer({ kind: 'upload', hostId, sourcePath: file.name, targetPath, totalBytes: file.size });
    transferFilesRef.current.set(job.id, file);
    updateTransferJob(job);
    try {
      updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
      updateTransferJob(await runtime.files.upload(job.id, fileToBinarySource(file)));
    } catch (error) {
      await refreshTransferJob(job.id);
      throw error;
    }
  };

  const handleDownloadSftp = async (hostId: string, sourcePath: string, name: string): Promise<void> => {
    const writer = await openDownloadWriter(name);
    const job = await runtime.files.createTransfer({ kind: 'download', hostId, sourcePath, targetPath: name });
    updateTransferJob(job);
    try {
      updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
      if (!writer) {
        triggerNativeDownload(job.id, name);
        return;
      }
      await saveDownloadStream(job.id, await runtime.files.download(job.id), name, 0, writer);
      await refreshTransferJob(job.id);
    } catch (error) {
      await refreshTransferJob(job.id);
      throw error;
    }
  };

  const handleCancelTransfer = (id: string): void => {
    const job = transferJobs.find((candidate) => candidate.id === id);
    if (job) updateTransferJob({ ...job, status: 'cancelled', updatedAt: new Date().toISOString() });
    void runtime.files.cancelTransfer(id).then(() => refreshTransferJob(id));
  };

  const handleRetryTransfer = (id: string): void => {
    const currentJob = transferJobs.find((candidate) => candidate.id === id);
    const preparedWriter = currentJob?.kind === 'download' && !downloadWritersRef.current.has(id)
      ? openDownloadWriter(currentJob.targetPath)
      : Promise.resolve(downloadWritersRef.current.get(id) ?? null);
    void preparedWriter.then((writer) => runtime.files.retryTransfer(id).then((job) => {
      updateTransferJob(job);
      if (job.kind === 'upload') {
        const file = transferFilesRef.current.get(id);
        if (!file) return;
        updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
        void runtime.files.upload(id, fileToBinarySource(file), resumeRequestForJob(job)).then(updateTransferJob).catch(() => refreshTransferJob(id));
        return;
      }
      if (!writer) {
        triggerNativeDownload(id, job.targetPath);
        return;
      }
      updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
      void runtime.files.download(id, resumeRequestForJob(job)).then((stream) => saveDownloadStream(id, stream, job.targetPath, job.checkpoint?.offset ?? 0, writer)).then(() => {
        return refreshTransferJob(id);
      }).catch(() => refreshTransferJob(id));
    })).catch(() => undefined);
  };

  const handleOpenActivity = (): void => {
    setActivityOpen(true);
    void runtime.activity.list({ limit: 50 }).then((events) => setActivityEvents([...events])).catch(() => setActivityEvents([]));
  };

  const handleOpenRunFromActivity = (runId: string): void => {
    setActivityOpen(false);
    void runtime.commands.get(runId).then((run) => {
      if (!run) throw new AppError('COMMAND_RUN_NOT_FOUND');
      setExpiredRunIds((current) => {
        const next = new Set(current);
        next.delete(runId);
        return next;
      });
      setCommandRun(run);
    }).catch(() => {
      setExpiredRunIds((current) => new Set(current).add(runId));
    });
  };

  const handleStartCommandRun = async (request: CommandRunRequest): Promise<void> => {
    try {
      const run = await runtime.commands.start(request);
      setCommandRun(run);
      setCommandDialogOpen(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleCancelCommandRun = (): void => {
    if (!commandRun) return;
    void runtime.commands.cancel(commandRun.id).then(() => refreshCommandRun(commandRun.id)).catch(() => undefined);
  };

  const refreshCommandRun = async (id: string): Promise<void> => {
    try {
      setCommandRun(await runtime.commands.get(id));
    } catch {
      setCommandRun(null);
    }
  };

  useEffect(() => {
    if (!commandRun || !['queued', 'running'].includes(commandRun.status)) return;
    const timer = window.setTimeout(() => {
      void runtime.commands.get(commandRun.id).then(setCommandRun).catch(() => undefined);
    }, 750);
    return () => window.clearTimeout(timer);
  }, [commandRun]);

  const handleDeleteHost = async (host: HostMetadataState): Promise<void> => {
    if (!window.confirm(`确定删除 Server「${host.name}」吗？`)) return;
    try {
      await runtime.hosts.delete(host.id);
      const remainingTerminals = state.terminals.filter((terminal) => terminal.hostId !== host.id);
      dispatch({ type: 'hostDeleted', hostId: host.id });
      saveTerminalDescriptors(remainingTerminals.map(({ terminalId, hostId }) => ({ terminalId, hostId, workspaceTabId: state.workspaceTabIdByTerminalId[terminalId] })));
      if (state.terminals.length > 0 && remainingTerminals.length === 0) setTerminalView(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  const handleTestConnection = async (host: HostMetadataState): Promise<void> => {
    setConnectionFeedback(null);
    try {
      const result = await runtime.connection.test(host.id);
      if (result.ok) {
        dispatch({ type: 'error', message: null });
        setConnectionFeedback({ tone: 'success', message: `连接测试成功：${host.name}` });
      } else if (result.hostKey) {
        dispatch({ type: 'error', message: null });
        setConnectionFeedback({ tone: 'info', message: `需要确认远程主机指纹：${result.hostKey.fingerprint}` });
      } else {
        dispatch({ type: 'error', message: `无法连接：${host.name}` });
      }
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  const openCreateHost = (): void => {
    setEditingHost(null);
    setHostFormOpen(true);
  };

  const openEditHost = (host: HostMetadataState): void => {
    setEditingHost(host);
    setHostFormOpen(true);
  };

  const closeHostForm = (): void => {
    setEditingHost(null);
    setHostFormOpen(false);
  };

  useDialogFocus(drawerRef, hostFormOpen, closeHostForm, '#host-name');

  const handleCloseTerminal = (terminalId: string): void => {
    dispatch({ type: 'terminalClosed', terminalId });
    saveTerminalDescriptors(loadTerminalDescriptors().filter((descriptor) => descriptor.terminalId !== terminalId));
    if (state.terminals.length <= 1) setTerminalView(false);
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent): void => {
      const target = event.target;
      if (!(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === 'p') {
        event.preventDefault();
        if (terminalView) handleOpenSnippetPalette();
        else handleOpenSnippetManager();
        return;
      }
      const isTerminalInput = target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea');
      const isTextEntry = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
      if (isTextEntry && !(isTerminalInput && (key === 'k' || key === 'w'))) return;
      if (key === 'k') {
        event.preventDefault();
        if (terminalView) {
          const terminalSearch = document.getElementById('terminal-host-search');
          if (terminalSearch) terminalSearch.focus();
          else document.getElementById('terminal-new-terminal')?.click();
        } else {
          document.getElementById('host-search')?.focus();
        }
      } else if (key === 'w' && terminalView && state.activeTerminalId) {
        event.preventDefault();
        handleCloseTerminal(state.activeTerminalId);
      }
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [state.activeTerminalId, terminalView]);

  const handleTerminalStatus = (terminalId: string, snapshot: TerminalSessionSnapshot): void => {
    dispatch({
      type: 'terminalStatusUpdated',
      terminalId,
      state: snapshot.state,
      reconnectDelayMs: snapshot.reconnectDelayMs,
      errorMessage: snapshot.error?.message ?? null
    });
    if (snapshot.diagnostics.length > 0) {
      setOperationDiagnostics((current) => {
        const next = new Map(current.map((diagnostic) => [`${diagnostic.operationId}:${diagnostic.hostId}`, diagnostic]));
        for (const diagnostic of snapshot.diagnostics) next.set(`${diagnostic.operationId}:${diagnostic.hostId}`, diagnostic);
        return [...next.values()].slice(-200);
      });
    }
    if (snapshot.state !== 'connected') {
      refreshedHostForTerminalRef.current.delete(terminalId);
      return;
    }
    if (refreshedHostForTerminalRef.current.has(terminalId)) return;
    refreshedHostForTerminalRef.current.add(terminalId);
    void runtime.hosts.list()
      .then((hosts) => dispatch({ type: 'hostsLoaded', hosts: [...hosts] }))
      .catch(() => {
        refreshedHostForTerminalRef.current.delete(terminalId);
      });
  };

  const handleLock = async (): Promise<void> => {
    try {
      await runtime.vault.lock();
      lockedFromCurrentAppRef.current = true;
      dispatch({ type: 'lock' });
      clearTerminalDescriptors();
      setTerminalView(false);
      closeHostForm();
      setActivityOpen(false);
      setSnippetManagerOpen(false);
      setSnippetPaletteOpen(false);
      setCommandRun(null);
      setTransferJobs([]);
      transferFilesRef.current.clear();
      downloadWritersRef.current.clear();
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  if (state.phase === 'loading') return <LoadingView errorMessage={state.errorMessage} onRetry={retryBoot} />;
  if (state.phase === 'setup') return <SetupGate onSubmit={completeSetup} errorMessage={state.errorMessage} />;
  if (state.phase === 'locked') return <UnlockView onSubmit={completeUnlock} errorMessage={state.errorMessage} />;

  return (
    <main className="app-shell">
      {!terminalView && <WorkspaceHeader onLock={() => void handleLock()} terminalCount={state.terminals.length} onOpenTerminals={() => setTerminalView(true)} onSettings={() => setPreferencesOpen(true)} onActivity={capabilities.supports('audit.activity') ? handleOpenActivity : undefined} onIdentities={capabilities.supports('vault.identities') ? () => setIdentityOpen(true) : undefined} onSnippets={capabilities.supports('automation.snippet-manager') ? handleOpenSnippetManager : undefined} onWorkspaces={capabilities.supports('workspace.templates') ? handleOpenWorkspaceSwitcher : undefined} />}
      {state.errorMessage && (
        <div className="global-alert" role="alert">
          <span>{state.errorMessage}</span>
          <button className="icon-button" type="button" aria-label="关闭提示" onClick={() => dispatch({ type: 'error', message: null })}>×</button>
        </div>
      )}
      {connectionFeedback && (
        <div className={`global-feedback global-feedback-${connectionFeedback.tone}`} role="status" aria-live="polite">
          <span>{connectionFeedback.message}</span>
          <button className="icon-button" type="button" aria-label="关闭提示" onClick={() => setConnectionFeedback(null)}>×</button>
        </div>
      )}
      <div className={`app-body ${terminalView ? 'app-body-terminal' : ''}`}>
        <div className="app-view" hidden={terminalView} aria-hidden={terminalView}>
          <HostWorkspace
            hosts={state.hosts}
            groups={state.groups}
            query={state.query}
            selectedGroupId={state.selectedGroupId}
            favoriteOnly={state.favoriteOnly}
            onQueryChange={(query) => dispatch({ type: 'queryChanged', query })}
            onGroupSelected={(groupId) => dispatch({ type: 'groupSelected', groupId })}
            onFavoriteFilter={(favoriteOnly) => dispatch({ type: 'favoriteFilterChanged', favoriteOnly })}
            onFavoriteToggle={(host) => void handleFavoriteToggle(host)}
            onConnect={handleOpenTerminal}
            onAddHost={openCreateHost}
            onBatchCommand={capabilities.supports('automation.batch-exec') ? handleOpenBatchCommand : undefined}
            onImport={capabilities.supports('vault.bundle') ? () => setWorkspaceSettingsMode('import') : undefined}
            onExport={capabilities.supports('vault.bundle') ? () => setWorkspaceSettingsMode('export') : undefined}
            onEdit={openEditHost}
            onDelete={(host) => void handleDeleteHost(host)}
            onTestConnection={(host) => void handleTestConnection(host)}
          />
        </div>
        <div className="app-view app-view-terminal" hidden={!terminalView} aria-hidden={!terminalView}>
          <TerminalWorkspace
            hosts={state.hosts}
            terminals={state.terminals}
            activeTerminalId={state.activeTerminalId}
            onActivate={(terminalId) => dispatch({ type: 'terminalActivated', terminalId })}
            onClose={handleCloseTerminal}
            onEditHost={openEditHost}
            onConnectHost={handleOpenTerminal}
            onStatusChange={handleTerminalStatus}
            onOpenBatchCommand={capabilities.supports('automation.batch-exec') ? () => handleOpenBatchCommand() : undefined}
            onOpenSnippetPalette={capabilities.supports('automation.snippets') ? handleOpenSnippetPalette : undefined}
            onListSftp={capabilities.supports('sftp.browse') ? (hostId, path) => runtime.files.list(hostId, path) : undefined}
            onCreateDirectorySftp={capabilities.supports('sftp.entry-mutations') ? (hostId, path) => runtime.files.createDirectory(hostId, path) : undefined}
            onRenameSftp={capabilities.supports('sftp.entry-mutations') ? (hostId, from, to) => runtime.files.rename(hostId, from, to) : undefined}
            onDeleteSftp={capabilities.supports('sftp.entry-mutations') ? (hostId, path) => runtime.files.remove(hostId, path) : undefined}
            onUploadSftp={capabilities.supports('sftp.transfer') ? handleUploadSftp : undefined}
            onDownloadSftp={capabilities.supports('sftp.transfer') ? handleDownloadSftp : undefined}
            transferJobs={capabilities.supports('sftp.transfer') ? transferJobs : []}
            onCancelTransfer={capabilities.supports('sftp.transfer') ? handleCancelTransfer : undefined}
            onRetryTransfer={capabilities.supports('sftp.transfer') ? handleRetryTransfer : undefined}
            allowMultiPane={capabilities.supports('workspace.multi-pane')}
            workspaceLayout={state.workspace.layout}
            workspaceTabIdByTerminalId={state.workspaceTabIdByTerminalId}
            onLayoutChange={(layout) => dispatch({ type: 'workspaceLayoutChanged', layout })}
            preferences={preferences}
            visible={terminalView}
            onBackToHosts={() => setTerminalView(false)}
            workspaceHeader={<WorkspaceHeader compact onLock={() => void handleLock()} terminalCount={state.terminals.length} onOpenTerminals={() => setTerminalView(true)} onSettings={() => setPreferencesOpen(true)} onActivity={capabilities.supports('audit.activity') ? handleOpenActivity : undefined} onIdentities={capabilities.supports('vault.identities') ? () => setIdentityOpen(true) : undefined} onSnippets={capabilities.supports('automation.snippet-manager') ? handleOpenSnippetManager : undefined} onWorkspaces={capabilities.supports('workspace.templates') ? handleOpenWorkspaceSwitcher : undefined} />}
          />
        </div>
      </div>
      {hostFormOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeHostForm(); }}>
          <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="host-form-title" onMouseDown={(event) => event.stopPropagation()}>
            {editingHost ? <HostForm mode="edit" initialHost={editingHost} groups={state.groups} hosts={state.hosts} identities={identities} onEditSubmit={handleUpdateHost} onCancel={closeHostForm} /> : <HostForm groups={state.groups} hosts={state.hosts} identities={identities} onSubmit={handleCreateHost} onCancel={closeHostForm} />}
          </aside>
        </div>
      )}
      {preferencesOpen && <PreferencesPanel preferences={preferences} onChange={setPreferences} onClose={() => setPreferencesOpen(false)} />}
      {identityOpen && capabilities.supports('vault.identities') && <IdentityManager identities={identities} onCreate={handleCreateIdentity} onUpdate={handleUpdateIdentity} onDelete={async (id) => { if (window.confirm('确定删除这个身份吗？')) await handleDeleteIdentity(id); }} onClose={() => setIdentityOpen(false)} />}
      {snippetManagerOpen && capabilities.supports('automation.snippet-manager') && <SnippetManager snippets={snippets} onGet={(id) => runtime.snippets.get(id)} onCreate={handleCreateSnippet} onUpdate={handleUpdateSnippet} onDelete={handleDeleteSnippet} onClose={() => setSnippetManagerOpen(false)} />}
      {snippetPaletteOpen && capabilities.supports('automation.snippets') && <SnippetPalette snippets={snippets} onSelect={handleSelectSnippetFromPalette} onClose={() => setSnippetPaletteOpen(false)} />}
      {workspaceSwitcherOpen && capabilities.supports('workspace.templates') && <WorkspaceSwitcher templates={workspaceTemplates} currentWorkspace={workspaceStateFromAppState(state)} hosts={state.hosts} onOpen={handleOpenWorkspaceTemplate} onSave={handleSaveWorkspaceTemplate} onDelete={handleDeleteWorkspaceTemplate} onClose={() => setWorkspaceSwitcherOpen(false)} />}
      {commandDialogOpen && <CommandRunDialog
        hosts={state.hosts}
        hostIds={commandTargetHostIds}
        initialCommand={commandInitialCommand}
        initialVariables={commandInitialVariables}
        groups={state.groups.map((group) => ({
          id: group.id,
          name: group.name,
          parentId: group.parentId ?? null,
          sortOrder: group.sortOrder,
          defaultIdentityId: group.defaultIdentityId ?? null,
          connectionProfile: group.connectionProfile ?? null
        }))}
        snippets={snippets}
        onSnippetSelect={(id): Promise<Snippet> => runtime.snippets.get(id).then((snippet) => {
          if (!snippet) throw new AppError('SNIPPET_NOT_FOUND');
          return snippet;
        })}
        onClose={() => setCommandDialogOpen(false)}
        onConfirm={handleStartCommandRun}
      />}
      {commandRun && <div className="modal-backdrop" role="presentation"><section className="command-run-result-modal" role="dialog" aria-modal="true" aria-labelledby="command-run-result-title"><CommandRunResults run={commandRun} hosts={state.hosts} onCancel={handleCancelCommandRun} /><button className="button button-ghost" id="command-run-result-title" type="button" onClick={() => setCommandRun(null)}>关闭结果</button></section></div>}
      {activityOpen && <div className="modal-backdrop" role="presentation"><section className="command-run-result-modal activity-modal" role="dialog" aria-modal="true" aria-label="最近活动"><ActivityPanel events={activityEvents} diagnostics={operationDiagnostics} expiredRunIds={expiredRunIds} onOpenRun={handleOpenRunFromActivity} /><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setActivityOpen(false)}>关闭</button></div></section></div>}
      {workspaceSettingsMode && <WorkspaceSettings
        mode={workspaceSettingsMode}
        onClose={() => setWorkspaceSettingsMode(null)}
        onExport={runtime.imports.exportVaultBundle}
        onPreviewImport={runtime.imports.previewVaultImport}
        onPreviewExternalImport={runtime.imports.previewExternalImport}
        onApplyImport={async (previewId, resolution) => {
          const result = await runtime.imports.applyVaultImport(previewId, resolution);
          const [hosts, groups, workspace] = await Promise.all([runtime.hosts.list(), runtime.groups.list(), runtime.workspace.load()]);
          dispatch({ type: 'hostsLoaded', hosts: [...hosts] });
          dispatch({ type: 'groupsLoaded', groups: [...groups].map((group) => ({ ...group })) });
          dispatch({ type: 'workspaceLoaded', workspace, terminalIds: createFreshTerminalIds(workspace, new Set(hosts.map((host) => host.id)), () => createTerminalId()) });
          return result;
        }}
        onApplyExternalImport={async (previewId, input) => {
          const result = await runtime.imports.applyExternalImport(previewId, input);
          const [hosts, groups, workspace] = await Promise.all([runtime.hosts.list(), runtime.groups.list(), runtime.workspace.load()]);
          dispatch({ type: 'hostsLoaded', hosts: [...hosts] });
          dispatch({ type: 'groupsLoaded', groups: [...groups].map((group) => ({ ...group })) });
          dispatch({ type: 'workspaceLoaded', workspace, terminalIds: createFreshTerminalIds(workspace, new Set(hosts.map((host) => host.id)), () => createTerminalId()) });
          return result;
        }}
      />}
      <div className="app-watermark" aria-hidden="true">LOCAL-FIRST · ENCRYPTED BY DEFAULT{snippetCount > 0 ? ` · ${snippetCount} 个片段` : ''}</div>
    </main>
  );
};
