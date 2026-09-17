import { networkInterfaces } from 'node:os';

export interface AppRuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  dataDir: string;
  trustedOrigins: string[];
  sessionIdleTimeoutMs: number;
  maxSessions: number;
  /** Optional for backwards-compatible test/embedding configs; loadConfig always supplies a boolean. */
  accountSyncEnabled?: boolean;
  /** Optional cloud API base URL. Local-only mode remains unchanged when absent. */
  cloudApiUrl?: string;
  rateLimitMax?: number;
  logLevel: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_DIR = '/data';
const DEFAULT_FRONTEND_PORT = 5173;
const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_RATE_LIMIT_MAX = 120;
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
type Environment = Record<string, string | undefined>;

const parseInteger = (
  env: Environment,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number
): number => {
  const value = env[name];
  if (value === undefined || value.trim() === '') return fallback;
  if (!/^\d+$/u.test(value.trim())) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} is outside the supported range`);
  }
  return parsed;
};

const parseNodeEnv = (value: string | undefined): AppRuntimeConfig['nodeEnv'] => {
  if (value === undefined || value === '') return 'development';
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new Error('NODE_ENV must be development, test, or production');
};

const parseAccountSyncEnabled = (value: string | undefined): boolean => {
  if (value === undefined) return false;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error('ACCOUNT_SYNC_ENABLED must be true, false, 1, or 0');
};

const parseCloudApiUrl = (value: string | undefined, nodeEnv: AppRuntimeConfig['nodeEnv']): string | undefined => {
  const raw = value?.trim();
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('CLOUD_API_URL must be a valid HTTP(S) URL');
  }
  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new Error('CLOUD_API_URL must be a valid HTTP(S) URL');
  }
  if (nodeEnv === 'production' && parsed.protocol !== 'https:') {
    throw new Error('CLOUD_API_URL must use HTTPS in production');
  }
  return parsed.toString().replace(/\/$/u, '');
};

const parseDataDir = (value: string | undefined): string => {
  const dataDir = value === undefined ? DEFAULT_DATA_DIR : value.trim();
  if (!dataDir || [...dataDir].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === '\u007f')) {
    throw new Error('DATA_DIR must be a valid path');
  }
  return dataDir;
};

const localOrigin = (address: string, port: number): string => (
  `http://${address.includes(':') ? `[${address}]` : address}:${port}`
);

const defaultDevelopmentOrigins = (env: Environment): string[] => {
  const frontendPort = parseInteger(env, 'VITE_PORT', DEFAULT_FRONTEND_PORT, 1, 65_535);
  const origins = new Set([
    `http://localhost:${frontendPort}`,
    `http://127.0.0.1:${frontendPort}`,
    `http://0.0.0.0:${frontendPort}`,
    `http://[::1]:${frontendPort}`
  ]);

  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry.address.includes('%')) origins.add(localOrigin(entry.address, frontendPort));
    }
  }

  return [...origins];
};

const parseTrustedOrigins = (env: Environment, nodeEnv: AppRuntimeConfig['nodeEnv']): string[] => {
  const raw = env.TRUSTED_ORIGINS;
  if (raw === undefined || raw.trim() === '') {
    if (nodeEnv === 'production') throw new Error('TRUSTED_ORIGINS must be configured in production');
    return defaultDevelopmentOrigins(env);
  }

  const origins = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  if (origins.length === 0) throw new Error('TRUSTED_ORIGINS must contain at least one origin');
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('TRUSTED_ORIGINS must contain valid HTTP(S) origins');
    }
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      throw new Error('TRUSTED_ORIGINS must contain valid HTTP(S) origins');
    }
  }
  return origins.map((origin) => new URL(origin).origin);
};

export const loadConfig = (env: Environment = process.env): AppRuntimeConfig => {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const port = parseInteger(env, 'PORT', DEFAULT_PORT, 1, 65_535);
  const sessionIdleTimeoutMs = parseInteger(
    env,
    'SESSION_IDLE_TIMEOUT',
    DEFAULT_SESSION_IDLE_TIMEOUT_MS,
    60_000,
    24 * 60 * 60 * 1000
  );
  const maxSessions = parseInteger(env, 'MAX_SESSIONS', DEFAULT_MAX_SESSIONS, 1, 64);
  const rateLimitMax = parseInteger(env, 'RATE_LIMIT_MAX', DEFAULT_RATE_LIMIT_MAX, 1, 100_000);
  const logLevel = env.LOG_LEVEL?.trim() || 'info';
  if (!(LOG_LEVELS as readonly string[]).includes(logLevel)) {
    throw new Error('LOG_LEVEL is invalid');
  }

  return {
    nodeEnv,
    port,
    dataDir: parseDataDir(env.DATA_DIR),
    trustedOrigins: parseTrustedOrigins(env, nodeEnv),
    sessionIdleTimeoutMs,
    maxSessions,
    accountSyncEnabled: parseAccountSyncEnabled(env.ACCOUNT_SYNC_ENABLED),
    cloudApiUrl: parseCloudApiUrl(env.CLOUD_API_URL, nodeEnv),
    rateLimitMax,
    logLevel
  };
};
