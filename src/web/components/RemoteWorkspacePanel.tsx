import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

import type { RemoteWorkspaceSession, RemoteWorkspaceState } from '../../shared/cloud/remote-workspace.js';
import type { ClipboardPort } from '../../shared/core/ports.js';
import { TERMINAL_SCROLLBACK_LINES, TerminalOutputSanitizer } from '../terminal-output';
import { DEFAULT_PREFERENCES, getTerminalTheme, type UiPreferences } from '../theme';

export interface RemoteWorkspacePanelProps {
  session: RemoteWorkspaceSession;
  label: string;
  onBack: () => void;
  preferences?: UiPreferences;
  clipboard?: ClipboardPort;
}

const statusLabel: Record<RemoteWorkspaceState['status'], string> = {
  connecting: '连接中',
  live: '实时同步',
  stale: '需要同步',
  closed: '已关闭',
  offline: '设备离线'
};

export const RemoteWorkspacePanel = ({ session, label, onBack, preferences = DEFAULT_PREFERENCES, clipboard }: RemoteWorkspacePanelProps) => {
  const mountRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const sanitizerRef = useRef(new TerminalOutputSanitizer());
  const [remoteState, setRemoteState] = useState<RemoteWorkspaceState>(session.state);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(session.state.terminals[0]?.sessionId ?? null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === 'state') {
        setRemoteState(event.state);
        if (selectedSessionId === null && event.state.terminals[0]) setSelectedSessionId(event.state.terminals[0].sessionId);
        return;
      }
      if (event.type === 'output' && event.sessionId === selectedSessionId) {
        const output = sanitizerRef.current.sanitize(new globalThis.TextEncoder().encode(event.payload));
        if (output.length > 0) terminalRef.current?.write(output);
      }
    });
    void session.connect().catch((error: unknown) => setFeedback(error instanceof Error ? error.message : '远程工作区连接失败'));
    return unsubscribe;
  }, [selectedSessionId, session]);

  useEffect(() => {
    if (!mountRef.current || terminalRef.current) return;
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: preferences.fontSize,
      lineHeight: 1.25,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      theme: getTerminalTheme(preferences.theme)
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(mountRef.current);
    terminalRef.current = terminal;
    fitRef.current = fitAddon;
    const fit = (): void => {
      try { fitAddon.fit(); } catch { /* hidden views can report zero dimensions */ }
    };
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(fit);
    resizeObserver?.observe(mountRef.current);
    fit();
    const dataDisposable = terminal.onData((data) => {
      void session.sendInput(selectedSessionId ?? '', data).catch((error: unknown) => setFeedback(error instanceof Error ? error.message : '输入未发送'));
    });
    return () => {
      resizeObserver?.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [preferences.fontSize, preferences.theme, selectedSessionId, session]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const selected = remoteState.terminals.find((item) => item.sessionId === selectedSessionId);
    if (!terminal || !selected) return;
    terminal.clear();
    sanitizerRef.current.reset();
    if (selected.screen) terminal.write(selected.screen);
    void session.requestResync(selected.sessionId, 0).catch(() => undefined);
    fitRef.current?.fit();
  }, [remoteState.terminals, selectedSessionId, session]);

  const copySelection = async (): Promise<void> => {
    const selected = terminalRef.current?.getSelection() ?? '';
    if (!selected) {
      setFeedback('请先选择要复制的内容');
      return;
    }
    try {
      await clipboard?.writeText(selected);
      setFeedback('已复制');
    } catch {
      setFeedback('复制失败，请检查剪贴板权限');
    }
  };

  const paste = async (): Promise<void> => {
    try {
      const value = await clipboard?.readText() ?? '';
      if (value) await session.sendInput(selectedSessionId ?? '', value);
    } catch {
      setFeedback('粘贴失败，请检查剪贴板权限');
    }
  };

  return (
    <section className="remote-workspace-panel" aria-label={`${label}远程工作区`}>
      <header className="remote-workspace-toolbar">
        <button className="button button-ghost button-small" type="button" onClick={onBack}>返回工作区</button>
        <div className="remote-workspace-title"><strong>{label}</strong><span>{statusLabel[remoteState.status]} · {remoteState.participantCount} 个设备在线</span></div>
        <div className="remote-workspace-actions">
          {remoteState.terminals.length > 1 && <label className="remote-workspace-terminal-select"><span className="visually-hidden">选择远程 Console</span><select value={selectedSessionId ?? ''} onChange={(event) => setSelectedSessionId(event.target.value)}>{remoteState.terminals.map((terminal) => <option key={terminal.sessionId} value={terminal.sessionId}>{terminal.title}</option>)}</select></label>}
          <button className="button button-ghost button-small" type="button" onClick={() => void copySelection()} disabled={!clipboard}>复制</button>
          <button className="button button-ghost button-small" type="button" onClick={() => void paste()} disabled={!clipboard}>粘贴</button>
        </div>
      </header>
      <div className="remote-workspace-canvas" ref={mountRef} />
      {remoteState.status !== 'live' && <div className="remote-workspace-overlay" role="status"><strong>{statusLabel[remoteState.status]}</strong><span>{remoteState.lastError ?? '正在等待工作区状态…'}</span>{(remoteState.status === 'offline' || remoteState.status === 'stale') && <button className="button button-ghost button-small" type="button" onClick={() => void session.connect().catch((error: unknown) => setFeedback(error instanceof Error ? error.message : '重连失败'))}>重新连接</button>}</div>}
      {feedback && <button className="remote-workspace-feedback" type="button" onClick={() => setFeedback(null)}>{feedback}</button>}
    </section>
  );
};
