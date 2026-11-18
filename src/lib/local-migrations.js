import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const defaultDirectory = fileURLToPath(new URL('../local-migrations/', import.meta.url));
export function runLocalMigrations(targetDb, { directory = defaultDirectory, legacyDatabase = false } = {}) {
  if (targetDb.pragma('user_version', { simple: true }) !== 32) {
    throw new Error('Unsupported upstream schema: expected approved version 32');
  }
  const files = fs.readdirSync(directory).filter(name => /^\d{3}_[a-z0-9_]+\.sql$/.test(name)).sort();
  targetDb.exec(`CREATE TABLE IF NOT EXISTS local_schema_migrations (
    id TEXT PRIMARY KEY NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const applied = targetDb.prepare('SELECT id, checksum FROM local_schema_migrations ORDER BY id').all();
  if (applied.some(row => !files.includes(row.id))) throw new Error('Unknown applied local migration');
  const results = [];
  for (const id of files) {
    // Git may check out CRLF on Windows. Hash canonical UTF-8/LF SQL, not OS line endings.
    const sql = fs.readFileSync(path.join(directory, id), 'utf8').replace(/\r\n/g, '\n');
    const checksum = crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
    const previous = applied.find(row => row.id === id);
    if (previous) {
      if (previous.checksum !== checksum) throw new Error(`Applied local migration checksum mismatch: ${id}`);
      continue;
    }
    targetDb.transaction(() => {
      targetDb.exec(sql);
      if (id === '001_identity.sql') {
        targetDb.prepare('UPDATE identity_state SET legacy_required = ? WHERE id = 1').run(legacyDatabase ? 1 : 0);
      }
      targetDb.prepare('INSERT INTO local_schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)')
        .run(id, checksum, new Date().toISOString());
    }).immediate();
    results.push(id);
  }
  return results;
}
