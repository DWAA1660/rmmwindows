import { randomUUID } from 'node:crypto';
import { passwordHash, verifyPassword, rateLimiter } from './security.mjs';
import { transaction } from './db.mjs';
export const publicUser = row => ({ id: row.user_id || row.id, username: row.username, email: row.email, role: row.role, disabled: Boolean(row.disabled), createdAt: row.created_at });

export function mountAccounts(app, { db, operator, csrf, audit, fail, str }) {
  const now = () => new Date().toISOString();
  const email = value => {
    const result = str(value, 'email', { min: 0, max: 254 }).trim();
    if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) fail(400, 'Enter a valid email address.');
    return result;
  };
  const role = value => { if (!['admin', 'operator', 'viewer'].includes(value)) fail(400, 'Invalid account role.'); return value; };
  const password = value => passwordHash(str(value, 'password', { min: 14, max: 1024 }));
  const confirm = req => {
    const supplied = str(req.body.currentPassword, 'currentPassword', { max: 1024 });
    const current = db.prepare('SELECT * FROM users WHERE id=? AND disabled=0').get(req.operator.user_id);
    if (!current || !verifyPassword(supplied, current.password_hash)) fail(403, 'Current password is incorrect.');
    return current;
  };
  const admin = (req, res, next) => req.operator.role === 'admin' ? next() : res.status(403).json({ error: 'Administrator access required.' });
  const limit = rateLimiter({ limit: 30, intervalMs: 15 * 60000, key: req => req.operator.user_id });
  app.patch('/api/account', operator, csrf, limit, (req, res) => {
    const current = confirm(req);
    const nextEmail = email(req.body.email);
    db.prepare('UPDATE users SET email=? WHERE id=?').run(nextEmail, current.id);
    audit(current.username, 'account.email.changed', current.id);
    res.json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(current.id)));
  });
  app.post('/api/account/password', operator, csrf, limit, (req, res) => {
    const current = confirm(req); const hash = password(req.body.newPassword);
    transaction(db, () => {
      db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, current.id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.id);
      audit(current.username, 'account.password.changed', current.id);
    });
    res.json({ ok: true, signInRequired: true });
  });
  app.get('/api/users', operator, admin, (req, res) => res.json(db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all().map(publicUser)));
  app.post('/api/users', operator, csrf, admin, limit, (req, res) => {
    confirm(req);
    const username = str(req.body.username, 'username', { max: 100 }).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,99}$/.test(username)) fail(400, 'Username may contain letters, numbers, dots, underscores, @ and hyphens.');
    const nextEmail = email(req.body.email ?? ''); const nextRole = role(req.body.role); const hash = password(req.body.password);
    if (db.prepare('SELECT id FROM users WHERE lower(username)=lower(?)').get(username)) fail(409, 'Username already exists.');
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,username,password_hash,created_at,email,role,disabled) VALUES (?,?,?,?,?,?,0)').run(id, username, hash, now(), nextEmail, nextRole);
    audit(req.operator.username, 'user.created', id, { username, role: nextRole });
    res.status(201).json(publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(id)));
  });
  app.patch('/api/users/:id', operator, csrf, admin, limit, (req, res) => {
    confirm(req);
    const result = transaction(db, () => {
      const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id);
      if (!target) fail(404, 'Account not found.');
      const nextEmail = req.body.email === undefined ? target.email : email(req.body.email);
      const nextRole = req.body.role === undefined ? target.role : role(req.body.role);
      const disabled = req.body.disabled === undefined ? Boolean(target.disabled) : req.body.disabled;
      if (typeof disabled !== 'boolean') fail(400, 'disabled must be true or false.');
      if (target.role === 'admin' && !target.disabled && (disabled || nextRole !== 'admin') && db.prepare("SELECT count(*) n FROM users WHERE role='admin' AND disabled=0").get().n <= 1) fail(409, 'Keep at least one enabled administrator.');
      const hash = req.body.password === undefined ? target.password_hash : password(req.body.password);
      db.prepare('UPDATE users SET email=?,role=?,disabled=?,password_hash=? WHERE id=?').run(nextEmail, nextRole, disabled ? 1 : 0, hash, target.id);
      if (disabled || nextRole !== target.role || req.body.password !== undefined) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
      audit(req.operator.username, 'user.updated', target.id, { role: nextRole, disabled, passwordReset: req.body.password !== undefined });
      return publicUser(db.prepare('SELECT * FROM users WHERE id=?').get(target.id));
    });
    res.json(result);
  });
}
