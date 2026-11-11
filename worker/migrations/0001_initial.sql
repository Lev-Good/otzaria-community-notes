-- Otzaria Community Notes — D1 Initial Schema (v1)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  pubkey TEXT NOT NULL,
  recovery_hash TEXT NOT NULL,
  display_name TEXT NOT NULL UNIQUE,
  level TEXT NOT NULL DEFAULT 'new',          -- new | active | veteran | moderator
  role TEXT NOT NULL DEFAULT 'user',          -- user | moderator | admin
  seq INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_name_change_at INTEGER,
  banned_until INTEGER,
  ban_reason TEXT,
  daily_counts TEXT NOT NULL DEFAULT '{}',    -- JSON: { date, posts, votes, reports }
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(display_name);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  book_uid TEXT NOT NULL,
  title_hint TEXT NOT NULL DEFAULT '',
  ref TEXT NOT NULL DEFAULT '',
  section_hint INTEGER NOT NULL DEFAULT 0,
  quote TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL DEFAULT '',
  suffix TEXT NOT NULL DEFAULT '',
  occurrence INTEGER NOT NULL DEFAULT 0,
  lib_version TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,                         -- note | question | answer | reply
  root_id TEXT,
  reply_to_id TEXT,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',   -- pending | published | hidden | rejected | deleted
  question_status TEXT,                       -- open | answered (for kind='question')
  accepted_answer_id TEXT,
  w_up REAL NOT NULL DEFAULT 0,
  w_down REAL NOT NULL DEFAULT 0,
  up_count INTEGER NOT NULL DEFAULT 0,
  down_count INTEGER NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'new',           -- recommended | new | normal | low
  moderation_reason TEXT,
  moderation_category TEXT,
  risk_score INTEGER NOT NULL DEFAULT 0,      -- Higher = higher priority in mod queue
  ai_flags TEXT,                              -- JSON array of advisory AI flags
  appeal_status TEXT,                         -- none | pending | reviewed
  appeal_note TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  FOREIGN KEY (author_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_notes_book_ref_status ON notes(book_uid, ref, status);
CREATE INDEX IF NOT EXISTS idx_notes_root_status ON notes(root_id, status);
CREATE INDEX IF NOT EXISTS idx_notes_kind_qstatus_book ON notes(kind, question_status, book_uid);
CREATE INDEX IF NOT EXISTS idx_notes_author_created ON notes(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_mod_queue ON notes(status, risk_score DESC, created_at ASC);

CREATE TABLE IF NOT EXISTS votes (
  note_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  value INTEGER NOT NULL,                     -- 1 (helpful) | -1 (not helpful)
  reason TEXT,                                -- wrong | off_topic | unclear | inappropriate
  weight REAL NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (note_id, user_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_votes_note ON votes(note_id);
CREATE INDEX IF NOT EXISTS idx_votes_user_created ON votes(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  note_id TEXT NOT NULL,
  reporter_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_by TEXT,
  resolution TEXT,                            -- dismissed | upheld
  resolved_at INTEGER,
  UNIQUE(note_id, reporter_id),
  FOREIGN KEY (note_id) REFERENCES notes(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reports_note_unresolved ON reports(note_id, resolved_by);

CREATE TABLE IF NOT EXISTS inbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,                         -- reply | answer | accepted | mod_approved | mod_rejected | mod_hidden | appeal_decision
  note_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  actor_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_inbox_user_seq ON inbox(user_id, seq);
CREATE INDEX IF NOT EXISTS idx_inbox_created ON inbox(created_at);
CREATE INDEX IF NOT EXISTS idx_inbox_coalesce ON inbox(user_id, root_id, type, created_at DESC);

CREATE TABLE IF NOT EXISTS mod_log (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  details TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mod_log_at ON mod_log(at DESC);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  used_by TEXT,
  level TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  used_at INTEGER
);

-- Used for read-auth replay window & simple nonces if needed, plus per-book ETag versions
CREATE TABLE IF NOT EXISTS book_versions (
  book_uid TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS used_challenges (
  id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
