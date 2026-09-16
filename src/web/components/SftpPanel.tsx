import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import { AppError } from '@shared/errors';
import type { SftpEntry } from '../../shared/core/models';
import { sftpChildPath, sftpParentPath } from '../../shared/core/sftp-path';
import { Dialog } from './Dialog';
import { SftpBreadcrumbs } from './SftpBreadcrumbs';

type SftpAction = '读取' | '上传' | '下载' | '删除' | '新建目录' | '重命名';

export const sftpErrorMessage = (error: unknown, action: SftpAction, path?: string): string => {
  if (error instanceof AppError) {
    if (error.code === 'SFTP_PERMISSION_DENIED') return action === '读取'
      ? `读取失败：${path ?? '当前目录'}没有访问权限，请检查权限后重试`
      : '当前目录没有写权限，请切换到可写目录（如 /tmp）';
    if (error.code === 'SFTP_NOT_FOUND') return `远程文件或目录不存在${path ? `：${path}` : ''}，请刷新后重试`;
    if (error.code === 'SFTP_PATH_INVALID') return `远程路径无效${path ? `：${path}` : ''}，请检查路径后重试`;
    if (error.code === 'SFTP_CONNECTION_FAILED') return `${action}失败${path ? `（${path}）` : ''}，SFTP 连接已断开，请恢复连接后重试`;
    if (error.code === 'TRANSFER_RESUME_INVALID') return `${action}的断点校验失败，已回退到安全位置，请重试`;
  }
  return `${action}失败${path ? `（${path}）` : ''}，请检查远程路径和权限后重试`;
};

export interface SftpPanelProps {
  hostId: string;
  onList: (hostId: string, path: string) => Promise<readonly SftpEntry[]>;
  /** Parent-owned path keeps the SFTP view scoped to the active Host/Workspace. */
  remotePath?: string;
  /** Increment after an upload/drop outside this component to refresh the listing. */
  refreshToken?: number;
  onCreateDirectory?: (path: string) => Promise<void>;
  onRename?: (from: string, to: string) => Promise<void>;
  onDelete?: (path: string) => Promise<void>;
  onUpload?: (file: File, path: string) => Promise<void>;
  onDownload?: (path: string, name: string) => Promise<void>;
  onNavigate?: (path: string) => void;
}

type SftpDialog =
  | { type: 'create-directory' }
  | { type: 'rename'; entry: SftpEntry }
  | { type: 'delete'; paths: readonly string[] }
  | null;

export const SftpPanel = ({
  hostId,
  onList,
  remotePath,
  refreshToken,
  onCreateDirectory,
  onRename,
  onDelete,
  onUpload,
  onDownload,
  onNavigate
}: SftpPanelProps) => {
  const initialPath = remotePath?.trim() || '/';
  const [path, setPath] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const [entries, setEntries] = useState<readonly SftpEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<SftpDialog>(null);
  const [directoryName, setDirectoryName] = useState('');
  const [renameName, setRenameName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const loadSequence = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const nextEntries = await onList(hostId, path);
      if (sequence === loadSequence.current) {
        setEntries(nextEntries);
        setSelectedPaths((current) => new Set([...current].filter((selectedPath) => nextEntries.some((entry) => entry.path === selectedPath))));
      }
    } catch (listError) {
      if (sequence === loadSequence.current) {
        setEntries([]);
        setSelectedPaths(new Set());
        setError(sftpErrorMessage(listError, '读取', path));
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [hostId, onList, path]);

  useEffect(() => {
    if (remotePath === undefined) return;
    const nextPath = remotePath.trim() || '/';
    setPath(nextPath);
    setPathInput(nextPath);
    setSelectedPaths(new Set());
  }, [hostId, remotePath]);

  useEffect(() => { void load(); }, [load, refreshToken]);

  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.has(entry.path)),
    [entries, selectedPaths]
  );
  const selectedFiles = useMemo(
    () => selectedEntries.filter((entry) => entry.type === 'file'),
    [selectedEntries]
  );
  const allEntriesSelected = entries.length > 0 && entries.every((entry) => selectedPaths.has(entry.path));

  const navigateTo = (nextPath: string): void => {
    const target = nextPath.trim() || '/';
    setPath(target);
    setPathInput(target);
    setSelectedPaths(new Set());
    onNavigate?.(target);
  };

  const navigate = (entry: SftpEntry): void => {
    if (entry.type !== 'directory') return;
    navigateTo(entry.path);
  };

  const navigateToPath = (): void => navigateTo(pathInput);

  const toggleSelected = (entryPath: string, checked: boolean): void => {
    setSelectedPaths((current) => {
      const next = new Set(current);
      if (checked) next.add(entryPath);
      else next.delete(entryPath);
      return next;
    });
  };

  const toggleAll = (checked: boolean): void => {
    setSelectedPaths(checked ? new Set(entries.map((entry) => entry.path)) : new Set());
  };

  const confirmDelete = async (): Promise<void> => {
    if (!dialog || dialog.type !== 'delete' || !onDelete) return;
    setBusy(true);
    setError(null);
    try {
      for (const selectedPath of dialog.paths) await onDelete(selectedPath);
      setDialog(null);
      setSelectedPaths(new Set());
      await load();
    } catch (deleteError) {
      setError(sftpErrorMessage(deleteError, '删除'));
    } finally {
      setBusy(false);
    }
  };

  const createDirectory = async (): Promise<void> => {
    if (!onCreateDirectory) return;
    const name = directoryName.trim();
    if (!name) {
      setError('请输入目录名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreateDirectory(sftpChildPath(path, name));
      setDialog(null);
      setDirectoryName('');
      await load();
    } catch (createError) {
      setError(sftpErrorMessage(createError, '新建目录'));
    } finally {
      setBusy(false);
    }
  };

  const renameEntry = async (): Promise<void> => {
    if (!onRename || !dialog || dialog.type !== 'rename') return;
    const name = renameName.trim();
    if (!name) {
      setError('请输入新名称');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onRename(dialog.entry.path, sftpChildPath(sftpParentPath(dialog.entry.path), name));
      setDialog(null);
      setRenameName('');
      await load();
    } catch (renameError) {
      setError(sftpErrorMessage(renameError, '重命名'));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0 || !onUpload) return;
    setUploading(true);
    setError(null);
    try {
      for (const file of files) await onUpload(file, path);
      await load();
    } catch (uploadError) {
      setError(sftpErrorMessage(uploadError, '上传'));
    } finally {
      setUploading(false);
    }
  };

  const download = async (entry: SftpEntry): Promise<void> => {
    if (!onDownload) return;
    setError(null);
    try {
      await onDownload(entry.path, entry.name);
    } catch (downloadError) {
      setError(sftpErrorMessage(downloadError, '下载'));
    }
  };

  const downloadSelected = async (): Promise<void> => {
    if (!onDownload || selectedFiles.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      for (const entry of selectedFiles) await onDownload(entry.path, entry.name);
      setSelectedPaths(new Set());
    } catch (downloadError) {
      setError(sftpErrorMessage(downloadError, '下载'));
    } finally {
      setBusy(false);
    }
  };

  const openRename = (entry: SftpEntry): void => {
    setRenameName(entry.name);
    setError(null);
    setDialog({ type: 'rename', entry });
  };

  const openDelete = (paths: readonly string[]): void => {
    setError(null);
    setDialog({ type: 'delete', paths });
  };

  return (
    <section className="sftp-panel" aria-label="远程文件">
      <div className="sftp-panel-heading">
        <div><p className="eyebrow">REMOTE FILES</p><h2>SFTP</h2></div>
        <div className="sftp-panel-actions">
          <label className="sftp-path-input"><span className="visually-hidden">远程路径</span><input aria-label="远程路径" value={pathInput} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') navigateToPath(); }} /></label>
          <button className="button button-ghost button-small" type="button" onClick={navigateToPath}>跳转</button>
          <button className="button button-ghost button-small" type="button" onClick={() => void load()}>刷新</button>
          {onCreateDirectory && <button className="button button-ghost button-small" type="button" onClick={() => { setDirectoryName(''); setError(null); setDialog({ type: 'create-directory' }); }}>新建目录</button>}
          {onUpload && <label className="button button-ghost button-small sftp-upload-button">{uploading ? '上传中…' : '上传'}<input type="file" multiple aria-label="选择上传文件" onChange={(event) => void upload(event)} disabled={uploading || busy} /></label>}
        </div>
      </div>
      <SftpBreadcrumbs path={path} onNavigate={navigateTo} />
      {selectedEntries.length > 0 && <div className="sftp-selection-toolbar" role="toolbar" aria-label="已选文件操作"><span>已选择 {selectedEntries.length} 项</span>{onDownload && selectedFiles.length > 0 && <button className="button button-ghost button-small" type="button" disabled={busy} onClick={() => void downloadSelected()}>下载选中</button>}{onDelete && <button className="button button-ghost button-small" type="button" disabled={busy} onClick={() => openDelete(selectedEntries.map((entry) => entry.path))}>删除选中</button>}<button className="button button-ghost button-small" type="button" onClick={() => setSelectedPaths(new Set())}>清除选择</button></div>}
      {loading && <p className="sftp-empty-state">正在读取目录…</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {!loading && !error && entries.length === 0 && <p className="sftp-empty-state">目录为空</p>}
      {!loading && !error && entries.length > 0 && <>
        <label className="sftp-select-all"><input type="checkbox" aria-label="选择当前目录全部项目" checked={allEntriesSelected} onChange={(event) => toggleAll(event.target.checked)} />选择当前目录</label>
        <ul className="sftp-entry-list">{entries.map((entry) => <li key={entry.path} className={`sftp-entry ${selectedPaths.has(entry.path) ? 'is-selected' : ''}`}>
          <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selectedPaths.has(entry.path)} onChange={(event) => toggleSelected(entry.path, event.target.checked)} />
          <button type="button" className="sftp-entry-name" aria-label={entry.type === 'directory' ? `打开目录 ${entry.name}` : entry.name} onClick={() => navigate(entry)} disabled={entry.type !== 'directory'}><span aria-hidden="true">{entry.type === 'directory' ? '▸' : '·'}</span>{entry.name}</button>
          <span className="sftp-entry-meta">{entry.type === 'directory' ? '目录' : `${entry.size} B`}</span>
          {entry.type === 'file' && onDownload && <button type="button" className="icon-button" aria-label={`下载 ${entry.name}`} onClick={() => void download(entry)} disabled={busy}>↓</button>}
          {onRename && <button type="button" className="icon-button" aria-label={`重命名 ${entry.name}`} onClick={() => openRename(entry)} disabled={busy}>✎</button>}
          {onDelete && <button type="button" className="icon-button" aria-label={`删除 ${entry.name}`} onClick={() => openDelete([entry.path])} disabled={busy}>×</button>}
        </li>)}</ul>
      </>}
      {dialog?.type === 'create-directory' && <Dialog title="新建目录" onClose={() => setDialog(null)} closeOnBackdrop={false} initialFocusSelector="#sftp-new-directory-name"><label htmlFor="sftp-new-directory-name">目录名称</label><input id="sftp-new-directory-name" aria-label="新目录名称" value={directoryName} onChange={(event) => setDirectoryName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createDirectory(); }} /><p className="dialog-copy">将在 {path} 下创建目录。</p><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setDialog(null)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void createDirectory()}>创建目录</button></div></Dialog>}
      {dialog?.type === 'rename' && <Dialog title={`重命名 ${dialog.entry.name}`} onClose={() => setDialog(null)} closeOnBackdrop={false} initialFocusSelector="#sftp-rename-name"><label htmlFor="sftp-rename-name">新名称</label><input id="sftp-rename-name" aria-label="新名称" value={renameName} onChange={(event) => setRenameName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void renameEntry(); }} /><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setDialog(null)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void renameEntry()}>确认重命名</button></div></Dialog>}
      {dialog?.type === 'delete' && <Dialog title={dialog.paths.length === 1 ? '删除远程文件？' : `删除 ${dialog.paths.length} 个远程项目？`} onClose={() => setDialog(null)} closeOnBackdrop={false} initialFocusSelector="#sftp-delete-confirm"><p className="dialog-copy">{dialog.paths.join('、')}</p><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setDialog(null)}>取消</button><button className="button button-primary" id="sftp-delete-confirm" type="button" disabled={busy} onClick={() => void confirmDelete()}>确认删除</button></div></Dialog>}
    </section>
  );
};
