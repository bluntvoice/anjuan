'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { assertBackupPaths } = require('../src/lib/windows-data-paths.cjs');

const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function inventory(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const source = path.join(root, entry.name), relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new Error('备份遇到符号链接或重解析点，请先核查');
    if (entry.isDirectory()) result.push(...inventory(source, relative));
    else if (entry.isFile()) {
      const stat = fs.statSync(source);
      result.push({ relative, size: stat.size, mtime: stat.mtimeMs });
    } else throw new Error('备份遇到不支持的文件类型');
  }
  return result.sort((a, b) => a.relative.localeCompare(b.relative));
}
async function createIdentityBackup({ dataDir, configPath }) {
  const root = fs.realpathSync.native(dataDir);
  if (fs.lstatSync(dataDir).isSymbolicLink()) throw new Error('迁移数据根不能是重解析点');
  const filesRoot = path.join(root, '案件夹');
  const before = inventory(filesRoot);
  assertBackupPaths({ dataDir: root, configPath, relativePaths: before.map(file => '案件夹/' + file.relative) });
  const backupParent = path.join(root, 'migration-backups');
  if (fs.existsSync(backupParent) && fs.lstatSync(backupParent).isSymbolicLink()) throw new Error('备份根不能是重解析点');
  fs.mkdirSync(backupParent, { recursive: true });
  const backupRoot = fs.mkdtempSync(path.join(backupParent, 'identity-'));
  const manifest = { format: 1, complete: false, sourceVersion: require('../package.json').version, createdAt: new Date().toISOString(), entries: [] };
  fs.writeFileSync(path.join(backupRoot, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
  const add = (source, relative) => {
    const target = path.join(backupRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (process.platform === 'win32' && (relative === 'config.json' || relative === 'secret.key')) {
      require('../src/lib/private-key-file.js').writeWindowsPrivateTempFile(target, fs.readFileSync(source));
    } else fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    manifest.entries.push({ path: relative, bytes: fs.statSync(target).size, sha256: digest(target) });
  };
  const dbPath = path.join(root, 'anjian.db');
  let sourceDb;
  try {
    if (fs.existsSync(dbPath)) {
      if (fs.lstatSync(dbPath).isSymbolicLink()) throw new Error('数据库不能是符号链接');
      sourceDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      const dataVersion = sourceDb.pragma('data_version', { simple: true });
      await sourceDb.backup(path.join(backupRoot, 'anjian.db'));
      manifest.entries.push({ path: 'anjian.db', bytes: fs.statSync(path.join(backupRoot, 'anjian.db')).size, sha256: digest(path.join(backupRoot, 'anjian.db')) });
      for (const file of before) add(path.join(filesRoot, file.relative), '案件夹/' + file.relative);
      if (sourceDb.pragma('data_version', { simple: true }) !== dataVersion) throw new Error('备份期间数据库发生写入，停止迁移');
    } else {
      for (const file of before) add(path.join(filesRoot, file.relative), '案件夹/' + file.relative);
    }
    if (JSON.stringify(before) !== JSON.stringify(inventory(filesRoot))) throw new Error('备份期间案件文件发生变化，停止迁移');
    for (const [source, relative] of [[configPath, 'config.json'], [path.join(root, 'secret.key'), 'secret.key']]) {
      if (fs.existsSync(source)) {
        if (fs.lstatSync(source).isSymbolicLink()) throw new Error('必要配置或密钥不能是符号链接');
        add(source, relative);
      }
    }
    manifest.complete = true;
    const completedManifest = path.join(backupRoot, '.manifest.tmp');
    fs.writeFileSync(completedManifest, JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(completedManifest, path.join(backupRoot, 'manifest.json'));
    verifyIdentityBackup(backupRoot);
    return backupRoot;
  } finally { sourceDb?.close(); }
}
function verifyIdentityBackup(backupRoot) {
  if (fs.lstatSync(backupRoot).isSymbolicLink()) throw new Error('备份根不能是重解析点');
  if (fs.lstatSync(path.join(backupRoot, 'manifest.json')).isSymbolicLink()) throw new Error('备份清单不能是重解析点');
  const manifest = JSON.parse(fs.readFileSync(path.join(backupRoot, 'manifest.json'), 'utf8'));
  if (manifest.format !== 1 || !manifest.complete || !Array.isArray(manifest.entries)) throw new Error('备份不完整');
  const seen = new Set();
  for (const entry of manifest.entries) {
    if (typeof entry.path !== 'string' || entry.path.includes('\\') || entry.path.includes(':') || path.posix.isAbsolute(entry.path)
      || entry.path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(entry.path)) throw new Error('备份路径无效');
    seen.add(entry.path);
    const file = path.join(backupRoot, entry.path);
    let ancestor = backupRoot;
    for (const part of entry.path.split('/')) {
      ancestor = path.join(ancestor, part);
      if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('备份路径不能包含重解析点');
    }
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size !== entry.bytes || digest(file) !== entry.sha256) throw new Error('备份文件校验失败');
  }
  return manifest;
}
module.exports = { createIdentityBackup, verifyIdentityBackup };
