export type ShortcutScope = 'global' | 'workspace' | 'terminal' | 'sftp';

export type ShortcutCommand = 'quick-switch' | 'new-terminal' | 'close-tab' | 'focus-pane' | 'open-sftp' | 'open-snippets';

export interface ShortcutDefinition {
  id: string;
  label: string;
  keys: string;
  scope: ShortcutScope;
  command: ShortcutCommand;
}

export const shortcutDefinitions: readonly ShortcutDefinition[] = [
  { id: 'quick-switch', label: '快速切换', keys: 'Ctrl/Cmd+K', scope: 'global', command: 'quick-switch' },
  { id: 'new-terminal', label: '新建终端', keys: 'Ctrl/Cmd+N', scope: 'workspace', command: 'new-terminal' },
  { id: 'close-tab', label: '关闭终端标签', keys: 'Ctrl/Cmd+W', scope: 'workspace', command: 'close-tab' },
  { id: 'focus-pane', label: '聚焦面板', keys: 'Alt+1–4', scope: 'workspace', command: 'focus-pane' },
  { id: 'open-sftp', label: '打开远程文件', keys: 'Ctrl/Cmd+Shift+F', scope: 'terminal', command: 'open-sftp' },
  { id: 'open-snippets', label: '打开命令片段', keys: 'Ctrl/Cmd+Shift+P', scope: 'terminal', command: 'open-snippets' }
];

export const shortcutScopeLabels: Record<ShortcutScope, string> = {
  global: '全局',
  workspace: '工作区',
  terminal: '终端',
  sftp: '文件'
};

const normalized = (value: string): string => value.trim().toLocaleLowerCase().replace(/[\s+_–-]+/gu, '').replaceAll('/', '');

export const filterShortcutDefinitions = (
  definitions: readonly ShortcutDefinition[],
  query: string
): ShortcutDefinition[] => {
  const search = normalized(query);
  if (!search) return [...definitions];
  return definitions.filter((definition) => [
    definition.id,
    definition.label,
    definition.keys,
    shortcutScopeLabels[definition.scope]
  ].some((value) => normalized(value).includes(search)));
};

const isHTMLElement = (target: EventTarget | null): target is HTMLElement => (
  typeof HTMLElement !== 'undefined' && target instanceof HTMLElement
);

export const isTerminalInputTarget = (target: EventTarget | null): boolean => (
  isHTMLElement(target) && target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea')
);

export const isEditableTarget = (target: EventTarget | null): boolean => (
  (typeof HTMLInputElement !== 'undefined' && target instanceof HTMLInputElement)
  || (typeof HTMLTextAreaElement !== 'undefined' && target instanceof HTMLTextAreaElement)
  || (typeof HTMLSelectElement !== 'undefined' && target instanceof HTMLSelectElement)
  || (isHTMLElement(target) && (target.isContentEditable || target.closest('[contenteditable="true"]') !== null))
);

export interface ShortcutEventContext {
  terminalView: boolean;
}

export const shortcutCommandForEvent = (
  event: KeyboardEvent,
  { terminalView }: ShortcutEventContext
): ShortcutCommand | null => {
  const key = event.key.toLowerCase();
  const terminalInput = isTerminalInputTarget(event.target);
  const editable = isEditableTarget(event.target);

  if (isHTMLElement(event.target) && event.target.closest('[role="dialog"]') !== null) return null;
  if (editable && !terminalInput) return null;
  if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && /^[1-4]$/.test(event.key)) {
    return terminalInput ? null : 'focus-pane';
  }
  if (!(event.ctrlKey || event.metaKey)) return null;

  // Ctrl/Cmd+C belongs to the terminal/browser selection model. Relay must
  // never prevent it, even when the event comes from an xterm helper input.
  if (key === 'c') return null;
  if (key === 'k') return terminalInput ? null : 'quick-switch';
  if (key === 'n') return terminalView ? 'new-terminal' : null;
  if (key === 'w') return terminalView ? 'close-tab' : null;
  if (event.shiftKey && key === 'f') return terminalView ? 'open-sftp' : null;
  if (event.shiftKey && key === 'p') return 'open-snippets';
  return null;
};
