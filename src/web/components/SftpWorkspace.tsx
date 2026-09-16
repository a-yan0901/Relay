import { useCallback, useState } from 'react';

import type { FileTransport } from '../../shared/core/ports';
import type { SftpEntry, TransferJob } from '../../shared/core/models';
import { SftpPanel, sftpErrorMessage } from './SftpPanel';
import { LocalFilePanel } from './LocalFilePanel';
import { TransferCenter } from './TransferCenter';

export type SftpFileOperations = Pick<FileTransport, 'list' | 'createDirectory' | 'rename' | 'remove'>;

export interface SftpWorkspaceProps {
  hostId: string;
  workspaceId: string | null;
  remotePath: string;
  fileTransport: SftpFileOperations;
  transferJobs: readonly TransferJob[];
  hostAliases?: Readonly<Record<string, string>>;
  onRemotePathChange?: (path: string) => void;
  onUploadFile?: (file: File, path: string) => Promise<void>;
  onDownloadFile?: (path: string, name: string) => Promise<void>;
  mutationsEnabled?: boolean;
  onCancelTransfer?: (id: string) => void;
  onPauseTransfer?: (id: string) => void;
  onRetryTransfer?: (id: string) => void;
  onResumeTransfer?: (id: string) => void;
  onOpenTransferPath?: (job: TransferJob) => void;
  onBackToTerminal?: () => void;
}

export const SftpWorkspace = ({
  hostId,
  workspaceId,
  remotePath,
  fileTransport,
  transferJobs,
  hostAliases,
  onRemotePathChange,
  onUploadFile,
  onDownloadFile,
  mutationsEnabled = true,
  onCancelTransfer,
  onPauseTransfer,
  onRetryTransfer,
  onResumeTransfer,
  onOpenTransferPath,
  onBackToTerminal
}: SftpWorkspaceProps) => {
  const currentPath = remotePath.trim() || '/';
  const [refreshToken, setRefreshToken] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [dropError, setDropError] = useState<string | null>(null);

  const list = useCallback((nextHostId: string, path: string): Promise<readonly SftpEntry[]> => fileTransport.list(nextHostId, path), [fileTransport]);
  const createDirectory = useCallback((path: string): Promise<void> => fileTransport.createDirectory(hostId, path), [fileTransport, hostId]);
  const rename = useCallback((from: string, to: string): Promise<void> => fileTransport.rename(hostId, from, to), [fileTransport, hostId]);
  const remove = useCallback((path: string): Promise<void> => fileTransport.remove(hostId, path), [fileTransport, hostId]);

  const uploadFiles = useCallback(async (files: readonly File[]): Promise<void> => {
    if (!onUploadFile || files.length === 0) return;
    setUploading(true);
    setDropError(null);
    try {
      for (const file of files) {
        await onUploadFile(file, currentPath);
        setRefreshToken((token) => token + 1);
      }
    } catch (error) {
      setDropError(sftpErrorMessage(error, '上传', currentPath));
    } finally {
      setUploading(false);
    }
  }, [currentPath, onUploadFile]);

  return (
    <section className="sftp-workspace" aria-label="SFTP 工作区" data-workspace-id={workspaceId ?? undefined} data-host-id={hostId}>
      <div className="sftp-workspace-heading">
        <div><p className="eyebrow">FILE WORKSPACE</p><h2>{hostAliases?.[hostId] ?? hostId}</h2><span className="sftp-workspace-context">Workspace 文件上下文 · {currentPath}</span></div>
        {onBackToTerminal && <button className="button button-ghost button-small" type="button" onClick={onBackToTerminal}>返回终端</button>}
      </div>
      <div className="sftp-workspace-columns">
        <LocalFilePanel remotePath={currentPath} onFilesSelected={uploadFiles} disabled={uploading || onUploadFile === undefined} />
        <div className="sftp-remote-pane">
          <SftpPanel
            key={hostId}
            hostId={hostId}
            remotePath={currentPath}
            refreshToken={refreshToken}
            onList={list}
            onCreateDirectory={mutationsEnabled ? createDirectory : undefined}
            onRename={mutationsEnabled ? rename : undefined}
            onDelete={mutationsEnabled ? remove : undefined}
            onDownload={onDownloadFile}
            onNavigate={onRemotePathChange}
          />
        </div>
      </div>
      {dropError && <p className="form-error sftp-workspace-error" role="alert">{dropError}</p>}
      <TransferCenter
        jobs={transferJobs}
        hostAliases={hostAliases}
        onCancel={onCancelTransfer}
        onPause={onPauseTransfer}
        onRetry={onRetryTransfer}
        onResume={onResumeTransfer}
        onOpenPath={onOpenTransferPath}
      />
    </section>
  );
};
