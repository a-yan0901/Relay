import { useMemo, useState } from 'react';

import type { HostMetadataState } from '../state/app-state';
import type { WorkspaceState, WorkspaceTemplate } from '../../shared/core/models';
import { Dialog } from './Dialog';
import { WorkspaceTemplateDialog } from './WorkspaceTemplateDialog';

export interface WorkspaceSwitcherProps {
  templates: readonly WorkspaceTemplate[];
  currentWorkspace: WorkspaceState;
  hosts: readonly HostMetadataState[];
  onOpen: (template: WorkspaceTemplate) => void;
  onSave: (name: string) => Promise<void>;
  onDelete: (templateId: string) => Promise<void>;
  onClose: () => void;
}

type PendingAction =
  | { type: 'open'; template: WorkspaceTemplate; closingHosts: string[] }
  | { type: 'delete'; template: WorkspaceTemplate };

export const WorkspaceSwitcher = ({ templates, currentWorkspace, hosts, onOpen, onSave, onDelete, onClose }: WorkspaceSwitcherProps) => {
  const [saveOpen, setSaveOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const hostNameById = useMemo(() => new Map(hosts.map((host) => [host.id, host.name])), [hosts]);
  const visibleTemplates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return templates.filter((template) => !normalizedQuery || template.name.toLowerCase().includes(normalizedQuery));
  }, [query, templates]);

  const requestOpen = (template: WorkspaceTemplate): void => {
    const templateHostByTabId = new Map(template.state.tabs.map((tab) => [tab.id, tab.hostId]));
    const closingHosts = currentWorkspace.tabs
      .filter((tab) => templateHostByTabId.get(tab.id) !== tab.hostId)
      .map((tab) => hostNameById.get(tab.hostId) ?? tab.hostId);
    if (closingHosts.length > 0) {
      setPendingAction({ type: 'open', template, closingHosts: [...new Set(closingHosts)] });
      return;
    }
    onOpen(template);
  };

  const confirmPending = async (): Promise<void> => {
    if (!pendingAction) return;
    setBusy(true);
    try {
      if (pendingAction.type === 'open') {
        onOpen(pendingAction.template);
        setPendingAction(null);
      } else {
        await onDelete(pendingAction.template.id);
        setPendingAction(null);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog title="工作区" onClose={onClose} initialFocusSelector="#workspace-template-search">
        <div className="workspace-switcher-heading">
          <p className="dialog-copy">按任务恢复一组 Server 标签和布局。模板只保存可重建的工作区意图。</p>
          <button className="button button-primary button-small" type="button" onClick={() => setSaveOpen(true)}>保存当前</button>
        </div>
        <label className="search-field workspace-template-search" htmlFor="workspace-template-search"><span aria-hidden="true">⌕</span><span className="visually-hidden">搜索工作区</span><input id="workspace-template-search" aria-label="搜索工作区" placeholder="搜索工作区" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="workspace-template-list" role="list" aria-label="工作区模板">
          {visibleTemplates.map((template) => (
            <div className="workspace-template-item" key={template.id} role="listitem">
              <button className="workspace-template-open" type="button" onClick={() => requestOpen(template)}>
                <strong>{template.name}</strong>
                <small>{template.state.tabs.length} 个 Console · {template.state.layout.mode === 'grid' ? '四格' : template.state.layout.mode === 'single' ? '单面板' : '分屏'}</small>
              </button>
              <button className="button button-ghost button-small" type="button" aria-label={`删除工作区 ${template.name}`} onClick={() => setPendingAction({ type: 'delete', template })}>删除</button>
            </div>
          ))}
          {visibleTemplates.length === 0 && <p className="sftp-empty-state">{templates.length === 0 ? '还没有保存的工作区。' : '没有匹配的工作区。'}</p>}
        </div>
      </Dialog>
      {saveOpen && <WorkspaceTemplateDialog onSave={onSave} onClose={() => setSaveOpen(false)} />}
      {pendingAction && (
        <Dialog title={pendingAction.type === 'open' ? '切换工作区' : '删除工作区'} onClose={() => setPendingAction(null)} closeOnBackdrop={!busy}>
          {pendingAction.type === 'open' ? (
            <>
              <p className="dialog-warning">切换到「{pendingAction.template.name}」会关闭当前未包含在模板中的 Console：</p>
              <ul className="workspace-closing-list">{pendingAction.closingHosts.map((hostName) => <li key={hostName}>{hostName}</li>)}</ul>
              <p className="dialog-copy">远程 Shell 不会被伪装成可恢复状态；模板只会重新打开对应 Server。</p>
            </>
          ) : <p className="dialog-warning">确定删除工作区「{pendingAction.template.name}」吗？此操作不可撤销。</p>}
          <div className="dialog-actions">
            <button className="button button-ghost" type="button" onClick={() => setPendingAction(null)} disabled={busy}>取消</button>
            <button className="button button-primary" type="button" onClick={() => void confirmPending()} disabled={busy}>{busy ? '处理中…' : pendingAction.type === 'open' ? '继续切换' : '确认删除'}</button>
          </div>
        </Dialog>
      )}
    </>
  );
};
