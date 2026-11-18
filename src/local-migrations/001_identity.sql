CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL,
  username_normalized TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_key TEXT NOT NULL CHECK (role_key IN ('admin', 'editor', 'viewer')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  session_version INTEGER NOT NULL DEFAULT 1 CHECK (session_version >= 1),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE user_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64),
  user_id TEXT NOT NULL REFERENCES users(id),
  session_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX user_sessions_user ON user_sessions(user_id);
CREATE INDEX user_sessions_expiry ON user_sessions(expires_at);

CREATE TABLE identity_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  initialized INTEGER NOT NULL DEFAULT 0 CHECK (initialized IN (0, 1)),
  legacy_required INTEGER NOT NULL DEFAULT 0 CHECK (legacy_required IN (0, 1)),
  initialized_at TEXT,
  first_admin_id TEXT REFERENCES users(id)
);
INSERT INTO identity_state (id) VALUES (1);

ALTER TABLE audit_log ADD COLUMN actor_user_id TEXT REFERENCES users(id);
ALTER TABLE audit_log ADD COLUMN actor_display_name TEXT;
ALTER TABLE audit_log ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE audit_log ADD COLUMN request_id TEXT;
ALTER TABLE audit_log ADD COLUMN target_user_id TEXT REFERENCES users(id);

CREATE TRIGGER users_id_immutable BEFORE UPDATE OF id ON users
BEGIN SELECT RAISE(ABORT, 'user_id_immutable'); END;
CREATE TRIGGER users_no_delete BEFORE DELETE ON users
BEGIN SELECT RAISE(ABORT, 'user_hard_delete_disabled'); END;
CREATE TRIGGER users_last_admin BEFORE UPDATE OF active, role_key ON users
WHEN OLD.active = 1 AND OLD.role_key = 'admin'
 AND (NEW.active <> 1 OR NEW.role_key <> 'admin')
 AND NOT EXISTS (SELECT 1 FROM users WHERE id <> OLD.id AND active = 1 AND role_key = 'admin')
BEGIN SELECT RAISE(ABORT, 'last_active_admin'); END;

-- Old plaintext sessions have no trustworthy user mapping.
DELETE FROM sessions;
