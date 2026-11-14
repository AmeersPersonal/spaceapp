-- Multi-agent chat threads (shared across specialist agents) and per-scene numeric stats
-- from the processor manifest (used by the predictive analysis).

ALTER TABLE scenes ADD COLUMN stats TEXT;   -- JSON object copied from manifest.stats

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_event ON conversations(event_id);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL,              -- user | assistant | consult
  agent TEXT,                      -- specialist id for assistant/consult rows
  model TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
