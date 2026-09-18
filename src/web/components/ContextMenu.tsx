import { useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

import type { ContextMenuItem, ContextMenuPosition, ContextMenuState } from '../context-menu';

export interface ContextMenuProps {
  state: ContextMenuState<unknown>;
  items: readonly ContextMenuItem[];
  onClose: () => void;
  ariaLabel?: string;
}

const enabledItemIndices = (items: readonly ContextMenuItem[]): number[] => items
  .map((item, index) => item.disabled ? -1 : index)
  .filter((index) => index >= 0);

const focusItem = (refs: RefObject<Array<HTMLButtonElement | null>>, items: readonly ContextMenuItem[], index: number): void => {
  if (items[index]?.disabled) return;
  refs.current[index]?.focus();
};

const boundedPosition = (position: ContextMenuPosition, width: number, height: number): ContextMenuPosition => {
  const margin = 8;
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  return { x: Math.min(Math.max(margin, position.x), maxX), y: Math.min(Math.max(margin, position.y), maxY) };
};

export const ContextMenu = ({ state, items, onClose, ariaLabel = '上下文菜单' }: ContextMenuProps) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState(state.position);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const rect = menu.getBoundingClientRect();
    const nextPosition = boundedPosition(state.position, rect.width, rect.height);
    if (nextPosition.x !== position.x || nextPosition.y !== position.y) {
      setPosition(nextPosition);
      return;
    }
    const firstEnabled = enabledItemIndices(items)[0];
    if (firstEnabled !== undefined) itemRefs.current[firstEnabled]?.focus({ preventScroll: true });
  }, [items, position, state.position]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const enabled = enabledItemIndices(items);
    if (enabled.length === 0) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
      return;
    }
    const currentIndex = itemRefs.current.findIndex((item) => item === document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const currentEnabledIndex = enabled.indexOf(currentIndex);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      const nextEnabledIndex = currentEnabledIndex < 0
        ? 0
        : (currentEnabledIndex + delta + enabled.length) % enabled.length;
      focusItem(itemRefs, items, enabled[nextEnabledIndex]);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      focusItem(itemRefs, items, event.key === 'Home' ? enabled[0] : enabled.at(-1)!);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  return <div
    ref={menuRef}
    className="context-menu"
    data-context-menu="true"
    role="menu"
    aria-label={ariaLabel}
    style={{ left: `${position.x}px`, top: `${position.y}px` }}
    onKeyDown={handleKeyDown}
    onContextMenu={(event) => event.preventDefault()}
  >
    {items.map((item, index) => <div key={item.id}>
      {item.separatorBefore && <div className="context-menu-separator" role="separator" />}
      <button
        ref={(element) => { itemRefs.current[index] = element; }}
        className={`context-menu-item${item.tone === 'danger' ? ' is-danger' : ''}`}
        type="button"
        role="menuitem"
        aria-disabled={item.disabled || undefined}
        disabled={item.disabled}
        onClick={() => {
          if (item.disabled) return;
          void item.onSelect();
          onClose();
        }}
      >
        <span>{item.label}</span>
        {item.shortcut && <kbd className="context-menu-shortcut">{item.shortcut}</kbd>}
      </button>
    </div>)}
  </div>;
};
