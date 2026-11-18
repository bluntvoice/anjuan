'use strict';
// W05 measured Node 24.19/Electron Node 24.21 + SQLite 3.53.4 + Windows PowerShell ACL budget.
// Plain Windows paths only; no truncation, relocation, long-path prefix or policy changes.
const fs = require('node:fs');
const path = require('node:path');
const FILE_LIMIT = 259, TEMP_DIRECTORY_LIMIT = 247, COMPONENT_LIMIT = 255;
const BACKUP_NAME = 'identity-XXXXXX';
const CONFIG_TEMP = '.config-12345678-1234-1234-1234-123456789012.tmp';
const KEY_TEMP = '.secret.key.tmp-' + 'x'.repeat(16);
function unsupported(reason, actual, limit) {
  return Object.assign(new Error('所选数据目录或配置路径过深，无法安全完成初始化和备份。请选择较短的目录；现有资料未移动或删除。'),
    { code: 'DATA_PATH_UNSUPPORTED', reason, actual, limit });
}
function assertFilePath(file, { directory = false } = {}) {
  const absolute = path.resolve(file);
  if (process.platform !== 'win32') return absolute;
  if (!/^[a-z]:\\/i.test(absolute) || absolute.startsWith('\\\\')) throw unsupported('unsupported_path_form');
  const parts = absolute.slice(3).split(path.sep);
  for (const part of parts) {
    if (part.length > COMPONENT_LIMIT) throw unsupported('component_length', part.length, COMPONENT_LIMIT);
    if (part && (/[<>:"|?*\x00-\x1f]/.test(part) || /[ .]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw unsupported('unsupported_component');
  }
  const limit = directory ? TEMP_DIRECTORY_LIMIT : FILE_LIMIT;
  if (absolute.length > limit) throw unsupported(directory ? 'temporary_directory_length' : 'derived_file_length', absolute.length, limit);
  return absolute;
}
function assertRoot(root) {
  const absolute = path.resolve(root);
  if (process.platform !== 'win32') return absolute;
  assertFilePath(absolute);
  let cursor = absolute;
  while (true) {
    if (fs.existsSync(cursor)) {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error('数据路径包含非目录或重解析点，请保留资料并核查路径。'), { code: 'DATA_PATH_INVALID' });
      if (path.resolve(fs.realpathSync.native(cursor)).toLowerCase() !== cursor.toLowerCase()) throw Object.assign(new Error('数据路径实体与所选路径不一致。'), { code: 'DATA_PATH_INVALID' });
    }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
  return absolute;
}
function assertDatabasePath(dbPath) {
  if (dbPath === ':memory:') return;
  const absolute = assertFilePath(dbPath);
  if (process.platform !== 'win32') return;
  assertRoot(path.dirname(absolute));
  for (const suffix of ['-wal', '-shm', '-journal']) assertFilePath(absolute + suffix);
  // Keys and future identity snapshots must remain usable, not only the current database.
  assertDataPaths({ dataDir: path.dirname(absolute) });
}
function assertConfigWritePath(file) {
  assertFilePath(file);
  assertFilePath(path.join(path.dirname(file), CONFIG_TEMP));
  if (process.platform === 'win32') assertRoot(path.dirname(file));
}
function assertDataPaths({ dataDir, userData, configPath } = {}) {
  if (process.platform !== 'win32') return;
  if (userData) {
    assertRoot(userData);
    for (const name of ['config.json', 'identity-migration.json', CONFIG_TEMP]) assertFilePath(path.join(userData, name));
  }
  if (configPath) assertConfigWritePath(configPath);
  if (!dataDir) return;
  const root = assertRoot(dataDir);
  for (const name of ['anjian.db', 'anjian.db-wal', 'anjian.db-shm', 'anjian.db-journal', 'secret.key', KEY_TEMP]) assertFilePath(path.join(root, name));
  const snapshot = path.join(root, 'migration-backups', BACKUP_NAME);
  assertFilePath(snapshot, { directory: true });
  for (const name of ['anjian.db', 'anjian.db-journal', 'anjian.db-wal', 'anjian.db-shm', 'config.json', 'secret.key', 'manifest.json', '.manifest.tmp']) assertFilePath(path.join(snapshot, name));
}
function assertBackupPaths({ dataDir, configPath, relativePaths = [] }) {
  assertDataPaths({ dataDir, configPath });
  if (process.platform !== 'win32') return;
  const backup = path.join(path.resolve(dataDir), 'migration-backups', BACKUP_NAME);
  for (const relative of relativePaths) assertFilePath(path.join(backup, relative));
}
function assertRestorePaths(target, relativePaths) {
  if (process.platform !== 'win32') return;
  assertRoot(target);
  for (const relative of relativePaths) {
    const file = path.join(target, relative); assertFilePath(file);
    if (relative === 'anjian.db') for (const suffix of ['-wal', '-shm', '-journal']) assertFilePath(file + suffix);
  }
}
module.exports = { assertFilePath, assertRoot, assertDatabasePath, assertConfigWritePath, assertDataPaths, assertBackupPaths, assertRestorePaths,
  limits: Object.freeze({ file: FILE_LIMIT, temporaryDirectory: TEMP_DIRECTORY_LIMIT, component: COMPONENT_LIMIT }) };
