import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import dataPaths from './windows-data-paths.cjs';

const verifiedFiles = new Set();
const identity = stat => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
const powerShell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const protectScript = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$file = Get-Item -LiteralPath $env:ANJUAN_PRIVATE_KEY_FILE -Force
if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Not a regular private file' }
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ids = @($current, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
$existing = Get-Acl -LiteralPath $file.FullName
$valid = $existing.AreAccessRulesProtected -and $existing.Access.Count -eq $ids.Count
foreach ($rule in $existing.Access) {
  if ($rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $ids -or $rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or [int]$rule.FileSystemRights -ne 2032127) { $valid = $false }
}
if (-not $valid) {
  $acl = New-Object Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in $ids) {
    $principal = New-Object Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($principal, 'FullControl', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $file.FullName -AclObject $acl
}
$read = Get-Acl -LiteralPath $file.FullName
$rules = @($read.Access | ForEach-Object { @{ sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; allow=($_.AccessControlType -eq 'Allow'); inherited=$_.IsInherited; rights=[int]$_.FileSystemRights } })
@{ current=$current; protected=$read.AreAccessRulesProtected; rules=$rules } | ConvertTo-Json -Depth 4 -Compress
`;

export function protectWindowsPrivateFile(filePath) {
  dataPaths.assertFilePath(filePath);
  const before = fs.lstatSync(filePath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('密钥文件必须是普通文件');
  const key = identity(before);
  if (verifiedFiles.has(key)) return before;
  try {
    const env = { ...process.env, ANJUAN_PRIVATE_KEY_FILE: path.resolve(filePath) };
    for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
    env.PSModulePath = path.join(path.dirname(powerShell), 'Modules');
    const output = execFileSync(powerShell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(protectScript, 'utf16le').toString('base64')], {
      env,
      encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(output.trim());
    const allowed = new Set([result.current, 'S-1-5-18', 'S-1-5-32-544']);
    if (!/^S-1-/.test(result.current) || !result.protected || result.rules.length !== allowed.size
      || result.rules.some(rule => !allowed.has(rule.sid) || !rule.allow || rule.inherited || rule.rights !== 2032127)
      || new Set(result.rules.map(rule => rule.sid)).size !== allowed.size) throw new Error('ACL readback mismatch');
    const after = fs.lstatSync(filePath, { bigint: true });
    if (!after.isFile() || after.isSymbolicLink() || identity(after) !== key) throw new Error('Private file changed during ACL setup');
    if (verifiedFiles.size >= 64) verifiedFiles.clear();
    verifiedFiles.add(key);
    return after;
  } catch (error) {
    // Never include a key, native command output or private pathname in errors.
    const failure = error.message === 'ACL readback mismatch' ? 'acl_readback' : error.message === 'Private file changed during ACL setup' ? 'file_identity' : 'acl_command';
    throw Object.assign(new Error('Windows 密钥 ACL 保护失败，已停止读取或写入'), { code: 'PRIVATE_KEY_ACL_FAILED', failure });
  }
}

export function readWindowsPrivateFile(filePath) {
  const protectedStat = protectWindowsPrivateFile(filePath);
  const fd = fs.openSync(filePath, 'r');
  try {
    if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(protectedStat)) throw new Error('密钥文件在读取前被替换');
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

export function writeWindowsPrivateTempFile(filePath, bytes, protect = protectWindowsPrivateFile) {
  dataPaths.assertFilePath(filePath);
  const fd = fs.openSync(filePath, 'wx', 0o600);
  const original = fs.fstatSync(fd, { bigint: true });
  let completed = false;
  try {
    const protectedStat = protect(filePath);
    if (identity(original) !== identity(protectedStat)) throw new Error('密钥临时文件在保护前被替换');
    fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    completed = true;
  } finally {
    fs.closeSync(fd);
    if (!completed && fs.existsSync(filePath)) {
      const remaining = fs.lstatSync(filePath, { bigint: true });
      if (!remaining.isSymbolicLink() && identity(remaining) === identity(original)) fs.unlinkSync(filePath);
    }
  }
}
