import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/server/config.js';

describe('loadConfig', () => {
  it('uses safe development defaults', () => {
    expect(loadConfig({ NODE_ENV: 'development' })).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      dataDir: '/data',
      sessionIdleTimeoutMs: 86_400_000,
      maxSessions: 8,
      logLevel: 'info'
    });
  });

  it('requires explicit trusted origins in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow('TRUSTED_ORIGINS');
    expect(() => loadConfig({ NODE_ENV: 'production', TRUSTED_ORIGINS: '   ' })).toThrow('TRUSTED_ORIGINS');
    expect(loadConfig({ NODE_ENV: 'production', TRUSTED_ORIGINS: 'https://ssh.example' }).trustedOrigins)
      .toEqual(['https://ssh.example']);
  });

  it('parses and validates limits and origins', () => {
    expect(loadConfig({
      NODE_ENV: 'test',
      PORT: '4173',
      DATA_DIR: ':memory:',
      TRUSTED_ORIGINS: 'http://localhost:4173, http://localhost:4173',
      SESSION_IDLE_TIMEOUT: '60000',
      MAX_SESSIONS: '12',
      LOG_LEVEL: 'debug'
    })).toMatchObject({
      port: 4173,
      dataDir: ':memory:',
      trustedOrigins: ['http://localhost:4173'],
      sessionIdleTimeoutMs: 60_000,
      maxSessions: 12,
      logLevel: 'debug'
    });

    expect(() => loadConfig({ PORT: '0' })).toThrow('PORT');
    expect(() => loadConfig({ SESSION_IDLE_TIMEOUT: '10' })).toThrow('SESSION_IDLE_TIMEOUT');
    expect(() => loadConfig({ TRUSTED_ORIGINS: 'ssh.example' })).toThrow('TRUSTED_ORIGINS');
  });
});
