import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';

export const MIN_PASSWORD_LENGTH = 8;
export const randomToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`;
}
export function verifyPassword(password, encoded) {
  const [scheme, salt, expected] = encoded.split(':');
  if (scheme !== 'scrypt' || !expected) return false;
  const actual = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expectedBytes = Buffer.from(expected, 'hex');
  return expectedBytes.length === actual.length && timingSafeEqual(actual, expectedBytes);
}
export function equalText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aa = Buffer.from(a); const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}
export function cookies(header = '') {
  return Object.fromEntries(header.split(';').map(v => v.trim().split('=')).filter(v => v.length === 2));
}

export function rateLimiter({ limit, intervalMs, key = req => req.ip || req.socket.remoteAddress }) {
  const entries = new Map();
  let calls = 0;
  return (req, res, next) => {
    const now = Date.now();
    if (++calls % 1000 === 0) for (const [k, v] of entries) if (v.reset <= now) entries.delete(k);
    const k = key(req); let entry = entries.get(k);
    if (!entry || entry.reset <= now) { entry = { count: 0, reset: now + intervalMs }; entries.set(k, entry); }
    if (++entry.count > limit) return res.status(429).set('Retry-After', String(Math.ceil((entry.reset - now) / 1000))).json({ error: 'Too many requests. Try again later.' });
    next();
  };
}
