// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostMetadataState } from '../../../src/web/state/app-state';
import { TerminalPanel } from '../../../src/web/components/TerminalPanel';

const testState = vi.hoisted(() => ({
  terminalInstances: [] as Array<{ constructorOptions: Record<string, unknown> }>,
  terminalOutputs: [] as Array<string | Uint8Array>,
  onOutput: null as ((data: Uint8Array) => void) | null
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
      state: { state: 'connected', reconnectDelayMs: 0, error: null, hostKey: null },
      resize: () => {},
      sendInput: () => {},
      decideHostKey: () => {},
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
});
