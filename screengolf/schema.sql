-- 스크린골프 동호회 예약 시스템 스키마 (Cloudflare D1 / SQLite)

CREATE TABLE IF NOT EXISTS members (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  login_id   TEXT    NOT NULL UNIQUE,
  name       TEXT    NOT NULL,
  phone      TEXT,
  pw_hash    TEXT    NOT NULL,
  pw_salt    TEXT    NOT NULL,
  role       TEXT    NOT NULL DEFAULT 'guest',    -- master | member | guest
  status     TEXT    NOT NULL DEFAULT 'pending',  -- pending | approved | rejected
  memo       TEXT,
  created_at TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  member_id  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_member ON sessions(member_id);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_date  TEXT    NOT NULL,            -- YYYY-MM-DD (KST)
  start_time  TEXT    NOT NULL,            -- HH:MM (KST)
  title       TEXT,
  place       TEXT,
  note        TEXT,
  rooms_count INTEGER NOT NULL DEFAULT 6,  -- 구장에서 쓸 방 수 (1~6). 정원 = 방수 x 4
  capacity    INTEGER,                     -- (예전 칼럼, 지금은 rooms_count로 계산)
  spread_guests INTEGER NOT NULL DEFAULT 1,-- 1이면 게스트를 방마다 고르게 분산
  assigned_at TEXT,                        -- 방 배정 완료 시각 (ISO)
  closed      INTEGER NOT NULL DEFAULT 0,  -- 1이면 신청 마감
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);

-- 참가 의사: yes(참가) / hold(보류) / no(비참가) / wait(당일 대기신청)
CREATE TABLE IF NOT EXISTS signups (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL,
  member_id  INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'yes',
  dropped    INTEGER NOT NULL DEFAULT 0,  -- 1이면 보류 상태로 마감을 넘겨 자동 제외됨
  created_at TEXT    NOT NULL,
  updated_at TEXT,
  UNIQUE(event_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_signups_event ON signups(event_id, status);

CREATE TABLE IF NOT EXISTS rooms (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  room_no  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_event ON rooms(event_id);

CREATE TABLE IF NOT EXISTS notices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT    NOT NULL,
  body       TEXT,
  pinned     INTEGER NOT NULL DEFAULT 0,  -- 1이면 맨 위 고정
  author_id  INTEGER,
  created_at TEXT    NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notices_created ON notices(created_at);

CREATE TABLE IF NOT EXISTS room_members (
  room_id   INTEGER NOT NULL,
  member_id INTEGER NOT NULL,
  seq       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_room_members_room ON room_members(room_id);
