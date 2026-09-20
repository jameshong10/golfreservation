// 스크린골프 동호회 예약 API  —  Cloudflare Pages Functions + D1
// 경로: /api/*

import {
  MAX_ROOMS,
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
  phone: m.phone,
  role: m.role,
  status: m.status,
  memo: m.memo,
  created_at: m.created_at,
});

/* ---------------- 일정 상세 ---------------- */

function decorate(ev, extra = {}) {
  return {
    ...ev,
    rooms_count: roomsOf(ev),
    capacity: capacityOf(ev),
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
    `SELECT m.id, m.name, m.role, s.status, s.dropped, s.created_at, s.updated_at
     FROM signups s JOIN members m ON m.id = s.member_id
     WHERE s.event_id = ? ORDER BY s.id`
  )
    .bind(eventId)
    .all();

  const { results: rm } = await env.DB.prepare(
    `SELECT r.room_no, m.id, m.name, m.role FROM rooms r
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
    r.members.push({ id: row.id, name: row.name, role: row.role });
  }

  const list = responses || [];
  const mine = me ? list.find((x) => x.id === me.id) : null;
  return decorate(ev, {
    responses: list,
    rooms,
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
    if (!login_id || !name || !password) return fail("아이디, 이름, 비밀번호를 모두 입력하세요.");
    if (String(password).length < 4) return fail("비밀번호는 4자 이상으로 정하세요.");

    const dup = await env.DB.prepare(`SELECT id FROM members WHERE login_id = ?`).bind(login_id).first();
    if (dup) return fail("이미 사용 중인 아이디입니다.");

    // 첫 가입자는 자동으로 마스터가 된다
    const cnt = await env.DB.prepare(`SELECT COUNT(*) AS c FROM members`).first();
    const first = cnt.c === 0;

    const salt = randomHex(16);
    const hash = await hashPw(password, salt);
    await env.DB.prepare(
      `INSERT INTO members (login_id, name, phone, pw_hash, pw_salt, role, status, memo, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(login_id, name, phone || null, hash, salt, first ? "master" : "guest", first ? "approved" : "pending", memo || null, nowISO())
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
  const isMaster = me.role === "master";

  if (seg[0] === "me" && seg.length === 1 && method === "GET") return json({ me: publicMember(me) });

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
      `SELECT * FROM members ORDER BY
        CASE status WHEN 'pending' THEN 0 ELSE 1 END,
        CASE role WHEN 'master' THEN 0 WHEN 'member' THEN 1 ELSE 2 END,
        name`
    ).all();
    const list = (results || []).filter((m) => isMaster || m.status === "approved");
    return json({ members: list.map(publicMember) });
  }

  if (seg[0] === "members" && seg[1] && method === "PATCH") {
    if (!isMaster) return fail("마스터만 할 수 있습니다.", 403);
    const id = Number(seg[1]);
    const target = await env.DB.prepare(`SELECT * FROM members WHERE id = ?`).bind(id).first();
    if (!target) return fail("회원을 찾을 수 없습니다.", 404);

    const fields = [];
    const vals = [];
    if (body.role && ["master", "member", "guest"].includes(body.role)) {
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
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM room_members WHERE member_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM signups WHERE member_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM sessions WHERE member_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM members WHERE id = ?`).bind(id),
    ]);
    return json({ ok: true });
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
        `INSERT INTO events (event_date, start_time, title, place, note, rooms_count, spread_guests, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        d,
        body.start_time,
        body.title || null,
        body.place || null,
        body.note || null,
        rooms,
        body.spread_guests === false ? 0 : 1,
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
    await clearRooms(env, id);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM signups WHERE event_id = ?`).bind(id),
      env.DB.prepare(`DELETE FROM events WHERE id = ?`).bind(id),
    ]);
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

  return fail("요청하신 주소를 찾을 수 없습니다.", 404);
}
