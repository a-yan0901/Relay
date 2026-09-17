// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OperationDiagnostic } from '../../../src/shared/core/models';
import type { ClipboardPort } from '../../../src/shared/core/ports';
import type { HostMetadataState } from '../../../src/web/state/app-state';
import { TerminalPanel } from '../../../src/web/components/TerminalPanel';

const testState = vi.hoisted(() => ({
  terminalInstances: [] as Array<{ constructorOptions: Record<string, unknown> }>,
  terminalOutputs: [] as Array<string | Uint8Array>,
  onOutput: null as ((data: Uint8Array) => void) | null,
  selection: 'selected terminal output',
  selectionActive: false,
  onSelectionChange: null as (() => void) | null,
  customKeyEventHandler: null as ((event: KeyboardEvent) => boolean) | null,
  selectAll: vi.fn(),
  diagnostics: [] as OperationDiagnostic[],
  credential: null as { hostId: string; authType: 'password' | 'private_key'; name: string; address: string; port: number; username: string } | null,
  submitCredential: vi.fn(),
  sendInput: vi.fn(),
  resize: vi.fn()
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class FakeTerminal {
    readonly cols = 80;
    readonly rows = 24;
    readonly options = { fontSize: 14, theme: {} };

    constructor(readonly constructorOptions: Record<string, unknown>) {
      testState.terminalInstances.push(this);
    }

    write(data: string | Uint8Array): void {
      testState.terminalOutputs.push(data);
    }

    loadAddon(): void {}

    open(mount: HTMLElement): void {
      const root = document.createElement('div');
      root.className = 'xterm';
      root.appendChild(document.createElement('div')).className = 'xterm-viewport';
      root.appendChild(document.createElement('div')).className = 'xterm-screen';
      mount.appendChild(root);
    }

    focus(): void {}

    onData(): { dispose: () => void } {
      return { dispose: () => {} };
    }

    onBinary(): { dispose: () => void } {
      return { dispose: () => {} };
    }

    onResize(): { dispose: () => void } {
      return { dispose: () => {} };
    }

    onSelectionChange(handler: () => void): { dispose: () => void } {
      testState.onSelectionChange = handler;
      return { dispose: () => { testState.onSelectionChange = null; } };
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void {
      testState.customKeyEventHandler = handler;
    }

    getSelection(): string {
      return testState.selection;
    }

    hasSelection(): boolean {
      return testState.selectionActive;
    }

    selectAll(): void {
      testState.selectAll();
    }

    clearSelection(): void {}

    refresh(): void {}

    dispose(): void {}
  }
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class FakeFitAddon {
    fit(): void {}
  }
}));

vi.mock('@xterm/addon-search', () => ({
  SearchAddon: class FakeSearchAddon {
    findNext(): void {}
    clearDecorations(): void {}
  }
}));

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class FakeWebLinksAddon {
    constructor() {}
  }
}));

vi.mock('../../../src/web/hooks/use-terminal-session', () => ({
  useTerminalSession: (options: { onOutput?: (data: Uint8Array) => void }) => {
    testState.onOutput = options.onOutput ?? null;
    return {
      state: { state: testState.credential ? 'awaiting-credential' : 'connected', reconnectDelayMs: 0, error: null, hostKey: null, credential: testState.credential, diagnostics: testState.diagnostics },
      resize: testState.resize,
      sendInput: testState.sendInput,
      decideHostKey: () => {},
      submitCredential: testState.submitCredential,
      reconnect: () => {}
    };
  }
}));

const host: HostMetadataState = {
  id: 'host-1',
  name: 'Production',
  address: 'prod.internal',
  port: 22,
  username: 'ops',
  authType: 'password',
  groupId: null,
  tags: [],
  isFavorite: false,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  lastConnectedAt: null,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z'
};

describe('TerminalPanel mobile selection', () => {
  beforeEach(() => {
    testState.terminalInstances.length = 0;
    testState.terminalOutputs.length = 0;
    testState.onOutput = null;
    testState.selection = 'selected terminal output';
    testState.selectionActive = false;
    testState.onSelectionChange = null;
    testState.customKeyEventHandler = null;
    testState.selectAll.mockReset();
    testState.diagnostics.length = 0;
    testState.credential = null;
    testState.submitCredential.mockReset();
    testState.sendInput.mockReset();
    testState.resize.mockReset();
    vi.stubGlobal('requestAnimationFrame', (callback: (timestamp: number) => void) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('updates xterm colors and font size when the application theme changes', () => {
    const { rerender } = render(<TerminalPanel terminalId="terminal-theme" host={host} active onClose={() => {}} preferences={{ theme: 'midnight', fontSize: 13 }} />);
    const terminal = testState.terminalInstances[0] as unknown as { options: { theme: { background?: string }; fontSize: number } };
    expect(terminal.options.theme.background).toBe('#07111f');
    rerender(<TerminalPanel terminalId="terminal-theme" host={host} active onClose={() => {}} preferences={{ theme: 'light', fontSize: 16 }} />);
    expect(terminal.options.theme.background).toBe('#f5f8fc');
    expect(terminal.options.fontSize).toBe(16);
  });

  it('enables word selection for long-press context menus on touch devices', () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 });
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} />);

    expect(testState.terminalInstances[0]?.constructorOptions.rightClickSelectsWord).toBe(true);
  });

  it('keeps desktop right-click behavior unchanged', () => {
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} />);

    expect(testState.terminalInstances[0]?.constructorOptions.rightClickSelectsWord).toBe(false);
  });

  it('removes the redundant session heading and exposes its tools to the workspace bar', () => {
    const onToolbarChange = vi.fn();
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} onToolbarChange={onToolbarChange} />);

    expect(document.querySelector('.terminal-panel-heading')).not.toBeInTheDocument();
    expect(onToolbarChange).toHaveBeenCalledWith('terminal-1', expect.objectContaining({ state: 'connected' }));
    expect(screen.queryByText('SSH SESSION')).not.toBeInTheDocument();
  });

  it('keeps binary log control bytes from hiding later terminal output', () => {
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} />);

    testState.onOutput?.(Uint8Array.from([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x72, 0x65, 0x64, 0xc2]));
    testState.onOutput?.(Uint8Array.from([0x9b, 0x38, 0x6d, 0x70, 0x72, 0x6f, 0x6d, 0x70, 0x74]));

    const output = testState.terminalOutputs.flatMap((data) => typeof data === 'string' ? [...data].map((character) => character.codePointAt(0) ?? 0) : [...data]);
    expect(output).toEqual([0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x72, 0x65, 0x64, 0x38, 0x6d, 0x70, 0x72, 0x6f, 0x6d, 0x70, 0x74]);
  });

  it('preserves regular UTF-8 characters while filtering C1 controls', () => {
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} />);

    testState.onOutput?.(Uint8Array.from([0xc2, 0xa0, 0xe7, 0xbb, 0x88]));

    const output = testState.terminalOutputs.flatMap((data) => typeof data === 'string' ? [...data].map((character) => character.codePointAt(0) ?? 0) : [...data]);
    expect(output).toEqual([0xc2, 0xa0, 0xe7, 0xbb, 0x88]);
  });

  it('does not render connection diagnostics over the console area', () => {
    testState.diagnostics.push({
      operationId: 'terminal-1',
      hostId: 'host-1',
      kind: 'terminal',
      stage: 'pty',
      state: 'running',
      retryable: false,
      nextAction: 'wait',
      startedAt: '2026-09-16T00:00:00.000Z'
    });
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} />);

    expect(screen.queryByRole('status', { name: '连接诊断' })).not.toBeInTheDocument();
    expect(screen.queryByText('打开会话通道中')).not.toBeInTheDocument();
  });

  it('submits a password with Enter from the credential dialog', async () => {
    const user = userEvent.setup();
    testState.credential = {
      hostId: 'host-1',
      authType: 'password',
      name: 'Production',
      address: 'prod.internal',
      port: 22,
      username: 'ops'
    };
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} />);

    await user.type(screen.getByLabelText('密码'), 'filled-at-connect{Enter}');

    expect(testState.submitCredential).toHaveBeenCalledWith({ type: 'password', password: 'filled-at-connect' });
  });

  it('copies only the active terminal selection through the optional clipboard port', async () => {
    const clipboard: ClipboardPort = {
      readText: vi.fn(async () => ''),
      writeText: vi.fn(async () => undefined)
    };
    const onToolbarChange = vi.fn();
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} clipboard={clipboard} onToolbarChange={onToolbarChange} />);
    const toolbar = onToolbarChange.mock.calls[0]?.[1] as { onCopy?: () => Promise<void> };

    await toolbar.onCopy?.();

    expect(clipboard.writeText).toHaveBeenCalledWith('selected terminal output');
  });

  it('keeps copy enabled while paste is unavailable on a write-only clipboard', () => {
    testState.selectionActive = true;
    const clipboard: ClipboardPort = {
      canRead: false,
      canWrite: true,
      readText: vi.fn(async () => 'unavailable'),
      writeText: vi.fn(async () => undefined)
    };
    const onToolbarChange = vi.fn();
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} clipboard={clipboard} onToolbarChange={onToolbarChange} />);

    const toolbar = onToolbarChange.mock.calls[0]?.[1] as { onCopy?: () => Promise<void>; onPaste?: () => Promise<void> };
    expect(toolbar.onCopy).toEqual(expect.any(Function));
    expect(toolbar.onPaste).toBeUndefined();
    fireEvent.contextMenu(document.querySelector('.terminal-canvas')!, { clientX: 100, clientY: 80 });
    expect(screen.getByRole('menuitem', { name: /^复制/ })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: /^粘贴/ })).toHaveAttribute('aria-disabled', 'true');
  });

  it('requires confirmation before sending clipboard text to the terminal', async () => {
    const clipboard: ClipboardPort = {
      readText: vi.fn(async () => 'echo from clipboard'),
      writeText: vi.fn(async () => undefined)
    };
    const onToolbarChange = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} clipboard={clipboard} onToolbarChange={onToolbarChange} />);
    const toolbar = onToolbarChange.mock.calls[0]?.[1] as { onPaste?: () => Promise<void> };

    await toolbar.onPaste?.();

    expect(clipboard.readText).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('将粘贴 19 个字符到终端，是否继续？');
    expect(testState.sendInput).toHaveBeenCalledWith('echo from clipboard');
    confirm.mockRestore();
  });

  it('shows context actions for terminal selection and workspace shortcuts', async () => {
    const user = userEvent.setup();
    testState.selectionActive = true;
    const clipboard: ClipboardPort = {
      readText: vi.fn(async () => 'echo from context menu'),
      writeText: vi.fn(async () => undefined)
    };
    const onOpenSftp = vi.fn();
    const onNewTerminal = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} clipboard={clipboard} onOpenSftp={onOpenSftp} onNewTerminal={onNewTerminal} />);

    fireEvent.contextMenu(document.querySelector('.terminal-canvas')!, { clientX: 160, clientY: 120 });
    expect(screen.getByRole('menuitem', { name: /^复制/ })).not.toHaveAttribute('aria-disabled', 'true');
    await user.click(screen.getByRole('menuitem', { name: '全选' }));
    expect(testState.selectAll).toHaveBeenCalledOnce();

    fireEvent.contextMenu(document.querySelector('.terminal-canvas')!, { clientX: 160, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: /^复制/ }));
    expect(clipboard.writeText).toHaveBeenCalledWith('selected terminal output');

    fireEvent.contextMenu(document.querySelector('.terminal-canvas')!, { clientX: 160, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: /^粘贴/ }));
    expect(confirm).toHaveBeenCalledWith('将粘贴 22 个字符到终端，是否继续？');
    expect(testState.sendInput).toHaveBeenCalledWith('echo from context menu');

    fireEvent.contextMenu(document.querySelector('.terminal-canvas')!, { clientX: 160, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: '打开远程文件' }));
    fireEvent.contextMenu(document.querySelector('.terminal-canvas')!, { clientX: 160, clientY: 120 });
    await user.click(screen.getByRole('menuitem', { name: '新建 Console' }));
    expect(onOpenSftp).toHaveBeenCalledOnce();
    expect(onNewTerminal).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it('copies selected text with Ctrl+C but preserves remote interrupt without a selection', async () => {
    const clipboard: ClipboardPort = {
      readText: vi.fn(async () => ''),
      writeText: vi.fn(async () => undefined)
    };
    testState.selectionActive = true;
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} clipboard={clipboard} />);

    let result = true;
    await act(async () => {
      result = testState.customKeyEventHandler?.(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })) ?? true;
    });
    expect(result).toBe(false);
    expect(clipboard.writeText).toHaveBeenCalledWith('selected terminal output');

    cleanup();
    testState.selectionActive = false;
    render(<TerminalPanel terminalId="terminal-1" host={host} active onClose={() => {}} clipboard={clipboard} />);
    result = testState.customKeyEventHandler?.(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true })) ?? false;
    expect(result).toBe(true);
    expect(testState.sendInput).not.toHaveBeenCalledWith(expect.anything());
  });
});
