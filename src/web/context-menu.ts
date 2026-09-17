import type { MouseEvent as ReactMouseEvent } from 'react';

export type ContextMenuTone = 'default' | 'danger';

export interface ContextMenuPosition {
  x: number;
  y: number;
}

export interface ContextMenuItem {
  id: string;
  label: string;
  shortcut?: string;
  disabled?: boolean;
  tone?: ContextMenuTone;
  separatorBefore?: boolean;
  onSelect: () => void | Promise<void>;
}

export interface ContextMenuState<T> {
  target: T;
  position: ContextMenuPosition;
}

export interface ContextMenuController<T> {
  state: ContextMenuState<T> | null;
  open: (event: ReactMouseEvent, target: T) => void;
  close: () => void;
}

const NATIVE_CONTEXT_MENU_SELECTOR = 'input, textarea, select, [contenteditable="true"], a, [data-native-context-menu="true"]';

export const isNativeContextMenuTarget = (target: EventTarget | null): boolean => {
  if (typeof Element === 'undefined') return false;
  const element = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  return element?.closest(NATIVE_CONTEXT_MENU_SELECTOR) !== null;
};
