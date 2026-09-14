import type { FastifyReply, FastifyRequest } from 'fastify';

export const SESSION_COOKIE_NAME = 'webssh_session';

export interface SessionCookieConfig {
  secure: boolean;
}

export const getSessionId = (request: FastifyRequest): string | null => {
  const value = request.cookies[SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

export const setSessionCookie = (reply: FastifyReply, sessionId: string, config: SessionCookieConfig): void => {
  reply.setCookie(SESSION_COOKIE_NAME, sessionId, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secure
  });
};

export const clearSessionCookie = (reply: FastifyReply, config: SessionCookieConfig): void => {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: config.secure
  });
};
