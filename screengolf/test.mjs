import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const db = new DatabaseSync(":memory:");
db.exec(readFileSync("./schema.sql", "utf8"));

function stmt(sql, args = []) {
  return {
    bind: (...a) => stmt(sql, a),
    first: () => db.prepare(sql).get(...args) ?? null,
    all: () => ({ results: db.prepare(sql).all(...args) }),
    run: () => {
      const r = db.prepare(sql).run(...args);
      return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  };
}
const env = { DB: { prepare: (sql) => stmt(sql), batch: async (ss) => ss.map((s) => s.run()) } };

const mod = await import(pathToFileURL("./functions/api/[[path]].js").href);
const sch = await import(pathToFileURL("./shared/assign.js").href);

let TOKEN = "";
async function call(path, method = "GET", body) {
  const res = await mod.onRequest({
    env,
    request: new Request("https://x" + path, {
      method,
      headers: Object.assign({ "content-type": "application/json" }, TOKEN ? { authorization: "Bearer " + TOKEN } : {}),
      body: body ? JSON.stringify(body) : undefined,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}
const ok = (c, m) => { console.log((c ? "PASS " : "FAIL ") + m); if (!c) process.exit(1); };
const kst = (min = 0) => new Date(Date.now() + 9 * 3600000 + min * 60000).toISOString();
const dateOf = (s) => s.slice(0, 10), timeOf = (s) => s.slice(11, 16);

/* 1. 마스터 + 회원 8명 */
let r = await call("/api/register", "POST", { login_id: "master", name: "홍마스터", password: "1234" });
ok(r.first, "첫 가입자가 마스터");
TOKEN = (await call("/api/login", "POST", { login_id: "master", password: "1234" })).token;

for (let i = 1; i <= 8; i++) {
  const t = TOKEN; TOKEN = "";
  await call("/api/register", "POST", { login_id: "u" + i, name: "회원" + i, password: "1234" });
  TOKEN = t;
}
const pend = (await call("/api/members")).members.filter((m) => m.status === "pending");
ok(pend.length === 8, "승인 대기 8명");
const ids = [];
for (const m of pend) {
  const role = Number(m.login_id.slice(1)) > 6 ? "guest" : "member";
  await call("/api/members/" + m.id, "PATCH", { status: "approved", role });
  ids.push(m.id);
}

/* 2. 내일 일정 생성 (정식 신청 기간) */
const tomorrow = kst(24 * 60);
r = await call("/api/events", "POST", {
  dates: [dateOf(tomorrow)], start_time: "19:00", place: "OO스크린골프", title: "월례회", rooms_count: 6,
});
const evId = (await call("/api/events")).events[0].id;
let ev = (await call("/api/events/" + evId)).event;
ok(ev.phase === "open", "내일 일정은 정식 신청 기간(open)");
ok(ev.rooms_count === 6 && ev.capacity === 24, "방 6개 = 정원 24명");

/* 3. 참가 / 보류 / 비참가 */
async function rsvpAs(loginId, status) {
  const t = TOKEN;
  try {
    TOKEN = (await call("/api/login", "POST", { login_id: loginId, password: "1234" })).token;
    return await call(`/api/events/${evId}/rsvp`, "POST", { status });
  } finally {
    TOKEN = t;
  }
}
for (const i of [1, 2, 3, 4]) await rsvpAs("u" + i, "yes");
await rsvpAs("u7", "yes"); // 게스트
for (const i of [5, 6]) await rsvpAs("u" + i, "hold");
await rsvpAs("u8", "no");
await call(`/api/events/${evId}/rsvp`, "POST", { status: "yes" }); // 마스터 본인

ev = (await call("/api/events/" + evId)).event;
ok(ev.yes_count === 6 && ev.hold_count === 2 && ev.no_count === 1, `참가6/보류2/불참1 (실제 ${ev.yes_count}/${ev.hold_count}/${ev.no_count})`);

/* 4. 마감 전에는 보류 가능, 마감 후에는 불가 — 날짜를 오늘로 당겨 마감을 지나게 한다 */
const later = kst(75);
if (dateOf(later) !== dateOf(kst(0))) {
  console.log("SKIP 자정 근처라 마감 시나리오는 건너뜁니다");
  process.exit(0);
}
db.prepare("UPDATE events SET event_date = ?, start_time = ? WHERE id = ?").run(dateOf(later), timeOf(later), evId);

ok((await sch.sweepHolds(env)) === 2, "마감이 지나자 보류 2명이 자동 제외됨");
ev = (await call("/api/events/" + evId)).event;
ok(ev.phase === "waitlist", "당일에는 대기신청 단계(waitlist)");
ok(ev.hold_count === 0 && ev.no_count === 3, "보류 0명 · 비참가 3명으로 정리");
ok(ev.responses.filter((x) => x.dropped).length === 2, "자동 제외 표시(dropped) 2명");

/* 5. 당일 추가 신청은 대기로 들어간다 */
r = await rsvpAs("u5", "yes");
ok(r.status === "wait", "당일 참가 신청 → 대기로 접수");
ok(/대기 신청으로 접수/.test(r.message || ""), "대기 안내 메시지");

try {
  await rsvpAs("u6", "hold");
  ok(false, "당일 보류 선택은 거부");
} catch (e) {
  ok(/11시 59분/.test(e.message), "당일 보류 선택은 거부");
}

/* 6. 방 수와 정원 */
try {
  await call("/api/events/" + evId, "PATCH", { rooms_count: 1 });
  ok(false, "확정 인원보다 적은 방 수로는 못 줄임");
} catch (e) {
  ok(/줄일 수 없습니다/.test(e.message), "확정 인원보다 적은 방 수로는 못 줄임");
}
await call("/api/events/" + evId, "PATCH", { rooms_count: 2 }); // 정원 8명
ev = (await call("/api/events/" + evId)).event;
ok(ev.capacity === 8, "방 2개 → 정원 8명");

/* 7. 마스터가 대기자를 확정 */
const waiting = ev.responses.find((x) => x.status === "wait");
r = await call(`/api/events/${evId}/rsvp`, "POST", { status: "yes", member_id: waiting.id });
ok(r.event.yes_count === 7 && r.event.wait_count === 0, "대기자 확정 → 참가 7명");

/* 8. 정원 초과 확정은 거부 */
await call("/api/events/" + evId, "PATCH", { rooms_count: 2 }); // 정원 8명
let detail = (await call("/api/events/" + evId)).event;
async function firstOutsider() {
  const d = (await call("/api/events/" + evId)).event;
  const yes = new Set(d.responses.filter((x) => x.status === "yes").map((x) => x.id));
  return (await call("/api/members")).members.find((m) => m.status === "approved" && !yes.has(m.id));
}
let o = await firstOutsider();
await call(`/api/events/${evId}/rsvp`, "POST", { status: "yes", member_id: o.id }); // 8명째 = 정원 꽉
detail = (await call("/api/events/" + evId)).event;
ok(detail.yes_count === 8, "정원 8명이 모두 참");
o = await firstOutsider();
try {
  await call(`/api/events/${evId}/rsvp`, "POST", { status: "yes", member_id: o.id });
  ok(false, "정원이 찬 뒤 확정은 거부");
} catch (e) {
  ok(/정원/.test(e.message), "정원이 찬 뒤 확정은 거부");
}

/* 9. 시작 20분 전이 되면 Cron이 확정 인원만 배정 */
await call("/api/events/" + evId, "PATCH", { rooms_count: 6 });
const soon = kst(15);
db.prepare("UPDATE events SET event_date = ?, start_time = ? WHERE id = ?").run(dateOf(soon), timeOf(soon), evId);
const res = await sch.runSchedule(env);
ok(res.assigned === 1, "시작 20분 안쪽 → Cron이 배정");

ev = (await call("/api/events/" + evId)).event;
const sizes = ev.rooms.map((x) => x.members.length).sort((a, b) => b - a);
ok(sizes.reduce((a, b) => a + b, 0) === ev.yes_count, `확정 ${ev.yes_count}명 전원 배정 (${sizes.join("+")})`);
ok(ev.rooms.length <= 6 && sizes[0] <= 4, "방은 6개 이하, 한 방 4명 이하");
const assignedIds = new Set(ev.rooms.flatMap((x) => x.members.map((m) => m.id)));
ok(ev.responses.filter((x) => x.status !== "yes").every((x) => !assignedIds.has(x.id)), "비참가·대기는 배정에서 제외");
ok((await sch.runSchedule(env)).assigned === 0, "Cron 재실행해도 중복 배정 없음");

/* 10. 8명 → 4+4, 6명 방 제한 확인 */
ok(JSON.stringify(sch.roomSizes(8)) === "[4,4]", "8명 → 4+4");
ok(JSON.stringify(sch.roomSizes(7)) === "[4,3]", "7명 → 4+3");
ok(JSON.stringify(sch.roomSizes(5)) === "[3,2]", "5명 → 3+2");
ok(sch.roomSizes(24).length === 6, "24명 → 방 6개");
ok(sch.roomSizes(26).length === 6, "정원을 넘겨도 방은 6개까지만");

console.log("\n모든 테스트 통과");
