import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';

import { AppError } from '@shared/errors';
import { BUILTIN_TERMINAL_PROFILES, type TerminalProfile } from '@shared/terminal-appearance';
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
import { QuickSwitcher } from './components/QuickSwitcher';
import { ShortcutMap } from './components/ShortcutMap';
import { BroadcastPreview } from './components/BroadcastPreview';
import { AccountMenu } from './components/AccountMenu';
import { SyncCenter } from './components/SyncCenter';
import { WorkspaceDirectory } from './components/WorkspaceDirectory';
import type { SftpOpenRequest } from './components/ServerContextMenu';
import type { AccountSession, ActivityFilter, AuditEvent, BroadcastTargetSnapshot, CommandRun, CommandRunRequest, IdentityMetadata, OperationDiagnostic, Snippet, SnippetMetadata, SyncState, TargetSelectionSource, TransferJob, WorkspaceTemplate } from '../shared/core/models';
import { effectiveMaxPanes, supportsWorkspacePanes, type CapabilitySet } from '../shared/core/capabilities';
import type { BinarySource, CloudSyncResult, NotificationPermission, NotificationPort } from '../shared/core/ports';
import type { CoreRuntime } from '../shared/core/runtime';
import type { TerminalSessionSnapshot } from './hooks/use-terminal-session';
import { useDialogFocus } from './hooks/use-dialog-focus';
import { shortcutCommandForEvent } from './state/shortcut-map';
import { isNativeContextMenuTarget } from './context-menu';
import {
  appReducer,
  clearTerminalDescriptors,
  defaultWorkspaceState,
  initialAppState,
  loadTerminalDescriptors,
  saveTerminalDescriptors,
  type HostMetadataState,
  type TerminalDescriptor
} from './state/app-state';
import { createFreshTerminalIds, restoreWorkspace, workspaceStateFromAppState } from './state/workspace-state';
import { createQuickSwitcherItems, type PrimaryDestination, type QuickSwitcherItem } from './state/navigation-state';
import type { WorkspaceState } from '../shared/core/models';
import type { CloudWorkspaceDirectorySnapshot } from '../shared/cloud/directory';
import {
  applyPreferences,
  fontSizeOptions,
  getThemeDefinition,
  loadPreferences,
  savePreferences,
  themeOptions,
  type TerminalFontSize,
  type ServerViewMode,
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

const WorkspaceHeader = ({ destination, onLock, onServers, onConsole, onQuickSwitcher, onSettings, onWorkspaces, accountMenu, compact = false }: { destination: PrimaryDestination; onLock: () => void; onServers: () => void; onConsole?: () => void; onQuickSwitcher: () => void; onSettings: () => void; onWorkspaces?: () => void; accountMenu?: ReactNode; compact?: boolean }) => (
  <header className={`app-header ${compact ? 'app-header-embedded' : ''}`}>
    <div className="app-header-main">
      <Brand />
      {!compact && <nav className="primary-nav" aria-label="主导航">
        <button className={`primary-nav-item ${destination === 'servers' ? 'is-active' : ''}`} type="button" aria-current={destination === 'servers' ? 'page' : undefined} onClick={onServers}>Server</button>
        {onConsole && <button className="primary-nav-item" type="button" onClick={onConsole}>Console</button>}
        {onWorkspaces && <button className={`primary-nav-item ${destination === 'workspaces' ? 'is-active' : ''}`} type="button" aria-current={destination === 'workspaces' ? 'page' : undefined} onClick={onWorkspaces}>工作区</button>}
      </nav>}
    </div>
    <div className="app-header-actions">
      <button className="button button-ghost button-small quick-switcher-trigger" type="button" aria-label="快速切换" aria-keyshortcuts="Control+K Meta+K" onClick={onQuickSwitcher}><span aria-hidden="true">⌘K</span><span className="quick-switcher-trigger-label">快速切换</span></button>
      <button className="secure-pill secure-pill-action" type="button" aria-label="Vault 已解锁，点击锁定" title="锁定 Vault" onClick={onLock}><span className="status-dot status-dot-green" />Vault 已解锁</button>
      <button className="button button-ghost button-small" type="button" aria-label="偏好设置" title="偏好设置" onClick={onSettings}>⚙<span className="settings-label">偏好</span></button>
      {accountMenu ?? <span className="avatar" aria-label="本地用户">L</span>}
    </div>
  </header>
);

interface PreferencesPanelProps {
  preferences: UiPreferences;
  onChange: (preferences: UiPreferences) => void;
  onClose: () => void;
  notifications?: NotificationPort;
  notificationPermission?: NotificationPermission;
  onRequestNotifications?: () => Promise<void>;
  onOpenActivity?: () => void;
  onOpenIdentities?: () => void;
  onOpenSnippets?: () => void;
}

const PreferencesPanel = ({ preferences, onChange, onClose, notifications, notificationPermission = 'denied', onRequestNotifications, onOpenActivity, onOpenIdentities, onOpenSnippets }: PreferencesPanelProps) => {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus(dialogRef, true, onClose, '.theme-preview-card');

  return (
  <div className="preferences-backdrop" role="presentation" onMouseDown={onClose}>
    <aside ref={dialogRef} className="preferences-panel" role="dialog" aria-modal="true" aria-labelledby="preferences-title" onMouseDown={(event) => event.stopPropagation()}>
      <div className="form-heading">
        <div><p className="eyebrow">WORKSPACE PREFERENCES</p><h2 id="preferences-title">偏好设置</h2></div>
        <button className="icon-button" type="button" aria-label="关闭偏好设置" title="关闭偏好设置" onClick={onClose}>×</button>
      </div>
      <div className="preferences-fields">
        <div className="theme-preview-grid" aria-label="主题预览">
          {themeOptions.map((option) => {
            const definition = getThemeDefinition(option.value);
            return <button
              className={`theme-preview-card ${preferences.theme === option.value ? 'is-selected' : ''}`}
              type="button"
              key={option.value}
              aria-label={`预览主题：${option.label}`}
              aria-pressed={preferences.theme === option.value}
              onClick={() => onChange({ ...preferences, theme: option.value })}
            >
              <span className="theme-preview-swatches" aria-hidden="true">
                {definition.swatches.map((swatch) => <span className="theme-preview-swatch" style={{ backgroundColor: swatch }} key={swatch} />)}
              </span>
              <span className="theme-preview-ansi" aria-label={`${option.label} 终端文字颜色预览`}>
                {[definition.terminal.foreground, definition.terminal.black, definition.terminal.red, definition.terminal.green, definition.terminal.yellow, definition.terminal.blue, definition.terminal.magenta, definition.terminal.cyan, definition.terminal.white, definition.terminal.brightBlack, definition.terminal.brightRed, definition.terminal.brightGreen, definition.terminal.brightYellow, definition.terminal.brightBlue, definition.terminal.brightMagenta, definition.terminal.brightCyan, definition.terminal.brightWhite].map((color, index) => <span className="theme-preview-ansi-swatch" style={{ backgroundColor: color }} key={`${option.value}-ansi-${index}`} />)}
              </span>
              <span className="theme-preview-copy"><strong>{option.label}</strong><small>{definition.colorScheme === 'light' ? 'Light' : 'Dark'}</small></span>
            </button>;
          })}
        </div>
        <label htmlFor="font-size-select">终端字号</label>
        <select id="font-size-select" aria-label="终端字号" value={preferences.fontSize} onChange={(event) => onChange({ ...preferences, fontSize: Number(event.target.value) as TerminalFontSize })}>
          {fontSizeOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}
        </select>
      </div>
      {notifications && <section className="preferences-system-section" aria-labelledby="preferences-system-title">
        <p className="eyebrow" id="preferences-system-title">PLATFORM</p>
        <div className="preferences-system-row">
          <div>
            <strong>桌面通知</strong>
            <span>只发送任务状态摘要，不包含命令、输出或凭据。</span>
          </div>
          {notificationPermission === 'granted'
            ? <span className="preferences-system-status" role="status">桌面通知已启用</span>
            : notificationPermission === 'denied'
              ? <span className="preferences-system-status">浏览器未允许通知</span>
              : <button className="button button-ghost button-small" type="button" onClick={() => void onRequestNotifications?.()}>启用桌面通知</button>}
        </div>
      </section>}
      {(onOpenActivity || onOpenIdentities || onOpenSnippets) && <section className="preferences-system-section" aria-labelledby="preferences-management-title">
        <p className="eyebrow" id="preferences-management-title">MANAGEMENT</p>
        {onOpenActivity && <div className="preferences-system-row"><div><strong>最近活动</strong><span>查看连接与批量任务的安全摘要。</span></div><button className="button button-ghost button-small" type="button" onClick={onOpenActivity}>打开</button></div>}
        {onOpenIdentities && <div className="preferences-system-row"><div><strong>身份</strong><span>管理可复用的 SSH 认证身份。</span></div><button className="button button-ghost button-small" type="button" onClick={onOpenIdentities}>管理</button></div>}
        {onOpenSnippets && <div className="preferences-system-row"><div><strong>片段</strong><span>管理保存的命令片段。</span></div><button className="button button-ghost button-small" type="button" onClick={onOpenSnippets}>管理</button></div>}
      </section>}
      <ShortcutMap />
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
  const [terminalProfiles, setTerminalProfiles] = useState<readonly TerminalProfile[]>([]);
  const [defaultTerminalProfile, setDefaultTerminalProfile] = useState<TerminalProfile | undefined>();
  const [terminalView, setTerminalView] = useState(false);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [workspaceHydrated, setWorkspaceHydrated] = useState(false);
  const [recentOnly, setRecentOnly] = useState(false);
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [sftpOpenRequest, setSftpOpenRequest] = useState<SftpOpenRequest | null>(null);
  const [networkOnline, setNetworkOnline] = useState(() => globalThis.navigator?.onLine !== false);
  const [networkRecoveryVisible, setNetworkRecoveryVisible] = useState(false);
  const [preferences, setPreferences] = useState<UiPreferences>(() => loadPreferences());
  const [capabilities, setCapabilities] = useState<CapabilitySet>(() => runtime.capabilities);
  const [accountSession, setAccountSession] = useState<AccountSession | null>(null);
  const [syncState, setSyncState] = useState<SyncState | null>(null);
  const [workspaceDirectory, setWorkspaceDirectory] = useState<CloudWorkspaceDirectorySnapshot | null>(null);
  const [workspaceDirectoryLoading, setWorkspaceDirectoryLoading] = useState(false);
  const [workspaceDirectoryError, setWorkspaceDirectoryError] = useState<string | null>(null);
  const [cloudSyncResult, setCloudSyncResult] = useState<CloudSyncResult | null>(null);
  const [cloudSyncError, setCloudSyncError] = useState<string | null>(null);
  const [syncCenterOpen, setSyncCenterOpen] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>('denied');
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [snippetManagerOpen, setSnippetManagerOpen] = useState(false);
  const [snippetPaletteOpen, setSnippetPaletteOpen] = useState(false);
  const [workspaceSwitcherOpen, setWorkspaceSwitcherOpen] = useState(false);
  const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);
  const [workspaceTemplates, setWorkspaceTemplates] = useState<WorkspaceTemplate[]>([]);
  const [workspaceSettingsMode, setWorkspaceSettingsMode] = useState<'import' | 'export' | null>(null);
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [broadcastPreviewOpen, setBroadcastPreviewOpen] = useState(false);
  const [commandTargetHostIds, setCommandTargetHostIds] = useState<string[]>([]);
  const [commandTargetSource, setCommandTargetSource] = useState<TargetSelectionSource>('servers');
  const [commandInitialCommand, setCommandInitialCommand] = useState('');
  const [commandInitialVariables, setCommandInitialVariables] = useState<Record<string, string>>({});
  const [commandRun, setCommandRun] = useState<CommandRun | null>(null);
  const [snippetCount, setSnippetCount] = useState(0);
  const [snippets, setSnippets] = useState<SnippetMetadata[]>([]);
  const [activityOpen, setActivityOpen] = useState(false);
  const [activityEvents, setActivityEvents] = useState<AuditEvent[]>([]);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>({ limit: 50 });
  const [activityNextCursor, setActivityNextCursor] = useState<string | undefined>();
  const [activityLoading, setActivityLoading] = useState(false);
  const [operationDiagnostics, setOperationDiagnostics] = useState<OperationDiagnostic[]>([]);
  const [expiredRunIds, setExpiredRunIds] = useState<Set<string>>(new Set());
  const [transferJobs, setTransferJobs] = useState<TransferJob[]>([]);
  const transferFilesRef = useRef(new Map<string, File>());
  const downloadWritersRef = useRef(new Map<string, DownloadWriter>());
  const refreshedHostForTerminalRef = useRef(new Set<string>());
  const lockedFromCurrentAppRef = useRef(false);
  const [connectionFeedback, setConnectionFeedback] = useState<ConnectionFeedback | null>(null);
  const networkRecoveryTimerRef = useRef<number | null>(null);
  const previousCommandStatusRef = useRef<CommandRun['status'] | null>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const latestStateRef = useRef(state);
  latestStateRef.current = state;
  const lastSavedWorkspaceRef = useRef<string | null>(null);
  const workspaceVersionRef = useRef(0);
  const workspaceSaveQueueRef = useRef(Promise.resolve());
  const workspaceLoadRequestRef = useRef(0);
  const activityRequestRef = useRef(0);
  const cloudSyncTimerRef = useRef<number | null>(null);
  const cloudSyncInFlightRef = useRef(false);

  const quickSwitcherItems = useMemo(() => createQuickSwitcherItems({
    hosts: state.hosts,
    groups: state.groups,
    terminals: state.terminals,
    workspaceTemplates,
    snippets
  }), [snippets, state.groups, state.hosts, state.terminals, workspaceTemplates]);
  const maxWorkspacePanes = effectiveMaxPanes(capabilities);

  useEffect(() => {
    const handleOffline = (): void => setNetworkOnline(false);
    const handleOnline = (): void => {
      setNetworkOnline(true);
      setNetworkRecoveryVisible(true);
      if (networkRecoveryTimerRef.current !== null) window.clearTimeout(networkRecoveryTimerRef.current);
      networkRecoveryTimerRef.current = window.setTimeout(() => {
        networkRecoveryTimerRef.current = null;
        setNetworkRecoveryVisible(false);
      }, 1_800);
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      if (networkRecoveryTimerRef.current !== null) window.clearTimeout(networkRecoveryTimerRef.current);
    };
  }, []);

  const notifications = runtime.platformServices?.notifications;

  useEffect(() => {
    let cancelled = false;
    if (!notifications) {
      setNotificationPermission('denied');
      return () => { cancelled = true; };
    }
    void notifications.permission()
      .then((permission) => {
        if (!cancelled) setNotificationPermission(permission);
      })
      .catch(() => {
        if (!cancelled) setNotificationPermission('denied');
      });
    return () => { cancelled = true; };
  }, [notifications]);

  const requestNotificationPermission = useCallback(async (): Promise<void> => {
    if (!notifications) return;
    try {
      setNotificationPermission(await notifications.requestPermission());
    } catch {
      setNotificationPermission('denied');
    }
  }, [notifications]);

  const terminalDescriptorsFor = (terminals: readonly { terminalId: string; hostId: string; recoveryStatus?: string; state: string }[], tabIds: Readonly<Record<string, string>>): TerminalDescriptor[] => terminals
    .filter((terminal) => {
      if (terminal.recoveryStatus === 'missing-host' || terminal.recoveryStatus === 'needs-reopen') return false;
      if (terminal.recoveryStatus === 'restored') return terminal.state !== 'failed' && terminal.state !== 'needs-reopen';
      return ['connecting', 'awaiting-host-key', 'awaiting-credential', 'connected', 'reconnecting', 'interrupted'].includes(terminal.state);
    })
    .map(({ terminalId, hostId }) => ({ terminalId, hostId, workspaceTabId: tabIds[terminalId] }));

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
    const loadRequest = workspaceLoadRequestRef.current + 1;
    workspaceLoadRequestRef.current = loadRequest;
    try {
      const negotiatedCapabilities = await runtime.negotiateCapabilities().catch(() => runtime.capabilities);
      setCapabilities(negotiatedCapabilities);
      const [hosts, groups, loadedIdentities, loadedTerminalProfiles, loadedDefaultTerminalProfile] = await Promise.all([
        runtime.hosts.list(),
        runtime.groups.list(),
        runtime.identities.list().catch(() => [] as readonly IdentityMetadata[]),
        runtime.terminalProfiles.list().catch(() => [] as readonly TerminalProfile[]),
        runtime.terminalProfiles.getDefault().catch(() => undefined)
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
      setTerminalProfiles([...loadedTerminalProfiles]);
      setDefaultTerminalProfile(loadedDefaultTerminalProfile);
      const savedTheme = themeOptions.find((option) => loadedDefaultTerminalProfile?.id === `builtin:${option.value}`)?.value;
      if (savedTheme) setPreferences((current) => current.theme === savedTheme ? current : { ...current, theme: savedTheme });
      void runtime.workspace.listTemplates().then((templates) => setWorkspaceTemplates([...templates])).catch(() => setWorkspaceTemplates([]));
      if (negotiatedCapabilities.supports('sftp.transfer')) {
        void runtime.files.listTransfers().then((jobs) => setTransferJobs([...jobs])).catch(() => setTransferJobs([]));
      } else {
        setTransferJobs([]);
      }
      const availableHostIds = new Set(hosts.map((host) => host.id));
      const restoreResults = restoreWorkspace(workspace, availableHostIds, loadTerminalDescriptors(), () => createTerminalId());
      if (workspaceLoadRequestRef.current !== loadRequest || latestStateRef.current.phase === 'locked') return;
      const terminalIds = Object.fromEntries(restoreResults.map((result) => [result.tabId, result.terminalId]));
      saveTerminalDescriptors(restoreResults
        .filter((result) => result.status === 'restored' && availableHostIds.has(result.hostId))
        .map((result) => ({ terminalId: result.terminalId, hostId: result.hostId, workspaceTabId: result.tabId })));
      dispatch({ type: 'workspaceLoaded', workspace, terminalIds, restoreResults });
      if ((options.openTerminalView ?? true) && restoreResults.length > 0) setTerminalView(true);
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
        } else {
          if (status.phase === 'uninitialized') clearTerminalDescriptors();
          void runtime.negotiateCapabilities().then((nextCapabilities) => {
            if (!cancelled) setCapabilities(nextCapabilities);
          }).catch(() => undefined);
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
    let cancelled = false;
    const accountPort = runtime.account;
    if (!capabilities.supports('account.auth') || !accountPort) {
      setAccountSession(null);
      setSyncState(null);
      setSyncCenterOpen(false);
      return () => { cancelled = true; };
    }

    void accountPort.status()
      .then((account) => {
        if (cancelled) return;
        setAccountSession(account);
        if (!account || !capabilities.supports('sync.encrypted') || !runtime.sync) {
          setSyncState(null);
          return;
        }
        void runtime.sync.status()
          .then((nextSync) => {
            if (!cancelled) setSyncState({ sync: nextSync.sync, head: nextSync.head, pendingCount: nextSync.pendingCount ?? 0, ...(nextSync.lastErrorCode === undefined ? {} : { lastErrorCode: nextSync.lastErrorCode }), ...(nextSync.recovery === undefined ? {} : { recovery: nextSync.recovery }), ...(nextSync.deletion === undefined ? {} : { deletion: nextSync.deletion }) });
          })
          .catch(() => {
            if (!cancelled) setSyncState({ sync: 'offline', head: null, pendingCount: 0 });
          });
      })
      .catch(() => {
        if (!cancelled) {
          setAccountSession(null);
          setSyncState(null);
        }
      });

    return () => { cancelled = true; };
  }, [capabilities, runtime]);

  const refreshWorkspaceDirectory = useCallback(async (): Promise<void> => {
    const directory = runtime.workspaceDirectory;
    if (!directory || !accountSession) {
      setWorkspaceDirectory(null);
      setWorkspaceDirectoryError(null);
      setWorkspaceDirectoryLoading(false);
      return;
    }
    setWorkspaceDirectoryLoading(true);
    setWorkspaceDirectoryError(null);
    try {
      setWorkspaceDirectory(await directory.refresh());
    } catch (error: unknown) {
      setWorkspaceDirectoryError(messageFromError(error));
    } finally {
      setWorkspaceDirectoryLoading(false);
    }
  }, [accountSession, runtime]);

  useEffect(() => {
    if (!workspaceHydrated || state.phase !== 'ready') return;
    void refreshWorkspaceDirectory();
  }, [refreshWorkspaceDirectory, state.phase, workspaceHydrated]);

  const runCloudSync = useCallback(async (): Promise<void> => {
    if (!workspaceHydrated || state.phase !== 'ready' || !accountSession || !runtime.cloudSync || !networkOnline) return;
    if (cloudSyncInFlightRef.current) return;
    cloudSyncInFlightRef.current = true;
    setCloudSyncError(null);
    try {
      const result = await runtime.cloudSync.sync();
      setCloudSyncResult(result);
      if (result.status === 'pulled') await loadWorkspace({ openTerminalView: false });
    } catch (error: unknown) {
      setCloudSyncError(messageFromError(error));
    } finally {
      cloudSyncInFlightRef.current = false;
    }
  }, [accountSession, loadWorkspace, networkOnline, runtime, state.phase, workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated || state.phase !== 'ready' || !accountSession || !runtime.cloudSync || !networkOnline) return;
    if (cloudSyncTimerRef.current !== null) window.clearTimeout(cloudSyncTimerRef.current);
    cloudSyncTimerRef.current = window.setTimeout(() => {
      cloudSyncTimerRef.current = null;
      void runCloudSync();
    }, 700);
    return () => {
      if (cloudSyncTimerRef.current !== null) {
        window.clearTimeout(cloudSyncTimerRef.current);
        cloudSyncTimerRef.current = null;
      }
    };
  }, [accountSession, identities, loadWorkspace, networkOnline, runCloudSync, runtime.cloudSync, snippets, state.groups, state.hosts, state.phase, state.workspace, terminalProfiles, workspaceHydrated]);

  useEffect(() => {
    if (!workspaceHydrated || state.phase !== 'ready') return;
    saveTerminalDescriptors(terminalDescriptorsFor(state.terminals, state.workspaceTabIdByTerminalId));
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

  const completeSyncRecovery = async (): Promise<void> => {
    dispatch({ type: 'setup', initialized: true, locked: false });
    lockedFromCurrentAppRef.current = false;
    await loadWorkspace({ openTerminalView: false });
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

  const handleOpenSftp = (host: HostMetadataState): void => {
    handleOpenTerminal(host);
    setSftpOpenRequest({ requestId: createTerminalId(), hostId: host.id });
  };

  const handleCopyText = async (value: string): Promise<void> => {
    const clipboard = runtime.platformServices?.clipboard;
    if (!clipboard) {
      setConnectionFeedback({ tone: 'info', message: '当前浏览器不支持剪贴板操作' });
      return;
    }
    try {
      await clipboard.writeText(value);
      setConnectionFeedback({ tone: 'info', message: '已复制到剪贴板' });
    } catch {
      setConnectionFeedback({ tone: 'info', message: '复制失败，请检查浏览器剪贴板权限' });
    }
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

  const handleOpenQuickSwitcher = (): void => {
    setQuickSwitcherOpen(true);
    void runtime.workspace.listTemplates().then((templates) => setWorkspaceTemplates([...templates])).catch(() => setWorkspaceTemplates([]));
    void loadSnippets();
  };

  const handleOpenServers = (): void => {
    setTerminalView(false);
    setActivityOpen(false);
    setWorkspaceSwitcherOpen(false);
    setQuickSwitcherOpen(false);
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
    const restoreResults = restoreWorkspace(template.state, availableHostIds, [], () => createTerminalId());
    const terminalIds = Object.fromEntries(restoreResults.map((result) => [result.tabId, result.terminalId]));
    dispatch({ type: 'workspaceLoaded', workspace: template.state, terminalIds, restoreResults });
    const nextWorkspace: WorkspaceState = { ...template.state, version: workspaceVersionRef.current };
    enqueueWorkspaceSave(nextWorkspace);
    setWorkspaceSwitcherOpen(false);
    setTerminalView(restoreResults.length > 0);
  };

  const handleOpenBatchCommand = (hostIds: readonly string[] = state.terminals.map((terminal) => terminal.hostId), source: TargetSelectionSource = 'servers'): void => {
    const uniqueHostIds = [...new Set(hostIds)];
    if (uniqueHostIds.length === 0) return;
    setCommandInitialCommand('');
    setCommandInitialVariables({});
    setCommandTargetHostIds(uniqueHostIds);
    setCommandTargetSource(source);
    setCommandDialogOpen(true);
    void loadSnippets();
  };

  const handleOpenHostFromResult = (hostId: string): void => {
    const host = latestStateRef.current.hosts.find((candidate) => candidate.id === hostId);
    if (!host) return;
    setCommandRun(null);
    handleOpenTerminal(host);
  };

  const handleOpenBroadcast = (): void => setBroadcastPreviewOpen(true);

  const handleConfirmBroadcast = (snapshot: BroadcastTargetSnapshot): void => {
    setBroadcastPreviewOpen(false);
    setCommandInitialCommand('');
    setCommandInitialVariables({});
    setCommandTargetHostIds([...snapshot.hostIds]);
    setCommandTargetSource('workspace');
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
      setCommandTargetSource('workspace');
      setCommandDialogOpen(true);
    }).catch((error: unknown) => dispatch({ type: 'error', message: messageFromError(error) }));
  };

  const handleQuickSwitcherSelect = (item: QuickSwitcherItem): void => {
    setQuickSwitcherOpen(false);
    if (item.type === 'host') {
      const host = latestStateRef.current.hosts.find((candidate) => candidate.id === item.id);
      if (host) handleOpenTerminal(host);
      return;
    }
    if (item.type === 'tab') {
      if (latestStateRef.current.terminals.some((terminal) => terminal.terminalId === item.id)) {
        dispatch({ type: 'terminalActivated', terminalId: item.id });
        setTerminalView(true);
      }
      return;
    }
    if (item.type === 'workspace') {
      const template = workspaceTemplates.find((candidate) => candidate.id === item.id);
      if (template) handleOpenWorkspaceTemplate(template);
      return;
    }
    handleSelectSnippetFromPalette(item.id);
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
      const latest = await refreshTransferJob(job.id);
      if (latest?.status === 'paused') return;
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
      const latest = await refreshTransferJob(job.id);
      if (latest?.status === 'paused') return;
      throw error;
    }
  };

  const handleCancelTransfer = (id: string): void => {
    const job = transferJobs.find((candidate) => candidate.id === id);
    if (job) updateTransferJob({ ...job, status: 'cancelled', updatedAt: new Date().toISOString() });
    void runtime.files.cancelTransfer(id).then(() => refreshTransferJob(id));
  };

  const handlePauseTransfer = (id: string): void => {
    const job = transferJobs.find((candidate) => candidate.id === id);
    if (job) updateTransferJob({ ...job, status: 'paused', updatedAt: new Date().toISOString() });
    void runtime.files.pauseTransfer(id).then(() => refreshTransferJob(id)).catch(() => refreshTransferJob(id));
  };

  const handleRetryTransfer = (id: string): void => {
    const resumeSupported = capabilities.supports('transfer.resume');
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
        void runtime.files.upload(id, fileToBinarySource(file), resumeSupported ? resumeRequestForJob(job) : undefined).then(updateTransferJob).catch(() => refreshTransferJob(id));
        return;
      }
      if (!writer) {
        triggerNativeDownload(id, job.targetPath);
        return;
      }
      updateTransferJob({ ...job, status: 'running', updatedAt: new Date().toISOString() });
      void runtime.files.download(id, resumeSupported ? resumeRequestForJob(job) : undefined).then((stream) => saveDownloadStream(id, stream, job.targetPath, resumeSupported ? job.checkpoint?.offset ?? 0 : 0, writer)).then(() => {
        return refreshTransferJob(id);
      }).catch(() => refreshTransferJob(id));
    })).catch(() => undefined);
  };

  const loadActivity = (filter: ActivityFilter, append: boolean): void => {
    const requestId = activityRequestRef.current + 1;
    activityRequestRef.current = requestId;
    setActivityLoading(true);
    void runtime.activity.list(filter).then((page) => {
      if (requestId !== activityRequestRef.current) return;
      setActivityEvents((current) => append ? [...current, ...page.items] : [...page.items]);
      setActivityNextCursor(page.nextCursor);
    }).catch(() => {
      if (requestId !== activityRequestRef.current) return;
      if (!append) setActivityEvents([]);
      setActivityNextCursor(undefined);
    }).finally(() => {
      if (requestId === activityRequestRef.current) setActivityLoading(false);
    });
  };

  const handleOpenActivity = (): void => {
    const nextFilter: ActivityFilter = { limit: 50 };
    setActivityOpen(true);
    setActivityFilter(nextFilter);
    setActivityNextCursor(undefined);
    loadActivity(nextFilter, false);
  };

  const handleApplyActivityFilter = (nextFilter: ActivityFilter): void => {
    setActivityFilter(nextFilter);
    setActivityNextCursor(undefined);
    loadActivity(nextFilter, false);
  };

  const handleLoadMoreActivity = (): void => {
    if (!activityNextCursor || activityLoading) return;
    loadActivity({ ...activityFilter, cursor: activityNextCursor }, true);
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

  useEffect(() => {
    if (!commandRun) {
      previousCommandStatusRef.current = null;
      return;
    }
    const previousStatus = previousCommandStatusRef.current;
    previousCommandStatusRef.current = commandRun.status;
    if (!notifications || !previousStatus || previousStatus === commandRun.status || !['completed', 'failed', 'cancelled'].includes(commandRun.status)) return;
    const message = commandRun.status === 'completed'
      ? '批量任务已完成，请回到 Relay 查看结果。'
      : commandRun.status === 'cancelled'
        ? '批量任务已取消，请回到 Relay 查看结果。'
        : '批量任务有失败目标，请回到 Relay 查看结果。';
    void notifications.permission()
      .then((permission) => permission === 'granted'
        ? notifications.notify({ title: 'Relay 任务更新', body: message, tag: `command-run:${commandRun.id}` })
        : undefined)
      .catch(() => undefined);
  }, [commandRun, notifications]);

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

  const handleClearHostKey = async (host: HostMetadataState): Promise<void> => {
    if (!window.confirm(`清除 Server「${host.name}」已保存的 Host Key 信任吗？下次连接需要重新确认指纹。`)) return;
    try {
      await runtime.hosts.clearHostKey(host.id);
      dispatch({ type: 'hostUpdated', host: { ...host, hostKeyAlgorithm: null, hostKeyFingerprint: null } });
      setConnectionFeedback({ tone: 'info', message: `已清除 ${host.name} 的 Host Key 信任，下次连接会重新确认。` });
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
      const command = shortcutCommandForEvent(event, { terminalView });
      if (!command) return;
      if (command === 'focus-pane') return;
      if (command === 'quick-switch') {
        event.preventDefault();
        handleOpenQuickSwitcher();
        return;
      }
      if (command === 'open-snippets') {
        const supported = terminalView
          ? capabilities.supports('automation.snippets')
          : capabilities.supports('automation.snippet-manager');
        if (!supported) return;
        event.preventDefault();
        if (terminalView) handleOpenSnippetPalette();
        else handleOpenSnippetManager();
        return;
      }
      if (command === 'new-terminal') {
        const newTerminalButton = document.getElementById('terminal-new-terminal');
        if (!(newTerminalButton instanceof HTMLButtonElement)) return;
        event.preventDefault();
        newTerminalButton.click();
        return;
      }
      if (command === 'open-sftp') {
        const openSftpButton = document.getElementById('terminal-open-sftp');
        if (!(openSftpButton instanceof HTMLButtonElement)) return;
        event.preventDefault();
        openSftpButton.click();
        return;
      }
      if (command === 'close-tab' && state.activeTerminalId) {
        event.preventDefault();
        handleCloseTerminal(state.activeTerminalId);
      }
    };
    window.addEventListener('keydown', handleShortcut, true);
    return () => window.removeEventListener('keydown', handleShortcut, true);
  }, [capabilities, state.activeTerminalId, terminalView]);

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

  const handlePreferencesChange = useCallback((next: UiPreferences): void => {
    setPreferences(next);
    if (next.theme === preferences.theme) return;
    const profile = BUILTIN_TERMINAL_PROFILES.find((candidate) => candidate.id === `builtin:${next.theme}`);
    if (!profile) return;
    setDefaultTerminalProfile(profile);
    void runtime.terminalProfiles.setDefault(profile.id).catch((error: unknown) => dispatch({ type: 'error', message: messageFromError(error) }));
  }, [preferences.theme, runtime]);

  const handleLock = async (): Promise<void> => {
    try {
      await runtime.vault.lock();
      workspaceLoadRequestRef.current += 1;
      lockedFromCurrentAppRef.current = true;
      dispatch({ type: 'lock' });
      clearTerminalDescriptors();
      setTerminalView(false);
      closeHostForm();
      setActivityOpen(false);
      activityRequestRef.current += 1;
      setActivityEvents([]);
      setActivityFilter({ limit: 50 });
      setActivityNextCursor(undefined);
      setActivityLoading(false);
      setOperationDiagnostics([]);
      setExpiredRunIds(new Set());
      setSnippetManagerOpen(false);
      setSnippetPaletteOpen(false);
      setQuickSwitcherOpen(false);
      setSyncCenterOpen(false);
      setBroadcastPreviewOpen(false);
      setCommandRun(null);
      setTransferJobs([]);
      transferFilesRef.current.clear();
      downloadWritersRef.current.clear();
    } catch (error) {
      dispatch({ type: 'error', message: messageFromError(error) });
    }
  };

  const handleAccountChange = (nextAccount: AccountSession | null): void => {
    setAccountSession(nextAccount);
    setSyncState(null);
    if (!nextAccount || !capabilities.supports('sync.encrypted') || !runtime.sync) return;
    void runtime.sync.status()
      .then((nextSync) => setSyncState({ sync: nextSync.sync, head: nextSync.head, pendingCount: nextSync.pendingCount ?? 0, ...(nextSync.lastErrorCode === undefined ? {} : { lastErrorCode: nextSync.lastErrorCode }), ...(nextSync.recovery === undefined ? {} : { recovery: nextSync.recovery }), ...(nextSync.deletion === undefined ? {} : { deletion: nextSync.deletion }) }))
      .catch(() => setSyncState({ sync: 'offline', head: null, pendingCount: 0 }));
  };

  const accountMenu = <AccountMenu
    capabilities={capabilities}
    account={accountSession}
    sync={syncState}
    accountPort={runtime.account}
    devicesPort={runtime.devices}
    syncPort={runtime.sync}
    onAccountChange={handleAccountChange}
    onSyncChange={setSyncState}
    onOpenSync={() => setSyncCenterOpen(true)}
  />;

  const syncCenterState = useMemo<SyncState>(() => syncState ?? {
    sync: state.phase === 'locked' ? 'needs-unlock' : 'local-only',
    head: null,
    pendingCount: 0
  }, [state.phase, syncState]);

  const handleAppContextMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    if (!isNativeContextMenuTarget(event.target)) event.preventDefault();
  };

  if (state.phase === 'loading') return <LoadingView errorMessage={state.errorMessage} onRetry={retryBoot} />;
  if (state.phase === 'setup') return <SetupGate onSubmit={completeSetup} errorMessage={state.errorMessage} headerSlot={accountMenu} account={accountSession} recoveryPort={runtime.vaultRecovery} onRecovered={completeSyncRecovery} />;
  if (state.phase === 'locked') return <>
    <UnlockView
      onSubmit={completeUnlock}
      errorMessage={state.errorMessage}
      headerSlot={accountMenu}
      account={accountSession}
      recoveryPort={runtime.vaultRecovery}
      onRecovered={completeSyncRecovery}
    />
    {syncCenterOpen && accountSession && runtime.sync && <SyncCenter account={accountSession} sync={syncCenterState} capabilities={capabilities} vaultLocked syncPort={runtime.sync} devicesPort={runtime.devices} clipboard={runtime.platformServices?.clipboard} fileSave={runtime.platformServices?.fileSave} onSyncChange={setSyncState} onClose={() => setSyncCenterOpen(false)} />}
  </>;

  return (
    <main className="app-shell" onContextMenu={handleAppContextMenu}>
      {!terminalView && <WorkspaceHeader
        destination={activityOpen ? 'activity' : workspaceSwitcherOpen ? 'workspaces' : 'servers'}
        onLock={() => void handleLock()}
        onServers={handleOpenServers}
        onConsole={state.terminals.length > 0 ? () => setTerminalView(true) : undefined}
        onQuickSwitcher={handleOpenQuickSwitcher}
        onSettings={() => setPreferencesOpen(true)}
        onWorkspaces={capabilities.supports('workspace.templates') ? handleOpenWorkspaceSwitcher : undefined}
        accountMenu={accountMenu}
      />}
      {state.errorMessage && (
        <div className="global-alert" role="alert">
          <span>{state.errorMessage}</span>
          <button className="icon-button" type="button" aria-label="关闭提示" title="关闭提示" onClick={() => dispatch({ type: 'error', message: null })}>×</button>
        </div>
      )}
      {!networkOnline && (
        <div className="global-feedback global-feedback-info" role="status" aria-live="polite">
          <span>网络已断开，终端会话将在恢复后自动重连；未提交的操作请稍后重试。</span>
        </div>
      )}
      {networkOnline && networkRecoveryVisible && (
        <div className="global-feedback global-feedback-info" role="status" aria-live="polite">
          <span>网络已恢复，正在检查会话状态。</span>
        </div>
      )}
      {connectionFeedback && (
        <div className={`global-feedback global-feedback-${connectionFeedback.tone}`} role="status" aria-live="polite">
          <span>{connectionFeedback.message}</span>
          <button className="icon-button" type="button" aria-label="关闭提示" title="关闭提示" onClick={() => setConnectionFeedback(null)}>×</button>
        </div>
      )}
      {cloudSyncError && (
        <div className="global-feedback global-feedback-info" role="status" aria-live="polite">
          <span>账号配置同步失败：{cloudSyncError}</span>
          <button className="button button-ghost button-small" type="button" onClick={() => void runCloudSync()}>重试</button>
        </div>
      )}
      {cloudSyncResult?.status === 'conflict' && !cloudSyncError && (
        <div className="global-feedback global-feedback-info" role="status" aria-live="polite">
          <span>账号配置在本端和云端同时发生了修改，已暂停自动覆盖，请先处理冲突。</span>
          <button className="button button-ghost button-small" type="button" onClick={() => void runCloudSync()}>重新检查</button>
        </div>
      )}
      <div className={`app-body ${terminalView ? 'app-body-terminal' : ''}`}>
        <div className="app-view" hidden={terminalView} aria-hidden={terminalView}>
          {accountSession && runtime.workspaceDirectory && <WorkspaceDirectory
            snapshot={workspaceDirectory}
            loading={workspaceDirectoryLoading}
            error={workspaceDirectoryError}
            onRefresh={() => void refreshWorkspaceDirectory()}
          />}
          <HostWorkspace
            hosts={state.hosts}
            groups={state.groups}
            query={state.query}
            selectedGroupId={state.selectedGroupId}
            favoriteOnly={state.favoriteOnly}
            recentOnly={recentOnly}
            selectedTag={selectedTag}
            onQueryChange={(query) => dispatch({ type: 'queryChanged', query })}
            onGroupSelected={(groupId) => { dispatch({ type: 'groupSelected', groupId }); setRecentOnly(false); setSelectedTag(null); }}
            onFavoriteFilter={(favoriteOnly) => { dispatch({ type: 'favoriteFilterChanged', favoriteOnly }); setRecentOnly(false); setSelectedTag(null); }}
            onRecentFilter={(nextRecentOnly) => { setRecentOnly(nextRecentOnly); if (nextRecentOnly) { dispatch({ type: 'groupSelected', groupId: null }); dispatch({ type: 'favoriteFilterChanged', favoriteOnly: false }); } }}
            onTagSelected={(tag) => { setSelectedTag(tag); if (tag !== null) { dispatch({ type: 'groupSelected', groupId: null }); dispatch({ type: 'favoriteFilterChanged', favoriteOnly: false }); setRecentOnly(false); } }}
            onFavoriteToggle={(host) => void handleFavoriteToggle(host)}
            onConnect={handleOpenTerminal}
            onAddHost={openCreateHost}
            onBatchCommand={capabilities.supports('automation.batch-exec') ? (hostIds) => handleOpenBatchCommand(hostIds, 'servers') : undefined}
            onImport={capabilities.supports('vault.bundle') ? () => setWorkspaceSettingsMode('import') : undefined}
            onExport={capabilities.supports('vault.bundle') ? () => setWorkspaceSettingsMode('export') : undefined}
            onEdit={openEditHost}
            onDelete={(host) => void handleDeleteHost(host)}
            onClearHostKey={(host) => void handleClearHostKey(host)}
            onTestConnection={(host) => void handleTestConnection(host)}
            onOpenSftp={capabilities.supports('sftp.browse') ? handleOpenSftp : undefined}
            onCopyText={handleCopyText}
            viewMode={preferences.serverViewMode ?? 'list'}
            onViewModeChange={(serverViewMode: ServerViewMode) => setPreferences((current) => ({ ...current, serverViewMode }))}
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
            onOpenBatchCommand={capabilities.supports('automation.batch-exec') ? () => handleOpenBatchCommand(state.terminals.map((terminal) => terminal.hostId), 'workspace') : undefined}
            onOpenBroadcast={capabilities.supports('automation.batch-exec') && capabilities.supports('terminal.broadcast') && maxWorkspacePanes > 1 ? handleOpenBroadcast : undefined}
            openSftpRequest={sftpOpenRequest}
            onSftpRequestConsumed={(requestId) => setSftpOpenRequest((current) => current?.requestId === requestId ? null : current)}
            clipboard={runtime.platformServices?.clipboard}
            onOpenSnippetPalette={capabilities.supports('automation.snippets') ? handleOpenSnippetPalette : undefined}
            onListSftp={capabilities.supports('sftp.browse') ? (hostId, path) => runtime.files.list(hostId, path) : undefined}
            onCreateDirectorySftp={capabilities.supports('sftp.entry-mutations') ? (hostId, path) => runtime.files.createDirectory(hostId, path) : undefined}
            onRenameSftp={capabilities.supports('sftp.entry-mutations') ? (hostId, from, to) => runtime.files.rename(hostId, from, to) : undefined}
            onDeleteSftp={capabilities.supports('sftp.entry-mutations') ? (hostId, path) => runtime.files.remove(hostId, path) : undefined}
            fileTransport={capabilities.supports('sftp.browse') ? runtime.files : undefined}
            sftpMutationsEnabled={capabilities.supports('sftp.entry-mutations')}
            onUploadSftp={capabilities.supports('sftp.transfer') && capabilities.supports('sftp.local-files') ? handleUploadSftp : undefined}
            onDownloadSftp={capabilities.supports('sftp.transfer') ? handleDownloadSftp : undefined}
            onCopyText={handleCopyText}
            transferJobs={capabilities.supports('sftp.transfer') ? transferJobs : []}
            onCancelTransfer={capabilities.supports('sftp.transfer') ? handleCancelTransfer : undefined}
            onPauseTransfer={capabilities.supports('sftp.transfer') ? handlePauseTransfer : undefined}
            onRetryTransfer={capabilities.supports('sftp.transfer') ? handleRetryTransfer : undefined}
            onResumeTransfer={capabilities.supports('sftp.transfer') && capabilities.supports('transfer.resume') ? handleRetryTransfer : undefined}
            resumeSupported={capabilities.supports('transfer.resume')}
            localFilesEnabled={capabilities.supports('sftp.local-files')}
            allowMultiPane={supportsWorkspacePanes(capabilities)}
            maxPanes={maxWorkspacePanes}
            workspaceLayout={state.workspace.layout}
            workspaceTabIdByTerminalId={state.workspaceTabIdByTerminalId}
            onLayoutChange={(layout) => dispatch({ type: 'workspaceLayoutChanged', layout })}
            preferences={preferences}
            terminalProfiles={terminalProfiles}
            defaultTerminalProfile={defaultTerminalProfile}
            visible={terminalView}
            onBackToHosts={() => setTerminalView(false)}
            workspaceHeader={<WorkspaceHeader
              compact
              destination="servers"
              onLock={() => void handleLock()}
              onServers={handleOpenServers}
              onQuickSwitcher={handleOpenQuickSwitcher}
              onSettings={() => setPreferencesOpen(true)}
              onWorkspaces={capabilities.supports('workspace.templates') ? handleOpenWorkspaceSwitcher : undefined}
              accountMenu={accountMenu}
            />}
          />
        </div>
      </div>
      {quickSwitcherOpen && <QuickSwitcher items={quickSwitcherItems} onSelect={handleQuickSwitcherSelect} onClose={() => setQuickSwitcherOpen(false)} />}
      {hostFormOpen && (
        <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeHostForm(); }}>
          <aside ref={drawerRef} className="drawer" role="dialog" aria-modal="true" aria-labelledby="host-form-title" onMouseDown={(event) => event.stopPropagation()}>
            {editingHost ? <HostForm mode="edit" initialHost={editingHost} groups={state.groups} hosts={state.hosts} identities={identities} terminalProfiles={terminalProfiles} onEditSubmit={handleUpdateHost} onCancel={closeHostForm} /> : <HostForm groups={state.groups} hosts={state.hosts} identities={identities} terminalProfiles={terminalProfiles} onSubmit={handleCreateHost} onCancel={closeHostForm} />}
          </aside>
        </div>
      )}
      {preferencesOpen && <PreferencesPanel preferences={preferences} onChange={handlePreferencesChange} onClose={() => setPreferencesOpen(false)} notifications={notifications} notificationPermission={notificationPermission} onRequestNotifications={requestNotificationPermission}
        onOpenActivity={capabilities.supports('audit.activity') ? () => { setPreferencesOpen(false); handleOpenActivity(); } : undefined}
        onOpenIdentities={capabilities.supports('vault.identities') ? () => { setPreferencesOpen(false); setIdentityOpen(true); } : undefined}
        onOpenSnippets={capabilities.supports('automation.snippet-manager') ? () => { setPreferencesOpen(false); handleOpenSnippetManager(); } : undefined}
      />}
      {identityOpen && capabilities.supports('vault.identities') && <IdentityManager identities={identities} onCreate={handleCreateIdentity} onUpdate={handleUpdateIdentity} onDelete={async (id) => { if (window.confirm('确定删除这个身份吗？')) await handleDeleteIdentity(id); }} onClose={() => setIdentityOpen(false)} />}
      {snippetManagerOpen && capabilities.supports('automation.snippet-manager') && <SnippetManager snippets={snippets} onGet={(id) => runtime.snippets.get(id)} onCreate={handleCreateSnippet} onUpdate={handleUpdateSnippet} onDelete={handleDeleteSnippet} onClose={() => setSnippetManagerOpen(false)} />}
      {snippetPaletteOpen && capabilities.supports('automation.snippets') && <SnippetPalette snippets={snippets} onSelect={handleSelectSnippetFromPalette} onClose={() => setSnippetPaletteOpen(false)} />}
      {workspaceSwitcherOpen && capabilities.supports('workspace.templates') && <WorkspaceSwitcher templates={workspaceTemplates} currentWorkspace={workspaceStateFromAppState(state)} hosts={state.hosts} onOpen={handleOpenWorkspaceTemplate} onSave={handleSaveWorkspaceTemplate} onDelete={handleDeleteWorkspaceTemplate} onClose={() => setWorkspaceSwitcherOpen(false)} />}
      {broadcastPreviewOpen && <BroadcastPreview workspaceId={null} hosts={state.hosts} groups={state.groups} terminals={state.terminals} workspaceTabIdByTerminalId={state.workspaceTabIdByTerminalId} onConfirm={handleConfirmBroadcast} onClose={() => setBroadcastPreviewOpen(false)} />}
      {commandDialogOpen && <CommandRunDialog
        hosts={state.hosts}
        hostIds={commandTargetHostIds}
        initialTargetSource={commandTargetSource}
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
      {commandRun && <div className="modal-backdrop" role="presentation"><section className="command-run-result-modal" role="dialog" aria-modal="true" aria-labelledby="command-run-result-title"><CommandRunResults run={commandRun} hosts={state.hosts} onCancel={handleCancelCommandRun} onOpenHost={handleOpenHostFromResult} /><button className="button button-ghost" id="command-run-result-title" type="button" onClick={() => setCommandRun(null)}>关闭结果</button></section></div>}
      {activityOpen && <div className="modal-backdrop" role="presentation"><section className="command-run-result-modal activity-modal" role="dialog" aria-modal="true" aria-label="最近活动"><ActivityPanel events={activityEvents} hosts={state.hosts} filter={activityFilter} loading={activityLoading} hasMore={activityNextCursor !== undefined} diagnostics={operationDiagnostics} expiredRunIds={expiredRunIds} onOpenRun={handleOpenRunFromActivity} onApplyFilter={handleApplyActivityFilter} onLoadMore={handleLoadMoreActivity} onClose={() => setActivityOpen(false)} /></section></div>}
      {syncCenterOpen && accountSession && runtime.sync && capabilities.supports('sync.encrypted') && <SyncCenter account={accountSession} sync={syncCenterState} capabilities={capabilities} vaultLocked={false} syncPort={runtime.sync} devicesPort={runtime.devices} clipboard={runtime.platformServices?.clipboard} fileSave={runtime.platformServices?.fileSave} onSyncChange={setSyncState} onClose={() => setSyncCenterOpen(false)} />}
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
