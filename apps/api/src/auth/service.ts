import { createHash, randomBytes } from 'node:crypto';
import type { CurrentUser } from '@task-tg/shared';
import { AuthError, validateInitData, type TelegramUser } from './telegram.js';

export interface SessionRecord {
  user: CurrentUser;
  expiresAt: Date;
}

export interface NewSession {
  user: TelegramUser;
  tokenHash: string;
  expiresAt: Date;
  grantHash: string;
  grantExpiresAt: Date;
  now: Date;
}

export interface AuthStore {
  // Atomically consume initData, upsert the user and create the session.
  // null means this grant was consumed already (including concurrent requests).
  createSession: (input: NewSession) => Promise<CurrentUser | null>;
  findSession: (hash: string) => Promise<SessionRecord | null>;
  deleteSession: (hash: string) => Promise<void>;
}

interface AuthOptions {
  botToken?: string | undefined;
  initDataMaxAgeSeconds: number;
  sessionTtlSeconds: number;
  now?: () => Date;
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export function createAuthService(store: AuthStore, options: AuthOptions) {
  const now = options.now ?? (() => new Date());
  const tokenIsValid = (token: string | undefined): token is string => !!token && /^[\w-]{43}$/.test(token);
  return {
    async login(raw: string) {
      if (!options.botToken) throw new AuthError(503, 'AUTH_NOT_CONFIGURED');
      const date = now();
      const grant = validateInitData(raw, options.botToken, date, options.initDataMaxAgeSeconds);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = new Date(date.getTime() + options.sessionTtlSeconds * 1000);
      const user = await store.createSession({ user: grant.user, tokenHash: hashSessionToken(token), expiresAt, grantHash: grant.hash, grantExpiresAt: grant.expiresAt, now: date });
      if (!user) throw new AuthError(401, 'INIT_DATA_ALREADY_USED');
      return { token, expiresAt, user };
    },
    async currentUser(token: string | undefined) {
      if (!tokenIsValid(token)) return null;
      const session = await store.findSession(hashSessionToken(token));
      return session && session.expiresAt > now() ? session.user : null;
    },
    async logout(token: string | undefined) {
      if (tokenIsValid(token)) await store.deleteSession(hashSessionToken(token));
    },
  };
}

export type AuthService = ReturnType<typeof createAuthService>;
