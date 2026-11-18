import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

export function readActualWindowsAcl(file) {
  const env = { ...process.env, ANJUAN_ACL_TEST_FILE: path.resolve(file) };
  for (const name of Object.keys(env)) if (name.toLowerCase() === 'psmodulepath') delete env[name];
  env.PSModulePath = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules');
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $acl=Get-Acl -LiteralPath $env:ANJUAN_ACL_TEST_FILE;
    @{protected=$acl.AreAccessRulesProtected; sddl=$acl.Sddl; current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
      rules=@($acl.Access | ForEach-Object {@{sid=$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value; inherited=$_.IsInherited; kind=$_.AccessControlType.ToString(); rights=[int]$_.FileSystemRights}})} | ConvertTo-Json -Depth 4 -Compress`;
  return JSON.parse(execFileSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { encoding: 'utf8', windowsHide: true, env }).trim());
}
export function assertPrivateWindowsAcl(file) {
  const actual = readActualWindowsAcl(file);
  const expected = new Set([actual.current, 'S-1-5-18', 'S-1-5-32-544']);
  assert.equal(actual.protected, true, 'Private key ACL must disable inheritance');
  assert.equal(actual.rules.length, expected.size, 'Private key must have only the intended principals');
  for (const rule of actual.rules) {
    assert.equal(expected.has(rule.sid), true, 'Unexpected principal in private-key ACL');
    assert.equal(rule.inherited, false);
    assert.equal(rule.kind, 'Allow');
    assert.equal(rule.rights, 2032127, 'Current user, SYSTEM and local Administrators must retain required control');
  }
  assert.equal(new Set(actual.rules.map(r => r.sid)).size, expected.size);
}
