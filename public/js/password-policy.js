// One policy module is used by both the native HTML client and the server.
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export function newPasswordError(password) {
  if (typeof password !== 'string' || !password.isWellFormed()) return '请输入有效的 Unicode 密码';
  const length = Array.from(password).length;
  return length < PASSWORD_MIN || length > PASSWORD_MAX ? '密码长度须为 12–128 个字符' : '';
}
