// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostMetadataState } from '../../../src/web/state/app-state';
import { TerminalPanel } from '../../../src/web/components/TerminalPanel';

const testState = vi.hoisted(() => ({
  terminalInstances: [] as Array<{ constructorOptions: Record<string, unknown> }>
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class FakeTerminal {
    readonly cols = 80;
    readonly rows = 24;
    readonly options = { fontSize: 14, theme: {} };

    constructor(readonly constructorOptions: Record<string, unknown>) {
      testState.terminalInstances.push(this);
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
  useTerminalSession: () => ({
    state: { state: 'connected', reconnectDelayMs: 0, error: null, hostKey: null },
    resize: () => {},
    sendInput: () => {},
    decideHostKey: () => {},
    reconnect: () => {}
  })
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
});
