import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';

import { Dialog } from './Dialog';
import { filterQuickSwitcherItems, type QuickSwitcherItem } from '../state/navigation-state';

export interface QuickSwitcherProps {
  items: readonly QuickSwitcherItem[];
  onSelect: (item: QuickSwitcherItem) => void;
  onClose: () => void;
}

const itemTypeLabels: Record<QuickSwitcherItem['type'], string> = {
  host: 'Server',
  tab: '打开 Console',
  workspace: 'Workspace',
  snippet: 'Snippet'
};

const optionId = (index: number): string => `quick-switcher-option-${index}`;

export const QuickSwitcher = ({ items, onSelect, onClose }: QuickSwitcherProps) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const visibleItems = useMemo(() => filterQuickSwitcherItems(items, query), [items, query]);

  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => {
    if (visibleItems.length > 0 && activeIndex >= visibleItems.length) setActiveIndex(visibleItems.length - 1);
  }, [activeIndex, visibleItems.length]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((current) => visibleItems.length === 0 ? 0 : (current + 1) % visibleItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((current) => visibleItems.length === 0 ? 0 : (current - 1 + visibleItems.length) % visibleItems.length);
    } else if (event.key === 'Enter') {
      const item = visibleItems[activeIndex];
      if (item) {
        event.preventDefault();
        onSelect(item);
      }
    }
  };

  return (
    <Dialog title="快速切换" ariaLabel="快速切换" onClose={onClose} initialFocusSelector="#quick-switcher-search" className="quick-switcher-dialog">
      <div className="quick-switcher-content" onKeyDown={handleKeyDown}>
        <label className="search-field quick-switcher-search" htmlFor="quick-switcher-search">
          <span aria-hidden="true">⌕</span>
          <span className="visually-hidden">快速搜索</span>
          <input
            id="quick-switcher-search"
            aria-label="快速搜索"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-activedescendant={visibleItems[activeIndex] ? optionId(activeIndex) : undefined}
            placeholder="搜索 Server、Console、Workspace 或 Snippet"
            autoComplete="off"
          />
        </label>
        <div className="quick-switcher-results" role="listbox" aria-label="快速切换结果">
          {visibleItems.map((item, index) => (
            <button
              className={`quick-switcher-item ${index === activeIndex ? 'is-active' : ''}`}
              id={optionId(index)}
              key={`${item.type}:${item.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              tabIndex={-1}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => onSelect(item)}
            >
              <span className="quick-switcher-item-main"><strong>{item.label}</strong><small>{item.secondary}</small></span>
              <span className="quick-switcher-item-type">{itemTypeLabels[item.type]}</span>
            </button>
          ))}
          {visibleItems.length === 0 && <p className="quick-switcher-empty">没有匹配的结果</p>}
        </div>
        <p className="quick-switcher-hint">↑↓ 选择 · Enter 打开 · Esc 关闭</p>
      </div>
    </Dialog>
  );
};
