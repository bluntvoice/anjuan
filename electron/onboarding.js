// Only this trusted onboarding document receives the narrow preload bridge.
(async () => {
  const { newPasswordError } = await import('../public/js/password-policy.js');
  const api = window.anjianOnboarding;
  const $ = id => document.getElementById(id);
  let context, busy = false;
  function validate() {
    const legacy = context?.mode === 'legacy';
    const ready = context && context.mode !== 'blocked' && $('dir').value
      && (legacy ? $('pass').value.length > 0 && $('confirm').checked
        : $('user').value.trim() && !newPasswordError($('pass').value));
    $('submit').disabled = busy || !ready;
  }
  try {
    context = await api.context();
    if (context.dataDir) $('dir').value = context.dataDir;
    if (context.mode === 'blocked') {
      $('err').textContent = context.message; $('pick').disabled = true;
    } else if (context.mode === 'legacy') {
      $('user').value = context.username; $('user').readOnly = true; $('pick').disabled = true;
      $('pass-label').textContent = '原账号密码'; $('pass').autocomplete = 'current-password';
      $('password-hint').textContent = '验证原凭据后迁移，合法旧密码不受新建密码长度限制。';
      $('legacy-confirm').hidden = false; $('submit').textContent = '备份并验证迁移';
    } else if (context.pending) {
      $('pick').disabled = true; $('submit').textContent = '继续初始化，进入登录';
    }
    validate();
  } catch (error) { $('err').textContent = error.message; }
  $('pick').addEventListener('click', async () => {
    try { const directory = await api.chooseDir(); if (directory) $('dir').value = directory; validate(); }
    catch (error) { $('err').textContent = error.message; }
  });
  for (const id of ['user', 'pass', 'confirm']) $(id).addEventListener('input', validate);
  $('form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    const legacy = context?.mode === 'legacy';
    if (!legacy) { const error = newPasswordError($('pass').value); if (error) { $('err').textContent = error; return; } }
    busy = true; validate(); $('err').textContent = ''; $('checking').classList.add('show');
    try {
      const result = await api.complete(legacy
        ? { old_password: $('pass').value, confirm_legacy: $('confirm').checked }
        : { username: $('user').value, password: $('pass').value });
      if (!result?.ok) throw new Error('初始化尚未完成');
      $('pass').value = '';
    } catch (error) {
      $('err').textContent = error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
    } finally { busy = false; $('checking').classList.remove('show'); validate(); }
  });
})().catch(() => {
  document.getElementById('err').textContent = '初始化页面未能加载，请退出并核查程序文件';
});
