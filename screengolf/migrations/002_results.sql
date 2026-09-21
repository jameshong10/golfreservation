-- 닉네임 · 대회 결과 · 시상 기능 추가 (지금 운영 중인 DB에 한 번만 실행)
--
--   wrangler d1 execute screengolf --remote --file=./migrations/002_results.sql
--
-- "duplicate column name" 오류가 나면 이미 적용된 것이니 그 줄은 무시해도 됩니다.

ALTER TABLE members ADD COLUMN nickname TEXT;
ALTER TABLE members ADD COLUMN gz_mask  TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_nickname ON members(nickname);

ALTER TABLE events ADD COLUMN entry_fee  INTEGER NOT NULL DEFAULT 4000;
ALTER TABLE events ADD COLUMN prize_json TEXT;
ALTER TABLE events ADD COLUMN results_at TEXT;

CREATE TABLE IF NOT EXISTS member_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL,
  alias      TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE(member_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON member_aliases(alias);

CREATE TABLE IF NOT EXISTS results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL,
  member_id  INTEGER,
  raw_nick   TEXT,
  gz_mask    TEXT,
  rank_no    INTEGER NOT NULL,
  rank_label TEXT,
  stroke     INTEGER NOT NULL,
  handicap   INTEGER NOT NULL DEFAULT 0,
  final      INTEGER NOT NULL,
  prize      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_event ON results(event_id);
CREATE INDEX IF NOT EXISTS idx_results_member ON results(member_id);
