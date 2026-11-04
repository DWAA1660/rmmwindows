import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.mjs';
import { listen } from './listen.mjs';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/db.mjs';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('account lifecycle enforces roles, reauthentication, last admin and session revocation', async t => {
  const password='isolated-admin-password';
  const service=createApp({databasePath:':memory:',env:{ADMIN_USERNAME:'admin',ADMIN_PASSWORD:password}});
  const server=await listen(service.app);
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));service.close();});
  const base=`http://127.0.0.1:${server.address().port}/api`;
  const req=async(path,method='GET',body,session)=>{
    const response=await fetch(base+path,{method,headers:{Origin:base.slice(0,-4),'Content-Type':'application/json',...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}: {})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  };
  const login=async(username,pass=password)=>{const result=await req('/auth/login','POST',{username,password:pass});return {...result,csrf:result.data.csrfToken};};
  const admin=await login('ADMIN');assert.equal(admin.status,200);
  const self=admin.data.user;assert.equal(self.role,'admin');
  assert.equal((await req('/users','POST',{username:'no-auth'},undefined)).status,401);
  assert.equal((await req('/account','PATCH',{email:'admin@example.org',currentPassword:'wrong'},admin)).status,403);
  assert.equal((await req('/account','PATCH',{email:'admin@example.org',currentPassword:password},admin)).status,200);
  assert.equal((await req(`/users/${self.id}`,'PATCH',{role:'viewer',currentPassword:password},admin)).status,409);
  assert.equal((await req(`/users/${self.id}`,'PATCH',{disabled:true,currentPassword:password},admin)).status,409);
  for(const role of ['viewer','operator']) {
    const created=await req('/users','POST',{username:role,email:`${role}@example.org`,role,password:'isolated-user-password',currentPassword:password},admin);
    assert.equal(created.status,201);assert.equal('password_hash' in created.data,false);
    const session=await login(role,'isolated-user-password');assert.equal(session.status,200);
    assert.equal((await req('/users','GET',undefined,session)).status,403);
    assert.equal((await req('/settings/update','POST',{},session)).status,403);
    assert.equal((await req('/Settings/Update/','POST',{},session)).status,403);
    assert.equal((await req('/AUDIT/','GET',undefined,session)).status,403);
    assert.equal((await req('/overview','GET',undefined,session)).status,200);
    const script=await req('/scripts','POST',{name:'test',body:'Write-Output ok'},session);
    assert.equal(script.status,role==='viewer'?403:201);
    assert.equal((await req(`/users/${created.data.id}`,'PATCH',{disabled:true,currentPassword:password},admin)).status,200);
    assert.equal((await req('/auth/me','GET',undefined,session)).status,401);
    assert.equal((await login(role,'isolated-user-password')).status,401);
    await req(`/users/${created.data.id}`,'PATCH',{disabled:false,password:'replacement-user-password',currentPassword:password},admin);
    assert.equal((await login(role,'replacement-user-password')).status,200);
  }
  assert.equal((await req('/users','POST',{username:'VIEWER',role:'viewer',password:'isolated-user-password',currentPassword:password},admin)).status,409);
  assert.equal((await req('/account/password','POST',{currentPassword:password,newPassword:'short'},admin)).status,400);
  assert.equal((await req('/account/password','POST',{currentPassword:password,newPassword:'replacement-admin-password'},admin)).status,200);
  assert.equal((await req('/auth/me','GET',undefined,admin)).status,401);
  assert.equal((await login('admin','replacement-admin-password')).status,200);
  const audit=JSON.stringify(service.db.prepare('SELECT * FROM audit').all());assert.ok(!audit.includes('replacement-admin-password'));
});

test('v1 migration preserves the existing account and is repeatable',()=>{
  const folder=mkdtempSync(join(tmpdir(),'rmm-account-migration-'));const filename=join(folder,'test.db');
  try {
    const old=new DatabaseSync(filename);old.exec("CREATE TABLE users (id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,created_at TEXT NOT NULL); INSERT INTO users VALUES ('old','admin','original-hash','2026-01-01'); PRAGMA user_version=1;");old.close();
    for(let i=0;i<2;i++){const db=openDatabase(filename);const user=db.prepare('SELECT * FROM users').get();assert.equal(user.role,'admin');assert.equal(user.disabled,0);assert.equal(user.password_hash,'original-hash');assert.equal(db.prepare('PRAGMA user_version').get().user_version,2);db.close();}
  }finally{assert.ok(folder.startsWith(join(tmpdir(),'rmm-account-migration-')));rmSync(folder,{recursive:true,force:true});}
});

test('8-character passwords are accepted and console reset revokes sessions without exposing the hash', async t => {
  const { resetPassword } = await import('../src/reset-password.mjs');
  const { verifyPassword } = await import('../src/security.mjs');
  const service=createApp({databasePath:':memory:',env:{ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'Short#88'}});
  t.after(()=>service.close());
  const db=service.db;
  assert.ok(db, 'createApp must expose its database for this test');
  db.prepare("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) SELECT 'x',id,'y','2999-01-01' FROM users").run();
  db.prepare('UPDATE users SET disabled=1').run();
  assert.throws(()=>resetPassword(db,'admin','seven77'),/8-1024/);
  assert.throws(()=>resetPassword(db,'missing','Long-enough'),/No account/);
  assert.equal(resetPassword(db,'ADMIN','New#Pass1'),'admin');
  const row=db.prepare('SELECT * FROM users').get();
  assert.equal(row.disabled,0); assert.ok(verifyPassword('New#Pass1',row.password_hash));
  assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n,0);
  assert.equal(db.prepare("SELECT count(*) n FROM audit WHERE action='account.password.reset.console'").get().n,1);
});
