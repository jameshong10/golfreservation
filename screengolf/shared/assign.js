// 방 배정·마감 공용 모듈 — Pages Functions와 Cron Worker가 같이 사용합니다.

export const ROOM_MAX = 4; // 한 방 최대 인원
export const MAX_ROOMS = 6; // 구장에 있는 방 수 (1~6번 방)
export const ASSIGN_LEAD_MIN = 20; // 시작 몇 분 전에 배정할지
export const ENTRY_FEE = 4000; // 1인 참가비 (원)
export const PRIZE_UNIT = 1000; // 상금 단위 (원)

// 신청 상태
//  yes  : 참가 확정
//  hold : 보류 (전날 23:59까지만 유효)
//  no   : 비참가
//  wait : 대기 (당일 추가 신청 — 마스터가 방을 확보하면 yes로 올림)
export const STATUSES = ["yes", "hold", "no", "wait"];

export const nowISO = () => new Date().toISOString();

// KST 기준 시각(ms)
export const startTs = (ev) => Date.parse(`${ev.event_date}T${ev.start_time}:00+09:00`);
export const assignTs = (ev) => startTs(ev) - ASSIGN_LEAD_MIN * 60000;
// 정식 신청 마감 = 전날 23:59 (= 당일 00:00 직전)
export const deadlineTs = (ev) => Date.parse(`${ev.event_date}T00:00:00+09:00`);

export const roomsOf = (ev) => Math.min(Math.max(Number(ev.rooms_count) || MAX_ROOMS, 1), MAX_ROOMS);
export const capacityOf = (ev) => roomsOf(ev) * ROOM_MAX;

// 오늘 날짜(KST, YYYY-MM-DD)
export const todayKST = (offsetDays = 0) =>
  new Date(Date.now() + 9 * 3600000 + offsetDays * 86400000).toISOString().slice(0, 10);

/**
 * 인원수 n을 최대 4명 방으로 최대한 고르게 나눈다. (방은 최대 6개)
 *  5 -> [3,2]   6 -> [3,3]   7 -> [4,3]   8 -> [4,4]
 *  9 -> [3,3,3] 10 -> [4,3,3] 11 -> [4,4,3] 12 -> [4,4,4]
 */
export function roomSizes(n) {
  if (n <= 0) return [];
  const rooms = Math.min(Math.ceil(n / ROOM_MAX), MAX_ROOMS);
  const base = Math.floor(n / rooms);
  const rem = n % rooms;
  return Array.from({ length: rooms }, (_, i) => base + (i < rem ? 1 : 0));
}

export function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 참가자를 방에 랜덤 배정 */
export function buildRooms(participants, spreadGuests) {
  const sizes = roomSizes(participants.length);
  const rooms = sizes.map((cap) => ({ cap, members: [] }));
  if (!rooms.length) return rooms;

  // 정회원을 먼저 돌려 담고 게스트를 이어서 돌려 담으면 게스트가 방마다 흩어진다
  const order = spreadGuests
    ? [
        ...shuffle(participants.filter((p) => p.role !== "guest")),
        ...shuffle(participants.filter((p) => p.role === "guest")),
      ]
    : shuffle(participants);

  let i = 0;
  for (const p of order) {
    let guard = 0;
    while (rooms[i % rooms.length].members.length >= rooms[i % rooms.length].cap && guard < rooms.length * 3) {
      i++;
      guard++;
    }
    rooms[i % rooms.length].members.push(p);
    i++;
  }
  return rooms;
}

/* ---------------- 시상 ---------------- */

/** 시상 인원: 참가자의 절반(내림). 7명 → 3명, 10명 → 5명. 1명이면 1명 */
export const winnersOf = (n) => (n <= 0 ? 0 : Math.max(1, Math.floor(n / 2)));

const rand01 = () => crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296;

/**
 * 참가비 총액을 1등이 가장 많고 아래로 갈수록 적게, 랜덤으로 나눈다.
 *  - 1,000원 단위, 합계 = 인원 x 참가비
 *  - 입상자는 최소 참가비 + 1,000원은 받는다
 *  - 가능한 한 모든 순위가 서로 다른 금액(1등 > 2등 > 3등 ...)
 * 예) 7명 28,000원 → [13000, 8000, 7000] 같은 식
 */
export function drawPrizes(n, fee = ENTRY_FEE, rnd = rand01) {
  const k = winnersOf(n);
  if (!k) return [];
  const total = Math.round((n * fee) / PRIZE_UNIT);
  if (k === 1) return [total * PRIZE_UNIT];

  // 입상자는 최소 참가비 + 1,000원 (입상했는데 본전이면 서운하니까)
  const min = Math.max(1, Math.floor(fee / PRIZE_UNIT) + 1);
  const a = Array(k).fill(min);
  let rest = total - min * k;

  // 계단: 위 순위부터 1단위씩 차등 (가능한 만큼)
  let t = 0;
  while (t + 1 <= k - 1 && ((t + 1) * (t + 2)) / 2 <= rest) t++;
  for (let i = 0; i < t; i++) a[i] += t - i;
  rest -= (t * (t + 1)) / 2;

  // 남은 금액은 위 순위일수록 확률이 높게 랜덤 분배
  const w = a.map((_, i) => Math.pow(k - i, 2.2) * (0.6 + rnd() * 0.8));
  const wsum = w.reduce((x, y) => x + y, 0);
  while (rest > 0) {
    let r = rnd() * wsum;
    let i = 0;
    while (i < k - 1 && r >= w[i]) r -= w[i++];
    // 순서가 뒤집히지 않도록: 받을 수 없으면 한 계단 위로
    while (i > 0 && (i <= t ? a[i] + 1 >= a[i - 1] : a[i] + 1 > a[i - 1])) i--;
    a[i]++;
    rest--;
  }
  return a.map((x) => x * PRIZE_UNIT);
}

/** "T6" · "6" · "6위" → 6 */
export function parseRank(label) {
  const m = String(label == null ? "" : label).match(/\d+/);
  return m ? Number(m[0]) : null;
}

/**
 * 결과 행에 순위와 상금을 붙인다.
 * rows: [{final, rank_label?}]  plan: [1등금액, 2등금액, ...]
 * 공동 순위는 해당 자리들의 상금을 합쳐 똑같이 나눈다 (100원 미만 버림).
 */
export function rankAndPrize(rows, plan) {
  const list = rows.map((r) => ({ ...r }));
  // 순위가 비어 있으면 최종성적으로 계산 (같은 점수는 공동)
  const needCalc = list.some((r) => parseRank(r.rank_label) == null);
  if (needCalc) {
    const sorted = [...list].sort((x, y) => x.final - y.final);
    sorted.forEach((r, i) => {
      r.rank_no = i > 0 && sorted[i - 1].final === r.final ? sorted[i - 1].rank_no : i + 1;
    });
  } else {
    list.forEach((r) => (r.rank_no = parseRank(r.rank_label)));
  }
  list.sort((x, y) => x.rank_no - y.rank_no || x.final - y.final);

  const groups = {};
  list.forEach((r) => (groups[r.rank_no] = (groups[r.rank_no] || 0) + 1));
  let pos = 0;
  let leftover = 0;
  const seen = new Set();
  for (const r of list) {
    if (seen.has(r.rank_no)) continue;
    seen.add(r.rank_no);
    const cnt = groups[r.rank_no];
    let sum = 0;
    for (let j = pos; j < pos + cnt; j++) sum += plan[j] || 0;
    const each = Math.floor(sum / cnt / 100) * 100;
    leftover += sum - each * cnt;
    list.filter((x) => x.rank_no === r.rank_no).forEach((x) => {
      x.prize = each;
      x.rank_label = cnt > 1 ? `T${r.rank_no}` : String(r.rank_no);
    });
    pos += cnt;
  }
  return { rows: list, leftover };
}

/** 확정 참가(yes) 인원 수 */
export async function yesCount(env, eventId) {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS c FROM signups WHERE event_id = ? AND status = 'yes'`)
    .bind(eventId)
    .first();
  return r.c;
}

/** 해당 일정의 기존 배정을 모두 지운다 */
export async function clearRooms(env, eventId, alsoResetFlag = false) {
  const old = await env.DB.prepare(`SELECT id FROM rooms WHERE event_id = ?`).bind(eventId).all();
  const stmts = (old.results || []).map((r) =>
    env.DB.prepare(`DELETE FROM room_members WHERE room_id = ?`).bind(r.id)
  );
  stmts.push(env.DB.prepare(`DELETE FROM rooms WHERE event_id = ?`).bind(eventId));
  if (alsoResetFlag)
    stmts.push(env.DB.prepare(`UPDATE events SET assigned_at = NULL, prize_json = NULL WHERE id = ?`).bind(eventId));
  await env.DB.batch(stmts);
}

/**
 * 배정 시각이 지났고 아직 배정 전이면, 확정 참가자(yes)만으로 방을 배정한다.
 * force = true 면 시각을 무시하고 즉시(또는 다시) 배정한다.
 */
export async function maybeAssign(env, ev, force = false) {
  if (ev.assigned_at && !force) return false;
  if (!force && Date.now() < assignTs(ev)) return false;
  if (!(await yesCount(env, ev.id))) return false;

  // 동시 요청 방지: assigned_at이 비어 있을 때만 선점
  if (!force) {
    const r = await env.DB.prepare(`UPDATE events SET assigned_at = ? WHERE id = ? AND assigned_at IS NULL`)
      .bind(nowISO(), ev.id)
      .run();
    if (!r.meta.changes) return false;
  } else {
    await env.DB.prepare(`UPDATE events SET assigned_at = ? WHERE id = ?`).bind(nowISO(), ev.id).run();
  }

  const { results: parts } = await env.DB.prepare(
    `SELECT m.id, m.name, m.role FROM signups s JOIN members m ON m.id = s.member_id
     WHERE s.event_id = ? AND s.status = 'yes' ORDER BY s.id`
  )
    .bind(ev.id)
    .all();

  await clearRooms(env, ev.id);

  const rooms = buildRooms(parts || [], !!ev.spread_guests);

  // 방이 정해질 때 시상 금액도 함께 랜덤 배정
  const fee = Number(ev.entry_fee) || ENTRY_FEE;
  const plan = { n: (parts || []).length, fee, amounts: drawPrizes((parts || []).length, fee), drawn_at: nowISO() };
  await env.DB.prepare(`UPDATE events SET prize_json = ? WHERE id = ?`).bind(JSON.stringify(plan), ev.id).run();
  for (let i = 0; i < rooms.length; i++) {
    const res = await env.DB.prepare(`INSERT INTO rooms (event_id, room_no) VALUES (?, ?)`)
      .bind(ev.id, i + 1)
      .run();
    const roomId = res.meta.last_row_id;
    const ins = rooms[i].members.map((m, idx) =>
      env.DB.prepare(`INSERT INTO room_members (room_id, member_id, seq) VALUES (?, ?, ?)`).bind(roomId, m.id, idx)
    );
    if (ins.length) await env.DB.batch(ins);
  }
  return true;
}

/**
 * 마감(전날 23:59)이 지난 일정의 '보류'를 자동으로 비참가 처리한다.
 * 되돌려주는 값은 정리된 인원 수.
 */
export async function sweepHolds(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events WHERE event_date BETWEEN ? AND ?`
  )
    .bind(todayKST(-1), todayKST(1))
    .all();

  const now = Date.now();
  let dropped = 0;
  for (const ev of results || []) {
    if (now < deadlineTs(ev)) continue;
    if (now > startTs(ev) + 6 * 3600000) continue;
    const r = await env.DB
      .prepare(
        `UPDATE signups SET status = 'no', dropped = 1, updated_at = ?
         WHERE event_id = ? AND status = 'hold'`
      )
      .bind(nowISO(), ev.id)
      .run();
    dropped += r.meta.changes;
  }
  return dropped;
}

/**
 * 배정할 때가 된 일정을 모두 찾아 배정한다. (Cron Worker가 1분마다 호출)
 * 되돌려주는 값은 실제로 배정된 일정 수.
 */
export async function assignDueEvents(env) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM events WHERE assigned_at IS NULL AND event_date BETWEEN ? AND ?`
  )
    .bind(todayKST(-1), todayKST(1))
    .all();

  const now = Date.now();
  let done = 0;
  for (const ev of results || []) {
    // 배정 시각은 지났고, 시작 후 6시간이 안 지난 일정만
    if (now < assignTs(ev)) continue;
    if (now > startTs(ev) + 6 * 3600000) continue;
    if (await maybeAssign(env, ev)) done++;
  }
  return done;
}

/** Cron이 1분마다 부르는 진입점: 보류 정리 → 방 배정 */
export async function runSchedule(env) {
  const dropped = await sweepHolds(env);
  const assigned = await assignDueEvents(env);
  return { dropped, assigned };
}
