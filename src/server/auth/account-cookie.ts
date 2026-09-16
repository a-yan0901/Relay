import type { FastifyReply, FastifyRequest } from 'fastify';

export const ACCOUNT_SESSION_COOKIE_NAME = 'relay_account_session';

export interface AccountSessionCookieConfig {
  secure: boolean;
}

export const getAccountSessionId = (request: FastifyRequest): string | null => {
  const value = request.cookies[ACCOUNT_SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const setAccountSessionCookie = (
  reply: FastifyReply,
  sessionId: string,
  config: AccountSessionCookieConfig
): void => {
  reply.setCookie(ACCOUNT_SESSION_COOKIE_NAME, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secure
  });
};

export const clearAccountSessionCookie = (
  reply: FastifyReply,
  config: AccountSessionCookieConfig
): void => {
  reply.clearCookie(ACCOUNT_SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secure
  });
};
