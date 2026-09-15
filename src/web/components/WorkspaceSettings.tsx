import { useState } from 'react';

import type { ImportPreviewResponse, ImportResultResponse, ExternalImportResultResponse } from '../api';
import type { ExportOptions, ImportedCredential, ImportApplyRequest, ImportFormat, ImportPreview } from '../../shared/import/types';

export interface WorkspaceSettingsProps {
  onClose: () => void;
  onExport: (password: string) => Promise<string>;
  onPreviewImport: (password: string, bundle: string) => Promise<ImportPreviewResponse>;
  onApplyImport: (previewId: string, resolution: { hostConflicts: 'skip' | 'replace'; groupConflicts: 'reuse' | 'replace' }) => Promise<ImportResultResponse>;
  onPreviewExternalImport: (files: readonly File[], formatHint?: ImportFormat) => Promise<ImportPreview>;
  onApplyExternalImport: (previewId: string, input: ImportApplyRequest) => Promise<ExternalImportResultResponse>;
  onExportOpenSsh: () => Promise<Blob>;
  onExportCsv: (options?: ExportOptions) => Promise<Blob>;
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

const downloadBlob = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const WorkspaceSettings = ({ onClose, onExport, onPreviewImport, onApplyImport, onPreviewExternalImport, onApplyExternalImport, onExportOpenSsh, onExportCsv }: WorkspaceSettingsProps) => {
  const [password, setPassword] = useState('');
  const [bundle, setBundle] = useState('');
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [resolution, setResolution] = useState<{ hostConflicts: 'skip' | 'replace'; groupConflicts: 'reuse' | 'replace' }>({ hostConflicts: 'skip', groupConflicts: 'reuse' });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [externalFiles, setExternalFiles] = useState<File[]>([]);
  const [externalFormat, setExternalFormat] = useState<ImportFormat | ''>('');
  const [externalPreview, setExternalPreview] = useState<ImportPreview | null>(null);
  const [externalSelectedIds, setExternalSelectedIds] = useState<string[]>([]);
  const [externalCredentials, setExternalCredentials] = useState<Record<string, ImportedCredential>>({});
  const [externalConflictPolicy, setExternalConflictPolicy] = useState<'skip' | 'create' | 'replace'>('skip');
  const [includeExportPasswords, setIncludeExportPasswords] = useState(false);

  const clearExternalState = (): void => {
    setExternalFiles([]);
    setExternalPreview(null);
    setExternalSelectedIds([]);
    setExternalCredentials({});
    setExternalFormat('');
  };

  const close = (): void => {
    setPassword('');
    setBundle('');
    clearExternalState();
    onClose();
  };

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

  const runExternalPreview = async (): Promise<void> => {
    if (externalFiles.length === 0) {
      setMessage('请先选择要导入的配置文件。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const next = await onPreviewExternalImport(externalFiles, externalFormat || undefined);
      setExternalPreview(next);
      setExternalSelectedIds(next.connections.filter((connection) => connection.applicable).map((connection) => connection.sourceId));
      setExternalCredentials({});
      setMessage('已生成跨产品导入预览，请检查凭据和冲突。');
    } catch {
      setMessage('跨产品预览失败，请检查文件格式。');
    } finally {
      setBusy(false);
    }
  };

  const setExternalCredential = (connection: ImportPreview['connections'][number], value: string): void => {
    const credential: ImportedCredential = connection.authType === 'private_key'
      ? { type: 'private_key', privateKey: value }
      : { type: 'password', password: value };
    setExternalCredentials((current) => ({ ...current, [connection.sourceId]: credential }));
    setExternalSelectedIds((current) => current.includes(connection.sourceId) ? current : [...current, connection.sourceId]);
  };

  const runExternalApply = async (): Promise<void> => {
    if (!externalPreview) return;
    const selected = externalPreview.connections.filter((connection) => externalSelectedIds.includes(connection.sourceId));
    const missingCredential = selected.some((connection) => connection.credentialState !== 'ready' && !externalCredentials[connection.sourceId]);
    if (missingCredential) {
      setMessage('请为已选择的记录补录凭据，或取消选择不完整记录。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const credentials = selected.flatMap((connection) => {
        const credential = externalCredentials[connection.sourceId];
        return credential ? [{ sourceId: connection.sourceId, credential }] : [];
      });
      const result = await onApplyExternalImport(externalPreview.previewId, {
        selectedSourceIds: selected.map((connection) => connection.sourceId),
        conflictPolicy: externalConflictPolicy,
        credentials
      });
      clearExternalState();
      setMessage(`跨产品导入完成：${result.importedHosts} 台服务器，${result.importedGroups} 个分组。`);
    } catch {
      setMessage('跨产品导入失败，现有数据未被部分覆盖。');
    } finally {
      setBusy(false);
    }
  };

  const runExternalExport = async (kind: 'openssh' | 'csv'): Promise<void> => {
    if (kind === 'csv' && includeExportPasswords && !window.confirm('导出的 CSV 将包含服务器密码，请确认仅在安全环境中保存。')) return;
    setBusy(true);
    setMessage(null);
    try {
      const options: ExportOptions = includeExportPasswords ? { includePasswords: true, confirmPasswordExport: true } : {};
      const blob = kind === 'openssh' ? await onExportOpenSsh() : await onExportCsv(options);
      downloadBlob(blob, kind === 'openssh' ? 'ssh-config' : 'ssh-connections.csv');
      setIncludeExportPasswords(false);
      setMessage('标准配置已生成，请注意文件中的敏感信息。');
    } catch {
      setMessage('标准配置导出失败。');
    } finally {
      setBusy(false);
    }
  };

  const externalApplyReady = externalPreview !== null && externalSelectedIds.length > 0 && externalPreview.connections
    .filter((connection) => externalSelectedIds.includes(connection.sourceId))
    .every((connection) => !connection.conflicts.some((conflict) => conflict.kind === 'unresolved-jump') && (connection.credentialState === 'ready' || Boolean(externalCredentials[connection.sourceId])));

  return (
    <div className="preferences-backdrop" role="presentation" onMouseDown={close}>
      <aside className="preferences-panel workspace-settings-panel" role="dialog" aria-modal="true" aria-labelledby="workspace-settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="form-heading">
          <div><p className="eyebrow">WORKSPACE DATA</p><h2 id="workspace-settings-title">工作区与加密数据</h2></div>
          <button className="icon-button" type="button" aria-label="关闭工作区设置" onClick={close}>×</button>
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
        <div className="workspace-settings-section">
          <h3>跨产品迁移</h3>
          <p className="preferences-note">导入 MobaXterm、Termius/通用 CSV、OpenSSH、Xshell 或 SecureCRT 配置。源密码不可读取时，只显示状态并要求补录。</p>
          <label htmlFor="external-import-files">外部配置文件</label>
          <input id="external-import-files" type="file" multiple accept=".config,.conf,.ssh_config,.csv,.mxtsessions,.mobaconf,.xsh,.xml,.ini,.zip" onChange={(event) => { setExternalFiles([...event.target.files ?? []]); setExternalPreview(null); }} />
          <label htmlFor="external-import-format">外部格式</label>
          <select id="external-import-format" value={externalFormat} onChange={(event) => setExternalFormat(event.target.value as ImportFormat | '')}>
            <option value="">自动识别</option>
            <option value="openssh-config">OpenSSH config</option>
            <option value="ssh-csv">SSH / Termius CSV</option>
            <option value="mobaxterm">MobaXterm</option>
            <option value="xshell">Xshell</option>
            <option value="securecrt">SecureCRT</option>
          </select>
          <div className="workspace-settings-actions">
            <button className="button button-ghost" type="button" disabled={busy || externalFiles.length === 0} onClick={() => void runExternalPreview()}>预览跨产品导入</button>
            <button className="button button-ghost" type="button" disabled={busy} onClick={() => void runExternalExport('openssh')}>导出 OpenSSH 配置</button>
            <button className="button button-ghost" type="button" disabled={busy} onClick={() => void runExternalExport('csv')}>导出通用 CSV</button>
          </div>
          <label className="checkbox-row"><input type="checkbox" checked={includeExportPasswords} onChange={(event) => setIncludeExportPasswords(event.target.checked)} />包含密码导出（需确认）</label>
          {externalPreview && <div className="workspace-import-preview" role="status">
            <strong>跨产品预览</strong>
            <span>{externalPreview.connectionCount} 台服务器 · {externalPreview.groupCount} 个分组</span>
            <span>{externalPreview.conflicts.length === 0 ? '没有冲突' : `发现 ${externalPreview.conflicts.length} 个冲突`}</span>
            {externalPreview.warnings.length > 0 && <ul>{externalPreview.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
            <label htmlFor="external-conflict-policy">冲突处理</label>
            <select id="external-conflict-policy" value={externalConflictPolicy} onChange={(event) => setExternalConflictPolicy(event.target.value as 'skip' | 'create' | 'replace')}>
              <option value="skip">跳过现有服务器</option>
              <option value="create">创建为新服务器</option>
              <option value="replace">替换现有服务器</option>
            </select>
            {externalPreview.connections.map((connection) => {
              const selected = externalSelectedIds.includes(connection.sourceId);
              const needsCredential = connection.credentialState !== 'ready';
              const credential = externalCredentials[connection.sourceId];
              const privateKeyValue = credential?.type === 'private_key' ? credential.privateKey : '';
              const passwordValue = credential?.type === 'password' ? credential.password : '';
              return <div className="workspace-import-record" key={connection.sourceId}>
                <label className="checkbox-row"><input type="checkbox" aria-label={`选择 ${connection.name}`} disabled={connection.conflicts.some((conflict) => conflict.kind === 'unresolved-jump')} checked={selected} onChange={(event) => setExternalSelectedIds((current) => event.target.checked ? [...current, connection.sourceId] : current.filter((id) => id !== connection.sourceId))} />{connection.name} · {connection.address}:{connection.port}</label>
                <span>{connection.credentialState === 'ready' ? '凭据可导入' : '需要补录凭据'}</span>
                {connection.conflicts.map((conflict) => <small key={`${connection.sourceId}-${conflict.kind}`}>{conflict.message}</small>)}
                {needsCredential && <label htmlFor={`external-credential-${connection.sourceId}`}>为 {connection.name} 补录{connection.authType === 'private_key' ? '私钥' : '密码'}
                  {connection.authType === 'private_key' ? <textarea id={`external-credential-${connection.sourceId}`} value={privateKeyValue} onChange={(event) => setExternalCredential(connection, event.target.value)} /> : <input id={`external-credential-${connection.sourceId}`} type="password" autoComplete="new-password" value={passwordValue} onChange={(event) => setExternalCredential(connection, event.target.value)} />}
                </label>}
                {connection.notes.map((note) => <small key={note}>{note}</small>)}
              </div>;
            })}
            <button className="button button-primary" type="button" disabled={busy || !externalApplyReady} onClick={() => void runExternalApply()}>应用跨产品导入</button>
          </div>}
        </div>
        {message && <p className="preferences-note" role="status">{message}</p>}
      </aside>
    </div>
  );
};
