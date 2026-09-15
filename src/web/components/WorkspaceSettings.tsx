import { useState } from 'react';

import type { ImportPreviewResponse, ImportResultResponse } from '../api';

export interface WorkspaceSettingsProps {
  onClose: () => void;
  onExport: (password: string) => Promise<string>;
  onPreviewImport: (password: string, bundle: string) => Promise<ImportPreviewResponse>;
  onApplyImport: (previewId: string, resolution: { hostConflicts: 'skip' | 'replace'; groupConflicts: 'reuse' | 'replace' }) => Promise<ImportResultResponse>;
}

const downloadBundle = (bundle: string): void => {
  const blob = new Blob([bundle], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `relay-vault-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const WorkspaceSettings = ({ onClose, onExport, onPreviewImport, onApplyImport }: WorkspaceSettingsProps) => {
  const [password, setPassword] = useState('');
  const [bundle, setBundle] = useState('');
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [resolution, setResolution] = useState<{ hostConflicts: 'skip' | 'replace'; groupConflicts: 'reuse' | 'replace' }>({ hostConflicts: 'skip', groupConflicts: 'reuse' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const runExport = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      downloadBundle(await onExport(password));
      setMessage('已生成加密数据包，请妥善保存。');
      setPassword('');
    } catch {
      setMessage('导出失败，请检查导出密码。');
    } finally {
      setBusy(false);
    }
  };

  const loadBundle = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      setBundle(await file.text());
      setPreview(null);
      setMessage('已读取数据包，点击“预览变更”检查导入内容。');
    } catch {
      setMessage('无法读取数据包。');
    }
  };

  const runPreview = async (): Promise<void> => {
    if (!bundle) {
      setMessage('请先选择加密数据包。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      setPreview(await onPreviewImport(password, bundle));
      setPassword('');
    } catch {
      setMessage('预览失败，数据包或导出密码可能不正确。');
    } finally {
      setBusy(false);
    }
  };

  const runApply = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await onApplyImport(preview.previewId, resolution);
      setMessage(`导入完成：${result.importedHosts} 台服务器，${result.importedGroups} 个分组。`);
      setPreview(null);
      setBundle('');
    } catch {
      setMessage('导入失败，现有数据未被部分覆盖。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="preferences-backdrop" role="presentation" onMouseDown={onClose}>
      <aside className="preferences-panel workspace-settings-panel" role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="form-heading">
          <div><p className="eyebrow">WORKSPACE DATA</p><h2 id="workspace-settings-title">工作区与加密数据</h2></div>
          <button className="icon-button" type="button" aria-label="关闭工作区设置" onClick={onClose}>×</button>
        </div>
        <p className="preferences-note">工作区只保存标签、布局和筛选意图。导出包中的凭据使用单独的导出密码加密，不会写入浏览器存储。</p>
        <div className="workspace-settings-section">
          <h3>导出加密数据</h3>
          <label htmlFor="vault-export-password">导出密码</label>
          <input id="vault-export-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <button className="button button-primary" type="button" disabled={busy || password.length === 0} onClick={() => void runExport()}>导出加密数据</button>
        </div>
        <div className="workspace-settings-section">
          <h3>导入加密数据</h3>
          <label htmlFor="vault-import-file">数据包文件</label>
          <input id="vault-import-file" type="file" accept="application/json,.json" onChange={(event) => void loadBundle(event.target.files?.[0])} />
          <label htmlFor="vault-import-password">导出密码</label>
          <input id="vault-import-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
          <div className="workspace-settings-actions">
            <button className="button button-ghost" type="button" disabled={busy || !bundle || password.length === 0} onClick={() => void runPreview()}>预览变更</button>
            {preview && <button className="button button-primary" type="button" disabled={busy} onClick={() => void runApply()}>确认导入</button>}
          </div>
          {preview && <div className="workspace-import-preview" role="status"><strong>预览结果</strong><span>{preview.hostCount} 台服务器 · {preview.groupCount} 个分组</span><span>{preview.conflicts.length === 0 ? '没有冲突' : `发现 ${preview.conflicts.length} 个冲突`}</span>{preview.conflicts.length > 0 && <><label htmlFor="host-conflict-resolution">服务器冲突</label><select id="host-conflict-resolution" value={resolution.hostConflicts} onChange={(event) => setResolution({ ...resolution, hostConflicts: event.target.value as 'skip' | 'replace' })}><option value="skip">跳过现有服务器</option><option value="replace">替换现有服务器</option></select><label htmlFor="group-conflict-resolution">分组冲突</label><select id="group-conflict-resolution" value={resolution.groupConflicts} onChange={(event) => setResolution({ ...resolution, groupConflicts: event.target.value as 'reuse' | 'replace' })}><option value="reuse">复用现有分组</option><option value="replace">替换现有分组</option></select></>}</div>}
        </div>
        {message && <p className="preferences-note" role="status">{message}</p>}
      </aside>
    </div>
  );
};
