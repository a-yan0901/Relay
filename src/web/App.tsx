import { useCallback, useEffect, useReducer, useRef, useState } from 'react';

import { AppError } from '@shared/errors';
import type { HostCreateInput, HostPatchInput } from '@shared/validation';

import {
  createHost,
  deleteHost,
  getSetupStatus,
  listGroups,
  listHosts,
  lockVault,
  setupVault,
  testConnection,
  unlockVault,
  updateHost
} from './api';
import * as webApi from './api';
import { HostForm } from './components/HostForm';
import { HostWorkspace } from './components/HostWorkspace';
import { SetupGate } from './components/SetupGate';
import { TerminalWorkspace } from './components/TerminalWorkspace';
import { UnlockView } from './components/UnlockView';
import { WorkspaceSettings } from './components/WorkspaceSettings';
import { CommandRunDialog } from './components/CommandRunDialog';
import { CommandRunResults } from './components/CommandRunResults';
import { ActivityPanel } from './components/ActivityPanel';
import type { AuditEvent, CommandRun, CommandRunRequest, Snippet, SnippetMetadata, TransferJob } from '../shared/core/models';
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
import { webWorkspaceAdapter } from './platform/web-adapters';
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

const WorkspaceHeader = ({ onLock, terminalCount, onOpenTerminals, onSettings, onActivity, compact = false }: { onLock: () => void; terminalCount: number; onOpenTerminals: () => void; onSettings: () => void; onActivity?: () => void; compact?: boolean }) => (
  <header className={`app-header ${compact ? 'app-header-embedded' : ''}`}>
    <Brand />
    <div className="app-header-actions">
      <span className="secure-pill"><span className="status-dot status-dot-green" />Vault 已解锁</span>
      <button className="button button-ghost button-small" type="button" onClick={onLock}>
        <span aria-hidden="true">↥</span> 锁定
      </button>
      {terminalCount > 0 && !compact && <button className="button button-ghost button-small" type="button" onClick={onOpenTerminals}>终端 <span className="header-count">{terminalCount}</span></button>}
      {onActivity && <button className="button button-ghost button-small" type="button" onClick={onActivity}>活动</button>}
      <button className="button button-ghost button-small" type="button" aria-label="偏好设置" onClick={onSettings}>⚙<span className="settings-label">偏好</span></button>
      <span className="avatar" aria-label="本地用户">L</span>
    </div>
  </header>
);

const PreferencesPanel = ({ preferences, onChange, onClose, onWorkspaceSettings }: { preferences: UiPreferences; onChange: (preferences: UiPreferences) => void; onClose: () => void; onWorkspaceSettings: () => void }) => {
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
      <button className="button button-ghost" type="button" onClick={onWorkspaceSettings}>工作区与加密数据</button>
      <p className="preferences-note">偏好只保存在当前浏览器，不包含主密码、服务器密码或私钥。</p>
    </aside>
  </div>
  );
};

export const App = () => {
  const [state, dispatch] = useReducer(appReducer, initialAppState);
  const [hostFormOpen, setHostFormOpen] = useState(false);
  const [editingHost, setEditingHost] = useState<HostMetadataState | null>(null);
  const [terminalView, setTerminalView] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [preferences, setPreferences] = useState<UiPreferences>(() => loadPreferences());
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = useState(false);
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [commandRun, setCommandRun] = useState<CommandRun | null>(null);
  const [snippetCount, setSnippetCount] = useState(0);
  const [snippets, setSnippets] = useState<SnippetMetadata[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityEvents, setActivityEvents] = useState<AuditEvent[]>([]);
  const [expiredRunIds, setExpiredRunIds] = useState<Set<string>>(new Set());
  const [transferJobs, setTransferJobs] = useState<TransferJob[]>([]);
  const transferFilesRef = useRef(new Map<string, File>());
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
        const saved = await webWorkspaceAdapter.save(expectedVersion, { ...requestWorkspace, version: expectedVersion });
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
  }, []);

  useEffect(() => {
    applyPreferences(preferences);
    savePreferences(preferences);
  }, [preferences]);

  const loadWorkspace = useCallback(async (options: { openTerminalView?: boolean } = {}): Promise<void> => {
    try {
      const [hosts, groups] = await Promise.all([listHosts(), listGroups()]);
      let workspace: WorkspaceState;
      try {
        workspace = await webWorkspaceAdapter.load();
      } catch {
        workspace = defaultWorkspaceState;
      }
      dispatch({ type: 'hostsLoaded', hosts });
      dispatch({ type: 'groupsLoaded', groups });
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
  }, [enqueueWorkspaceSave]);

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
    void getSetupStatus()
      .then((status) => {
        if (cancelled) return;
        dispatch({ type: 'setup', initialized: status.initialized, locked: status.locked });
        if (status.initialized && !status.locked) {
          void loadWorkspace();
        } else if (!status.initialized) {
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
      await setupVault(masterPassword);
      dispatch({ type: 'setup', initialized: true, locked: false });
      await loadWorkspace();
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const completeUnlock = async (masterPassword: string): Promise<void> => {
    try {
      await unlockVault(masterPassword);
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
      const host = await createHost(input);
      dispatch({ type: 'hostCreated', host });
      setHostFormOpen(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleUpdateHost = async (input: HostPatchInput): Promise<void> => {
    if (!editingHost) return;
    try {
      const host = await updateHost(editingHost.id, input);
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
      const updated = await updateHost(host.id, { isFavorite: nextFavorite });
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

  const handleOpenBatchCommand = (): void => {
    if (state.terminals.length === 0) return;
    setCommandDialogOpen(true);
    const list = webApi.listSnippets;
    if (!list) return;
    void list().then((loaded) => { setSnippets(loaded); setSnippetCount(loaded.length); }).catch(() => { setSnippets([]); setSnippetCount(0); });
  };

  const updateTransferJob = (job: TransferJob): void => {
    setTransferJobs((current) => current.some((candidate) => candidate.id === job.id)
      ? current.map((candidate) => candidate.id === job.id ? job : candidate)
      : [...current, job]);
  };

  const refreshTransferJob = async (id: string): Promise<TransferJob | null> => {
    if (!webApi.getTransfer) return null;
    try {
      const job = await webApi.getTransfer(id);
      updateTransferJob(job);
      return job;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    const activeJobs = transferJobs.filter((job) => job.status === 'queued' || job.status === 'running');
    if (activeJobs.length === 0 || !webApi.getTransfer) return;
    const timer = window.setTimeout(() => {
      void Promise.all(activeJobs.map((job) => refreshTransferJob(job.id)));
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [transferJobs]);

  const handleUploadSftp = async (hostId: string, file: File, path: string): Promise<void> => {
    if (!webApi.createTransfer || !webApi.uploadTransferContent) throw new AppError('CAPABILITY_UNAVAILABLE');
    const targetPath = path === '/' ? `/${file.name}` : `${path}/${file.name}`;
    const job = await webApi.createTransfer({ kind: 'upload', hostId, sourcePath: file.name, targetPath, totalBytes: file.size });
    transferFilesRef.current.set(job.id, file);
    updateTransferJob(job);
    try {
      updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
      updateTransferJob(await webApi.uploadTransferContent(job.id, file));
    } catch (error) {
      await refreshTransferJob(job.id);
      throw error;
    }
  };

  const handleDownloadSftp = async (hostId: string, sourcePath: string, name: string): Promise<void> => {
    if (!webApi.createTransfer || !webApi.downloadTransferContent) throw new AppError('CAPABILITY_UNAVAILABLE');
    const job = await webApi.createTransfer({ kind: 'download', hostId, sourcePath, targetPath: name });
    updateTransferJob(job);
    try {
      updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
      const blob = await webApi.downloadTransferContent(job.id);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      await refreshTransferJob(job.id);
    } catch (error) {
      await refreshTransferJob(job.id);
      throw error;
    }
  };

  const handleCancelTransfer = (id: string): void => {
    const job = transferJobs.find((candidate) => candidate.id === id);
    if (job) updateTransferJob({ ...job, status: 'cancelled', updatedAt: new Date().toISOString() });
    if (webApi.cancelTransfer) void webApi.cancelTransfer(id).then(() => refreshTransferJob(id));
  };

  const handleRetryTransfer = (id: string): void => {
    if (!webApi.retryTransfer) return;
    void webApi.retryTransfer(id).then((job) => {
      updateTransferJob(job);
      if (job.kind === 'upload') {
        const file = transferFilesRef.current.get(id);
        if (!file || !webApi.uploadTransferContent) return;
        updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
        void webApi.uploadTransferContent(id, file).then(updateTransferJob).catch(() => refreshTransferJob(id));
        return;
      }
      if (!webApi.downloadTransferContent) return;
      updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
      void webApi.downloadTransferContent(id).then((blob) => {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = job.targetPath;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        return refreshTransferJob(id);
      }).catch(() => refreshTransferJob(id));
    }).catch(() => undefined);
  };

  const handleOpenActivity = (): void => {
    const list = webApi.listAuditEvents;
    if (!list) return;
    setActivityOpen(true);
    void list({ limit: 50 }).then((response) => setActivityEvents(response.items)).catch(() => setActivityEvents([]));
  };

  const handleOpenRunFromActivity = (runId: string): void => {
    setActivityOpen(false);
    const get = webApi.getCommandRun;
    if (!get) {
      setExpiredRunIds((current) => new Set(current).add(runId));
      return;
    }
    void get(runId).then((run) => {
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
      if (!webApi.startCommandRun) throw new AppError('CAPABILITY_UNAVAILABLE');
      const run = await webApi.startCommandRun(request);
      setCommandRun(run);
      setCommandDialogOpen(false);
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
      throw error;
    }
  };

  const handleCancelCommandRun = (): void => {
    if (!commandRun || !webApi.cancelCommandRun) return;
    void webApi.cancelCommandRun(commandRun.id).then(() => refreshCommandRun(commandRun.id)).catch(() => undefined);
  };

  const refreshCommandRun = async (id: string): Promise<void> => {
    if (!webApi.getCommandRun) return;
    try {
      setCommandRun(await webApi.getCommandRun(id));
    } catch {
      setCommandRun(null);
    }
  };

  useEffect(() => {
    if (!commandRun || !['queued', 'running'].includes(commandRun.status)) return;
    const timer = window.setTimeout(() => {
      const get = webApi.getCommandRun;
      if (!get) return;
      void get(commandRun.id).then(setCommandRun).catch(() => undefined);
    }, 750);
    return () => window.clearTimeout(timer);
  }, [commandRun]);

  const handleDeleteHost = async (host: HostMetadataState): Promise<void> => {
    if (!window.confirm(`确定删除 Server「${host.name}」吗？`)) return;
    try {
      await deleteHost(host.id);
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
      const result = await testConnection(host.id);
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
    if (snapshot.state !== 'connected') {
      refreshedHostForTerminalRef.current.delete(terminalId);
      return;
    }
    if (refreshedHostForTerminalRef.current.has(terminalId)) return;
    refreshedHostForTerminalRef.current.add(terminalId);
    void listHosts()
      .then((hosts) => dispatch({ type: 'hostsLoaded', hosts }))
      .catch(() => {
        refreshedHostForTerminalRef.current.delete(terminalId);
      });
  };

  const handleLock = async (): Promise<void> => {
    try {
      await lockVault();
      lockedFromCurrentAppRef.current = true;
      dispatch({ type: 'lock' });
      clearTerminalDescriptors();
      setTerminalView(false);
      closeHostForm();
      setActivityOpen(false);
      setCommandRun(null);
      setTransferJobs([]);
      transferFilesRef.current.clear();
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  if (state.phase === 'loading') return <LoadingView errorMessage={state.errorMessage} onRetry={retryBoot} />;
  if (state.phase === 'setup') return <SetupGate onSubmit={completeSetup} errorMessage={state.errorMessage} />;
  if (state.phase === 'locked') return <UnlockView onSubmit={completeUnlock} errorMessage={state.errorMessage} />;

  return (
    <main className="app-shell">
      {!terminalView && <WorkspaceHeader onLock={() => void handleLock()} terminalCount={state.terminals.length} onOpenTerminals={() => setTerminalView(true)} onSettings={() => setPreferencesOpen(true)} onActivity={handleOpenActivity} />}
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
        {terminalView ? (
          <TerminalWorkspace
            hosts={state.hosts}
            terminals={state.terminals}
            activeTerminalId={state.activeTerminalId}
            onActivate={(terminalId) => dispatch({ type: 'terminalActivated', terminalId })}
            onClose={handleCloseTerminal}
            onConnectHost={handleOpenTerminal}
            onStatusChange={handleTerminalStatus}
            onOpenBatchCommand={handleOpenBatchCommand}
            onListSftp={async (hostId, path) => {
              if (!webApi.listSftpEntries) throw new AppError('CAPABILITY_UNAVAILABLE');
              return webApi.listSftpEntries(hostId, path);
            }}
            onDeleteSftp={async (hostId, path) => {
              if (!webApi.mutateSftpEntry) throw new AppError('CAPABILITY_UNAVAILABLE');
              await webApi.mutateSftpEntry(hostId, { action: 'delete', path, confirmed: true });
            }}
            onUploadSftp={handleUploadSftp}
            onDownloadSftp={handleDownloadSftp}
            transferJobs={transferJobs}
            onCancelTransfer={handleCancelTransfer}
            onRetryTransfer={handleRetryTransfer}
            workspaceLayout={state.workspace.layout}
            onLayoutChange={(layout) => dispatch({ type: 'workspaceLayoutChanged', layout })}
            preferences={preferences}
            onBackToHosts={() => setTerminalView(false)}
            workspaceHeader={<WorkspaceHeader compact onLock={() => void handleLock()} terminalCount={state.terminals.length} onOpenTerminals={() => setTerminalView(true)} onSettings={() => setPreferencesOpen(true)} onActivity={handleOpenActivity} />}
          />
        ) : (
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
            onEdit={openEditHost}
            onDelete={(host) => void handleDeleteHost(host)}
            onTestConnection={(host) => void handleTestConnection(host)}
          />
        )}
      </div>
      {hostFormOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeHostForm(); }}>
          <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="host-form-title" onMouseDown={(event) => event.stopPropagation()}>
            {editingHost ? <HostForm mode="edit" initialHost={editingHost} groups={state.groups} hosts={state.hosts} onEditSubmit={handleUpdateHost} onCancel={closeHostForm} /> : <HostForm groups={state.groups} hosts={state.hosts} onSubmit={handleCreateHost} onCancel={closeHostForm} />}
          </aside>
        </div>
      )}
      {preferencesOpen && <PreferencesPanel preferences={preferences} onChange={setPreferences} onClose={() => setPreferencesOpen(false)} onWorkspaceSettings={() => { setPreferencesOpen(false); setWorkspaceSettingsOpen(true); }} />}
      {commandDialogOpen && <CommandRunDialog
        hosts={state.hosts}
        hostIds={state.terminals.map((terminal) => terminal.hostId)}
        snippets={snippets}
        onSnippetSelect={async (id): Promise<Snippet> => {
          if (!webApi.getSnippet) throw new AppError('CAPABILITY_UNAVAILABLE');
          return webApi.getSnippet(id);
        }}
        onClose={() => setCommandDialogOpen(false)}
        onConfirm={handleStartCommandRun}
      />}
      {commandRun && <div className="modal-backdrop" role="presentation"><section className="command-run-result-modal" role="dialog" aria-modal="true" aria-labelledby="command-run-result-title"><CommandRunResults run={commandRun} hosts={state.hosts} onCancel={handleCancelCommandRun} /><button className="button button-ghost" id="command-run-result-title" type="button" onClick={() => setCommandRun(null)}>关闭结果</button></section></div>}
      {activityOpen && <div className="modal-backdrop" role="presentation"><section className="command-run-result-modal activity-modal" role="dialog" aria-modal="true" aria-label="最近活动"><ActivityPanel events={activityEvents} expiredRunIds={expiredRunIds} onOpenRun={handleOpenRunFromActivity} /><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setActivityOpen(false)}>关闭</button></div></section></div>}
      {workspaceSettingsOpen && <WorkspaceSettings
        onClose={() => setWorkspaceSettingsOpen(false)}
        onExport={webWorkspaceAdapter.exportEncrypted}
        onPreviewImport={webWorkspaceAdapter.previewImport}
        onPreviewExternalImport={webWorkspaceAdapter.previewExternalImport}
        onExportOpenSsh={webWorkspaceAdapter.exportOpenSshConfig}
        onExportCsv={webWorkspaceAdapter.exportCsv}
        onApplyImport={async (previewId, resolution) => {
          const result = await webWorkspaceAdapter.applyImport(previewId, resolution);
          const [hosts, groups, workspace] = await Promise.all([listHosts(), listGroups(), webWorkspaceAdapter.load()]);
          dispatch({ type: 'hostsLoaded', hosts });
          dispatch({ type: 'groupsLoaded', groups });
          dispatch({ type: 'workspaceLoaded', workspace, terminalIds: createFreshTerminalIds(workspace, new Set(hosts.map((host) => host.id)), () => createTerminalId()) });
          return result;
        }}
        onApplyExternalImport={async (previewId, input) => {
          const result = await webWorkspaceAdapter.applyExternalImport(previewId, input);
          const [hosts, groups, workspace] = await Promise.all([listHosts(), listGroups(), webWorkspaceAdapter.load()]);
          dispatch({ type: 'hostsLoaded', hosts });
          dispatch({ type: 'groupsLoaded', groups });
          dispatch({ type: 'workspaceLoaded', workspace, terminalIds: createFreshTerminalIds(workspace, new Set(hosts.map((host) => host.id)), () => createTerminalId()) });
          return result;
        }}
      />}
      <div className="app-watermark" aria-hidden="true">LOCAL-FIRST · ENCRYPTED BY DEFAULT{snippetCount > 0 ? ` · ${snippetCount} 个片段` : ''}</div>
    </main>
  );
};
