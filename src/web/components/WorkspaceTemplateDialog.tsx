import { useState } from 'react';

import { Dialog } from './Dialog';

export interface WorkspaceTemplateDialogProps {
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}

export const WorkspaceTemplateDialog = ({ onSave, onClose }: WorkspaceTemplateDialogProps) => {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入工作区名称。');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSave(trimmed);
      onClose();
    } catch {
      setError('保存失败，请检查名称是否重复。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="保存工作区" onClose={onClose} initialFocusSelector="#workspace-template-name">
      <p className="dialog-copy">保存当前 Server 标签、筛选条件和分屏布局。工作区模板不包含密码、私钥或运行中的 Shell。</p>
      <label className="dialog-field-label" htmlFor="workspace-template-name">工作区名称</label>
      <input id="workspace-template-name" value={name} maxLength={120} placeholder="例如：生产排障" onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void submit(); }} />
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="button button-ghost" type="button" onClick={onClose} disabled={busy}>取消</button>
        <button className="button button-primary" type="button" onClick={() => void submit()} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </Dialog>
  );
};
