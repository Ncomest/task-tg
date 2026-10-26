import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { HttpError } from '../errors.js';

const telegramUserSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string().min(1).max(256),
  last_name: z.string().max(256).nullish(),
  username: z.string().max(64).nullish(),
  is_bot: z.literal(false).optional(),
});

export type TelegramUser = z.infer<typeof telegramUserSchema>;

export class AuthError extends HttpError {
  constructor(statusCode = 401, code = 'UNAUTHORIZED') {
    super(statusCode, code);
  }
}

// HMAC validation uses every field except hash (including signature, if present).
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export function validateInitData(raw: string, token: string, now: Date, maxAgeSeconds: number) {
  if (!raw || Buffer.byteLength(raw) > 16384) throw new AuthError();
  const parameters = new URLSearchParams(raw);
  const seen = new Set<string>();
  for (const key of parameters.keys()) {
    if (seen.has(key) || !/^[a-z_]+$/.test(key)) throw new AuthError();
    seen.add(key);
  }
  const hash = parameters.get('hash');
  if (!hash || !/^[a-f\d]{64}$/i.test(hash)) throw new AuthError();
  parameters.delete('hash');
  parameters.sort();
  const checkString = [...parameters].map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const expected = createHmac('sha256', secret).update(checkString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new AuthError();

  const authDate = parameters.get('auth_date');
  if (!authDate || !/^\d+$/.test(authDate)) throw new AuthError();
  const timestamp = Number(authDate);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  if (!Number.isSafeInteger(timestamp) || timestamp > nowSeconds + 30 || nowSeconds - timestamp >= maxAgeSeconds) {
    throw new AuthError(401, 'INIT_DATA_EXPIRED');
  }
  let user: TelegramUser;
  try {
    user = telegramUserSchema.parse(JSON.parse(parameters.get('user') ?? 'null'));
  } catch { throw new AuthError(); }
  return { user, hash: expected.toString('hex'), expiresAt: new Date((timestamp + maxAgeSeconds) * 1000) };
}
