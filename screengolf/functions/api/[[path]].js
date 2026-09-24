// 스크린골프 동호회 예약 API  —  Cloudflare Pages Functions + D1
// 경로: /api/*

import {
  ENTRY_FEE,
  shuffle,
  MAX_ROOMS,
  drawPrizes,
  rankAndPrize,
  winnersOf,
  assignTs,
  capacityOf,
  clearRooms,
  deadlineTs,
  maybeAssign,
  nowISO,
  roomsOf,
  startTs,
  sweepHolds,
  todayKST,
  yesCount,
} from "../../shared/assign.js";
import { jevMatchMembers, jevReadChat, jevReady, norm } from "../../shared/jev.js";

const SESSION_DAYS = 30;

const H = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: H });
const fail = (m, s = 400) => json({ error: m }, s);

/* ---------------- 공통 유틸 ---------------- */

const enc = new TextEncoder();

function randomHex(n = 24) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function hashPw(password, salt) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: enc.encode(salt), iterations: 100000, hash: "SHA-256" },
    key,
    256
  );
  return btoa(String.fromCharCode(...new Uint8Array(bits)));
}

/** 일정이 지금 어느 단계인지 */
function phaseOf(ev) {
  const now = Date.now();
  if (now < deadlineTs(ev)) return "open"; // 정식 신청 기간
  if (now < assignTs(ev)) return "waitlist"; // 당일 — 대기신청만 가능
  return "locked"; // 배정 시각 이후
}

/* ---------------- 인증 ---------------- */

async function currentMember(request, env) {
  const h = request.headers.get("authorization") || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT m.* FROM sessions s JOIN members m ON m.id = s.member_id
     WHERE s.token = ? AND s.expires_at > ?`
  )
    .bind(token, Date.now())
    .first();
  if (!row || row.status !== "approved") return null;
  return row;
}

const publicMember = (m) => ({
  id: m.id,
  login_id: m.login_id,
  name: m.name,
  nickname: m.nickname || null,
  gz_mask: m.gz_mask || null,
  is_test: m.memo === TEST_MARK,
  activity: m.activity == null ? undefined : m.activity, // 참가신청 + 결과 기록 수 (마스터용)
  phone: m.phone,
  role: m.role,
  status: m.status,
  memo: m.memo,
  created_at: m.created_at,
});

/* ---------------- 닉네임 ---------------- */

const TEST_MARK = "__TEST__"; // 테스트 계정·대회 표시

/** 회원 한 명 완전 삭제 (지난 결과는 '비회원'으로 남김) */
function deleteMemberStmts(env, id) {
  return [
    env.DB.prepare(`DELETE FROM room_members WHERE member_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM signups WHERE member_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM sessions WHERE member_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM member_aliases WHERE member_id = ?`).bind(id),
    env.DB.prepare(`UPDATE results SET member_id = NULL WHERE member_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM members WHERE id = ?`).bind(id),
  ];
}

/** 일정 한 건 완전 삭제 */
async function deleteEventStmts(env, id) {
  const { results } = await env.DB.prepare(`SELECT id FROM rooms WHERE event_id = ?`).bind(id).all();
  return [
    ...(results || []).map((r) => env.DB.prepare(`DELETE FROM room_members WHERE room_id = ?`).bind(r.id)),
    env.DB.prepare(`DELETE FROM rooms WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM signups WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM results WHERE event_id = ?`).bind(id),
    env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(id),
  ];
}

/* ---------------- 테스트 데이터 ---------------- */

const rint = (a, b) => a + Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296) * (b - a + 1));

/** 테스트1~테스트20 계정 + 지난 대회 기록(랜덤 스코어) 생성 */
async function makeTestData(env, eventCount, withUpcoming) {
  const now = nowISO();
  // 비밀번호 1234 — 계정마다 같은 해시를 써서 서버 부담을 줄임
  const salt = randomHex(16);
  const hash = await hashPw("1234", salt);

  const ins = [];
  for (let i = 1; i <= 20; i++) {
    ins.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO members (login_id, name, nickname, gz_mask, pw_hash, pw_salt, role, status, memo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'member', 'approved', ?, ?)`
      ).bind(`test${i}`, `테스트${i}`, `테스트${i}`, `test${i}**`, hash, salt, TEST_MARK, now)
    );
  }
  await env.DB.batch(ins);
  const { results: people } = await env.DB.prepare(`SELECT id FROM members WHERE memo = ?`).bind(TEST_MARK).all();

  // 사람마다 실력(평균 스트로크)과 보정치를 정해두고, 대회마다 컨디션 차이를 준다
  const skill = new Map(people.map((p) => [p.id, { base: rint(0, 16), hc: rint(-2, 3) }]));

  let made = 0;
  for (let k = 1; k <= eventCount; k++) {
    const date = todayKST(-7 * k);
    const ev = await env.DB.prepare(
      `INSERT INTO events (event_date, start_time, title, place, note, rooms_count, entry_fee, assigned_at, results_at, created_at)
       VALUES (?, '19:00', ?, '테스트 구장', ?, 6, 4000, ?, ?, ?)`
    )
      .bind(date, `테스트 대회 ${eventCount - k + 1}`, TEST_MARK, now, now, now)
      .run();
    const evId = ev.meta.last_row_id;

    const players = shuffle(people).slice(0, rint(6, 14));
    const rows = players.map((p) => {
      const s = skill.get(p.id);
      let stroke = s.base + rint(-4, 4);
      if (rint(1, 10) === 1) stroke += rint(3, 7); // 가끔 무너지는 날
      const handicap = Math.max(-3, Math.min(4, s.hc + rint(-1, 1)));
      return { member_id: p.id, raw_nick: null, gz_mask: null, rank_label: "", stroke, handicap, final: stroke + handicap };
    });
    const amounts = drawPrizes(rows.length, 4000);
    const ranked = rankAndPrize(rows, amounts).rows;

    const st = [
      env.DB.prepare(`UPDATE events SET prize_json = ? WHERE id = ?`).bind(
        JSON.stringify({ n: rows.length, fee: 4000, amounts, drawn_at: now }),
        evId
      ),
    ];
    for (const r of ranked) {
      st.push(
        env.DB.prepare(
          `INSERT INTO results (event_id, member_id, raw_nick, gz_mask, rank_no, rank_label, stroke, handicap, final, prize, created_at)
           SELECT ?, id, nickname, gz_mask, ?, ?, ?, ?, ?, ?, ? FROM members WHERE id = ?`
        ).bind(evId, r.rank_no, r.rank_label, r.stroke, r.handicap, r.final, r.prize, now, r.member_id),
        env.DB.prepare(`INSERT INTO signups (event_id, member_id, status, created_at, updated_at) VALUES (?, ?, 'yes', ?, ?)`).bind(
          evId,
          r.member_id,
          now,
          now
        )
      );
    }
    await env.DB.batch(st);
    made++;
  }

  // 방배정 테스트용: 30분 뒤 시작하는 일정 + 테스트 계정 10명 참가
  let upcoming = null;
  if (withUpcoming) {
    const t = new Date(Date.now() + 9 * 3600000 + 30 * 60000);
    t.setUTCMinutes(Math.ceil(t.getUTCMinutes() / 5) * 5, 0, 0);
    const iso = t.toISOString();
    const ev = await env.DB.prepare(
      `INSERT INTO events (event_date, start_time, title, place, note, rooms_count, entry_fee, created_at)
       VALUES (?, ?, '방배정 테스트', '테스트 구장', ?, 6, 4000, ?)`
    )
      .bind(iso.slice(0, 10), iso.slice(11, 16), TEST_MARK, now)
      .run();
    const evId = ev.meta.last_row_id;
    await env.DB.batch(
      shuffle(people)
        .slice(0, 10)
        .map((p) =>
          env.DB.prepare(`INSERT INTO signups (event_id, member_id, status, created_at, updated_at) VALUES (?, ?, 'yes', ?, ?)`).bind(
            evId,
            p.id,
            now,
            now
          )
        )
    );
    upcoming = `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  return { accounts: people.length, events: made, upcoming };
}

async function clearTestData(env) {
  const { results: evs } = await env.DB.prepare(`SELECT id FROM events WHERE note = ?`).bind(TEST_MARK).all();
  const { results: mem } = await env.DB.prepare(`SELECT id FROM members WHERE memo = ?`).bind(TEST_MARK).all();
  const st = [];
  for (const e of evs || []) st.push(...(await deleteEventStmts(env, e.id)));
  for (const m of mem || []) st.push(...deleteMemberStmts(env, m.id));
  if (st.length) await env.DB.batch(st);
  return { events: (evs || []).length, accounts: (mem || []).length };
}

/** 닉네임 변경 (본인 또는 마스터). 예전 닉네임은 별칭으로 남겨 사진 인식에 쓴다 */
async function setNickname(env, member, nickname) {
  const nick = String(nickname == null ? "" : nickname).normalize("NFC").trim();
  if (!nick) return "닉네임을 입력하세요.";
  if (nick.length > 20) return "닉네임은 20자 이내로 정하세요.";
  if (nick === member.nickname) return null;
  const dup = await env.DB.prepare(`SELECT id FROM members WHERE nickname = ? AND id <> ?`).bind(nick, member.id).first();
  if (dup) return "다른 회원이 쓰고 있는 닉네임입니다.";
  const stmts = [env.DB.prepare(`UPDATE members SET nickname = ? WHERE id = ?`).bind(nick, member.id)];
  if (member.nickname)
    stmts.push(
      env.DB.prepare(`INSERT OR IGNORE INTO member_aliases (member_id, alias, created_at) VALUES (?, ?, ?)`).bind(
        member.id,
        member.nickname,
        nowISO()
      )
    );
  await env.DB.batch(stmts);
  return null;
}

/** 결과표의 닉네임 / 가려진 골프존 아이디로 회원을 찾는다 */
async function matchRows(env, rows) {
  const { results: members } = await env.DB.prepare(
    `SELECT id, name, nickname, gz_mask FROM members WHERE status = 'approved'`
  ).all();
  const { results: aliases } = await env.DB.prepare(`SELECT member_id, alias FROM member_aliases`).all();
  const out = rows.map((r) => {
    const n = norm(r.nickname);
    const g = norm(r.gz_mask);
    let m = members.find((x) => x.nickname && x.nickname === r.nickname);
    let how = "닉네임";
    if (!m && n) m = members.find((x) => norm(x.nickname) === n);
    if (!m && n) {
      const a = (aliases || []).filter((x) => norm(x.alias) === n);
      const ids = [...new Set(a.map((x) => x.member_id))];
      if (ids.length === 1) {
        m = members.find((x) => x.id === ids[0]);
        how = "예전 닉네임";
      }
    }
    if (!m && g) {
      const c = members.filter((x) => norm(x.gz_mask) === g);
      if (c.length === 1) {
        m = c[0];
        how = "골프존 ID";
      }
    }
    return { ...r, member_id: m ? m.id : null, match: m ? how : null };
  });

  // 코드로 못 찾은 줄은 Jev에게 물어본다 (실패해도 결과는 그대로 쓴다 — 마스터가 직접 고름)
  const miss = out.map((r, i) => (r.member_id ? -1 : i)).filter((i) => i >= 0);
  let ai_note = null;
  if (miss.length && jevReady(env)) {
    try {
      const got = await jevMatchMembers(
        env,
        miss.map((i) => ({ name: out[i].nickname, gz_mask: out[i].gz_mask })),
        members,
        aliases
      );
      miss.forEach((i, k) => {
        if (!got[k] || out.some((x) => x.member_id === got[k].member_id)) return; // 이미 다른 줄이 차지한 회원은 제외
        out[i] = { ...out[i], member_id: got[k].member_id, match: "AI 추정", match_p: got[k].p };
      });
    } catch (e) {
      ai_note = e.message;
    }
  }
  return { rows: out, ai_note };
}

/* ---------------- 사진 인식 (Claude API) ---------------- */

const OCR_PROMPT = `이 이미지들은 스크린골프 '골프존' 앱의 대회 결과(스트로크 순위표) 캡처입니다.
여러 장이 같은 대회를 스크롤하며 찍은 것이라 같은 사람이 겹쳐 나올 수 있고,
맨 위 파란 배경의 '내 순위' 행이 한 번 더 나올 수 있습니다. 같은 사람은 한 번만 적으세요.

각 행에서 다음을 읽으세요.
- rank: 순위 칸 그대로 ("1", "T6" 등)
- nickname: 굵은 닉네임 (특수문자·물결표 포함 그대로)
- gz_id: 닉네임 아래 회색 아이디 (별표 포함 그대로, 예 "giveufi**")
- stroke: 스트로크 (정수, 음수 가능)
- handicap: 보정치 (정수, 음수 가능)
- final: 최종성적 (정수, 음수 가능)

화면 상단의 대회명과 날짜도 보이면 적으세요. 추측하지 말고 안 보이는 값은 null로 두세요.
설명 없이 아래 JSON 하나만 출력하세요.
{"title": "...", "date": "...", "rows": [{"rank": "1", "nickname": "...", "gz_id": "...", "stroke": 0, "handicap": 0, "final": 0}]}`;

/* Gemini (Google AI Studio 무료 키)
 * 1.5 / 2.0 Flash는 Google이 종료한 모델이라 현재 Flash 계열을 순서대로 시도한다.
 * 특정 모델을 쓰려면 Cloudflare 변수 GEMINI_MODEL 로 지정. */
const GEMINI_MODELS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-2.5-flash"];

async function callGemini(env, images, prompt) {
  const body = JSON.stringify({
    contents: [
      {
        role: "user",
        parts: [
          ...images.map((im) => ({ inlineData: { mimeType: im.media_type || "image/jpeg", data: im.data } })),
          { text: prompt },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 8192 },
  });
  const models = env.GEMINI_MODEL ? [env.GEMINI_MODEL] : GEMINI_MODELS;
  let lastErr = "";
  for (const m of models) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body,
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      return parts.map((p) => p.text || "").join("");
    }
    lastErr = `${m}: ${(data.error && data.error.message) || res.status}`;
    if (res.status === 429) throw new Error("사진 인식 무료 한도를 넘었습니다. 1~2분 뒤 다시 시도하거나 직접 입력하세요.");
    if (res.status === 400 || res.status === 401 || res.status === 403)
      throw new Error("Gemini 키 오류: " + lastErr + " — Cloudflare의 GEMINI_API_KEY 값을 확인하세요.");
    // 404 = 이 모델은 없음 → 다음 모델
  }
  throw new Error("사진 인식 실패: " + lastErr);
}

async function callClaude(env, images, prompt) {
  const content = images.map((im) => ({
    type: "image",
    source: { type: "base64", media_type: im.media_type || "image/jpeg", data: im.data },
  }));
  content.push({ type: "text", text: prompt });
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: env.ANTHROPIC_MODEL || "claude-sonnet-5", max_tokens: 4000, messages: [{ role: "user", content }] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error("사진 인식 실패: " + ((data.error && data.error.message) || res.status));
  return (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

const ocrReady = (env) => !!(env.GEMINI_API_KEY || env.ANTHROPIC_API_KEY);

async function ocrResults(env, images) {
  const text = env.GEMINI_API_KEY ? await callGemini(env, images, OCR_PROMPT) : await callClaude(env, images, OCR_PROMPT);

  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("사진에서 결과표를 읽지 못했습니다. 직접 입력을 이용하세요.");
  const parsed = JSON.parse(text.slice(a, b + 1));

  const num = (v) => (v == null || v === "" || isNaN(Number(v)) ? null : Number(v));
  const seen = new Set();
  const rows = [];
  for (const r of parsed.rows || []) {
    const nickname = String(r.nickname || "").trim();
    const gz = String(r.gz_id || "").trim();
    const key = norm(nickname) + "|" + norm(gz);
    if (!nickname || seen.has(key)) continue;
    seen.add(key);
    const stroke = num(r.stroke);
    const handicap = num(r.handicap) ?? 0;
    let final = num(r.final);
    if (final == null && stroke != null) final = stroke + handicap;
    rows.push({ rank_label: r.rank == null ? "" : String(r.rank), nickname, gz_mask: gz || null, stroke, handicap, final });
  }
  return { title: parsed.title || null, date: parsed.date || null, rows };
}

/* ---------------- 일정 상세 ---------------- */

function decorate(ev, extra = {}) {
  return {
    ...ev,
    rooms_count: roomsOf(ev),
    capacity: capacityOf(ev),
    entry_fee: Number(ev.entry_fee) || ENTRY_FEE,
    start_ts: startTs(ev),
    assign_ts: assignTs(ev),
    deadline_ts: deadlineTs(ev),
    phase: phaseOf(ev),
    ...extra,
  };
}

async function eventDetail(env, eventId, me, skipAuto = false) {
  let ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first();
  if (!ev) return null;

  if (!skipAuto) {
    // Cron이 아직 안 돌았더라도 화면을 여는 시점에 마감·배정을 한 번 더 확인한다
    if (Date.now() >= deadlineTs(ev)) await sweepHolds(env);
    if (await maybeAssign(env, ev)) ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(eventId).first();
  }

  const { results: responses } = await env.DB.prepare(
    `SELECT m.id, m.name, m.nickname, m.role, s.status, s.dropped, s.created_at, s.updated_at
     FROM signups s JOIN members m ON m.id = s.member_id
     WHERE s.event_id = ? ORDER BY s.id`
  )
    .bind(eventId)
    .all();

  const { results: rm } = await env.DB.prepare(
    `SELECT r.room_no, m.id, m.name, m.nickname, m.role FROM rooms r
     JOIN room_members rmx ON rmx.room_id = r.id
     JOIN members m ON m.id = rmx.member_id
     WHERE r.event_id = ? ORDER BY r.room_no, rmx.seq`
  )
    .bind(eventId)
    .all();

  const rooms = [];
  for (const row of rm || []) {
    let r = rooms.find((x) => x.room_no === row.room_no);
    if (!r) rooms.push((r = { room_no: row.room_no, members: [] }));
    r.members.push({ id: row.id, name: row.name, nickname: row.nickname, role: row.role });
  }

  const { results: res } = await env.DB.prepare(
    `SELECT r.*, m.nickname, m.name FROM results r LEFT JOIN members m ON m.id = r.member_id
     WHERE r.event_id = ? ORDER BY r.rank_no, r.final, r.id`
  )
    .bind(eventId)
    .all();

  let prize = null;
  try {
    prize = ev.prize_json ? JSON.parse(ev.prize_json) : null;
  } catch (_) {}

  const list = responses || [];
  const mine = me ? list.find((x) => x.id === me.id) : null;
  return decorate(ev, {
    responses: list,
    rooms,
    prize,
    results: res || [],
    my_status: mine ? mine.status : null,
    my_dropped: mine ? !!mine.dropped : false,
    yes_count: list.filter((x) => x.status === "yes").length,
    hold_count: list.filter((x) => x.status === "hold").length,
    no_count: list.filter((x) => x.status === "no").length,
    wait_count: list.filter((x) => x.status === "wait").length,
  });
}

/* ---------------- 참가 의사 변경 ---------------- */

async function setRsvp(env, ev, memberId, want, byMaster) {
  const phase = phaseOf(ev);
  const cur = await env.DB.prepare(`SELECT * FROM signups WHERE event_id = ? AND member_id = ?`)
    .bind(ev.id, memberId)
    .first();

  let status = want;
  let message = null;

  if (!byMaster) {
    if (ev.closed && status !== "no") return { error: "마스터가 신청을 마감한 일정입니다." };
    if (phase === "locked") return { error: "배정 시각이 지나 변경할 수 없습니다. 마스터에게 알려주세요." };

    if (phase === "waitlist") {
      if (status === "hold") return { error: "보류는 전날 밤 11시 59분까지만 선택할 수 있습니다." };
      if (status === "yes" && (!cur || cur.status !== "yes")) {
        status = "wait";
        message = "정식 신청이 마감돼 대기 신청으로 접수했습니다. 구장에서 방이 확보되면 마스터가 확정해 드립니다.";
      }
    } else if (status === "wait") {
      status = "yes"; // 마감 전에는 대기라는 개념이 없다
    }
  }

  // 정원(방 수 x 4)을 넘겨 확정할 수는 없다
  if (status === "yes" && (!cur || cur.status !== "yes")) {
    const cnt = await yesCount(env, ev.id);
    if (cnt >= capacityOf(ev)) {
      if (byMaster) return { error: `방 ${roomsOf(ev)}개 정원(${capacityOf(ev)}명)이 모두 찼습니다. 방을 더 확보한 뒤 올려주세요.` };
      status = "wait";
      message = `정원(${capacityOf(ev)}명)이 차서 대기 신청으로 접수했습니다.`;
    }
  }

  if (cur) {
    await env.DB.prepare(`UPDATE signups SET status = ?, dropped = 0, updated_at = ? WHERE id = ?`)
      .bind(status, nowISO(), cur.id)
      .run();
  } else {
    await env.DB.prepare(
      `INSERT INTO signups (event_id, member_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
      .bind(ev.id, memberId, status, nowISO(), nowISO())
      .run();
  }
  return { status, message };
}

/* ---------------- 라우터 ---------------- */

export async function onRequest(context) {
  const { request, env } = context;
  try {
    if (!env.DB) return fail("D1 데이터베이스(DB) 바인딩이 설정되지 않았습니다.", 500);
    return await handle(request, env);
  } catch (e) {
    return fail("서버 오류: " + (e && e.message ? e.message : String(e)), 500);
  }
}

async function handle(request, env) {
  const url = new URL(request.url);
  const seg = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const method = request.method.toUpperCase();
  const body = ["POST", "PATCH", "PUT", "DELETE"].includes(method)
    ? await request.json().catch(() => ({}))
    : {};

  /* ---- 가입 / 로그인 ---- */

  if (seg[0] === "register" && method === "POST") {
    const { login_id, name, phone, password, memo } = body;
    const nickname = String(body.nickname || "").normalize("NFC").trim();
    if (!login_id || !name || !password || !nickname) return fail("아이디, 이름, 닉네임, 비밀번호를 모두 입력하세요.");
    if (nickname.length > 20) return fail("닉네임은 20자 이내로 정하세요.");
    if (String(password).length < 4) return fail("비밀번호는 4자 이상으로 정하세요.");

    const dup = await env.DB.prepare(`SELECT id FROM members WHERE login_id = ?`).bind(login_id).first();
    if (dup) return fail("이미 사용 중인 아이디입니다.");
    const dupNick = await env.DB.prepare(`SELECT id FROM members WHERE nickname = ?`).bind(nickname).first();
    if (dupNick) return fail("이미 사용 중인 닉네임입니다. 골프존 닉네임과 같게 입력하세요.");

    // 첫 가입자는 자동으로 마스터가 된다
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS c FROM members`).first();
    const first = cnt.c === 0;

    const salt = randomHex(16);
    const hash = await hashPw(password, salt);
    await env.DB.prepare(
      `INSERT INTO members (login_id, name, nickname, phone, pw_hash, pw_salt, role, status, memo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(login_id, name, nickname, phone || null, hash, salt, first ? "master" : "guest", first ? "approved" : "pending", memo || null, nowISO())
      .run();

    return json({
      ok: true,
      first,
      message: first
        ? "마스터 계정이 만들어졌습니다. 바로 로그인하세요."
        : "가입 신청이 접수됐습니다. 마스터 승인 후 로그인할 수 있습니다.",
    });
  }

  if (seg[0] === "login" && method === "POST") {
    const { login_id, password } = body;
    const m = await env.DB.prepare(`SELECT * FROM members WHERE login_id = ?`).bind(login_id || "").first();
    if (!m) return fail("아이디 또는 비밀번호가 맞지 않습니다.", 401);
    const hash = await hashPw(password || "", m.pw_salt);
    if (hash !== m.pw_hash) return fail("아이디 또는 비밀번호가 맞지 않습니다.", 401);
    if (m.status === "pending") return fail("아직 승인 대기 중입니다. 마스터에게 승인을 요청하세요.", 403);
    if (m.status !== "approved") return fail("사용이 정지된 계정입니다. 마스터에게 문의하세요.", 403);

    const token = randomHex(32);
    await env.DB.prepare(`INSERT INTO sessions (token, member_id, expires_at) VALUES (?, ?, ?)`)
      .bind(token, m.id, Date.now() + SESSION_DAYS * 86400000)
      .run();
    await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`).bind(Date.now()).run();

    return json({ token, me: publicMember(m) });
  }

  /* ---- 여기부터 로그인 필요 ---- */

  const me = await currentMember(request, env);

  if (seg[0] === "logout" && method === "POST") {
    const h = request.headers.get("authorization") || "";
    if (h.startsWith("Bearer ")) await env.DB.prepare(`DELETE FROM sessions WHERE token = ?`).bind(h.slice(7)).run();
    return json({ ok: true });
  }

  if (!me) return fail("로그인이 필요합니다.", 401);
  // 개발자(dev)는 마스터 권한 전부 + 테스트 도구
  const isMaster = me.role === "master" || me.role === "dev";
  const isDev = me.role === "dev";

  if (seg[0] === "me" && seg.length === 1 && method === "GET")
    return json({ me: publicMember(me), features: isMaster ? { jev: jevReady(env), ocr: ocrReady(env) } : {} });

  if (seg[0] === "me" && seg.length === 1 && method === "PATCH") {
    if ("nickname" in body) {
      const err = await setNickname(env, me, body.nickname);
      if (err) return fail(err);
    }
    const fresh = await env.DB.prepare(`SELECT * FROM members WHERE id = ?`).bind(me.id).first();
    return json({ me: publicMember(fresh) });
  }

  if (seg[0] === "me" && seg[1] === "password" && method === "POST") {
    const { current, next } = body;
    if (!next || String(next).length < 4) return fail("새 비밀번호는 4자 이상으로 정하세요.");
    const cur = await hashPw(current || "", me.pw_salt);
    if (cur !== me.pw_hash) return fail("현재 비밀번호가 맞지 않습니다.");
    const salt = randomHex(16);
    await env.DB.prepare(`UPDATE members SET pw_hash = ?, pw_salt = ? WHERE id = ?`)
      .bind(await hashPw(next, salt), salt, me.id)
      .run();
    return json({ ok: true });
  }

  /* ---- 공지 ---- */

  if (seg[0] === "notices" && seg.length === 1 && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT n.*, m.name AS author_name FROM notices n LEFT JOIN members m ON m.id = n.author_id
       ORDER BY n.pinned DESC, n.created_at DESC LIMIT 100`
    ).all();
    return json({ notices: results || [] });
  }

  if (seg[0] === "notices" && seg.length === 1 && method === "POST") {
    if (!isMaster) return fail("공지는 마스터만 쓸 수 있습니다.", 403);
    if (!body.title || !String(body.title).trim()) return fail("제목을 입력하세요.");
    await env.DB.prepare(`INSERT INTO notices (title, body, pinned, author_id, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(String(body.title).trim(), body.body || null, body.pinned ? 1 : 0, me.id, nowISO())
      .run();
    return json({ ok: true });
  }

  if (seg[0] === "notices" && seg[1] && method === "PATCH") {
    if (!isMaster) return fail("공지는 마스터만 고칠 수 있습니다.", 403);
    const fields = [];
    const vals = [];
    if ("title" in body) {
      if (!String(body.title).trim()) return fail("제목을 입력하세요.");
      fields.push("title = ?");
      vals.push(String(body.title).trim());
    }
    if ("body" in body) {
      fields.push("body = ?");
      vals.push(body.body || null);
    }
    if ("pinned" in body) {
      fields.push("pinned = ?");
      vals.push(body.pinned ? 1 : 0);
    }
    if (!fields.length) return fail("바꿀 내용이 없습니다.");
    fields.push("updated_at = ?");
    vals.push(nowISO(), Number(seg[1]));
    await env.DB.prepare(`UPDATE notices SET ${fields.join(", ")} WHERE id = ?`).bind(...vals).run();
    return json({ ok: true });
  }

  if (seg[0] === "notices" && seg[1] && method === "DELETE") {
    if (!isMaster) return fail("공지는 마스터만 지울 수 있습니다.", 403);
    await env.DB.prepare(`DELETE FROM notices WHERE id = ?`).bind(Number(seg[1])).run();
    return json({ ok: true });
  }

  /* ---- 회원 ---- */

  if (seg[0] === "members" && seg.length === 1 && method === "GET") {
    const { results } = await env.DB.prepare(
      `SELECT m.*,
        (SELECT COUNT(*) FROM signups s WHERE s.member_id = m.id) +
        (SELECT COUNT(*) FROM results r WHERE r.member_id = m.id) AS activity
       FROM members m ORDER BY
        CASE status WHEN 'pending' THEN 0 ELSE 1 END,
        CASE role WHEN 'master' THEN 0 WHEN 'dev' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
        name`
    ).all();
    const list = (results || []).filter((m) => isMaster || m.status === "approved");
    return json({
      members: list.map((m) => {
        const p = publicMember(m);
        if (!isMaster) delete p.activity;
        return p;
      }),
    });
  }

  if (seg[0] === "members" && seg[1] && method === "PATCH") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    const target = await env.DB.prepare(`SELECT * FROM members WHERE id = ?`).bind(id).first();
    if (!target) return fail("회원을 찾을 수 없습니다.", 404);

    if ("nickname" in body) {
      const err = await setNickname(env, target, body.nickname);
      if (err) return fail(err);
      delete body.nickname;
      if (Object.keys(body).length === 0) return json({ ok: true });
    }

    const fields = [];
    const vals = [];
    if (body.role && ["master", "dev", "member", "guest"].includes(body.role)) {
      if (target.role === "master" && body.role !== "master") {
        const c = await env.DB.prepare(
          `SELECT COUNT(*) AS c FROM members WHERE role='master' AND status='approved'`
        ).first();
        if (c.c <= 1) return fail("마스터가 한 명뿐입니다. 다른 마스터를 먼저 지정하세요.");
      }
      fields.push("role = ?");
      vals.push(body.role);
    }
    if (body.status && ["pending", "approved", "rejected"].includes(body.status)) {
      fields.push("status = ?");
      vals.push(body.status);
    }
    if ("gz_mask" in body) {
      const g = String(body.gz_mask || "").trim() || null;
      if (g) await env.DB.prepare(`UPDATE members SET gz_mask = NULL WHERE gz_mask = ? AND id <> ?`).bind(g, id).run();
      fields.push("gz_mask = ?");
      vals.push(g);
    }
    for (const k of ["name", "phone", "memo"]) {
      if (k in body) {
        fields.push(`${k} = ?`);
        vals.push(body[k] || null);
      }
    }
    if (body.password) {
      const salt = randomHex(16);
      fields.push("pw_hash = ?", "pw_salt = ?");
      vals.push(await hashPw(body.password, salt), salt);
    }
    if (!fields.length) return fail("바꿀 내용이 없습니다.");
    vals.push(id);
    await env.DB.prepare(`UPDATE members SET ${fields.join(", ")} WHERE id = ?`).bind(...vals).run();
    if (body.status && body.status !== "approved") {
      await env.DB.prepare(`DELETE FROM sessions WHERE member_id = ?`).bind(id).run();
    }
    return json({ ok: true });
  }

  if (seg[0] === "members" && seg[1] && method === "DELETE") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    if (id === me.id) return fail("본인 계정은 삭제할 수 없습니다.");
    const t = await env.DB.prepare(`SELECT role FROM members WHERE id = ?`).bind(id).first();
    if (t && (t.role === "master" || t.role === "dev")) return fail("마스터·개발자 계정은 먼저 등급을 바꾼 뒤 삭제하세요.");
    await env.DB.batch(deleteMemberStmts(env, id));
    return json({ ok: true });
  }

  // 여러 계정 한 번에 삭제
  if (seg[0] === "members-delete" && method === "POST") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(Number))].filter((x) => x && x !== me.id);
    if (!ids.length) return fail("삭제할 계정을 고르세요.");
    const { results: masters } = await env.DB.prepare(
      `SELECT id FROM members WHERE role IN ('master', 'dev') AND id IN (${ids.map(() => "?").join(",")})`
    )
      .bind(...ids)
      .all();
    if (masters && masters.length) return fail("마스터·개발자 계정은 먼저 등급을 바꾼 뒤 삭제하세요.");
    await env.DB.batch(ids.flatMap((id) => deleteMemberStmts(env, id)));
    return json({ ok: true, deleted: ids.length });
  }

  // 사진 인식용 정보 (예전 닉네임 · 결과표 닉네임 · 골프존 ID)
  if (seg[0] === "members" && seg[1] && seg[2] === "aliases" && method === "GET") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const { results } = await env.DB.prepare(
      `SELECT id, alias, created_at FROM member_aliases WHERE member_id = ? ORDER BY created_at DESC`
    )
      .bind(Number(seg[1]))
      .all();
    return json({ aliases: results || [] });
  }

  if (seg[0] === "members" && seg[1] && seg[2] === "aliases" && seg[3] && method === "DELETE") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    await env.DB.prepare(`DELETE FROM member_aliases WHERE id = ? AND member_id = ?`)
      .bind(Number(seg[3]), Number(seg[1]))
      .run();
    return json({ ok: true });
  }

  /* ---- 테스트 데이터 ---- */

  if (seg[0] === "test-data" && method === "POST") {
    if (!isDev) return fail("개발자 계정만 할 수 있습니다.", 403);
    const n = Math.min(Math.max(body.events == null ? 8 : Number(body.events) || 0, 0), 20);
    return json(await makeTestData(env, n, body.upcoming !== false));
  }

  if (seg[0] === "test-data" && method === "DELETE") {
    if (!isDev) return fail("개발자 계정만 할 수 있습니다.", 403);
    return json(await clearTestData(env));
  }

  /* ---- 일정 ---- */

  if (seg[0] === "events" && seg.length === 1 && method === "GET") {
    const from = url.searchParams.get("from") || todayKST();
    const { results } = await env.DB.prepare(
      `SELECT e.*,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status='yes')  AS yes_count,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status='hold') AS hold_count,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status='no')   AS no_count,
              (SELECT COUNT(*) FROM signups s WHERE s.event_id = e.id AND s.status='wait') AS wait_count,
              (SELECT s.status FROM signups s WHERE s.event_id = e.id AND s.member_id = ?) AS my_status
       FROM events e WHERE e.event_date >= ?
       ORDER BY e.event_date, e.start_time`
    )
      .bind(me.id, from)
      .all();
    return json({ events: (results || []).map((e) => decorate(e)) });
  }

  if (seg[0] === "events" && seg.length === 1 && method === "POST") {
    if (!isMaster) return fail("마스터만 일정을 만들 수 있습니다.", 403);
    const dates = Array.isArray(body.dates) ? body.dates : body.event_date ? [body.event_date] : [];
    if (!dates.length || !body.start_time) return fail("날짜와 시작 시각을 입력하세요.");
    const rooms = Math.min(Math.max(Number(body.rooms_count) || MAX_ROOMS, 1), MAX_ROOMS);
    const stmts = dates.map((d) =>
      env.DB.prepare(
        `INSERT INTO events (event_date, start_time, title, place, note, rooms_count, spread_guests, entry_fee, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        d,
        body.start_time,
        body.title || null,
        body.place || null,
        body.note || null,
        rooms,
        body.spread_guests === false ? 0 : 1,
        Math.max(0, Number(body.entry_fee) || ENTRY_FEE),
        nowISO()
      )
    );
    await env.DB.batch(stmts);
    return json({ ok: true, created: dates.length });
  }

  if (seg[0] === "events" && seg[1] && seg.length === 2 && method === "GET") {
    const d = await eventDetail(env, Number(seg[1]), me);
    if (!d) return fail("일정을 찾을 수 없습니다.", 404);
    return json({ event: d });
  }

  if (seg[0] === "events" && seg[1] && seg.length === 2 && method === "PATCH") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    const before = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
    if (!before) return fail("일정을 찾을 수 없습니다.", 404);

    const fields = [];
    const vals = [];
    for (const k of ["event_date", "start_time", "title", "place", "note"]) {
      if (k in body) {
        fields.push(`${k} = ?`);
        vals.push(body[k] || null);
      }
    }
    if ("rooms_count" in body) {
      const rooms = Math.min(Math.max(Number(body.rooms_count) || MAX_ROOMS, 1), MAX_ROOMS);
      const cnt = await yesCount(env, id);
      if (rooms * 4 < cnt)
        return fail(`이미 확정된 참가자가 ${cnt}명이라 방 ${rooms}개(${rooms * 4}명)로는 줄일 수 없습니다.`);
      fields.push("rooms_count = ?");
      vals.push(rooms);
    }
    if ("closed" in body) {
      fields.push("closed = ?");
      vals.push(body.closed ? 1 : 0);
    }
    if ("spread_guests" in body) {
      fields.push("spread_guests = ?");
      vals.push(body.spread_guests ? 1 : 0);
    }
    if ("entry_fee" in body) {
      fields.push("entry_fee = ?");
      vals.push(Math.max(0, Number(body.entry_fee) || 0));
    }
    if (!fields.length) return fail("바꿀 내용이 없습니다.");
    vals.push(id);
    await env.DB.prepare(`UPDATE events SET ${fields.join(", ")} WHERE id = ?`).bind(...vals).run();

    // 시각을 바꿔서 배정 시각이 다시 미래가 되면, 기존 배정을 지우고 새 시각에 다시 배정하게 한다
    const timeChanged =
      ("event_date" in body && body.event_date !== before.event_date) ||
      ("start_time" in body && body.start_time !== before.start_time);
    if (timeChanged) {
      const after = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
      if (Date.now() < assignTs(after)) await clearRooms(env, id, true);
    }
    return json({ event: await eventDetail(env, id, me, true) });
  }

  if (seg[0] === "events" && seg[1] && seg.length === 2 && method === "DELETE") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    await env.DB.batch(await deleteEventStmts(env, id));
    return json({ ok: true });
  }

  /* ---- 참가 의사 (참가 / 보류 / 비참가 / 대기) ---- */

  if (seg[0] === "events" && seg[1] && seg[2] === "rsvp" && method === "POST") {
    const id = Number(seg[1]);
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
    if (!ev) return fail("일정을 찾을 수 없습니다.", 404);

    const want = body.status;
    if (!["yes", "hold", "no", "wait"].includes(want)) return fail("참가 상태 값이 올바르지 않습니다.");
    const targetId = body.member_id && isMaster ? Number(body.member_id) : me.id;

    const r = await setRsvp(env, ev, targetId, want, isMaster && !!body.member_id);
    if (r.error) return fail(r.error);
    return json({ event: await eventDetail(env, id, me), status: r.status, message: r.message });
  }

  /* ---- 카톡 대화로 참가 의사 한 번에 받기 (Jev) ---- */

  if (seg[0] === "events" && seg[1] && seg[2] === "chat" && method === "POST") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    if (!jevReady(env)) return fail("Jev 키(TYPESAFE_API_KEY)가 아직 설정되지 않았습니다.");
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(Number(seg[1])).first();
    if (!ev) return fail("일정을 찾을 수 없습니다.", 404);
    const text = String(body.text || "").slice(0, 30000);
    if (!text.trim()) return fail("카톡 대화를 붙여넣으세요.");
    const { results: members } = await env.DB.prepare(
      `SELECT id, name, nickname, gz_mask FROM members WHERE status = 'approved'`
    ).all();
    const { results: aliases } = await env.DB.prepare(`SELECT member_id, alias FROM member_aliases`).all();
    const out = await jevReadChat(env, ev, text, members || [], aliases || []);
    if (!out.parsed) return fail("대화에서 보낸 사람을 찾지 못했습니다. 카톡 대화를 그대로 복사해 붙여넣으세요.");
    return json(out);
  }

  if (seg[0] === "events" && seg[1] && seg[2] === "rsvp-bulk" && method === "POST") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
    if (!ev) return fail("일정을 찾을 수 없습니다.", 404);
    const items = (Array.isArray(body.items) ? body.items : []).filter(
      (x) => x && Number(x.member_id) && ["yes", "hold", "no", "wait"].includes(x.status)
    );
    if (!items.length) return fail("반영할 사람이 없습니다.");
    const seen = new Set();
    let done = 0;
    const errors = [];
    for (const x of items) {
      const mid = Number(x.member_id);
      if (seen.has(mid)) continue;
      seen.add(mid);
      const r = await setRsvp(env, ev, mid, x.status, true);
      if (r.error) errors.push({ member_id: mid, error: r.error });
      else done++;
    }
    return json({ event: await eventDetail(env, id, me), done, errors });
  }

  /* ---- 방 배정 ---- */

  if (seg[0] === "events" && seg[1] && seg[2] === "assign" && method === "POST") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
    if (!ev) return fail("일정을 찾을 수 없습니다.", 404);
    if (!(await maybeAssign(env, ev, true))) return fail("확정된 참가자가 없습니다.");
    return json({ event: await eventDetail(env, id, me, true) });
  }

  if (seg[0] === "events" && seg[1] && seg[2] === "unassign" && method === "POST") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    await clearRooms(env, Number(seg[1]), true);
    return json({ event: await eventDetail(env, Number(seg[1]), me, true) });
  }

  /* ---- 시상 금액 다시 뽑기 ---- */

  if (seg[0] === "events" && seg[1] && seg[2] === "prize" && method === "POST") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
    if (!ev) return fail("일정을 찾을 수 없습니다.", 404);
    const n = Math.max(0, Math.floor(Number(body.count) || 0));
    if (!n) return fail("인원을 입력하세요.");
    const fee = Number(ev.entry_fee) || ENTRY_FEE;
    const plan = { n, fee, amounts: drawPrizes(n, fee), drawn_at: nowISO() };
    await env.DB.prepare(`UPDATE events SET prize_json = ? WHERE id = ?`).bind(JSON.stringify(plan), id).run();
    await reapplyPrizes(env, id, plan.amounts);
    return json({ event: await eventDetail(env, id, me, true) });
  }

  /* ---- 대회 결과: 사진 인식 ---- */

  if (seg[0] === "events" && seg[1] && seg[2] === "ocr" && method === "POST") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    if (!ocrReady(env))
      return fail("사진 인식 키(GEMINI_API_KEY)가 아직 설정되지 않았습니다. '직접 입력'으로 기록하세요.");
    const images = Array.isArray(body.images) ? body.images.slice(0, 6) : [];
    if (!images.length) return fail("사진을 골라주세요.");
    const out = await ocrResults(env, images);
    if (!out.rows.length) return fail("사진에서 순위표를 찾지 못했습니다.");
    return json({ ...out, ...(await matchRows(env, out.rows)) });
  }

  /* ---- 대회 결과: 저장 / 삭제 ---- */

  if (seg[0] === "events" && seg[1] && seg[2] === "results" && method === "PUT") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    const ev = await env.DB.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
    if (!ev) return fail("일정을 찾을 수 없습니다.", 404);

    const toInt = (v) => (v === "" || v == null || isNaN(Number(v)) ? null : Math.round(Number(v)));
    const rows = [];
    const used = new Set();
    for (const r of Array.isArray(body.rows) ? body.rows : []) {
      const stroke = toInt(r.stroke);
      const handicap = toInt(r.handicap) ?? 0;
      const final = toInt(r.final) ?? (stroke == null ? null : stroke + handicap);
      if (stroke == null || final == null) return fail(`'${r.raw_nick || "?"}'의 스트로크/최종성적을 확인하세요.`);
      const mid = r.member_id ? Number(r.member_id) : null;
      if (mid) {
        if (used.has(mid)) return fail("같은 회원이 두 번 들어가 있습니다. 연결을 확인하세요.");
        used.add(mid);
      }
      rows.push({
        member_id: mid,
        raw_nick: String(r.raw_nick || "").trim() || null,
        gz_mask: String(r.gz_mask || "").trim() || null,
        rank_label: String(r.rank_label || "").trim(),
        stroke,
        handicap,
        final,
      });
    }
    if (!rows.length) return fail("저장할 결과가 없습니다.");

    // 시상 계획이 없으면(앱에서 방배정을 안 한 대회) 실제 인원으로 지금 뽑는다
    let plan = null;
    try {
      plan = ev.prize_json ? JSON.parse(ev.prize_json) : null;
    } catch (_) {}
    if (!plan) {
      const fee = Number(ev.entry_fee) || ENTRY_FEE;
      plan = { n: rows.length, fee, amounts: drawPrizes(rows.length, fee), drawn_at: nowISO() };
      await env.DB.prepare(`UPDATE events SET prize_json = ? WHERE id = ?`).bind(JSON.stringify(plan), id).run();
    }

    const ranked = rankAndPrize(rows, plan.amounts || []).rows;
    const now = nowISO();
    const stmts = [env.DB.prepare(`DELETE FROM results WHERE event_id = ?`).bind(id)];
    for (const r of ranked) {
      stmts.push(
        env.DB.prepare(
          `INSERT INTO results (event_id, member_id, raw_nick, gz_mask, rank_no, rank_label, stroke, handicap, final, prize, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, r.member_id, r.raw_nick, r.gz_mask, r.rank_no, r.rank_label, r.stroke, r.handicap, r.final, r.prize, now)
      );
      // 다음 인식 때 같은 사람으로 찾을 수 있게 골프존 ID·결과표 닉네임을 기억
      // 마스터가 고친 연결이 최신 정보: 같은 골프존 ID·닉네임이 다른 회원에게 잘못 붙어 있으면 떼어낸다
      if (r.member_id && r.gz_mask)
        stmts.push(
          env.DB.prepare(`UPDATE members SET gz_mask = NULL WHERE gz_mask = ? AND id <> ?`).bind(r.gz_mask, r.member_id),
          env.DB.prepare(`UPDATE members SET gz_mask = ? WHERE id = ?`).bind(r.gz_mask, r.member_id)
        );
      if (r.member_id && r.raw_nick)
        stmts.push(
          env.DB.prepare(`DELETE FROM member_aliases WHERE alias = ? AND member_id <> ?`).bind(r.raw_nick, r.member_id),
          env.DB.prepare(`INSERT OR IGNORE INTO member_aliases (member_id, alias, created_at) VALUES (?, ?, ?)`).bind(
            r.member_id,
            r.raw_nick,
            now
          )
        );
    }
    stmts.push(env.DB.prepare(`UPDATE events SET results_at = ? WHERE id = ?`).bind(now, id));
    await env.DB.batch(stmts);
    return json({ event: await eventDetail(env, id, me, true) });
  }

  if (seg[0] === "events" && seg[1] && seg[2] === "results" && method === "DELETE") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM results WHERE event_id = ?`).bind(id),
      env.DB.prepare(`UPDATE events SET results_at = NULL WHERE id = ?`).bind(id),
    ]);
    return json({ event: await eventDetail(env, id, me, true) });
  }

  /* ---- 기록 (랭킹 · 맞대결) ---- */

  if (seg[0] === "stats" && method === "GET") {
    const { results: evs } = await env.DB.prepare(
      `SELECT id, event_date, start_time, title, place, entry_fee, results_at,
              (SELECT COUNT(*) FROM results r WHERE r.event_id = e.id) AS players
       FROM events e WHERE results_at IS NOT NULL ORDER BY event_date DESC, start_time DESC`
    ).all();
    const { results: rows } = await env.DB.prepare(
      `SELECT r.event_id, r.member_id, r.raw_nick, r.rank_no, r.rank_label, r.stroke, r.handicap, r.final, r.prize
       FROM results r JOIN events e ON e.id = r.event_id WHERE e.results_at IS NOT NULL`
    ).all();
    const { results: mem } = await env.DB.prepare(
      `SELECT id, name, nickname, role FROM members WHERE status = 'approved'`
    ).all();
    const { results: pending } = await env.DB.prepare(
      `SELECT id, event_date, start_time, title, place FROM events
       WHERE results_at IS NULL AND event_date <= ? ORDER BY event_date DESC LIMIT 20`
    )
      .bind(todayKST())
      .all();
    return json({
      events: evs || [],
      results: rows || [],
      members: (mem || []).map((m) => ({ id: m.id, nickname: m.nickname, name: isMaster ? m.name : undefined, role: m.role })),
      pending: isMaster ? (pending || []).filter((e) => startTs(e) <= Date.now()) : [], // 시작한 대회만
    });
  }

  return fail("요청하신 주소를 찾을 수 없습니다.", 404);
}

/** 시상 금액이 바뀌면 이미 저장된 결과의 상금도 다시 계산 */
async function reapplyPrizes(env, eventId, amounts) {
  const { results } = await env.DB.prepare(`SELECT * FROM results WHERE event_id = ?`).bind(eventId).all();
  if (!results || !results.length) return;
  const ranked = rankAndPrize(results, amounts).rows;
  await env.DB.batch(ranked.map((r) => env.DB.prepare(`UPDATE results SET prize = ? WHERE id = ?`).bind(r.prize, r.id)));
}
