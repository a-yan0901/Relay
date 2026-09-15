import { useCallback, useEffect, useRef, useState } from 'react';

import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Terminal } from '@xterm/xterm';

import type { TerminalStatus } from '@shared/protocol';

import type { HostMetadataState } from '../state/app-state';
import { useTerminalSession, type TerminalSessionSnapshot } from '../hooks/use-terminal-session';
import { getTerminalTheme, DEFAULT_PREFERENCES, type UiPreferences } from '../theme';
import { HostKeyDialog } from './HostKeyDialog';

const isTouchDevice = (): boolean => {
  const coarsePointer = typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
  const touchPoints = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return coarsePointer || touchPoints;
};

export interface TerminalPanelToolbarState {
  state: TerminalStatus;
  reconnectDelayMs: number;
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
  onStatusChange?: (snapshot: TerminalSessionSnapshot) => void;
  onToolbarChange?: (terminalId: string, toolbar: TerminalPanelToolbarState | null) => void;
  preferences?: UiPreferences;
}

export const TerminalPanel = ({ terminalId, host, active, onStatusChange, onToolbarChange, preferences = DEFAULT_PREFERENCES }: TerminalPanelProps) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const fitRef = useRef<(() => void) | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const session = useTerminalSession({
    hostId: host.id,
    terminalId,
    getSize: () => ({
      cols: terminalRef.current?.cols ?? 80,
      rows: terminalRef.current?.rows ?? 24
    }),
    onOutput: (data) => terminalRef.current?.write(data),
    onSnapshot: onStatusChange
  });

  useEffect(() => {
    if (!mountRef.current || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: preferences.fontSize,
      lineHeight: 1.25,
      rightClickSelectsWord: isTouchDevice(),
      scrollback: 5_000,
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

  useEffect(() => {
    if (!active) {
      onToolbarChange?.(terminalId, null);
      return;
    }
    onToolbarChange?.(terminalId, {
      state: session.state.state,
      reconnectDelayMs: session.state.reconnectDelayMs,
      onReconnect: session.reconnect,
      onClear: clear,
      onSearch: toggleSearch,
      onFullscreen: fullscreen,
      searchActive: searchOpen
    });
    return () => onToolbarChange?.(terminalId, null);
  }, [active, clear, fullscreen, onToolbarChange, searchOpen, session.reconnect, session.state.reconnectDelayMs, session.state.state, terminalId, toggleSearch]);

  return (
    <section className={`terminal-panel ${active ? 'is-active' : ''}`} aria-hidden={!active}>
      {searchOpen && <div className="terminal-search"><label htmlFor={`terminal-search-${terminalId}`}>终端搜索</label><input id={`terminal-search-${terminalId}`} autoFocus value={searchValue} onChange={(event) => updateSearch(event.target.value)} placeholder="搜索终端输出" /></div>}
      <div className="terminal-canvas" ref={mountRef} />
      {session.state.error && <div className="terminal-error" role="alert"><strong>{session.state.error.message}</strong><button className="button button-ghost button-small" type="button" onClick={session.reconnect}>重新连接</button></div>}
      {session.state.hostKey && <HostKeyDialog challenge={session.state.hostKey} onDecision={session.decideHostKey} />}
    </section>
  );
};
