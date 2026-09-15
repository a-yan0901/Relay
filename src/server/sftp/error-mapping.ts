import { AppError, type AppErrorCode } from '../../shared/errors.js';

type SftpErrorLike = {
  code?: unknown;
  message?: unknown;
};

const numericCode = (error: unknown): number | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as SftpErrorLike).code;
  return typeof code === 'number' ? code : undefined;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message.toLowerCase();
  if (typeof error === 'object' && error !== null && typeof (error as SftpErrorLike).message === 'string') {
    return ((error as SftpErrorLike).message as string).toLowerCase();
  }
  return '';
};

export const mapSftpError = (error: unknown, fallback: AppErrorCode = 'SFTP_TRANSFER_FAILED'): AppError => {
  if (error instanceof AppError) return error;
  const code = numericCode(error);
  const message = errorMessage(error);
  if (code === 2 || message.includes('no such') || message.includes('not found') || message.includes('enoent')) {
    return new AppError('SFTP_NOT_FOUND');
  }
  if (code === 3 || message.includes('permission') || message.includes('denied') || message.includes('eacces')) {
    return new AppError('SFTP_PERMISSION_DENIED');
  }
  if (code === 6 || code === 7 || message.includes('connection') || message.includes('econnreset') || message.includes('epipe')) {
    return new AppError('SFTP_CONNECTION_FAILED');
  }
  return new AppError(fallback);
};
