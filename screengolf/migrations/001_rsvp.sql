-- 이미 예전 버전으로 배포해 둔 데이터베이스가 있을 때만 한 번 실행하세요.
-- 처음 설치하는 경우에는 schema.sql 하나만 실행하면 됩니다.
--
--   wrangler d1 execute screengolf --remote --file=./migrations/001_rsvp.sql
--
-- (이미 있는 칼럼이라 "duplicate column name" 오류가 나면 그 줄은 건너뛰어도 됩니다.)

ALTER TABLE events  ADD COLUMN rooms_count INTEGER NOT NULL DEFAULT 6;
ALTER TABLE signups ADD COLUMN status      TEXT    NOT NULL DEFAULT 'yes';
ALTER TABLE signups ADD COLUMN dropped     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE signups ADD COLUMN updated_at  TEXT;

CREATE TABLE IF NOT EXISTS notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT,
  pinned     INTEGER NOT NULL DEFAULT 0,
  author_id  INTEGER,
  created_at TEXT    NOT NULL,
  updated_at TEXT
);
