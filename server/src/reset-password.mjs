// Break-glass password reset for an operator who is locked out of the web console.
// Run on the Linux host inside the RMM container:
//   docker exec -it library-rmm-rmm-1 node src/reset-password.mjs <username>
// The new password is read from stdin (hidden when interactive) so it never appears in shell
// history, process listings or logs. The account is re-enabled, every existing session for it
// is revoked, and the action is written to the audit log.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase, transaction } from './db.mjs';
import { passwordHash, MIN_PASSWORD_LENGTH } from './security.mjs';

export function resetPassword(db, username, password) {
  if (typeof username !== 'string' || !username.trim()) throw new Error('Username is required.');
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH || password.length > 1024)
    throw new Error(`Password must be ${MIN_PASSWORD_LENGTH}-1024 characters.`);
  return transaction(db, () => {
    const user = db.prepare('SELECT id, username FROM users WHERE lower(username)=lower(?)').get(username.trim());
    if (!user) throw new Error('No account has that username.');
    db.prepare('UPDATE users SET password_hash=?, disabled=0 WHERE id=?').run(passwordHash(password), user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
    db.prepare('INSERT INTO audit(id,actor,action,target,details,created_at) VALUES (?,?,?,?,?,?)')
      .run(randomUUID(), 'server-console', 'account.password.reset.console', user.id, '{}', new Date().toISOString());
    return user.username;
  });
}

async function readSecret(prompt) {
  const input = process.stdin;
  if (!input.isTTY) {
    let text = '';
    for await (const chunk of input) text += chunk;
    return text.replace(/\r?\n$/, '');
  }
  process.stdout.write(prompt);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return await new Promise((done, failed) => {
    let value = '';
    input.on('data', function onData(key) {
      for (const character of key) {
        if (character === '\u0003') { input.setRawMode(false); failed(new Error('Cancelled.')); return; }
        if (character === '\r' || character === '\n') {
          input.setRawMode(false); input.pause(); input.off('data', onData);
          process.stdout.write('\n'); done(value); return;
        }
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
      }
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('reset-password.mjs')) {
  const username = process.argv[2];
  if (!username) { console.error('Usage: node src/reset-password.mjs <username>'); process.exit(2); }
  try {
    const password = await readSecret('New password: ');
    if (process.stdin.isTTY) {
      const again = await readSecret('Confirm new password: ');
      if (again !== password) throw new Error('Passwords did not match.');
    }
    const db = openDatabase(process.env.DATABASE_PATH || resolve('data/rmm.db'));
    try { console.log(`Password reset for ${resetPassword(db, username, password)}. Existing sessions were signed out.`); }
    finally { db.close(); }
  } catch (error) { console.error(error.message); process.exit(1); }
}
