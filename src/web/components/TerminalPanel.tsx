import { useCallback, useEffect, useRef, useState } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import type { OperationDiagnostic } from '@shared/core/models';
import type { TerminalCredentialRequiredEvent, TerminalStatus } from '@shared/protocol';
import type { HostCredentialInput } from '@shared/validation';
import type { HostMetadataState, WorkspaceRestoreStatus } from '../state/app-state';
import { TERMINAL_SCROLLBACK_LINES, TerminalOutputSanitizer } from '../terminal-output';
import { useTerminalSession, type TerminalSessionSnapshot } from '../hooks/use-terminal-session';
import { getTerminalTheme, DEFAULT_PREFERENCES, type UiPreferences } from '../theme';
import { HostKeyDialog } from './HostKeyDialog';

const isTouchDevice = (): boolean => {
  const coarsePointer = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const touchPoints = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return coarsePointer || touchPoints;
};

const CredentialDialog = ({ terminalId, prompt, onSubmit, onCancel }: { terminalId: string; prompt: TerminalCredentialRequiredEvent; onSubmit: (credential: HostCredentialInput) => void; onCancel: () => void }) => {
  const [value, setValue] = useState('');

  useEffect(() => setValue(''), [prompt.hostId, prompt.authType]);

  const submit = (): void => {
    if (!value) return;
    onSubmit(prompt.authType === 'private_key' ? { type: 'private_key', privateKey: value } : { type: 'password', password: value });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="host-key-dialog credential-dialog" role="dialog" aria-modal="true" aria-labelledby="credential-dialog-title">
        <p className="eyebrow">CONNECTION CREDENTIAL</p>
        <h2 id="credential-dialog-title">补录连接凭据</h2>
        <p className="dialog-copy">{prompt.name} · {prompt.address}:{prompt.port} 尚未保存凭据，请输入本次连接使用的{prompt.authType === 'private_key' ? '私钥' : '密码'}。</p>
        <label htmlFor={`terminal-credential-input-${terminalId}`}>{prompt.authType === 'private_key' ? '私钥' : '密码'}</label>
        {prompt.authType === 'private_key'
          ? <textarea id={`terminal-credential-input-${terminalId}`} value={value} onChange={(event) => setValue(event.target.value)} rows={8} autoFocus spellCheck={false} />
          : <input id={`terminal-credential-input-${terminalId}`} type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="current-password" autoFocus onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} />}
        <div className="dialog-actions">
          <button className="button button-ghost" type="button" onClick={onCancel}>取消</button>
          <button className="button button-primary" type="button" disabled={!value} onClick={submit}>连接</button>
        </div>
      </section>
    </div>
  );
};

export interface TerminalPanelToolbarState {
  state: TerminalStatus;
  reconnectDelayMs: number;
  networkOffline?: boolean;
  diagnostic: OperationDiagnostic | null;
  onReconnect: () => void;
  onClear: () => void;
  onSearch: () => void;
  onFullscreen: () => void;
  searchActive: boolean;
}

export interface TerminalPanelProps {
  terminalId: string;
  host: HostMetadataState;
  active: boolean;
  onClose: () => void;
  onEditHost?: (host: HostMetadataState) => void;
  onStatusChange?: (snapshot: TerminalSessionSnapshot) => void;
  onToolbarChange?: (terminalId: string, toolbar: TerminalPanelToolbarState | null) => void;
  preferences?: UiPreferences;
  recoveryStatus?: WorkspaceRestoreStatus;
}

export const TerminalPanel = ({ terminalId, host, active, onClose, onEditHost, onStatusChange, onToolbarChange, preferences = DEFAULT_PREFERENCES, recoveryStatus }: TerminalPanelProps) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const outputSanitizerRef = useRef(new TerminalOutputSanitizer());
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const session = useTerminalSession({
    hostId: host.id,
    terminalId,
    reconnectEnabled: (host.resolvedConnectionProfile ?? host.connectionProfile)?.reconnect.enabled,
    reconnectMaxAttempts: (host.resolvedConnectionProfile ?? host.connectionProfile)?.reconnect.maxAttempts,
    reconnectBaseMs: (host.resolvedConnectionProfile ?? host.connectionProfile)?.reconnect.baseDelayMs,
    reconnectMaxMs: (host.resolvedConnectionProfile ?? host.connectionProfile)?.reconnect.maxDelayMs,
    reattachOnly: recoveryStatus === 'restored',
    networkAware: true,
    autoConnect: recoveryStatus !== 'needs-reopen',
    getSize: () => ({
      cols: terminalRef.current?.cols ?? 80,
      rows: terminalRef.current?.rows ?? 24
    }),
    onOutput: (data) => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const sanitized = outputSanitizerRef.current.sanitize(data);
      if (sanitized.length > 0) terminal.write(sanitized);
    },
    onSnapshot: onStatusChange
  });

  useEffect(() => {
    if (session.state.state !== 'connecting' && session.state.state !== 'reconnecting' && session.state.state !== 'interrupted' && session.state.state !== 'closed' && session.state.state !== 'failed') return;
    outputSanitizerRef.current.reset();
  }, [session.state.state]);

  useEffect(() => {
    if (!mountRef.current || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: preferences.fontSize,
      lineHeight: 1.25,
      rightClickSelectsWord: isTouchDevice(),
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: getTerminalTheme(preferences.theme)
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new WebLinksAddon((_event, uri) => {
      if (/^https?:\/\//iu.test(uri)) window.open(uri, '_blank', 'noopener,noreferrer');
    }));
    terminal.open(mountRef.current);
    if (active) terminal.focus();
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    let fitFrame: number | null = null;
    let lastSize: { cols: number; rows: number } | null = null;
    const sendResizeIfChanged = (cols: number, rows: number): void => {
      if (lastSize?.cols === cols && lastSize.rows === rows) return;
      lastSize = { cols, rows };
      session.resize(cols, rows);
    };
    const fit = (): void => {
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        try {
          fitAddon.fit();
          sendResizeIfChanged(terminal.cols, terminal.rows);
        } catch {
          // The browser may report zero dimensions while a tab is being mounted.
        }
      });
    };
    const dataDisposable = terminal.onData((data) => session.sendInput(data));
    const binaryDisposable = terminal.onBinary((data) => session.sendInput(data));
    const resizeDisposable = terminal.onResize(({ cols, rows }) => sendResizeIfChanged(cols, rows));
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    observer?.observe(mountRef.current);
    fitRef.current = fit;
    fit();

    return () => {
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      fitRef.current = null;
      observer?.disconnect();
      dataDisposable.dispose();
      binaryDisposable.dispose();
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      outputSanitizerRef.current.reset();
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [session.resize, session.sendInput]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = preferences.fontSize;
    terminal.options.theme = getTerminalTheme(preferences.theme);
    fitRef.current?.();
  }, [preferences]);

  useEffect(() => {
    if (!active) return;
    fitRef.current?.();
    if (session.state.state === 'connected' && !session.state.hostKey) terminalRef.current?.focus();
  }, [active, session.state.hostKey, session.state.state]);

  const toggleSearch = useCallback((): void => {
    setSearchOpen((open) => {
      if (open) {
        setSearchValue('');
        searchAddonRef.current?.clearDecorations();
      }
      return !open;
    });
  }, []);

  const updateSearch = (value: string): void => {
    setSearchValue(value);
    if (value) searchAddonRef.current?.findNext(value);
    else searchAddonRef.current?.clearDecorations();
  };

  const clear = useCallback((): void => terminalRef.current?.clear(), []);

  const fullscreen = useCallback((): void => {
    const element = mountRef.current?.closest('.terminal-panel');
    if (!element) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void element.requestFullscreen?.();
    }
  }, []);

  const diagnostic = session.state.diagnostics.at(-1) ?? null;
  const errorAction = diagnostic?.nextAction;
  const displayState: TerminalStatus = recoveryStatus === 'needs-reopen' && session.state.state === 'closed'
    ? 'needs-reopen'
    : session.state.state;

  useEffect(() => {
    if (!active) {
      onToolbarChange?.(terminalId, null);
      return;
    }
    onToolbarChange?.(terminalId, {
      state: displayState,
      reconnectDelayMs: session.state.reconnectDelayMs,
      networkOffline: session.state.networkOffline,
      diagnostic,
      onReconnect: session.reconnect,
      onClear: clear,
      onSearch: toggleSearch,
      onFullscreen: fullscreen,
      searchActive: searchOpen
    });
    return () => onToolbarChange?.(terminalId, null);
  }, [active, clear, diagnostic, displayState, fullscreen, onToolbarChange, recoveryStatus, searchOpen, session.reconnect, session.state.networkOffline, session.state.reconnectDelayMs, session.state.state, terminalId, toggleSearch]);

  const errorActionButton = errorAction === 'edit-credentials'
    ? onEditHost ? <button className="button button-ghost button-small" type="button" onClick={() => onEditHost(host)}>编辑 Server 凭据</button> : null
    : errorAction === 'confirm-host-key'
      ? onEditHost ? <button className="button button-ghost button-small" type="button" onClick={() => onEditHost(host)}>检查 Host Key</button> : null
      : <button className="button button-ghost button-small" type="button" onClick={session.reconnect}>{session.state.state === 'needs-reopen' ? '重新打开' : '重新连接'}</button>;

  return (
    <section className={`terminal-panel ${active ? 'is-active' : ''}`} aria-hidden={!active}>
      {searchOpen && <div className="terminal-search"><label htmlFor={`terminal-search-${terminalId}`}>终端搜索</label><input id={`terminal-search-${terminalId}`} autoFocus value={searchValue} onChange={(event) => updateSearch(event.target.value)} placeholder="搜索终端输出" /></div>}
      <div className="terminal-canvas" ref={mountRef} />
      {recoveryStatus === 'needs-reopen' && session.state.state === 'closed' && <div className="terminal-recovery" role="status"><strong>此 Console 需要重新连接</strong><span>原来的远程 Shell 不再可用，重新打开会创建新的 Shell。</span><button className="button button-ghost button-small" type="button" onClick={session.reconnect}>重新打开</button></div>}
      {session.state.error && <div className="terminal-error" role="alert"><strong>{session.state.error.message}</strong>{errorAction !== 'none' && errorActionButton}</div>}
      {session.state.hostKey && <HostKeyDialog challenge={session.state.hostKey} onDecision={session.decideHostKey} />}
      {session.state.credential && <CredentialDialog terminalId={terminalId} prompt={session.state.credential} onSubmit={session.submitCredential} onCancel={onClose} />}
    </section>
  );
};
