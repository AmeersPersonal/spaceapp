-- Chat ownership survives browser session expiry: user_id is the verified Auth0 sub.
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  event_id TEXT REFERENCES events(id),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_chats_owner_updated ON chats(user_id, updated_at DESC, id);

CREATE TABLE chat_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 8000),
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_chat_messages_order ON chat_messages(chat_id, sequence);
