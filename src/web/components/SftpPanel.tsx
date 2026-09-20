import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import { AppError } from '@shared/errors';
import type { SftpEntry, SftpListOptions, SftpListPage } from '../../shared/core/models';
import { sftpChildPath, sftpParentPath } from '../../shared/core/sftp-path';
import { Dialog } from './Dialog';
import { SftpBreadcrumbs } from './SftpBreadcrumbs';
import { ContextMenu } from './ContextMenu';
import type { ContextMenuItem } from '../context-menu';
import { useContextMenu } from '../hooks/use-context-menu';

type SftpAction = '读取' | '上传' | '下载' | '分享' | '删除' | '新建目录' | '重命名';
const SFTP_PAGE_SIZE = 128;
const MAX_PAGE_HISTORY = 32;

export const sftpErrorMessage = (error: unknown, action: SftpAction, path?: string): string => {
  if (error instanceof AppError) {
    if (error.code === 'SFTP_PERMISSION_DENIED') return action === '读取' || action === '下载' || action === '分享'
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
  /** Optional bounded listing. When present, the panel keeps only one page in memory. */
  onListPage?: (hostId: string, path: string, options?: SftpListOptions) => Promise<SftpListPage>;
  /** Parent-owned path keeps the SFTP view scoped to the active Host/Workspace. */
  remotePath?: string;
  /** Increment after an upload/drop outside this component to refresh the listing. */
  refreshToken?: number;
  onCreateDirectory?: (path: string) => Promise<void>;
  onRename?: (from: string, to: string) => Promise<void>;
  onDelete?: (path: string) => Promise<void>;
  onUpload?: (file: File, path: string) => Promise<void>;
  onDownload?: (path: string, name: string) => Promise<void>;
  onShare?: (path: string, name: string) => Promise<void>;
  onCopyText?: (value: string) => Promise<void> | void;
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
  onListPage,
  remotePath,
  refreshToken,
  onCreateDirectory,
  onRename,
  onDelete,
  onUpload,
  onDownload,
  onShare,
  onCopyText,
  onNavigate
}: SftpPanelProps) => {
  const initialPath = remotePath?.trim() || '/';
  const [path, setPath] = useState(initialPath);
  const [pathInput, setPathInput] = useState(initialPath);
  const [filterQuery, setFilterQuery] = useState('');
  const [entries, setEntries] = useState<readonly SftpEntry[]>([]);
  const [pageCursor, setPageCursor] = useState<string | undefined>(undefined);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [previousCursors, setPreviousCursors] = useState<readonly string[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<ReadonlySet<string>>(new Set());
  const [dialog, setDialog] = useState<SftpDialog>(null);
  const [directoryName, setDirectoryName] = useState('');
  const [renameName, setRenameName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const loadSequence = useRef(0);
  const fileContextMenu = useContextMenu<SftpEntry>();

  const load = useCallback(async (): Promise<void> => {
    const sequence = ++loadSequence.current;
    setLoading(true);
    setError(null);
    try {
      const page = onListPage
        ? await onListPage(hostId, path, { cursor: pageCursor, limit: SFTP_PAGE_SIZE, filter: filterQuery })
        : { entries: await onList(hostId, path), nextCursor: null };
      const nextEntries = page.entries;
      if (sequence === loadSequence.current) {
        setEntries(nextEntries);
        setNextCursor(page.nextCursor);
        setSelectedPaths((current) => new Set([...current].filter((selectedPath) => nextEntries.some((entry) => entry.path === selectedPath))));
      }
    } catch (listError) {
      if (sequence === loadSequence.current) {
        setEntries([]);
        setNextCursor(null);
        setSelectedPaths(new Set());
        setError(sftpErrorMessage(listError, '读取', path));
      }
    } finally {
      if (sequence === loadSequence.current) setLoading(false);
    }
  }, [filterQuery, hostId, onList, onListPage, pageCursor, path]);

  useEffect(() => {
    if (remotePath === undefined) return;
    const nextPath = remotePath.trim() || '/';
    setPath(nextPath);
    setPathInput(nextPath);
    setFilterQuery('');
    setPageCursor(undefined);
    setNextCursor(null);
    setPreviousCursors([]);
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
  const visibleEntries = useMemo(() => {
    const query = filterQuery.trim().toLocaleLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => entry.name.toLocaleLowerCase().includes(query));
  }, [entries, filterQuery]);
  const allEntriesSelected = visibleEntries.length > 0 && visibleEntries.every((entry) => selectedPaths.has(entry.path));

  const navigateTo = (nextPath: string): void => {
    const target = nextPath.trim() || '/';
    setPath(target);
    setPathInput(target);
    setFilterQuery('');
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
    setSelectedPaths(checked ? new Set(visibleEntries.map((entry) => entry.path)) : new Set());
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

  const share = async (entry: SftpEntry): Promise<void> => {
    if (!onShare) return;
    setError(null);
    try {
      await onShare(entry.path, entry.name);
    } catch (shareError) {
      setError(sftpErrorMessage(shareError, '分享'));
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

  const fileContextEntry = fileContextMenu.state?.target;
  const fileContextItems: readonly ContextMenuItem[] = fileContextEntry
    ? [
      { id: 'enter-directory', label: '进入目录', disabled: fileContextEntry.type !== 'directory', onSelect: () => navigate(fileContextEntry) },
      { id: 'copy-remote-path', label: '复制远程路径', disabled: !onCopyText, onSelect: () => onCopyText?.(fileContextEntry.path) },
      { id: 'download-entry', label: '下载', disabled: fileContextEntry.type !== 'file' || !onDownload, onSelect: () => void download(fileContextEntry) },
      { id: 'share-entry', label: '分享', disabled: fileContextEntry.type !== 'file' || !onShare, onSelect: () => void share(fileContextEntry) },
      { id: 'rename-entry', label: '重命名', disabled: !onRename, separatorBefore: true, onSelect: () => openRename(fileContextEntry) },
      { id: 'delete-entry', label: '删除', disabled: !onDelete, tone: 'danger', onSelect: () => openDelete([fileContextEntry.path]) }
    ]
    : [];

  return (
    <section className="sftp-panel" aria-label="远程文件">
      <div className="sftp-panel-heading">
        <div><p className="eyebrow">REMOTE FILES</p><h2>SFTP</h2></div>
        <div className="sftp-panel-actions">
          <label className="sftp-path-input"><span className="visually-hidden">远程路径</span><input aria-label="远程路径" value={pathInput} onChange={(event) => setPathInput(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') navigateToPath(); }} /></label>
          <label className="sftp-filter-input"><span className="visually-hidden">过滤当前目录</span><input type="search" aria-label="过滤当前目录" placeholder="按名称过滤当前目录" value={filterQuery} onChange={(event) => { setFilterQuery(event.target.value); setPageCursor(undefined); setNextCursor(null); setPreviousCursors([]); }} /></label>
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
      {!loading && !error && entries.length > 0 && visibleEntries.length === 0 && <p className="sftp-empty-state">没有匹配的文件</p>}
      {!loading && !error && visibleEntries.length > 0 && <>
        <label className="sftp-select-all"><input type="checkbox" aria-label={filterQuery.trim() ? '选择筛选结果' : '选择当前目录全部项目'} checked={allEntriesSelected} onChange={(event) => toggleAll(event.target.checked)} />{filterQuery.trim() ? '选择筛选结果' : '选择当前目录'}</label>
        <ul className="sftp-entry-list">{visibleEntries.map((entry) => <li key={entry.path} className={`sftp-entry ${selectedPaths.has(entry.path) ? 'is-selected' : ''}`} onContextMenu={(event) => fileContextMenu.open(event, entry)}>
          <input type="checkbox" aria-label={`选择 ${entry.name}`} checked={selectedPaths.has(entry.path)} onChange={(event) => toggleSelected(entry.path, event.target.checked)} />
          <button type="button" className="sftp-entry-name" aria-label={entry.type === 'directory' ? `打开目录 ${entry.name}` : entry.name} onClick={() => navigate(entry)} disabled={entry.type !== 'directory'}><span aria-hidden="true">{entry.type === 'directory' ? '▸' : '·'}</span>{entry.name}</button>
          <span className="sftp-entry-meta">{entry.type === 'directory' ? '目录' : `${entry.size} B`}</span>
          {entry.type === 'file' && onDownload && <button type="button" className="icon-button" aria-label={`下载 ${entry.name}`} title={`下载 ${entry.name}`} onClick={() => void download(entry)} disabled={busy}>↓</button>}
          {entry.type === 'file' && onShare && <button type="button" className="icon-button" aria-label={`分享 ${entry.name}`} title={`分享 ${entry.name}`} onClick={() => void share(entry)} disabled={busy}>↗</button>}
          {onRename && <button type="button" className="icon-button" aria-label={`重命名 ${entry.name}`} title={`重命名 ${entry.name}`} onClick={() => openRename(entry)} disabled={busy}>✎</button>}
          {onDelete && <button type="button" className="icon-button" aria-label={`删除 ${entry.name}`} title={`删除 ${entry.name}`} onClick={() => openDelete([entry.path])} disabled={busy}>×</button>}
        </li>)}</ul>
        {onListPage && <div className="sftp-pagination" role="navigation" aria-label="远程文件分页">
          <button className="button button-ghost button-small" type="button" disabled={previousCursors.length === 0 || loading || busy} onClick={() => {
            const previous = previousCursors.at(-1);
            if (previous === undefined) return;
            setPreviousCursors((current) => current.slice(0, -1));
            setPageCursor(previous || undefined);
          }}>上一页</button>
          <span>{nextCursor ? `当前页 ${entries.length} 项 · 还有更多` : `当前页 ${entries.length} 项`}</span>
          <button className="button button-ghost button-small" type="button" disabled={!nextCursor || loading || busy} onClick={() => {
            if (!nextCursor) return;
            setPreviousCursors((current) => [...current, pageCursor ?? ''].slice(-MAX_PAGE_HISTORY));
            setPageCursor(nextCursor);
          }}>下一页</button>
        </div>}
      </>}
      {fileContextMenu.state && <ContextMenu state={fileContextMenu.state} items={fileContextItems} onClose={fileContextMenu.close} ariaLabel={`${fileContextEntry?.name ?? '远程文件'} 菜单`} />}
      {dialog?.type === 'create-directory' && <Dialog title="新建目录" onClose={() => setDialog(null)} closeOnBackdrop={false} initialFocusSelector="#sftp-new-directory-name"><label htmlFor="sftp-new-directory-name">目录名称</label><input id="sftp-new-directory-name" aria-label="新目录名称" value={directoryName} onChange={(event) => setDirectoryName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void createDirectory(); }} /><p className="dialog-copy">将在 {path} 下创建目录。</p><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setDialog(null)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void createDirectory()}>创建目录</button></div></Dialog>}
      {dialog?.type === 'rename' && <Dialog title={`重命名 ${dialog.entry.name}`} onClose={() => setDialog(null)} closeOnBackdrop={false} initialFocusSelector="#sftp-rename-name"><label htmlFor="sftp-rename-name">新名称</label><input id="sftp-rename-name" aria-label="新名称" value={renameName} onChange={(event) => setRenameName(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void renameEntry(); }} /><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setDialog(null)}>取消</button><button className="button button-primary" type="button" disabled={busy} onClick={() => void renameEntry()}>确认重命名</button></div></Dialog>}
      {dialog?.type === 'delete' && <Dialog title={dialog.paths.length === 1 ? '删除远程文件？' : `删除 ${dialog.paths.length} 个远程项目？`} onClose={() => setDialog(null)} closeOnBackdrop={false} initialFocusSelector="#sftp-delete-confirm"><p className="dialog-copy">{dialog.paths.join('、')}</p><div className="dialog-actions"><button className="button button-ghost" type="button" onClick={() => setDialog(null)}>取消</button><button className="button button-primary" id="sftp-delete-confirm" type="button" disabled={busy} onClick={() => void confirmDelete()}>确认删除</button></div></Dialog>}
    </section>
  );
};
