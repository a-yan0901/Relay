import { useMemo, useState } from 'react';

import type { Snippet, SnippetMetadata } from '../../shared/core/models';
import type { SnippetInput } from '../../shared/validation';
import { Dialog } from './Dialog';
import { SnippetEditor } from './SnippetEditor';

export interface SnippetManagerProps {
  snippets: readonly SnippetMetadata[];
  onGet: (id: string) => Promise<Snippet | null>;
  onCreate: (input: SnippetInput) => Promise<void> | void;
  onUpdate: (id: string, input: SnippetInput) => Promise<void> | void;
  onDelete: (id: string) => Promise<void> | void;
  onClose: () => void;
}

export const SnippetManager = ({ snippets, onGet, onCreate, onUpdate, onDelete, onClose }: SnippetManagerProps) => {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Snippet | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SnippetMetadata | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const visibleSnippets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return snippets;
    return snippets.filter((snippet) => [snippet.name, snippet.description ?? '', ...snippet.tags].join(' ').toLowerCase().includes(normalized));
  }, [query, snippets]);

  const edit = async (metadata: SnippetMetadata): Promise<void> => {
    setBusyId(metadata.id);
    setError(null);
    try {
      const snippet = await onGet(metadata.id);
      if (!snippet) {
        setError('命令片段不存在或已被删除');
        return;
      }
      setEditing(snippet);
    } catch {
      setError('无法读取命令片段，请稍后重试');
    } finally {
      setBusyId(null);
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (!deleting) return;
    setBusyId(deleting.id);
    setError(null);
    try {
      await onDelete(deleting.id);
      setDeleting(null);
    } catch {
      setError('删除命令片段失败，请稍后重试');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Dialog title="命令片段" onClose={onClose} initialFocusSelector="#snippet-create-button" className="snippet-manager-dialog">
      <p className="dialog-copy">把重复命令保存为可搜索的片段；命令内容只在使用时短暂读取。</p>
      <div className="snippet-manager-toolbar"><label className="search-field"><span aria-hidden="true">⌕</span><span className="visually-hidden">搜索片段</span><input aria-label="搜索片段" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、描述或标签" /></label><button id="snippet-create-button" className="button button-primary button-small" type="button" onClick={() => { setError(null); setEditing('new'); }}>新建片段</button></div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {visibleSnippets.length === 0 ? <div className="empty-state empty-state-compact"><h3>{snippets.length === 0 ? '还没有命令片段' : '没有匹配的片段'}</h3><p>{snippets.length === 0 ? '把常用检查或发布命令保存下来。' : '试试其它名称或标签。'}</p></div> : <div className="snippet-list" aria-label="命令片段列表">{visibleSnippets.map((snippet) => <article className="snippet-item" key={snippet.id}><div><strong>{snippet.name}</strong><small>{snippet.description || '无描述'}{snippet.tags.length > 0 ? ` · ${snippet.tags.join(' · ')}` : ''}</small></div><div className="snippet-item-actions"><button className="button button-ghost button-small" type="button" disabled={busyId === snippet.id} onClick={() => void edit(snippet)}>编辑 {snippet.name}</button><button className="button button-ghost button-small" type="button" disabled={busyId === snippet.id} onClick={() => setDeleting(snippet)}>删除</button></div></article>)}</div>}
      {editing !== null && <div className="snippet-editor-wrap"><SnippetEditor snippet={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSubmit={async (input) => { if (editing === 'new') await onCreate(input); else await onUpdate(editing.id, input); setEditing(null); }} /></div>}
      {deleting && <Dialog title={`删除片段 ${deleting.name}？`} onClose={() => setDeleting(null)} closeOnBackdrop={false} initialFocusSelector="#snippet-delete-confirm"><p className="dialog-copy">删除后不能从 Relay 恢复，但不会影响已经提交的任务。</p><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setDeleting(null)}>取消</button><button className="button button-primary" id="snippet-delete-confirm" type="button" disabled={busyId === deleting.id} onClick={() => void confirmDelete()}>确认删除</button></div></Dialog>}
    </Dialog>
  );
};
