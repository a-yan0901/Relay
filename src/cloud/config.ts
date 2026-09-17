export interface CloudRuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  trustedOrigins: readonly string[];
  mysql: {
    host: string;
    port: number;
    database: string;
    user: string;
    password: string;
    connectionLimit: number;
    queueLimit: number;
  };
  session: {
    idleTimeoutMs: number;
    absoluteTimeoutMs: number;
  };
  relay: {
    maxFrameBytes: number;
    maxBufferedBytes: number;
    maxSubscribersPerWorkspace: number;
    maxPayloadBytes: number;
    heartbeatMs: number;
  };
}

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

const required = (env: Environment, name: string): string => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  if ([...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === '\u007f')) {
    throw new Error(`${name} contains control characters`);
  }
  return value;
};

const parseNodeEnv = (value: string | undefined): CloudRuntimeConfig['nodeEnv'] => {
  if (value === undefined || value === '') return 'development';
  if (value === 'development' || value === 'test' || value === 'production') return value;
  throw new Error('NODE_ENV must be development, test, or production');
};

const parseOrigins = (env: Environment, nodeEnv: CloudRuntimeConfig['nodeEnv']): readonly string[] => {
  const raw = env.CLOUD_TRUSTED_ORIGINS?.trim();
  if (!raw) {
    if (nodeEnv === 'production') throw new Error('CLOUD_TRUSTED_ORIGINS must be configured in production');
    return [];
  }
  const origins = [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error('CLOUD_TRUSTED_ORIGINS must contain valid HTTP(S) origins');
    }
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('CLOUD_TRUSTED_ORIGINS must contain valid HTTP(S) origins');
    }
  }
  return origins.map((origin) => new URL(origin).origin);
};

export const loadCloudConfig = (env: Environment = process.env): CloudRuntimeConfig => {
  const nodeEnv = parseNodeEnv(env.NODE_ENV);
  const connectionLimit = parseInteger(env, 'CLOUD_MYSQL_CONNECTION_LIMIT', 4, 1, 8);
  const queueLimit = parseInteger(env, 'CLOUD_MYSQL_QUEUE_LIMIT', 16, 0, 32);
  const maxFrameBytes = parseInteger(env, 'CLOUD_RELAY_MAX_FRAME_BYTES', 64 * 1024, 1024, 256 * 1024);
  const maxBufferedBytes = parseInteger(env, 'CLOUD_RELAY_MAX_BUFFERED_BYTES', 256 * 1024, maxFrameBytes, 1024 * 1024);
  const maxSubscribersPerWorkspace = parseInteger(env, 'CLOUD_RELAY_MAX_SUBSCRIBERS', 16, 1, 64);
  const maxPayloadBytes = parseInteger(env, 'CLOUD_MAX_PAYLOAD_BYTES', 8 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024);

  return {
    nodeEnv,
    host: env.CLOUD_HOST?.trim() || '127.0.0.1',
    port: parseInteger(env, 'CLOUD_PORT', 8787, 1, 65_535),
    trustedOrigins: parseOrigins(env, nodeEnv),
    mysql: {
      host: env.MYSQL_HOST?.trim() || '127.0.0.1',
      port: parseInteger(env, 'MYSQL_PORT', 3306, 1, 65_535),
      database: required(env, 'MYSQL_DATABASE'),
      user: required(env, 'MYSQL_USER'),
      password: env.MYSQL_PASSWORD ?? '',
      connectionLimit,
      queueLimit
    },
    session: {
      idleTimeoutMs: parseInteger(env, 'CLOUD_SESSION_IDLE_TIMEOUT_MS', 24 * 60 * 60 * 1000, 60_000, 24 * 60 * 60 * 1000),
      absoluteTimeoutMs: parseInteger(env, 'CLOUD_SESSION_ABSOLUTE_TIMEOUT_MS', 30 * 24 * 60 * 60 * 1000, 60_000, 365 * 24 * 60 * 60 * 1000)
    },
    relay: {
      maxFrameBytes,
      maxBufferedBytes,
      maxSubscribersPerWorkspace,
      maxPayloadBytes,
      heartbeatMs: parseInteger(env, 'CLOUD_RELAY_HEARTBEAT_MS', 20_000, 5_000, 120_000)
    }
  };
};
