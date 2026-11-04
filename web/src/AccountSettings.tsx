import { useEffect, useState, type FormEvent } from 'react';
export type AccountUser = { id: string; username: string; email: string; role: string; disabled?: boolean };
type Request = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export function AccountSettings({user, request, onProfile}: {user:AccountUser; request:Request; onProfile:(user:AccountUser)=>void}) {
  const [users,setUsers] = useState<AccountUser[]>([]), [email,setEmail] = useState(user.email || '');
  const [current,setCurrent] = useState(''), [newPassword,setNewPassword] = useState(''), [confirmPassword,setConfirmPassword] = useState('');
  const [message,setMessage] = useState(''), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const [edit,setEdit] = useState<AccountUser | null>(null), [open,setOpen] = useState(false);
  const [username,setUsername] = useState(''), [accountEmail,setAccountEmail] = useState(''), [role,setRole] = useState('viewer'), [disabled,setDisabled] = useState(false), [password,setPassword] = useState(''), [adminPassword,setAdminPassword] = useState('');
  const reload = () => request<AccountUser[]>('/users').then(setUsers);
  useEffect(() => { if(user.role==='admin') reload().catch(e=>setError(e.message)); }, [user.role]);
  const perform = async (work:()=>Promise<void>) => {setBusy(true);setError('');setMessage('');try {await work();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const profile = (event:FormEvent) => {event.preventDefault();void perform(async()=>{
    const updated = await request<AccountUser>('/account','PATCH',{email,currentPassword:current}); onProfile(updated);setCurrent('');setMessage('Email saved.');
  });};
  const changePassword = (event:FormEvent) => {event.preventDefault();void perform(async()=>{
    if(newPassword!==confirmPassword) throw new Error('New passwords do not match.');
    await request('/account/password','POST',{currentPassword:current,newPassword});
    setCurrent('');setNewPassword('');setConfirmPassword('');window.dispatchEvent(new Event('session-expired'));
  });};
  const start = (account:AccountUser|null) => {setEdit(account);setOpen(true);setUsername(account?.username||'');setAccountEmail(account?.email||'');setRole(account?.role||'viewer');setDisabled(Boolean(account?.disabled));setPassword('');setAdminPassword('');setError('');setMessage('');};
  const save = (event:FormEvent) => {event.preventDefault();void perform(async()=>{
    const body = {username,email:accountEmail,role,disabled,currentPassword:adminPassword,...(password?{password}:{})};
    await request(edit?`/users/${edit.id}`:'/users',edit?'PATCH':'POST',body);
    setPassword('');setAdminPassword('');setOpen(false);await reload();setMessage(edit?'Account updated.':'Account created.');
    if(edit?.id===user.id) {const me=await request<{user:AccountUser}>('/auth/me');onProfile(me.user);}
  });};
  return <section className="panel account-settings">
    <div className="panel-heading"><div><h2>Your account</h2><p>Signed in as {user.username} · {user.role}</p></div></div>
    {error && <p className="account-feedback danger-text" role="alert">{error}</p>}
    {message && <p className="account-feedback" role="status">{message}</p>}
    <div className="account-forms">
      <form onSubmit={profile}><h3>Email address</h3><label>Email<input type="email" autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label><p className="muted">Contact email only. Continue signing in with your username; email delivery and password-reset emails are not configured.</p><label>Current password<input type="password" required autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)}/></label><button className="button primary" disabled={busy}>Save email</button></form>
      <form onSubmit={changePassword}><h3>Change password</h3><label>Current password<input type="password" required autoComplete="current-password" value={current} onChange={e=>setCurrent(e.target.value)}/></label><label>New password<input type="password" required minLength={8} maxLength={1024} autoComplete="new-password" value={newPassword} onChange={e=>setNewPassword(e.target.value)}/></label><label>Confirm new password<input type="password" required autoComplete="new-password" value={confirmPassword} onChange={e=>setConfirmPassword(e.target.value)}/></label><p className="muted">Use at least 8 characters. Changing your password signs out all sessions, including this one.</p><button className="button primary" disabled={busy}>Change password</button></form>
    </div>
    {user.role==='admin' && <><div className="panel-heading"><div><h2>User management</h2><p>Manage access without deleting account history.</p></div><button className="button primary" onClick={()=>start(null)}>Add user</button></div><div className="table-scroll"><table><thead><tr><th>USERNAME</th><th>EMAIL</th><th>ROLE</th><th>STATUS</th><th/></tr></thead><tbody>{users.map(account=><tr key={account.id}><td>{account.username}{account.id===user.id?' (you)':''}</td><td>{account.email||'—'}</td><td>{account.role}</td><td>{account.disabled?'Disabled':'Enabled'}</td><td><button className="button secondary small" onClick={()=>start(account)}>Manage {account.username}</button></td></tr>)}</tbody></table></div>
    <p className="account-feedback muted">Administrators manage users and app updates. Operators manage endpoints and run jobs. Viewers can only read fleet information and output.</p>
    {open && <form className="account-editor" onSubmit={save}><h3>{edit?`Manage ${edit.username}`:'Create user'}</h3><div className="account-editor-fields"><label>Username<input required disabled={!!edit} autoComplete="off" value={username} onChange={e=>setUsername(e.target.value)}/></label><label>Account email<input type="email" value={accountEmail} onChange={e=>setAccountEmail(e.target.value)}/></label><label>Role<select value={role} onChange={e=>setRole(e.target.value)}><option value="viewer">Viewer — read only</option><option value="operator">Operator — endpoint actions</option><option value="admin">Administrator — full access</option></select></label><label>{edit?'Reset password (leave blank to keep)':'Initial password'}<input type="password" required={!edit} minLength={8} maxLength={1024} autoComplete="new-password" value={password} onChange={e=>setPassword(e.target.value)}/></label><label>Your administrator password<input type="password" required autoComplete="current-password" value={adminPassword} onChange={e=>setAdminPassword(e.target.value)}/></label>{edit && <label className="account-toggle"><input type="checkbox" checked={disabled} onChange={e=>setDisabled(e.target.checked)}/>Disable account</label>}</div><p className="muted">Disabling, changing roles, or resetting a password signs that user out immediately. At least one enabled administrator must remain.</p><div className="account-buttons"><button className="button primary" disabled={busy}>Save account</button><button type="button" className="button secondary" onClick={()=>{setOpen(false);setPassword('');setAdminPassword('');}}>Cancel</button></div></form>}</>}
  </section>;
}
