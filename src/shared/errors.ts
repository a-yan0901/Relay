export const APP_ERROR_CODES = [
  'PROTOCOL_INVALID_MESSAGE',
  'HOST_VALIDATION_FAILED',
  'HOST_NOT_FOUND',
  'GROUP_NOT_FOUND',
  'AUTH_REQUIRED',
  'VAULT_NOT_INITIALIZED',
  'VAULT_LOCKED',
  'MASTER_PASSWORD_INVALID',
  'VAULT_UNLOCK_FAILED',
  'VAULT_CONFIG_INVALID',
  'VAULT_CRYPTO_FAILED',
  'SETUP_ALREADY_COMPLETE',
  'GROUP_ALREADY_EXISTS',
  'SESSION_INVALID',
  'SESSION_EXPIRED',
  'HOST_KEY_REQUIRED',
  'HOST_KEY_MISMATCH',
  'SSH_CONNECTION_FAILED',
  'SSH_AUTH_FAILED',
  'SSH_SESSION_LIMIT',
  'RATE_LIMITED',
  'NOT_FOUND',
  'INTERNAL_ERROR'
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

const DEFAULT_MESSAGES: Record<AppErrorCode, string> = {
  PROTOCOL_INVALID_MESSAGE: '终端请求格式无效',
  HOST_VALIDATION_FAILED: '请检查服务器配置',
  HOST_NOT_FOUND: '找不到服务器配置',
  GROUP_NOT_FOUND: '找不到服务器分组',
  AUTH_REQUIRED: '请先解锁 Vault',
  VAULT_NOT_INITIALIZED: '请先完成初始化',
  VAULT_LOCKED: 'Vault 已锁定，请先解锁',
  MASTER_PASSWORD_INVALID: '主密码至少需要 12 个字符',
  VAULT_UNLOCK_FAILED: '主密码错误或 Vault 已损坏',
  VAULT_CONFIG_INVALID: 'Vault 配置无效',
  VAULT_CRYPTO_FAILED: '凭据加密数据无效',
  SETUP_ALREADY_COMPLETE: '应用已完成初始化',
  GROUP_ALREADY_EXISTS: '已存在同名分组',
  SESSION_INVALID: '会话无效，请重新解锁',
  SESSION_EXPIRED: '会话已过期，请重新解锁',
  HOST_KEY_REQUIRED: '需要确认远程主机指纹',
  HOST_KEY_MISMATCH: '远程主机指纹与已保存指纹不一致',
  SSH_CONNECTION_FAILED: '无法连接远程服务器',
  SSH_AUTH_FAILED: '远程服务器认证失败',
  SSH_SESSION_LIMIT: '已达到终端连接数上限',
  RATE_LIMITED: '请求过于频繁，请稍后再试',
  NOT_FOUND: '请求的资源不存在',
  INTERNAL_ERROR: '服务暂时不可用'
};

const DEFAULT_STATUS_CODES: Record<AppErrorCode, number> = {
  PROTOCOL_INVALID_MESSAGE: 400,
  HOST_VALIDATION_FAILED: 400,
  HOST_NOT_FOUND: 404,
  GROUP_NOT_FOUND: 404,
  AUTH_REQUIRED: 401,
  VAULT_NOT_INITIALIZED: 409,
  VAULT_LOCKED: 423,
  MASTER_PASSWORD_INVALID: 400,
  VAULT_UNLOCK_FAILED: 401,
  VAULT_CONFIG_INVALID: 500,
  VAULT_CRYPTO_FAILED: 400,
  SETUP_ALREADY_COMPLETE: 409,
  GROUP_ALREADY_EXISTS: 409,
  SESSION_INVALID: 401,
  SESSION_EXPIRED: 401,
  HOST_KEY_REQUIRED: 409,
  HOST_KEY_MISMATCH: 409,
  SSH_CONNECTION_FAILED: 502,
  SSH_AUTH_FAILED: 502,
  SSH_SESSION_LIMIT: 429,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500
};

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly statusCode: number;

  constructor(code: AppErrorCode, message = DEFAULT_MESSAGES[code], statusCode = DEFAULT_STATUS_CODES[code]) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const isAppErrorCode = (value: string): value is AppErrorCode => (
  (APP_ERROR_CODES as readonly string[]).includes(value)
);
