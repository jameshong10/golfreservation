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
let r = await call("/api/register", "POST", { login_id: "master", name: "홍마스터", nickname: "홍그리골프", password: "1234" });
ok(r.first, "첫 가입자가 마스터");
TOKEN = (await call("/api/login", "POST", { login_id: "master", password: "1234" })).token;

for (let i = 1; i <= 8; i++) {
  const t = TOKEN; TOKEN = "";
  await call("/api/register", "POST", { login_id: "u" + i, name: "회원" + i, nickname: "닉" + i, password: "1234" });
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


/* 11. 방배정과 함께 시상 금액 배정 */
ok(ev.prize && ev.prize.n === ev.yes_count, `방배정 때 시상 계획 생성 (${ev.prize && ev.prize.amounts.join("/")})`);
ok(ev.prize.amounts.reduce((a, b) => a + b, 0) === ev.yes_count * 4000, "시상 총액 = 인원 x 4,000원");
ok(ev.prize.amounts.length === Math.floor(ev.yes_count / 2), "참가자 절반(내림)만 시상");
ok(ev.prize.amounts.every((x, i) => i === 0 || x < ev.prize.amounts[i - 1]), "1등 > 2등 > 3등 ... 차등");
for (let n = 1; n <= 30; n++) for (let t = 0; t < 50; t++) {
  const p = sch.drawPrizes(n);
  if (p.reduce((a, b) => a + b, 0) !== n * 4000 || p.some((x, i) => i && x > p[i - 1]) || p.length !== Math.max(1, Math.floor(n / 2)) || (p.length > 1 && p.some((x) => x < 5000)))
    ok(false, `시상 규칙 위반 n=${n} ${p}`);
}
ok(true, "1~30명 x 50회 랜덤 시상 모두 규칙 충족");

/* 12. 닉네임 */
try { await call("/api/me", "PATCH", { nickname: "닉1" }); ok(false, "중복 닉네임 거부"); }
catch (e) { ok(/다른 회원/.test(e.message), "다른 회원 닉네임으로는 못 바꿈"); }
{
  const t = TOKEN;
  TOKEN = (await call("/api/login", "POST", { login_id: "u1", password: "1234" })).token;
  r = await call("/api/me", "PATCH", { nickname: "스마일맨.준" });
  ok(r.me.nickname === "스마일맨.준", "본인이 닉네임 변경 (닉1 → 스마일맨.준)");
  TOKEN = t;
}

/* 13. 결과 저장 · 예전 닉네임/골프존ID로 매칭 · 공동순위 상금 */
const u1 = (await call("/api/members")).members.find((m) => m.login_id === "u1");
const u2 = (await call("/api/members")).members.find((m) => m.login_id === "u2");
const u3 = (await call("/api/members")).members.find((m) => m.login_id === "u3");
const masterM = (await call("/api/members")).members.find((m) => m.login_id === "master");
await call(`/api/events/${evId}/prize`, "POST", { count: 7 });
ev = (await call("/api/events/" + evId)).event;
const plan = ev.prize.amounts;
r = await call(`/api/events/${evId}/results`, "PUT", { rows: [
  { member_id: masterM.id, raw_nick: "홍그리골프", gz_mask: "giveufi**", rank_label: "3", stroke: 6, handicap: 1, final: 7 },
  { member_id: u1.id, raw_nick: "스마일맨.준", gz_mask: "wns10**", rank_label: "1", stroke: 3, handicap: -1, final: 2 },
  { member_id: u2.id, raw_nick: "해피라구~~", gz_mask: "hm85141**", rank_label: "2", stroke: 2, handicap: 1, final: 3 },
  { member_id: u3.id, raw_nick: "무산2", gz_mask: "cyh90**", rank_label: "4", stroke: 8, handicap: 3, final: 11 },
  { member_id: null, raw_nick: "월산.", rank_label: "T5", stroke: 10, handicap: 2, final: 12 },
  { member_id: null, raw_nick: "홀컵속그로", rank_label: "T5", stroke: 14, handicap: -2, final: 12 },
  { member_id: null, raw_nick: "윤프로", rank_label: "7", stroke: 24, handicap: -2, final: 22 },
]});
const res1 = r.event.results;
ok(res1[0].member_id === u1.id && res1[0].prize === plan[0], `1등 상금 ${res1[0].prize}`);
ok(res1[2].prize === plan[2] && res1[3].prize === 0, "3등까지만 상금, 4등부터 0");
ok(res1.filter((x) => x.rank_label === "T5").length === 2, "공동 순위 T5 유지");

// u2가 닉네임을 바꾼 뒤, 사진 인식 결과(가짜 Claude 응답)로 매칭 확인
{
  const t = TOKEN;
  TOKEN = (await call("/api/login", "POST", { login_id: "u2", password: "1234" })).token;
  await call("/api/me", "PATCH", { nickname: "해피라구2" });
  TOKEN = t;
}
env.gemini_api_key = "AQ.test"; // 운영에 소문자로 등록돼 있음
const fake = { title: "주오맨0920", date: "26.09.20", rows: [
  { rank: "3", nickname: "홍그리골프", gz_id: "giveufi**", stroke: 6, handicap: 1, final: 7 },
  { rank: "1", nickname: "스마일맨.준", gz_id: "wns10**", stroke: 3, handicap: -1, final: 2 },
  { rank: "2", nickname: "해피라구~~", gz_id: "hm85141**", stroke: 2, handicap: 1, final: 3 },
  { rank: "3", nickname: "홍그리골프", gz_id: "giveufi**", stroke: 6, handicap: 1, final: 7 },
  { rank: "5", nickname: "무산새닉", gz_id: "cyh90**", stroke: 8, handicap: 3, final: 11 },
  { rank: "9", nickname: "모르는사람", gz_id: "zzz**", stroke: 18, handicap: 0, final: 18 },
]};
const realFetch = globalThis.fetch;
const hit = [];
globalThis.fetch = async (url) => {
  hit.push(String(url).match(/models\/([^:]+)/)[1]);
  // 첫 모델은 없다(404)고 가정 → 다음 모델로 넘어가는지 확인
  if (hit.length === 1) return new Response(JSON.stringify({ error: { message: "not found" } }), { status: 404 });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(fake) }] } }] }), { status: 200 });
};
r = await call(`/api/events/${evId}/ocr`, "POST", { images: [{ media_type: "image/jpeg", data: "AAAA" }] });
globalThis.fetch = realFetch;
ok(hit.length === 2 && hit[0] === "gemini-flash-latest" && hit[1] === "gemini-3.8-flash", `Gemini: 모델이 없으면 다음 모델로 (${hit.join(" → ")})`);
const byNick = Object.fromEntries(r.rows.map((x) => [x.nickname, x]));
ok(r.rows.length === 5, "겹친 캡처의 중복 행 제거 (6 → 5)");
ok(byNick["홍그리골프"].member_id === masterM.id && byNick["홍그리골프"].match === "닉네임", "현재 닉네임으로 매칭");
ok(byNick["해피라구~~"].member_id === u2.id && byNick["해피라구~~"].match === "예전 닉네임", "닉네임 바꾼 회원 → 예전 닉네임으로 매칭");
ok(byNick["무산새닉"].member_id === u3.id && byNick["무산새닉"].match === "골프존 ID", "처음 보는 닉네임 → 골프존 ID로 매칭");
ok(byNick["모르는사람"].member_id === null, "모르는 사람은 연결 안 됨 (마스터가 선택)");

/* 14. 기록 */
const st = await call("/api/stats");
ok(st.events.length === 1 && st.results.length === 7, "기록: 대회 1건, 결과 7줄");
ok(st.results.filter((x) => x.member_id).length === 4, "회원 4명 · 비회원 3명");

/* 15. 오인식 수정: 같은 결과표 닉네임을 다른 회원으로 고쳐 저장하면 잘못된 연결이 옮겨감 */
const u4 = (await call("/api/members")).members.find((m) => m.login_id === "u4");
r = await call(`/api/events/${evId}/results`, "PUT", { rows: [
  { member_id: u4.id, raw_nick: "무산2", gz_mask: "cyh90**", rank_label: "", stroke: 8, handicap: 3, final: 11 },
  { member_id: masterM.id, raw_nick: "홍그리골프", gz_mask: "giveufi**", rank_label: "", stroke: 6, handicap: 1, final: 7 },
]});
let mm = (await call("/api/members")).members;
ok(mm.find((m) => m.id === u4.id).gz_mask === "cyh90**" && mm.find((m) => m.id === u3.id).gz_mask === null, "골프존 ID가 올바른 회원으로 옮겨짐");
const al3 = (await call(`/api/members/${u3.id}/aliases`)).aliases.map((a) => a.alias);
ok(!al3.includes("무산2"), "잘못 붙은 인식 이름이 이전 회원에게서 제거됨");
await call(`/api/members/${u4.id}`, "PATCH", { gz_mask: "fixed**" });
ok((await call("/api/members")).members.find((m) => m.id === u4.id).gz_mask === "fixed**", "마스터가 골프존 ID 직접 수정");
const al4 = (await call(`/api/members/${u4.id}/aliases`)).aliases;
await call(`/api/members/${u4.id}/aliases/${al4[0].id}`, "DELETE", {});
ok((await call(`/api/members/${u4.id}/aliases`)).aliases.length === al4.length - 1, "마스터가 인식 이름 삭제");

/* 16. 개발자 등급 + 테스트 데이터 생성 · 삭제 */
try { await call("/api/test-data", "POST", { events: 1 }); ok(false, "마스터는 테스트 도구 불가"); }
catch (e) { ok(/개발자/.test(e.message), "테스트 도구는 개발자 계정만"); }
// 두 번째 마스터를 만든 뒤 본인을 개발자로
await call(`/api/members/${u1.id}`, "PATCH", { role: "master" });
await call(`/api/members/${masterM.id}`, "PATCH", { role: "dev" });
ok((await call("/api/me")).me.role === "dev", "본인 등급을 개발자로 변경");
try { await call(`/api/members/${u1.id}`, "DELETE", {}); ok(false, "마스터 삭제 거부"); }
catch (e) { ok(/마스터·개발자/.test(e.message), "마스터 계정은 삭제 불가"); }
const before = (await call("/api/members")).members.length;
r = await call("/api/test-data", "POST", { events: 8, upcoming: true });
ok(r.accounts === 20 && r.events === 8 && r.upcoming, `테스트 계정 20명 · 대회 8회 · 배정 테스트 일정 ${r.upcoming}`);
const st2 = await call("/api/stats");
const testRes = st2.results.filter((x) => st2.events.find((e) => e.id === x.event_id && e.place === undefined) || true);
ok(st2.events.length >= 9, `기록 탭에 대회 ${st2.events.length}건`);
const byEv = {};
for (const x of st2.results) (byEv[x.event_id] = byEv[x.event_id] || []).push(x);
const okEv = Object.values(byEv).every((l) => l.length === 2 || (l.length >= 6 && l.length <= 14 && l.some((x) => x.prize > 0)));
ok(okEv, "대회마다 6~14명 참가 · 상금 배정");
const up = (await call("/api/events")).events.find((e) => e.title === "방배정 테스트");
ok(up && up.yes_count === 10, "방배정 테스트 일정에 10명 참가");
r = await call("/api/test-data", "POST", { events: 2, upcoming: false });
ok(r.accounts === 20, "다시 만들어도 계정은 20명 그대로(중복 없음)");
// 선택 삭제
const tests = (await call("/api/members")).members.filter((m) => m.is_test).slice(0, 3).map((m) => m.id);
r = await call("/api/members-delete", "POST", { ids: [...tests, masterM.id] });
ok(r.deleted === 3, "선택 삭제 3명 (본인은 제외)");
try { await call("/api/members-delete", "POST", { ids: [u1.id] }); ok(false, "마스터 선택 삭제 거부"); }
catch (e) { ok(true, "선택 삭제에 마스터 포함 시 거부"); }
try { await call("/api/members-delete", "POST", { ids: [masterM.id] }); ok(false, "본인 삭제 거부"); } catch (e) { ok(true, "본인만 고르면 삭제 거부"); }
r = await call("/api/test-data", "DELETE", {});
ok(r.accounts === 17 && r.events === 11, `테스트 데이터 전부 삭제 (계정 ${r.accounts}, 대회 ${r.events})`);
ok((await call("/api/members")).members.length === before, "실제 회원 수는 그대로");
ok((await call("/api/stats")).events.length === 1, "실제 대회 기록은 그대로");

/* 17. Jev: 결과표 닉네임 AI 매칭 · 카톡 대화로 참가 의사 받기 (API는 가짜 응답) */
const jevCalls = [];
function mockJev(answerFor) {
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes("generativelanguage"))
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(fake2) }] } }] }), { status: 200 });
    const req = JSON.parse(opts.body);
    jevCalls.push(req);
    const answers = {};
    for (const [k, q] of Object.entries(req.questions)) {
      const c = answerFor(k, q, req.state) || "none";
      answers[k] = { type: "choice", choice: c, probabilities: { [c]: 0.9 }, confidence: 0.8 };
    }
    return new Response(JSON.stringify({ model: "jev-test", answers }), { status: 200 });
  };
}
const fake2 = { rows: [
  { rank: "1", nickname: "스마일맨.준", gz_id: "wns10**", stroke: 3, handicap: -1, final: 2 },
  { rank: "2", nickname: "무 산 ~", gz_id: null, stroke: 8, handicap: 3, final: 11 },
]};
ok((await call("/api/me")).features.jev === false, "Jev 키가 없으면 기능 꺼짐 표시");
env.TYPESAFE_API_KEY = "sk-test";
ok((await call("/api/me")).features.jev === true, "Jev 키가 있으면 기능 켜짐 표시");
mockJev((k, q, state) => (state.names && state.names[0].표시_이름 === "무 산 ~" ? "m" + u3.id : "none"));
r = await call(`/api/events/${evId}/ocr`, "POST", { images: [{ media_type: "image/jpeg", data: "AAAA" }] });
ok(jevCalls.length === 1 && Object.keys(jevCalls[0].questions).length === 1, "코드로 못 찾은 1줄만 Jev에게 물음");
ok(jevCalls[0].model === "jev-latest", "모델은 jev-latest");
const aiRow = r.rows.find((x) => x.nickname === "무 산 ~");
ok(aiRow.member_id === u3.id && aiRow.match === "AI 추정" && aiRow.match_p === 0.9, "Jev가 고른 회원으로 'AI 추정' 연결");

// Jev가 실패해도 사진 인식 결과는 그대로
globalThis.fetch = async (url) =>
  String(url).includes("generativelanguage")
    ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(fake2) }] } }] }), { status: 200 })
    : new Response("{}", { status: 401 });
r = await call(`/api/events/${evId}/ocr`, "POST", { images: [{ media_type: "image/jpeg", data: "AAAA" }] });
ok(r.rows.length === 2 && r.rows.find((x) => x.nickname === "무 산 ~").member_id === null && /키 오류/.test(r.ai_note), "Jev 오류 → 연결만 비우고 안내");

const chat = [
  "--------------- 2026년 9월 24일 수요일 ---------------",
  "[회원1/42/분당] [오후 3:12] 저 참석합니다!",
  "[닉3] [오후 3:13] 이번주는 애매해요",
  "목요일에 말씀드릴게요",
  "[닉3] [오후 5:40] 아 그냥 패스할게요 ㅠ",
  "[홍그리골프] [오후 3:15] ㅋㅋㅋ 지난주 공 진짜 안맞더라",
  "[김모름] [오후 3:20] 참석이요",
].join("\n");
jevCalls.length = 0;
mockJev((k, q, state) => {
  const i = Number(k.slice(1));
  const sp = state.speakers[i];
  if (k[0] === "m") return "none";
  const last = sp.메시지[sp.메시지.length - 1];
  return /패스/.test(last) ? "no" : /참석/.test(last) ? "yes" : "none";
});
r = await call(`/api/events/${evId}/chat`, "POST", { text: chat });
const bySp = Object.fromEntries(r.people.map((x) => [x.speaker, x]));
ok(r.parsed === 5 && r.people.length === 4, `카톡 대화 5개 메시지 · 4명 (${r.parsed}/${r.people.length})`);
ok(bySp["닉3"].quote === "아 그냥 패스할게요 ㅠ" && bySp["닉3"].status === "no", "마음을 바꾸면 마지막 말 기준 (닉3 → 불참)");
ok(bySp["회원1/42/분당"].member_id === u1.id && bySp["회원1/42/분당"].match === "이름 포함", "'이름/나이/지역' 카톡 이름 → 코드로 회원 찾음");
ok(bySp["홍그리골프"].status === "none" && !bySp["홍그리골프"].sure, "잡담은 참가 의사 없음");
ok(bySp["김모름"].member_id === null, "모르는 사람은 연결 안 됨");
ok(Object.keys(jevCalls[0].questions).filter((k) => k[0] === "m").length === 1, "회원 매칭은 코드로 못 찾은 1명만 Jev에게");
globalThis.fetch = realFetch;

const u3m = (await call("/api/members")).members.find((m) => m.login_id === "u3");
r = await call(`/api/events/${evId}/rsvp-bulk`, "POST", { items: [
  { member_id: u1.id, status: "yes" }, { member_id: u3m.id, status: "no" }, { member_id: u1.id, status: "no" },
]});
ok(r.done === 2 && r.event.responses.find((x) => x.id === u3m.id).status === "no", "대화 결과 한 번에 반영 (중복은 1번만)");
delete env.TYPESAFE_API_KEY;
try { await call(`/api/events/${evId}/chat`, "POST", { text: chat }); ok(false, "키 없으면 거부"); }
catch (e) { ok(/TYPESAFE_API_KEY/.test(e.message), "Jev 키가 없으면 대화 읽기 안내"); }

/* 18. 가입: 아이디 · 비밀번호만으로 신청 → 마스터 승인 필수 */
{
  const mt = TOKEN;
  TOKEN = "";
  try { await call("/api/register", "POST", { login_id: "onlyid" }); ok(false, "비밀번호 없으면 거부"); }
  catch (e) { ok(/아이디와 비밀번호/.test(e.message), "비밀번호 없으면 가입 거부"); }
  r = await call("/api/register", "POST", { login_id: "onlyid", password: "abcd" });
  ok(r.ok && !r.first && /승인/.test(r.message), "아이디·비밀번호만으로 가입 신청");
  try { await call("/api/login", "POST", { login_id: "onlyid", password: "abcd" }); ok(false, "승인 전 로그인 거부"); }
  catch (e) { ok(/승인 대기/.test(e.message), "승인 전에는 로그인 안 됨 (마스터 승인 필수)"); }
  await call("/api/register", "POST", { login_id: "nick2", password: "abcd", nickname: "새닉" });
  try { await call("/api/register", "POST", { login_id: "nick3", password: "abcd", nickname: "새닉" }); ok(false, "닉네임 중복"); }
  catch (e) { ok(/닉네임/.test(e.message), "닉네임을 적으면 중복은 막음"); }
  TOKEN = mt;
  const p = (await call("/api/members")).members.find((m) => m.login_id === "onlyid");
  ok(p.status === "pending" && p.role === "guest" && p.name === "onlyid" && p.nickname === null, "이름은 아이디로 채우고 닉네임은 비움 · 승인 대기");
  await call("/api/members/" + p.id, "PATCH", { status: "approved", role: "member" });
  TOKEN = "";
  const lg = await call("/api/login", "POST", { login_id: "onlyid", password: "abcd" });
  ok(lg.me.role === "member", "마스터가 정회원으로 승인 → 로그인");
  TOKEN = lg.token;
  r = await call("/api/me", "PATCH", { name: "김온리", phone: "010-1111-2222" });
  ok(r.me.name === "김온리" && r.me.phone === "010-1111-2222", "이름·연락처는 나중에 내 정보에서 입력");
  try { await call("/api/diag"); ok(false, "점검은 마스터만"); } catch (e) { ok(/마스터/.test(e.message), "AI 점검은 마스터만"); }
  try { await call("/api/members/" + p.id + "/dues", "POST", { paid: true }); ok(false, "회비 기록은 마스터만"); }
  catch (e) { ok(/마스터/.test(e.message), "회비 기록은 마스터만"); }
  const plain = (await call("/api/members")).members.find((m) => m.login_id === "onlyid");
  ok(plain.dues_year === undefined && plain.phone === undefined, "일반 회원에겐 남의 회비·연락처 안 보임");
  TOKEN = mt;
}

/* 19. 회비 — 1년에 한 번. 버튼 한 번에 기록, 묻지 않음. 강등은 드물게 마스터가 등급에서 직접 */
{
  const year = Number(kst(0).slice(0, 4));
  let ms = (await call("/api/members")).members;
  const regular = ms.filter((m) => m.status === "approved" && m.role === "member");
  const [a] = regular;
  r = await call(`/api/members/${a.id}/dues`, "POST", { paid: true });
  ok(r.member.dues_year === year && r.member.role === "member" && !r.promoted, `${year}년 회비 납부 (한 번 누르기)`);
  r = await call(`/api/members/${a.id}/dues`, "POST", { paid: false });
  ok(r.member.dues_year === null, "다시 누르면 취소");
  await call(`/api/members/${a.id}/dues`, "POST", { paid: true });

  ms = (await call("/api/members")).members;
  const before = ms.filter((m) => m.role === "member").length;
  ok(before === regular.length, "회비 기록이 없어도 아무도 자동으로 강등되지 않음");
  try { await call("/api/dues/demote", "POST", {}); ok(false, "일괄 강등 없음"); }
  catch (e) { ok(/찾을 수 없습니다/.test(e.message), "월 단위 일괄 강등 기능은 없앰"); }

  const g = ms.find((m) => m.role === "guest" && m.status === "approved");
  r = await call(`/api/members/${g.id}/dues`, "POST", { paid: true });
  ok(r.promoted && r.member.role === "member", "게스트가 회비를 내면 묻지 않고 정회원으로");
  await call(`/api/members/${g.id}`, "PATCH", { role: "guest" });
  ok((await call("/api/members")).members.find((m) => m.id === g.id).role === "guest", "드문 강등은 마스터가 등급에서 직접");
  r = await call(`/api/members/${g.id}/dues`, "POST", { paid: true, year: year - 1 });
  ok(!r.promoted, "작년 회비 기록으로는 정회원 안 올라감");
}

/* 19-2. 지난번 설정 불러오기 */
{
  const L = (await call("/api/events")).last;
  const newest = db.prepare("SELECT place, start_time FROM events ORDER BY id DESC LIMIT 1").get();
  ok(L && L.event && L.event.place === newest.place && L.event.start_time === newest.start_time, `새 일정 폼에 지난번 일정 불러옴 (${L.event.place} ${L.event.start_time})`);
  TOKEN = (await call("/api/login", "POST", { login_id: "onlyid", password: "abcd" })).token;
  ok((await call("/api/events")).last === undefined, "지난 설정은 마스터에게만");
  TOKEN = (await call("/api/login", "POST", { login_id: "master", password: "1234" })).token;
}

/* 19-3. 로그인 유지 — 10년 + 쓸 때마다 자동 연장 */
{
  const tok = TOKEN;
  db.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Date.now() + 5 * 86400000, tok);
  await call("/api/me");
  const exp = db.prepare("SELECT expires_at FROM sessions WHERE token = ?").get(tok).expires_at;
  ok(exp - Date.now() > 3600 * 86400000, "만료가 가까우면 쓰는 순간 10년으로 다시 연장");
  const t2 = (await call("/api/login", "POST", { login_id: "master", password: "1234" })).token;
  const exp2 = db.prepare("SELECT expires_at FROM sessions WHERE token = ?").get(t2).expires_at;
  ok(exp2 - Date.now() > 3600 * 86400000, "새 로그인은 10년 유지");
}

/* 20. 특별상 (홀인원 · 알바트로스) */
{
  const d1 = dateOf(kst(3 * 24 * 60)), d2 = dateOf(kst(10 * 24 * 60));
  await call("/api/events", "POST", { dates: [d1, d2], start_time: "19:00", place: "특별상 구장" });
  const evs = (await call("/api/events")).events.filter((e) => e.place === "특별상 구장");
  const [e1, e2] = evs;
  r = await call(`/api/events/${e1.id}/jackpots`, "POST", { kind: "hio", amount: 100000, note: "달성자 없으면 이월" });
  ok(r.event.jackpots.length === 1 && r.event.jackpots[0].label === "홀인원" && r.event.jackpots[0].amount === 100000, "홀인원 특별상 10만원 걸기");
  await call(`/api/events/${e1.id}/jackpots`, "POST", { kind: "albatross", amount: 50000 });
  r = await call(`/api/events/${e1.id}/jackpots`, "POST", { kind: "custom", label: "니어핀", amount: 10000 });
  ok(r.event.jackpots.map((j) => j.label).join(",") === "홀인원,알바트로스,니어핀", "알바트로스 · 직접 입력(니어핀)도 가능");
  try { await call(`/api/events/${e1.id}/jackpots`, "POST", { kind: "hio" }); ok(false, "상금 없음"); }
  catch (e) { ok(/상금/.test(e.message), "상금 없이 만들면 거부"); }
  const listed = (await call("/api/events")).events.find((e) => e.id === e1.id);
  ok(listed.jackpots.length === 3, "일정 목록에도 특별상이 보임 (신청 전에 알 수 있게)");

  const [hio, alb, near] = r.event.jackpots;
  const winner = (await call("/api/members")).members.find((m) => m.role === "member");
  r = await call(`/api/jackpots/${hio.id}`, "PATCH", { winner_id: winner.id, hole_no: 7 });
  const h1 = r.event.jackpots.find((j) => j.id === hio.id);
  ok(h1.won_at && h1.winner === (winner.nickname || winner.name) && h1.hole_no === 7, "홀인원 달성자 기록 (7번 홀)");
  try { await call(`/api/jackpots/${hio.id}/carry`, "POST", {}); ok(false, "달성된 건 이월 불가"); }
  catch (e) { ok(/달성자가 있는/.test(e.message), "달성자가 있으면 이월 불가"); }
  try { await call(`/api/jackpots/${alb.id}`, "PATCH", { hole_no: 20, winner_name: "외부인" }); ok(false, "홀 번호"); }
  catch (e) { ok(/1~18/.test(e.message), "홀 번호는 1~18"); }

  r = await call(`/api/jackpots/${alb.id}/carry`, "POST", { add: 20000 });
  ok(r.next.id === e2.id, "알바트로스 → 다음 일정으로 이월");
  const e2d = (await call(`/api/events/${e2.id}`)).event;
  ok(e2d.jackpots.length === 1 && e2d.jackpots[0].amount === 70000 && /이월/.test(e2d.jackpots[0].note), "이월하면서 상금 5만 → 7만");
  try { await call(`/api/jackpots/${alb.id}/carry`, "POST", {}); ok(false, "두 번 이월"); }
  catch (e) { ok(/이미 이월/.test(e.message), "같은 특별상은 한 번만 이월"); }

  r = await call(`/api/jackpots/${near.id}`, "PATCH", { winner_name: "지나가던손님" });
  ok(r.event.jackpots.find((j) => j.id === near.id).winner === "지나가던손님", "비회원 달성자는 이름으로 기록");
  const fame = (await call("/api/stats")).jackpots;
  ok(fame.length === 2 && fame.some((j) => j.label === "홀인원" && j.hole_no === 7), "기록 탭 명예의 전당에 달성 2건");

  r = await call(`/api/jackpots/${near.id}`, "PATCH", { clear_winner: true });
  ok(!r.event.jackpots.find((j) => j.id === near.id).won_at, "달성 취소");
  r = await call(`/api/jackpots/${near.id}`, "DELETE", {});
  ok(r.event.jackpots.length === 2, "특별상 삭제");

  await call(`/api/events/${e2.id}`, "DELETE", {});
  const e1d = (await call(`/api/events/${e1.id}`)).event;
  ok(e1d.jackpots.find((j) => j.id === alb.id).carried_to === null, "이월 받은 일정을 지우면 원래 특별상의 이월 표시 해제");
  ok(db.prepare(`SELECT COUNT(*) c FROM jackpots WHERE event_id = ?`).get(e2.id).c === 0, "지운 일정의 특별상도 삭제");
  const LJ = (await call("/api/events")).last;
  ok(LJ.jackpots.hio.amount === 100000 && LJ.jackpots.hio.note === "달성자 없으면 이월" && LJ.jackpots["custom:니어핀"] === undefined, "특별상 폼에 지난번 홀인원 상금·메모 불러옴");
}

/* 21. AI 점검 (Gemini 키 인식) */
{
  const realFetch2 = globalThis.fetch;
  const keep = env.gemini_api_key;
  delete env.gemini_api_key;
  r = await call("/api/diag");
  ok(r.gemini.ready === false && /GEMINI_API_KEY/.test(r.gemini.error), "키가 없으면 '없음'으로 안내");
  env.GEMINI_KEY = "x";
  r = await call("/api/diag");
  ok(/비슷한 이름/.test(r.gemini.error) && /GEMINI_KEY/.test(r.gemini.error), "이름이 틀린 변수는 알려줌");
  delete env.GEMINI_KEY;

  env.gemini_api_key = '  "AQ.Ab8RN6-realistic-key-value-1234"\n';
  let sent = null;
  globalThis.fetch = async (url, init) => {
    sent = { url: String(url), key: init.headers["x-goog-api-key"] };
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "생각…", thought: true }, { text: "1" }] } }] }), { status: 200 });
  };
  r = await call("/api/diag");
  ok(r.gemini.ok && r.gemini.model === "gemini-flash-latest" && r.gemini.reply === "1", "소문자 변수(gemini_api_key)도 인식 → 연결 정상");
  ok(sent.key === "AQ.Ab8RN6-realistic-key-value-1234" && r.gemini.cleaned, "앞뒤 공백·따옴표·줄바꿈은 떼고 보냄");
  ok(r.gemini.looks_ok && /…/.test(r.gemini.key_hint) && !r.gemini.key_hint.includes("realistic"), "키는 앞뒤 4자만 보여줌 (AQ. 형식도 정상)");

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }), { status: 400 });
  r = await call("/api/diag");
  ok(!r.gemini.ok && /키 오류/.test(r.gemini.error), "잘못된 키(400 API key not valid) → '키 오류'로 안내");

  const tried = [];
  globalThis.fetch = async (url) => {
    tried.push(String(url).match(/models\/([^:]+)/)[1]);
    if (tried.length < 3) return new Response(JSON.stringify({ error: { message: "Unknown name thinking" } }), { status: 400 });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "1" }] } }] }), { status: 200 });
  };
  r = await call("/api/diag");
  ok(r.gemini.ok && tried.length === 3, `모델이 옵션을 거부(400)하면 키 오류가 아니라 다음 모델로 (${tried.join(" → ")})`);

  env.GEMINI_MODEL = " gemini-3.8-flash ";
  tried.length = 0;
  globalThis.fetch = async (url) => { tried.push(String(url).match(/models\/([^:]+)/)[1]); return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "1" }] } }] }), { status: 200 }); };
  r = await call("/api/diag");
  ok(tried[0] === "gemini-3.8-flash", "GEMINI_MODEL로 모델 고정 가능");
  delete env.GEMINI_MODEL;

  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
  r = await call("/api/diag");
  ok(!r.gemini.ok && /한도/.test(r.gemini.error), "무료 한도 초과는 따로 안내");
  globalThis.fetch = realFetch2;
  env.gemini_api_key = keep;
}

/* 22. reset.sql — 실제 회원은 절대 건드리지 않음 (테스트 표시 계정만 정리) */
{
  const before = db.prepare(`SELECT COUNT(*) c FROM members WHERE IFNULL(memo, '') <> '__TEST__'`).get().c;
  const evs = db.prepare(`SELECT COUNT(*) c FROM events`).get().c;
  const sess = db.prepare(`SELECT COUNT(*) c FROM sessions`).get().c;
  db.exec(`INSERT INTO members (login_id, name, pw_hash, pw_salt, role, status, memo, created_at) VALUES ('zz_test', 'x', 'h', 's', 'member', 'approved', '__TEST__', 't')`);
  db.exec(readFileSync("./reset.sql", "utf8").replace(/\n/g, " "));
  ok(db.prepare(`SELECT COUNT(*) c FROM members`).get().c === before, `실제 회원 ${before}명 그대로`);
  ok(db.prepare(`SELECT COUNT(*) c FROM members WHERE memo = '__TEST__'`).get().c === 0, "테스트 표시 계정만 삭제");
  ok(db.prepare(`SELECT COUNT(*) c FROM events`).get().c === evs, "일정·기록 그대로");
  ok(db.prepare(`SELECT COUNT(*) c FROM sessions`).get().c === sess, "로그인 상태 그대로 (아무도 로그아웃 안 됨)");
}

console.log("\n모든 테스트 통과");
