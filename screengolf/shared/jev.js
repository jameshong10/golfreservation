// TypeSafe Jev 연동 — 글자로 된 판단만 맡긴다 (사진은 읽지 못함)
//  1) 결과표 닉네임 → 회원 찾기 (코드 매칭이 실패한 줄만)
//  2) 카톡 단체방 대화 → 사람별 참가 의사 읽기
// 키: Cloudflare 변수 TYPESAFE_API_KEY  /  모델: JEV_MODEL (기본 jev-latest)

const JEV_URL = "https://api.typesafe.ai/v1/systemone";

/** AI 추정을 그대로 받아들이는 최소 확률 (마스터가 저장 전에 한 번 더 확인함) */
export const JEV_MATCH_MIN = 0.6;
export const JEV_RSVP_MIN = 0.55;

export const jevReady = (env) => !!env.TYPESAFE_API_KEY;

export const norm = (s) => String(s == null ? "" : s).normalize("NFC").replace(/\s+/g, "").toLowerCase();

export async function jevAsk(env, state, questions) {
  const res = await fetch(JEV_URL, {
    method: "POST",
    headers: { authorization: "Bearer " + env.TYPESAFE_API_KEY, "content-type": "application/json" },
    body: JSON.stringify({ model: env.JEV_MODEL || "jev-latest", state, questions }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 403)
    throw new Error("Jev 키 오류 — Cloudflare의 TYPESAFE_API_KEY 값을 확인하세요.");
  if (res.status === 429) throw new Error("Jev 사용량 한도를 넘었습니다. 잠시 뒤 다시 시도하세요.");
  if (!res.ok) throw new Error("Jev 요청 실패: " + res.status);
  return data.answers || {};
}

/* ---------------- 회원 찾기 ---------------- */

/** 회원 한 명을 Choice 선택지 설명으로 */
function memberCriteria(members, aliases) {
  const byMember = {};
  for (const a of aliases || []) (byMember[a.member_id] = byMember[a.member_id] || []).push(a.alias);
  const criteria = {};
  for (const m of members) {
    criteria["m" + m.id] = {
      닉네임: m.nickname || null,
      이름: m.name,
      예전_닉네임: byMember[m.id] || [],
      골프존_아이디: m.gz_mask || null,
    };
  }
  criteria.none = "위 회원 중 누구와도 같은 사람이 아님 (비회원이거나 알 수 없음)";
  return criteria;
}

const matchQuestion = (path, criteria) => ({
  type: "choice",
  instructions: `\`${path}\` 는 스크린골프 동호회 회원 중 한 명을 가리키는 표시 이름입니다. 닉네임의 띄어쓰기·특수문자·물결표·숫자 차이, 실명, 예전 닉네임, 가려진 골프존 아이디(별표)를 모두 고려할 때 누구입니까? 확실한 근거가 없으면 none.`,
  criteria,
});

/**
 * items: [{ name, gz_mask? }] → 같은 순서로 [{ member_id, p } | null]
 * 코드로 못 찾은 이름만 넘겨야 한다.
 */
export async function jevMatchMembers(env, items, members, aliases) {
  if (!items.length || !members.length) return items.map(() => null);
  const criteria = memberCriteria(members, aliases);
  const questions = {};
  items.forEach((_, i) => (questions["q" + i] = matchQuestion(`names[${i}]`, criteria)));
  const answers = await jevAsk(
    env,
    { names: items.map((x) => ({ 표시_이름: x.name, 골프존_아이디: x.gz_mask || null })) },
    questions
  );
  return items.map((_, i) => {
    const a = answers["q" + i];
    if (!a || a.choice === "none" || !a.choice) return null;
    const p = (a.probabilities || {})[a.choice] || 0;
    if (p < JEV_MATCH_MIN) return null;
    return { member_id: Number(a.choice.slice(1)), p };
  });
}

/* ---------------- 카톡 대화 ---------------- */

// [홍길동] [오후 3:12] 메시지            (PC에서 복사)
const RE_PC = /^\[([^\]]+)\]\s*\[(?:오전|오후)\s*\d{1,2}:\d{2}\]\s*(.*)$/;
// 2026. 9. 24. 오후 3:12, 홍길동 : 메시지   /  2026년 9월 24일 오후 3:12, 홍길동 : 메시지   (대화 내보내기)
const RE_EXPORT = /^\d{4}[.년]\s*\d{1,2}[.월]\s*\d{1,2}[.일]?\s*(?:오전|오후)?\s*\d{1,2}:\d{2},\s*(.+?)\s*:\s(.*)$/;
// 홍길동 : 메시지
const RE_SIMPLE = /^([^:\[\]]{1,20}?)\s*:\s(.+)$/;
const RE_SKIP = /^-{3,}|^\d{4}년 \d{1,2}월 \d{1,2}일 [월화수목금토일]요일|^저장한 날짜|님과 카카오톡 대화|님이 (들어왔|나갔)습니다|^사진$|^이모티콘$/;

/** 카톡 대화 텍스트 → [{ speaker, text }] */
export function parseKakao(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || RE_SKIP.test(line)) continue;
    const m = line.match(RE_PC) || line.match(RE_EXPORT) || line.match(RE_SIMPLE);
    if (m) out.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (out.length) out[out.length - 1].text += "\n" + line; // 여러 줄 메시지
  }
  return out.filter((x) => x.text && x.text !== "사진" && x.text !== "이모티콘");
}

/** 코드로 먼저 회원 찾기: 닉네임·이름·예전 닉네임이 같거나, 카톡 이름 안에 하나만 들어 있으면 */
export function codeMatch(name, members, aliases) {
  const n = norm(name);
  if (!n) return null;
  const eq = members.filter((m) => norm(m.nickname) === n || norm(m.name) === n);
  if (eq.length === 1) return { member_id: eq[0].id, how: "이름" };
  const al = [...new Set((aliases || []).filter((a) => norm(a.alias) === n).map((a) => a.member_id))];
  if (al.length === 1) return { member_id: al[0], how: "예전 닉네임" };
  // "홍길동/42/분당" 처럼 이름 뒤에 덧붙인 경우
  const inc = members.filter((m) => [m.nickname, m.name].some((x) => norm(x).length >= 2 && n.includes(norm(x))));
  if (inc.length === 1) return { member_id: inc[0].id, how: "이름 포함" };
  return null;
}

const RSVP_CRITERIA = {
  yes: "이번 모임에 참가하겠다고 밝힘 (참석, 콜, 갑니다, ㅇㅋ 저도요 등)",
  hold: "아직 확실하지 않음 — 나중에 알려주겠다, 애매하다, 가능하면 간다",
  no: "이번 모임에 불참하겠다고 밝힘 (패스, 못 가요, 다음에요 등)",
  none: "이번 모임 참가 여부에 대한 말이 없음 (잡담, 다른 날 이야기, 남의 참가 이야기)",
};

/**
 * 카톡 대화에서 사람별 참가 의사를 읽는다.
 * 한 번의 요청으로 ① 사람마다 참가 의사 ② 코드로 못 찾은 사람의 회원 매칭을 함께 묻는다.
 */
export async function jevReadChat(env, ev, text, members, aliases) {
  const msgs = parseKakao(text);
  if (!msgs.length) return { people: [], parsed: 0 };

  const bySpeaker = new Map();
  for (const m of msgs) {
    if (!bySpeaker.has(m.speaker)) bySpeaker.set(m.speaker, []);
    bySpeaker.get(m.speaker).push(m.text.slice(0, 300));
  }
  const speakers = [...bySpeaker.entries()].slice(0, 60).map(([name, list]) => ({
    카톡_이름: name,
    메시지: list.slice(-8), // 마지막 8개 (최근 말이 우선)
  }));

  const criteria = memberCriteria(members, aliases);
  const code = speakers.map((s) => codeMatch(s.카톡_이름, members, aliases));
  const questions = {};
  speakers.forEach((s, i) => {
    questions["r" + i] = {
      type: "choice",
      instructions: `스크린골프 동호회 단체방에서 \`speakers[${i}]\` 가 보낸 메시지들입니다. \`event\` 모임에 대해 이 사람이 마지막으로 밝힌 본인의 참가 의사는? 마음을 바꿨다면 가장 최근 말을 따르세요.`,
      criteria: RSVP_CRITERIA,
    };
    if (!code[i]) questions["m" + i] = matchQuestion(`speakers[${i}].카톡_이름`, criteria);
  });

  const answers = await jevAsk(
    env,
    {
      event: { 날짜: ev.event_date, 시작: ev.start_time, 구장: ev.place || null, 모임: ev.title || null },
      speakers,
    },
    questions
  );

  const people = speakers.map((s, i) => {
    const r = answers["r" + i] || {};
    const status = r.choice || "none";
    let member_id = code[i] ? code[i].member_id : null;
    let match = code[i] ? code[i].how : null;
    let match_p = null;
    const m = answers["m" + i];
    if (!member_id && m && m.choice && m.choice !== "none") {
      const p = (m.probabilities || {})[m.choice] || 0;
      if (p >= JEV_MATCH_MIN) {
        member_id = Number(m.choice.slice(1));
        match = "AI 추정";
        match_p = p;
      }
    }
    const p = (r.probabilities || {})[status] || 0;
    return {
      speaker: s.카톡_이름,
      quote: s.메시지[s.메시지.length - 1],
      status,
      p,
      sure: status !== "none" && p >= JEV_RSVP_MIN,
      member_id,
      match,
      match_p,
    };
  });
  return { people, parsed: msgs.length };
}
