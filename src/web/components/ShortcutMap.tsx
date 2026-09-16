import { useMemo, useState } from 'react';

import {
  filterShortcutDefinitions,
  shortcutDefinitions,
  shortcutScopeLabels,
  type ShortcutDefinition
} from '../state/shortcut-map';

export interface ShortcutMapProps {
  definitions?: readonly ShortcutDefinition[];
}

export const ShortcutMap = ({ definitions = shortcutDefinitions }: ShortcutMapProps) => {
  const [query, setQuery] = useState('');
  const visibleDefinitions = useMemo(() => filterShortcutDefinitions(definitions, query), [definitions, query]);

  return (
    <section className="shortcut-map" aria-label="快捷键">
      <div className="shortcut-map-heading">
        <div><p className="eyebrow">KEYBOARD</p><h3>快捷键</h3></div>
        <span className="shortcut-map-count">{visibleDefinitions.length}/{definitions.length}</span>
      </div>
      <label className="search-field shortcut-map-search" htmlFor="shortcut-map-search">
        <span aria-hidden="true">⌕</span>
        <span className="visually-hidden">搜索快捷键</span>
        <input
          id="shortcut-map-search"
          type="search"
          role="searchbox"
          aria-label="搜索快捷键"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索功能或按键"
          autoComplete="off"
        />
      </label>
      <ul className="shortcut-map-list">
        {visibleDefinitions.map((definition) => (
          <li className="shortcut-map-item" key={definition.id}>
            <span className="shortcut-map-item-label">{definition.label}</span>
            <span className="shortcut-map-item-meta">
              <kbd>{definition.keys}</kbd>
              <small>{shortcutScopeLabels[definition.scope]}</small>
            </span>
          </li>
        ))}
        {visibleDefinitions.length === 0 && <li className="shortcut-map-empty">没有匹配的快捷键</li>}
      </ul>
    </section>
  );
};
