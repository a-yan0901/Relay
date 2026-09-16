import { useMemo, useState } from 'react';

import type { SnippetMetadata } from '../../shared/core/models';
import { filterSnippetMetadata } from '../state/navigation-state';
import { Dialog } from './Dialog';

export interface SnippetPaletteProps {
  snippets: readonly SnippetMetadata[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

export const SnippetPalette = ({ snippets, onSelect, onClose }: SnippetPaletteProps) => {
  const [query, setQuery] = useState('');
  const visibleSnippets = useMemo(() => filterSnippetMetadata(snippets, query), [query, snippets]);

  return (
    <Dialog title="命令片段" onClose={onClose} initialFocusSelector="#snippet-palette-search" className="snippet-palette-dialog">
      <label className="search-field"><span aria-hidden="true">⌕</span><span className="visually-hidden">搜索命令片段</span><input id="snippet-palette-search" aria-label="搜索命令片段" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、描述或标签" /></label>
      <div className="snippet-palette-list" role="listbox" aria-label="可用命令片段">{visibleSnippets.map((snippet) => <button className="snippet-palette-item" type="button" role="option" key={snippet.id} aria-label={`使用片段 ${snippet.name}`} onClick={() => onSelect(snippet.id)}><strong>{snippet.name}</strong><small>{snippet.description || snippet.tags.join(' · ') || '无描述'}</small></button>)}{visibleSnippets.length === 0 && <p className="target-picker-empty">没有匹配的命令片段</p>}</div>
      <p className="dialog-copy snippet-palette-hint">选择后会进入批量执行预览，不会跳过确认。</p>
    </Dialog>
  );
};
