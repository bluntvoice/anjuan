import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { runLocalMigrations } from '../../src/lib/local-migrations.js';
import { createIdentityService } from '../../src/lib/identity-service.js';

export function memoryIdentity({ legacyDatabase = false, ...options } = {}) {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const migrations = path.resolve(import.meta.dirname, '../../src/migrations');
  for (const name of fs.readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) db.exec(fs.readFileSync(path.join(migrations, name), 'utf8'));
  db.pragma('user_version = 32');
  runLocalMigrations(db, { legacyDatabase });
  return { db, identity: createIdentityService(db, options) };
}
