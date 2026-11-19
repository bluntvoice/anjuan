import { newPasswordError } from './password-policy.js';
const $ = id => document.getElementById(id);
const roles = { admin: '管理员', editor: '编辑人员', viewer: '只读人员' };
let current, resetTarget;
function message(text) { $('message').textContent = text; }
async function request(url, method = 'GET', body) {
  const response = await fetch('/api' + url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (response.status === 401) { location.replace('/login.html'); throw new Error('请重新登录'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成');
  return data;
}
async function action(button, work) {
  if (button) button.disabled = true;
  message('');
  try { await work(); } catch (error) { message(error.message); } finally { if (button) button.disabled = false; }
}
function checkPassword(password) { const error = newPasswordError(password); if (error) throw new Error(error); }
async function loadUsers() {
  const { users } = await request('/users');
  $('users').replaceChildren();
  for (const user of users) {
    const row = document.createElement('tr');
    const title = document.createElement('td'); title.textContent = `${user.username} / ${user.display_name}`;
    const roleCell = document.createElement('td'), select = document.createElement('select');
    select.setAttribute('aria-label', `${user.username} 的角色`);
    for (const [key, text] of Object.entries(roles)) { const option = document.createElement('option'); option.value = key; option.textContent = text; select.append(option); }
    select.value = user.role_key; roleCell.append(select);
    const state = document.createElement('td'); state.textContent = user.active ? '启用' : '停用';
    const operations = document.createElement('td');
    const save = document.createElement('button'); save.textContent = '保存角色';
    const toggle = document.createElement('button'); toggle.textContent = user.active ? '停用' : '启用';
    const reset = document.createElement('button'); reset.textContent = '重置密码';
    const update = async body => {
      const data = await request('/users/' + encodeURIComponent(user.id), 'PATCH', { version: user.version, ...body });
      if (data.login_required) location.replace('/login.html'); else { await loadUsers(); message('账号已更新，旧会话已撤销'); }
    };
    save.addEventListener('click', () => action(save, () => update({ role_key: select.value })));
    toggle.addEventListener('click', () => action(toggle, () => update({ active: !user.active })));
    reset.addEventListener('click', () => { resetTarget = user; $('reset-target').value = user.username; $('reset-password').reset(); $('reset-target').value = user.username; $('reset-password').hidden = false; });
    operations.append(save, toggle, reset); row.append(title, roleCell, state, operations); $('users').append(row);
  }
}
$('logout').addEventListener('click', () => action($('logout'), async () => { await request('/logout', 'POST'); location.replace('/login.html'); }));
$('change-password').addEventListener('submit', event => {
  event.preventDefault(); const button = event.submitter; const form = event.currentTarget;
  action(button, async () => {
    const body = Object.fromEntries(new FormData(form)); checkPassword(body.password);
    await request('/auth/change-password', 'POST', { ...body, version: current.version });
    form.reset(); location.replace('/login.html');
  });
});
$('create-user').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(event.submitter, async () => {
    const body = Object.fromEntries(new FormData(form)); checkPassword(body.password);
    await request('/users', 'POST', body); form.reset(); await loadUsers(); message('账号已创建');
  });
});
$('reset-password').addEventListener('submit', event => {
  event.preventDefault(); const form = event.currentTarget;
  action(event.submitter, async () => {
    const password = new FormData(form).get('password'); checkPassword(password);
    const data = await request('/users/' + encodeURIComponent(resetTarget.id) + '/reset-password', 'POST', { password, version: resetTarget.version });
    form.reset(); form.hidden = true; resetTarget = null;
    if (data.login_required) location.replace('/login.html'); else { await loadUsers(); message('密码已重置，旧会话已撤销'); }
  });
});
$('cancel-reset').addEventListener('click', () => { $('reset-password').reset(); $('reset-password').hidden = true; resetTarget = null; });
$('refresh').addEventListener('click', () => action($('refresh'), loadUsers));
try {
  current = (await request('/auth/me')).user;
  $('current').textContent = `${current.display_name}（${current.username}） · ${roles[current.role_key]}`;
  if (current.role_key === 'admin') { $('admin').hidden = false; await loadUsers(); }
} catch (error) { message(error.message); }
