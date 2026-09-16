import { useState } from 'react';

import type {
  ImportedCredential,
  ImportApplyRequest,
  ImportApplyResult,
  ImportFormat,
  ImportPreview,
  ImportSourceFile,
  VaultBundleApplyResult,
  VaultBundlePreview,
  VaultBundleResolution
} from '../../shared/import/types';

export type WorkspaceSettingsMode = 'import' | 'export';

export interface WorkspaceSettingsProps {
  mode: WorkspaceSettingsMode;
  onClose: () => void;
  onExport: (password: string) => Promise<string>;
  onPreviewImport: (password: string, bundle: string) => Promise<VaultBundlePreview>;
  onApplyImport: (previewId: string, resolution: VaultBundleResolution) => Promise<VaultBundleApplyResult>;
  onPreviewExternalImport: (files: readonly ImportSourceFile[], formatHint?: ImportFormat) => Promise<ImportPreview>;
  onApplyExternalImport: (previewId: string, input: ImportApplyRequest) => Promise<ImportApplyResult>;
}

const formatLabels: Record<string, string> = {
  'openssh-config': 'OpenSSH',
  'ssh-csv': 'SSH / Termius CSV',
  mobaxterm: 'MobaXterm',
  xshell: 'Xshell',
  securecrt: 'SecureCRT'
};

const isVaultBundle = (content: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return false;
    const candidate = parsed as { format?: unknown; version?: unknown };
    return candidate.format === 'webssh-vault' && candidate.version === 1;
  } catch {
    return false;
  }
};

const downloadBundle = (bundle: string): void => {
  const blob = new Blob([bundle], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `relay-vault-${new Date().toISOString().slice(0, 10)}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
};

export const WorkspaceSettings = ({ mode, onClose, onExport, onPreviewImport, onApplyImport, onPreviewExternalImport, onApplyExternalImport }: WorkspaceSettingsProps) => {
  const [password, setPassword] = useState('');
  const [files, setFiles] = useState<ImportSourceFile[]>([]);
  const [bundle, setBundle] = useState('');
  const [importKind, setImportKind] = useState<'vault' | 'external' | null>(null);
  const [vaultPreview, setVaultPreview] = useState<VaultBundlePreview | null>(null);
  const [vaultResolution, setVaultResolution] = useState<VaultBundleResolution>({ hostConflicts: 'skip', groupConflicts: 'reuse', identityConflicts: 'reuse' });
  const [externalPreview, setExternalPreview] = useState<ImportPreview | null>(null);
  const [externalSelectedIds, setExternalSelectedIds] = useState<string[]>([]);
  const [externalCredentials, setExternalCredentials] = useState<Record<string, ImportedCredential>>({});
  const [externalConflictPolicy, setExternalConflictPolicy] = useState<'skip' | 'create' | 'replace'>('skip');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const resetImport = (): void => {
    setFiles([]);
    setBundle('');
    setImportKind(null);
    setVaultPreview(null);
    setExternalPreview(null);
    setExternalSelectedIds([]);
    setExternalCredentials({});
    setExternalConflictPolicy('skip');
  };

  const close = (): void => {
    setPassword('');
    resetImport();
    onClose();
  };

  const loadImportFiles = async (selectedFiles: File[]): Promise<void> => {
    setVaultPreview(null);
    setExternalPreview(null);
    setExternalSelectedIds([]);
    setExternalCredentials({});
    setMessage(null);
    const firstFile = selectedFiles[0];
    if (!firstFile) {
      setImportKind(null);
      setBundle('');
      return;
    }
    try {
      const sources = await Promise.all(selectedFiles.map(async (file): Promise<ImportSourceFile> => ({ filename: file.name, content: await file.text() })));
      setFiles(sources);
      const content = sources[0]?.content;
      if (typeof content !== 'string') throw new Error('empty file');
      if (isVaultBundle(content)) {
        setImportKind('vault');
        setBundle(content);
        setMessage('识别为 Vault 数据包，请输入导出密码后预览。');
      } else {
        setImportKind('external');
        setBundle('');
        setMessage('识别为外部 SSH 配置，点击“预览导入”自动识别平台。');
      }
    } catch {
      setFiles([]);
      setImportKind('external');
      setBundle('');
      setMessage('已读取文件，点击“预览导入”继续识别。');
    }
  };

  const runImportPreview = async (): Promise<void> => {
    if (files.length === 0 || !importKind) {
      setMessage('请先选择要导入的文件。');
      return;
    }
    if (importKind === 'vault' && password.length === 0) {
      setMessage('请输入导出密码。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      if (importKind === 'vault') {
        setVaultPreview(await onPreviewImport(password, bundle));
        setPassword('');
        setMessage('已生成 Vault 导入预览，请确认变更。');
      } else {
        const next = await onPreviewExternalImport(files);
        setExternalPreview(next);
        setExternalSelectedIds(next.connections.filter((connection) => !connection.conflicts.some((conflict) => conflict.kind === 'unresolved-jump')).map((connection) => connection.sourceId));
        setExternalCredentials({});
        setMessage(`已识别为 ${formatLabels[next.source.format] ?? next.source.format}，请确认导入内容。`);
      }
    } catch {
      setMessage('预览失败，请检查文件格式或导出密码。');
    } finally {
      setBusy(false);
    }
  };

  const runVaultApply = async (): Promise<void> => {
    if (!vaultPreview) return;
    setBusy(true);
    setMessage(null);
    try {
      const result = await onApplyImport(vaultPreview.previewId, vaultResolution);
      setVaultPreview(null);
      setFiles([]);
      setBundle('');
      setImportKind(null);
      setMessage(`导入完成：${result.importedHosts} 台服务器，${result.importedGroups} 个分组。`);
    } catch {
      setMessage('导入失败，现有数据未被部分覆盖。');
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

  const externalApplyReady = externalPreview !== null && externalSelectedIds.length > 0 && externalPreview.connections
    .filter((connection) => externalSelectedIds.includes(connection.sourceId))
    .every((connection) => !connection.conflicts.some((conflict) => conflict.kind === 'unresolved-jump'));

  const runExternalApply = async (): Promise<void> => {
    if (!externalPreview) return;
    const selected = externalPreview.connections.filter((connection) => externalSelectedIds.includes(connection.sourceId));
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
      resetImport();
      setMessage(`导入完成：${result.importedHosts} 台服务器，${result.importedGroups} 个分组。`);
    } catch {
      setMessage('导入失败，现有数据未被部分覆盖。');
    } finally {
      setBusy(false);
    }
  };

  const runExport = async (): Promise<void> => {
    if (password.length === 0) {
      setMessage('请输入导出密码。');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      downloadBundle(await onExport(password));
      setPassword('');
      setMessage('导出完成，请妥善保存加密数据包。');
    } catch {
      setMessage('导出失败，请检查导出密码。');
    } finally {
      setBusy(false);
    }
  };

  const title = mode === 'import' ? '导入' : '导出';

  return (
    <div className="preferences-backdrop" role="presentation" onMouseDown={close}>
      <aside className="preferences-panel workspace-settings-panel" role="dialog" aria-modal="true" aria-labelledby="vault-transfer-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="form-heading">
          <div><p className="eyebrow">VAULT DATA</p><h2 id="vault-transfer-title">{title}</h2></div>
          <button className="icon-button" type="button" aria-label={`关闭${title}`} onClick={close}>×</button>
        </div>
        {mode === 'import' ? (
          <>
            <p className="preferences-note">上传 Vault 数据包或其它 SSH 客户端配置，系统会自动识别格式。</p>
            <div className="workspace-settings-section workspace-transfer-section">
              <label htmlFor="vault-import-file">导入文件</label>
              <input id="vault-import-file" type="file" multiple accept="application/json,.json,.config,.conf,.ssh_config,.csv,.mxtsessions,.mobaconf,.xsh,.xml,.ini,.zip" onChange={(event) => void loadImportFiles([...event.target.files ?? []])} />
              {importKind === 'vault' && <>
                <span className="workspace-import-kind">识别为 Vault 数据包</span>
                <label htmlFor="vault-import-password">导出密码</label>
                <input id="vault-import-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </>}
              {importKind === 'external' && <span className="workspace-import-kind">识别为其它平台配置，预览时自动识别具体格式</span>}
              <div className="workspace-settings-actions">
                <button className="button button-primary" type="button" disabled={busy || files.length === 0 || (importKind === 'vault' && password.length === 0)} onClick={() => void runImportPreview()}>预览导入</button>
                {(vaultPreview || externalPreview) && <button className="button button-primary" type="button" disabled={busy || (externalPreview !== null && !externalApplyReady)} onClick={() => void (vaultPreview ? runVaultApply() : runExternalApply())}>确认导入</button>}
              </div>
              {vaultPreview && <div className="workspace-import-preview" role="status"><strong>导入预览</strong><span>{vaultPreview.hostCount} 台服务器 · {vaultPreview.groupCount} 个分组 · {vaultPreview.identityCount ?? 0} 个身份</span><span>{vaultPreview.conflicts.length === 0 ? '没有冲突' : `发现 ${vaultPreview.conflicts.length} 个冲突`}</span>{vaultPreview.conflicts.length > 0 && <><label htmlFor="host-conflict-resolution">服务器冲突</label><select id="host-conflict-resolution" value={vaultResolution.hostConflicts} onChange={(event) => setVaultResolution({ ...vaultResolution, hostConflicts: event.target.value as 'skip' | 'replace' })}><option value="skip">跳过现有服务器</option><option value="replace">替换现有服务器</option></select><label htmlFor="group-conflict-resolution">分组冲突</label><select id="group-conflict-resolution" value={vaultResolution.groupConflicts} onChange={(event) => setVaultResolution({ ...vaultResolution, groupConflicts: event.target.value as 'reuse' | 'replace' })}><option value="reuse">复用现有分组</option><option value="replace">替换现有分组</option></select><label htmlFor="identity-conflict-resolution">身份冲突</label><select id="identity-conflict-resolution" value={vaultResolution.identityConflicts ?? 'reuse'} onChange={(event) => setVaultResolution({ ...vaultResolution, identityConflicts: event.target.value as 'reuse' | 'replace' })}><option value="reuse">复用现有身份</option><option value="replace">替换现有身份</option></select></>}</div>}
              {externalPreview && <div className="workspace-import-preview" role="status">
                <strong>导入预览 · {formatLabels[externalPreview.source.format] ?? externalPreview.source.format}</strong>
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
              </div>}
            </div>
          </>
        ) : (
          <>
            <p className="preferences-note">输入导出密码，生成可再次导入的加密 Vault 数据包。</p>
            <div className="workspace-settings-section workspace-transfer-section">
              <label htmlFor="vault-export-password">导出密码</label>
              <input id="vault-export-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} />
              <button className="button button-primary" type="button" disabled={busy || password.length === 0} onClick={() => void runExport()}>导出</button>
            </div>
          </>
        )}
        {message && <p className="preferences-note" role="status">{message}</p>}
      </aside>
    </div>
  );
};
