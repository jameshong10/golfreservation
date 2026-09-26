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
  nickname   TEXT,                            -- 동호회 닉네임 = 골프존 닉네임 (본인이 자유롭게 변경)
  gz_mask    TEXT,                            -- 골프존 결과화면의 가려진 아이디 (예: giveufi**) — 결과 저장 시 자동 기록
  dues_year  INTEGER,                         -- 회비를 낸 해 (1년에 한 번, 예: 2026)
  created_at TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_members_nickname ON members(nickname);

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
  entry_fee   INTEGER NOT NULL DEFAULT 4000, -- 1인 참가비
  prize_json  TEXT,                        -- 방배정 때 뽑은 시상 금액 {n, fee, amounts[], drawn_at}
  results_at  TEXT,                        -- 대회 결과 저장 시각
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

-- 예전 닉네임 / 골프존 결과에 찍혔던 닉네임 (사진 인식 때 같은 사람으로 찾기 위해)
CREATE TABLE IF NOT EXISTS member_aliases (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id  INTEGER NOT NULL,
  alias      TEXT    NOT NULL,
  created_at TEXT    NOT NULL,
  UNIQUE(member_id, alias)
);
CREATE INDEX IF NOT EXISTS idx_aliases_alias ON member_aliases(alias);

-- 대회 결과 (골프존 스트로크 결과표)
CREATE TABLE IF NOT EXISTS results (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id   INTEGER NOT NULL,
  member_id  INTEGER,                 -- 비회원이면 NULL
  raw_nick   TEXT,                    -- 결과표에 찍힌 닉네임 그대로
  gz_mask    TEXT,                    -- 결과표에 찍힌 가려진 골프존 아이디
  rank_no    INTEGER NOT NULL,
  rank_label TEXT,                    -- "3", "T6"
  stroke     INTEGER NOT NULL,        -- 스트로크
  handicap   INTEGER NOT NULL DEFAULT 0, -- 보정치
  final      INTEGER NOT NULL,        -- 최종성적
  prize      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_results_event ON results(event_id);
CREATE INDEX IF NOT EXISTS idx_results_member ON results(member_id);

-- 특별상 (홀인원 · 알바트로스 등) — 마스터가 대회마다 만든다
CREATE TABLE IF NOT EXISTS jackpots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    INTEGER NOT NULL,
  kind        TEXT    NOT NULL,             -- hio(홀인원) | albatross(알바트로스) | custom
  label       TEXT    NOT NULL,             -- 화면에 보일 이름
  amount      INTEGER NOT NULL DEFAULT 0,   -- 상금 (원)
  note        TEXT,
  winner_id   INTEGER,                      -- 달성한 회원 (비회원이면 NULL)
  winner_name TEXT,                         -- 비회원 달성자 이름
  hole_no     INTEGER,
  won_at      TEXT,                         -- 달성 기록 시각
  carried_to  INTEGER,                      -- 달성자 없이 이월된 일정 id
  created_by  INTEGER,
  created_at  TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jackpots_event ON jackpots(event_id);
