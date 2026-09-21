/* 스크린골프 동호회 예약 — 프론트엔드 */

const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const ROLE_LABEL = { master: "마스터", dev: "개발자", member: "정회원", guest: "게스트" };
/** 마스터 권한이 있는 등급 (개발자 포함) */
const isAdmin = (m) => !!m && (m.role === "master" || m.role === "dev");
const ST_LABEL = { yes: "참가", hold: "보류", no: "비참가", wait: "대기" };
const MAX_ROOMS = 6;

const S = {
  token: localStorage.getItem("sg_token") || "",
  me: null,
  tab: "schedule",
  view: "list",
  eventId: null,
  events: [],
  detail: null,
  members: [],
  notices: [],
  gate: "login",
  showNewEvent: false,
  showEditEvent: false,
  noticeForm: null, // null | "new" | 공지 id
  stats: null, // 기록 탭 데이터
  recView: "rank", // rank | h2h | events
  recPeriod: "all", // all | YYYY
  h2hMember: null,
  h2hBasis: "final", // final(최종성적) | stroke(스트로크)
  h2hOpen: null,
  review: null, // 결과 검토 중인 행들
  ocrBusy: false,
  backTo: null,
  selMode: false, // 계정 정리(선택 삭제) 모드
  sel: new Set(),
  aliasOpen: null, // 인식 정보를 펼친 회원 id
  aliases: [],
  testBusy: false,
};

/** 화면에 보일 이름: 닉네임이 있으면 닉네임 */
const nm = (m) => (m && (m.nickname || m.name)) || "?";
const won = (n) => Number(n || 0).toLocaleString("ko-KR") + "원";

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

/* ---------- API ---------- */

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    method: opts.method || "GET",
    headers: Object.assign(
      { "content-type": "application/json" },
      S.token ? { authorization: "Bearer " + S.token } : {}
    ),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && S.token) signOut(true);
    throw new Error(data.error || "요청을 처리하지 못했습니다.");
  }
  return data;
}

let toastTimer;
function toast(msg, bad) {
  clearTimeout(toastTimer);
  let el = document.querySelector(".toast");
  if (!el) {
    el = document.createElement("div");
    document.body.appendChild(el);
  }
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  toastTimer = setTimeout(() => el.remove(), 4200);
}

/* ---------- 날짜 도우미 ---------- */

function fmtDate(d) {
  const [y, m, day] = d.split("-").map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, day)).getUTCDay()];
  return `${m}월 ${day}일 (${dow})`;
}

function prevDayLabel(d) {
  const [y, m, day] = d.split("-").map(Number);
  const p = new Date(Date.UTC(y, m - 1, day - 1));
  return `${p.getUTCMonth() + 1}/${p.getUTCDate()}`;
}

function fmtWhen(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600000);
  return `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, "0")}.${String(d.getUTCDate()).padStart(2, "0")}`;
}

function untilText(ts) {
  const diff = ts - Date.now();
  if (diff <= 0) return null;
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}분 ${Math.floor((diff % 60000) / 1000)}초`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}시간 ${min % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

/* ---------- 단계 표시줄 ---------- */

function statusBarHTML(ev) {
  if (ev.assigned_at) return `<div class="countdown done">방 배정 완료 · ${ev.yes_count}명</div>`;

  if (ev.phase === "open") {
    const t = untilText(ev.deadline_ts);
    const urgent = ev.deadline_ts - Date.now() < 6 * 3600000;
    return `<div class="countdown${urgent ? " urgent" : ""}" data-cd="${ev.deadline_ts}"
      data-pre="신청 마감까지 " data-post=" 남음 · ${prevDayLabel(ev.event_date)} 23:59 마감"
      data-over="정식 신청이 마감됐습니다">신청 마감까지 ${t} 남음 · ${prevDayLabel(ev.event_date)} 23:59 마감</div>`;
  }

  if (ev.phase === "waitlist") {
    const t = untilText(ev.assign_ts);
    return `<div class="countdown urgent" data-cd="${ev.assign_ts}"
      data-pre="정식 신청 마감 · 방 배정까지 " data-post=" 남음"
      data-over="배정 시각이 지났습니다 — 곧 배정됩니다">정식 신청 마감 · 방 배정까지 ${t} 남음</div>`;
  }

  return `<div class="countdown urgent">${
    ev.yes_count ? "배정 시각이 지났습니다 — 곧 배정됩니다" : "배정 시각이 지났지만 확정 인원이 없습니다"
  }</div>`;
}

/* ---------- 렌더 ---------- */

function render() {
  const app = $("app");
  if (!S.me) {
    app.innerHTML = gateHTML();
    bindGate();
    return;
  }
  app.innerHTML = `
    <header class="topbar">
      <h1>⛳ 동호회 예약</h1>
      <div class="who">
        <span>${esc(nm(S.me))} · ${ROLE_LABEL[S.me.role]}</span>
        <button id="btnOut">로그아웃</button>
      </div>
    </header>
    <div class="shell">
      <nav class="tabs" role="tablist">
        <button role="tab" aria-selected="${S.tab === "schedule"}" data-tab="schedule">일정</button>
        <button role="tab" aria-selected="${S.tab === "records"}" data-tab="records">기록</button>
        <button role="tab" aria-selected="${S.tab === "notice"}" data-tab="notice">공지${noticeBadge()}</button>
        <button role="tab" aria-selected="${S.tab === "members"}" data-tab="members">회원${pendingBadge()}</button>
        <button role="tab" aria-selected="${S.tab === "my"}" data-tab="my">내 정보</button>
      </nav>
      <main id="body"></main>
    </div>`;
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      S.tab = b.dataset.tab;
      S.view = "list";
      if (S.tab === "notice") markNoticesSeen();
      render();
      loadTab();
    })
  );
  $("btnOut").addEventListener("click", () => signOut());
  renderBody();
}

function pendingBadge() {
  if (S.me.role !== "master") return "";
  const n = S.members.filter((m) => m.status === "pending").length;
  return n ? `<span class="badge">${n}</span>` : "";
}

function noticeBadge() {
  const seen = localStorage.getItem("sg_notice_seen") || "";
  const n = S.notices.filter((x) => (x.updated_at || x.created_at) > seen).length;
  return n ? `<span class="badge">${n}</span>` : "";
}

function markNoticesSeen() {
  localStorage.setItem("sg_notice_seen", new Date().toISOString());
}

function renderBody() {
  const body = $("body");
  if (!body) return;
  if (S.tab === "schedule") body.innerHTML = S.view === "event" ? eventHTML() : scheduleHTML();
  else if (S.tab === "records") body.innerHTML = recordsHTML();
  else if (S.tab === "notice") body.innerHTML = noticesHTML();
  else if (S.tab === "members") body.innerHTML = membersHTML();
  else body.innerHTML = myHTML();
  bindBody();
  tickCountdowns();
}

/* ---------- 로그인 / 가입 ---------- */

function gateHTML() {
  const reg = S.gate === "register";
  return `
  <div class="gate">
    <div class="mark">⛳ 스크린골프 동호회</div>
    <div class="sub">${reg ? "가입 신청 후 마스터가 승인하면 사용할 수 있습니다." : "동호회 계정으로 로그인하세요."}</div>
    <div class="card">
      <div class="field"><label for="gid">아이디</label><input id="gid" autocomplete="username"></div>
      ${reg ? `<div class="field"><label for="gname">이름</label><input id="gname" autocomplete="name"></div>
      <div class="field"><label for="gnick">닉네임</label><input id="gnick" maxlength="20" placeholder="골프존 닉네임과 똑같이">
        <div class="hint">대회 결과 사진에서 이 닉네임으로 기록을 찾습니다. 나중에 내 정보에서 바꿀 수 있습니다.</div></div>
      <div class="field"><label for="gphone">연락처</label><input id="gphone" inputmode="tel" placeholder="010-0000-0000"></div>` : ""}
      <div class="field"><label for="gpw">비밀번호</label><input id="gpw" type="password" autocomplete="${reg ? "new-password" : "current-password"}"></div>
      ${reg ? `<div class="field"><label for="gmemo">마스터에게 남길 말</label><input id="gmemo" placeholder="예: 김OO 소개"></div>` : ""}
      <button class="btn wide" id="gsubmit">${reg ? "가입 신청하기" : "로그인"}</button>
    </div>
    <div class="switch">
      ${reg ? '이미 계정이 있나요? <button id="gswitch">로그인</button>' : '처음이신가요? <button id="gswitch">가입 신청</button>'}
    </div>
  </div>`;
}

function bindGate() {
  $("gswitch").addEventListener("click", () => {
    S.gate = S.gate === "login" ? "register" : "login";
    render();
  });
  const go = async () => {
    const btn = $("gsubmit");
    btn.disabled = true;
    try {
      if (S.gate === "register") {
        const r = await api("/register", {
          method: "POST",
          body: {
            login_id: $("gid").value.trim(),
            name: $("gname").value.trim(),
            nickname: $("gnick").value.trim(),
            phone: $("gphone").value.trim(),
            password: $("gpw").value,
            memo: $("gmemo").value.trim(),
          },
        });
        toast(r.message);
        S.gate = "login";
        render();
      } else {
        const r = await api("/login", {
          method: "POST",
          body: { login_id: $("gid").value.trim(), password: $("gpw").value },
        });
        S.token = r.token;
        S.me = r.me;
        localStorage.setItem("sg_token", r.token);
        render();
        loadAll();
      }
    } catch (e) {
      toast(e.message, true);
    } finally {
      const b = $("gsubmit");
      if (b) b.disabled = false;
    }
  };
  $("gsubmit").addEventListener("click", go);
  ["gid", "gpw"].forEach((id) =>
    $(id).addEventListener("keydown", (e) => {
      if (e.key === "Enter") go();
    })
  );
}

/* ---------- 참가 의사 버튼 ---------- */

function rsvpHTML(ev, wide) {
  const my = ev.my_status;
  const sz = wide ? "" : " sm";

  if (ev.assigned_at || ev.phase === "locked") {
    return `<div class="rsvp-state">${
      my === "yes" ? "참가 확정" : my === "wait" ? "대기 중" : "이번엔 불참"
    }</div>`;
  }

  if (ev.phase === "waitlist") {
    if (my === "yes")
      return `<div class="btn-row">
        <div class="rsvp-state ok">참가 확정</div>
        <button class="btn${sz} danger" data-rsvp="no" data-ev="${ev.id}">참가 취소</button>
      </div>`;
    if (my === "wait")
      return `<div class="btn-row">
        <div class="rsvp-state wait">대기 중 · 방이 확보되면 확정됩니다</div>
        <button class="btn${sz} ghost" data-rsvp="no" data-ev="${ev.id}">대기 취소</button>
      </div>`;
    return `<div class="btn-row">
      <button class="btn${wide ? " wide" : sz}" data-rsvp="yes" data-ev="${ev.id}">대기 신청</button>
    </div>`;
  }

  // 정식 신청 기간
  return `
  <div class="rsvp">
    ${["yes", "hold", "no"]
      .map(
        (s) =>
          `<button class="${my === s ? "on " + s : ""}" data-rsvp="${s}" data-ev="${ev.id}">${ST_LABEL[s]}</button>`
      )
      .join("")}
  </div>
  ${
    my === "hold"
      ? `<div class="hint warn">보류는 ${prevDayLabel(ev.event_date)} 밤 11시 59분까지만 유효합니다. 그때까지 참가로 바꾸지 않으면 자동으로 빠지고, 이후에는 대기 신청만 가능합니다.</div>`
      : my === "wait"
      ? `<div class="hint warn">정원이 차서 대기로 접수됐습니다. 자리가 나면 마스터가 확정해 드립니다.</div>`
      : !my
      ? `<div class="hint">참가 · 보류 · 비참가 중 하나를 눌러주세요.</div>`
      : ""
  }`;
}

/* ---------- 일정 목록 ---------- */

function scheduleHTML() {
  const master = isAdmin(S.me);
  const pinned = S.notices.filter((n) => n.pinned).slice(0, 2);
  let html = "";

  if (!S.me.nickname) {
    html += `<div class="banner warn" data-gomy="1">
      <span class="pin">필수</span><span class="t">닉네임을 골프존 닉네임과 똑같이 설정해 주세요 → 내 정보</span>
    </div>`;
  }

  if (pinned.length) {
    html += pinned
      .map(
        (n) => `<div class="banner" data-gonotice="1">
          <span class="pin">공지</span><span class="t">${esc(n.title)}</span>
        </div>`
      )
      .join("");
  }

  if (master) {
    html += S.showNewEvent
      ? eventFormHTML(null)
      : `<button class="btn wide ghost" id="openNew" style="margin-bottom:14px">+ 새 일정 만들기</button>`;
  }

  if (!S.events.length) {
    html += `<div class="empty">예정된 일정이 없습니다.${
      master ? "<br>위에서 새 일정을 만들어 보세요." : "<br>마스터가 일정을 올리면 여기에 표시됩니다."
    }</div>`;
    return html;
  }

  const [next, ...rest] = S.events;
  html += eventCardHTML(next, true);
  if (rest.length) {
    html += `<h2 style="font-size:14px;color:var(--muted);margin:22px 0 10px">다음 일정 ${rest.length}건</h2>`;
    html += rest.map((e) => eventCardHTML(e, false)).join("");
  }
  return html;
}

function countsLine(ev) {
  const bits = [`참가 ${ev.yes_count}`];
  if (ev.hold_count) bits.push(`보류 ${ev.hold_count}`);
  if (ev.wait_count) bits.push(`대기 ${ev.wait_count}`);
  if (ev.no_count) bits.push(`불참 ${ev.no_count}`);
  return `${bits.join(" · ")} · 방 ${ev.rooms_count}개(최대 ${ev.capacity}명) · 예상 ${roomPlan(ev.yes_count)}`;
}

function eventCardHTML(ev, isNext) {
  return `
  <article class="card${isNext ? " next" : ""}" data-open="${ev.id}" style="cursor:pointer">
    <div class="when">
      <span class="time">${esc(ev.start_time)}</span>
      <span class="date">${fmtDate(ev.event_date)}</span>
    </div>
    ${ev.place || ev.title ? `<div class="meta">${esc([ev.place, ev.title].filter(Boolean).join(" · "))}</div>` : ""}
    <div class="meta">${countsLine(ev)}</div>
    ${isNext ? statusBarHTML(ev) : ""}
    <div class="rsvp-wrap">${rsvpHTML(ev, isNext)}</div>
  </article>`;
}

function roomPlan(n) {
  if (!n) return "방 없음";
  const rooms = Math.min(Math.ceil(n / 4), MAX_ROOMS);
  const base = Math.floor(n / rooms);
  const rem = n % rooms;
  return Array.from({ length: rooms }, (_, i) => base + (i < rem ? 1 : 0)).join("+") + "명";
}

/** ev가 null이면 새 일정 만들기, 있으면 수정 */
function eventFormHTML(ev) {
  const edit = !!ev;
  const d = edit ? ev.event_date : new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const rc = edit ? ev.rooms_count : MAX_ROOMS;
  return `
  <section class="card">
    <h2>${edit ? "일정 수정" : "새 일정 만들기"}</h2>
    <div class="row2">
      <div class="field"><label for="nDate">날짜</label><input id="nDate" type="date" value="${d}"></div>
      <div class="field"><label for="nTime">시작 시각</label><input id="nTime" type="time" step="600" value="${edit ? esc(ev.start_time) : "19:00"}"></div>
    </div>
    <div class="row2">
      <div class="field"><label for="nPlace">구장</label><input id="nPlace" placeholder="OO스크린골프" value="${edit ? esc(ev.place || "") : ""}"></div>
      <div class="field"><label for="nTitle">모임 이름</label><input id="nTitle" placeholder="정기 라운드 / 월례회" value="${edit ? esc(ev.title || "") : ""}"></div>
    </div>
    <div class="field">
      <label for="nFee">1인 참가비</label>
      <input id="nFee" inputmode="numeric" value="${edit ? ev.entry_fee : 4000}">
      <div class="hint">참가비 총액을 방배정 때 1등부터 차등(랜덤)으로 시상 금액에 배정합니다. 참가자 절반까지 시상.</div>
    </div>
    <div class="field">
      <label for="nRooms">쓸 수 있는 방</label>
      <select id="nRooms">${Array.from({ length: MAX_ROOMS }, (_, i) => i + 1)
        .map((n) => `<option value="${n}" ${rc === n ? "selected" : ""}>${n}개 (최대 ${n * 4}명)</option>`)
        .join("")}</select>
      <div class="hint">구장에 1~6번 방이 있습니다. 당일 방을 더 받으면 여기서 늘리고 대기자를 확정하면 됩니다.</div>
    </div>
    ${
      edit
        ? ""
        : `<div class="field">
            <label><input type="checkbox" id="nRepeat" style="width:auto;margin-right:6px">여러 날 한 번에 만들기</label>
          </div>
          <div id="repeatBox" style="display:none">
            <div class="field"><label for="nEnd">종료일</label><input id="nEnd" type="date"></div>
            <div class="field">
              <label>요일</label>
              <div class="dow-pick">
                ${DOW.map((x, i) => `<label><input type="checkbox" class="dowChk" value="${i}"><span>${x}</span></label>`).join("")}
              </div>
            </div>
          </div>`
    }
    <div class="field">
      <label><input type="checkbox" id="nSpread" ${!edit || ev.spread_guests ? "checked" : ""} style="width:auto;margin-right:6px">게스트를 방마다 고르게 나누기</label>
    </div>
    ${edit ? `<div class="hint" style="margin-bottom:12px">시각을 바꾸면 이미 배정된 방은 지워지고 새 시각 20분 전에 다시 배정됩니다.</div>` : ""}
    <div class="btn-row">
      <button class="btn" id="${edit ? "updateEvent" : "saveEvent"}">${edit ? "저장" : "만들기"}</button>
      <button class="btn ghost" id="cancelForm">닫기</button>
    </div>
  </section>`;
}

/* ---------- 일정 상세 ---------- */

function groupChips(ev, status, master) {
  const list = ev.responses.filter((r) => r.status === status);
  if (!list.length) return "";
  return `<div class="grp">
    <div class="grp-h">${ST_LABEL[status]} ${list.length}${
    status === "yes" ? ` / ${ev.capacity}` : ""
  }</div>
    <div class="chips">${list
      .map(
        (m) => `<span class="chip ${m.role === "guest" ? "guest" : ""} st-${status}">${esc(nm(m))}${
          master
            ? status === "wait"
              ? `<button data-set="yes" data-mid="${m.id}" title="참가 확정">확정</button>`
              : status === "yes"
              ? `<button data-set="no" data-mid="${m.id}" title="제외">×</button>`
              : `<button data-set="yes" data-mid="${m.id}" title="참가로 올리기">＋</button>`
            : ""
        }</span>`
      )
      .join("")}</div>
  </div>`;
}

function noReplyHTML(ev, master) {
  const answered = new Set(ev.responses.map((r) => r.id));
  const rest = S.members.filter((m) => m.status === "approved" && !answered.has(m.id));
  if (!rest.length) return "";
  return `<div class="grp">
    <div class="grp-h muted">미응답 ${rest.length}</div>
    <div class="chips">${rest
      .map(
        (m) => `<span class="chip st-none">${esc(nm(m))}${
          master ? `<button data-set="yes" data-mid="${m.id}" title="참가로 등록">＋</button>` : ""
        }</span>`
      )
      .join("")}</div>
  </div>`;
}

function eventHTML() {
  const ev = S.detail;
  if (!ev) return `<div class="empty">불러오는 중…</div>`;
  const master = isAdmin(S.me);
  const assigned = !!ev.assigned_at;

  const roomsHTML = assigned
    ? ev.rooms.length
      ? ev.rooms
          .map(
            (r) => `
        <div class="room reveal">
          <div class="room-head"><span class="no">${r.room_no}번 방</span><span class="cnt">${r.members.length}명</span></div>
          <ol>
            ${r.members
              .map(
                (m, i) => `<li class="${m.id === S.me.id ? "self" : ""}">
                  <span class="seat">${i + 1}</span>${esc(nm(m))}
                  ${m.role === "guest" ? '<span class="tag">게스트</span>' : ""}
                </li>`
              )
              .join("")}
          </ol>
        </div>`
          )
          .join("")
      : `<div class="empty">확정 인원이 없어 배정된 방이 없습니다.</div>`
    : `<div class="empty">시작 20분 전에 확정 인원으로 방이 자동 배정됩니다.<br>1~6번 방 중 ${ev.rooms_count}개를 씁니다.</div>`;

  return `
  <button class="btn ghost sm" id="backList" style="margin-bottom:14px">← ${S.backTo === "records" ? "기록으로" : "목록으로"}</button>
  ${
    master && S.showEditEvent
      ? eventFormHTML(ev)
      : `<article class="card next">
          <div class="when">
            <span class="time">${esc(ev.start_time)}</span>
            <span class="date">${fmtDate(ev.event_date)}</span>
          </div>
          ${ev.place || ev.title ? `<div class="meta">${esc([ev.place, ev.title].filter(Boolean).join(" · "))}</div>` : ""}
          <div class="meta">${countsLine(ev)}</div>
          ${statusBarHTML(ev)}
          ${
            ev.my_dropped && ev.phase !== "open"
              ? `<div class="hint warn">보류 상태로 마감을 넘겨 자동으로 빠졌습니다. 참가하시려면 대기 신청을 눌러주세요.</div>`
              : ""
          }
          <div class="rsvp-wrap">${rsvpHTML(ev, true)}</div>
        </article>`
  }

  <section class="card">
    <h2>참가 현황</h2>
    ${groupChips(ev, "yes", master)}
    ${groupChips(ev, "wait", master)}
    ${groupChips(ev, "hold", master)}
    ${groupChips(ev, "no", master)}
    ${master ? noReplyHTML(ev, master) : ""}
    ${!ev.responses.length ? `<div class="empty" style="padding:16px">아직 응답한 사람이 없습니다.</div>` : ""}
    ${
      master
        ? `<div class="btn-row"><button class="btn sm ghost" id="shareBtn">단체방 공지문 복사</button></div>`
        : ""
    }
  </section>

  <section>
    <h2 style="font-size:15px;margin:22px 0 10px">방 배정</h2>
    ${roomsHTML}
    ${
      master
        ? `<div class="btn-row">
            <button class="btn sm" id="doAssign">${assigned ? "다시 섞어서 배정" : "지금 배정하기"}</button>
            ${assigned ? `<button class="btn sm ghost" id="doUnassign">배정 취소</button>` : ""}
          </div>`
        : ""
    }
  </section>

  ${prizeHTML(ev, master)}
  ${resultsHTML(ev, master)}

  ${
    master
      ? `<section class="card" style="margin-top:22px">
          <h2>일정 관리</h2>
          <div class="field" style="margin-top:10px">
            <label for="qRooms">구장에서 확보한 방</label>
            <select id="qRooms">${Array.from({ length: MAX_ROOMS }, (_, i) => i + 1)
              .map((n) => `<option value="${n}" ${ev.rooms_count === n ? "selected" : ""}>${n}개 (최대 ${n * 4}명)</option>`)
              .join("")}</select>
            <div class="hint">방을 더 받으면 늘린 다음 대기자 이름 옆 &ldquo;확정&rdquo;을 누르세요.</div>
          </div>
          <div class="btn-row" style="margin-top:0">
            <button class="btn sm ghost" id="editEvent">일정·참가비 수정</button>
            <button class="btn sm ghost" id="toggleClose">${ev.closed ? "신청 다시 열기" : "신청 즉시 마감"}</button>
            <button class="btn sm danger" id="delEvent">일정 삭제</button>
          </div>
        </section>`
      : ""
  }`;
}

function assignText(ev) {
  const lines = [`⛳ ${fmtDate(ev.event_date)} ${ev.start_time} 방배정`, [ev.place, ev.title].filter(Boolean).join(" · "), ""];
  for (const r of ev.rooms) lines.push(`${r.room_no}번 방: ${r.members.map(nm).join(", ")}`);
  if (ev.prize && ev.prize.amounts && ev.prize.amounts.length) {
    lines.push("", `🏆 시상 (참가비 ${won(ev.prize.fee)} × ${ev.prize.n}명 = ${won(ev.prize.fee * ev.prize.n)})`);
    ev.prize.amounts.forEach((a, i) => lines.push(`${i + 1}등 ${won(a)}`));
    lines.push(`※ 공동 순위는 해당 순위 상금을 합쳐 나눕니다.`);
  }
  return lines.filter((x) => x !== undefined).join("\n");
}

function resultText(ev) {
  const lines = [`🏌️ ${fmtDate(ev.event_date)} ${[ev.place, ev.title].filter(Boolean).join(" · ")} 결과`, ""];
  for (const r of ev.results)
    lines.push(`${r.rank_label}위 ${r.nickname || r.raw_nick} ${r.final} (${r.stroke}/${r.handicap >= 0 ? "+" : ""}${r.handicap})${r.prize ? " · " + won(r.prize) : ""}`);
  return lines.join("\n");
}

/* ---------- 시상 ---------- */

function prizeHTML(ev, master) {
  const p = ev.prize;
  if (!p || !p.amounts) {
    return ev.assigned_at || !master
      ? ""
      : `<section class="card" style="margin-top:22px"><h2>시상</h2>
          <div class="hint">방이 배정될 때 참가비(${won(ev.entry_fee)}) 총액으로 시상 금액이 함께 랜덤 배정됩니다.
          참가 인원의 절반(내림)까지 시상합니다.</div></section>`;
  }
  const played = ev.results.length;
  const mismatch = played && played !== p.n;
  return `<section class="card prize" style="margin-top:22px">
    <h2>🏆 시상</h2>
    <div class="meta">참가비 ${won(p.fee)} × ${p.n}명 = <b>${won(p.fee * p.n)}</b> · ${p.amounts.length}명 시상</div>
    <ol class="prize-list">${p.amounts
      .map((a, i) => `<li><span class="pl">${i + 1}등</span><span class="pa">${won(a)}</span></li>`)
      .join("")}</ol>
    <div class="hint">공동 순위는 해당 순위들의 상금을 합쳐 똑같이 나눕니다.</div>
    ${mismatch ? `<div class="hint warn">결과 인원(${played}명)이 시상 기준 인원(${p.n}명)과 다릅니다.</div>` : ""}
    ${
      master
        ? `<div class="btn-row">
            ${ev.assigned_at ? `<button class="btn sm ghost" id="copyAssign">방배정·시상 공지 복사</button>` : ""}
            <button class="btn sm ghost" id="redrawPrize" data-n="${mismatch ? played : p.n}">시상 다시 뽑기</button>
          </div>`
        : ""
    }
  </section>`;
}

/* ---------- 대회 결과 ---------- */

function resultsTable(rows) {
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>순위</th><th class="l">닉네임</th><th>타수</th><th>보정</th><th>최종</th><th>상금</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr class="${r.member_id === S.me.id ? "self" : ""}">
        <td><b class="${r.rank_no <= 3 ? "top" : ""}">${esc(r.rank_label)}</b></td>
        <td class="l">${esc(r.nickname || r.raw_nick || "?")}${r.member_id ? "" : ' <span class="tag">비회원</span>'}</td>
        <td>${r.stroke}</td><td>${r.handicap > 0 ? "+" + r.handicap : r.handicap}</td>
        <td><b>${r.final}</b></td><td>${r.prize ? won(r.prize) : ""}</td>
      </tr>`
      )
      .join("")}</tbody></table></div>`;
}

function resultsHTML(ev, master) {
  const started = Date.now() >= ev.start_ts;
  if (S.review && master) return reviewHTML();
  let html = `<section class="card" style="margin-top:22px"><h2>대회 결과</h2>`;
  if (ev.results.length) {
    html += resultsTable(ev.results);
    if (master)
      html += `<div class="btn-row">
        <button class="btn sm ghost" id="copyResult">결과 공지 복사</button>
        <button class="btn sm ghost" id="editResults">결과 수정</button>
        <button class="btn sm danger" id="delResults">결과 삭제</button>
      </div>`;
  } else if (master) {
    html += `<div class="hint">${started ? "" : "대회가 끝난 뒤 "}골프존 대회 결과 화면(스트로크 탭)을 캡처해 올리면 닉네임으로 자동 기록됩니다. 여러 장이면 한 번에 고르세요.</div>
      <input type="file" id="ocrFiles" accept="image/*" multiple style="display:none">
      <div class="btn-row">
        <button class="btn sm" id="pickPhotos" ${S.ocrBusy ? "disabled" : ""}>${S.ocrBusy ? "인식 중… (10~30초)" : "결과 사진 올리기"}</button>
        <button class="btn sm ghost" id="manualResults">직접 입력</button>
      </div>`;
  } else {
    html += `<div class="empty" style="padding:14px">아직 결과가 올라오지 않았습니다.</div>`;
  }
  return html + `</section>`;
}

function memberOptions(sel) {
  const list = [...S.members.filter((m) => m.status === "approved")].sort((a, b) => nm(a).localeCompare(nm(b), "ko"));
  return `<option value="">— 비회원 / 연결 안 함 —</option>` +
    list.map((m) => `<option value="${m.id}" ${Number(sel) === m.id ? "selected" : ""}>${esc(nm(m))}${m.nickname && m.nickname !== m.name ? " (" + esc(m.name) + ")" : ""}</option>`).join("");
}

function reviewHTML() {
  const R = S.review;
  const unmatched = R.rows.filter((r) => !r.member_id).length;
  return `<section class="card review" style="margin-top:22px">
    <h2>결과 확인 후 저장</h2>
    ${R.title || R.date ? `<div class="meta">사진 속 대회: ${esc([R.title, R.date].filter(Boolean).join(" · "))}</div>` : ""}
    <div class="hint">인식된 값을 확인하세요. 회원 연결이 안 된 줄은 직접 골라주세요.${unmatched ? ` <b style="color:var(--flag)">미연결 ${unmatched}명</b>` : ""}</div>
    ${R.rows
      .map(
        (r, i) => `<div class="rv-row ${r.member_id ? "" : "unmatched"}">
        <div class="rv-top">
          <input class="rv-rank" data-i="${i}" data-k="rank_label" value="${esc(r.rank_label || "")}" placeholder="순위">
          <div class="rv-nick"><b>${esc(r.raw_nick || "")}</b>${r.gz_mask ? ` <span class="sub">${esc(r.gz_mask)}</span>` : ""}
            ${r.match ? `<span class="tag ok">${esc(r.match)} 일치</span>` : r.member_id ? "" : '<span class="tag">연결 필요</span>'}</div>
          <button class="rv-del" data-rvdel="${i}" title="이 줄 삭제">×</button>
        </div>
        <select data-i="${i}" data-k="member_id">${memberOptions(r.member_id)}</select>
        <div class="rv-nums">
          <label>타수<input inputmode="numeric" data-i="${i}" data-k="stroke" value="${r.stroke ?? ""}"></label>
          <label>보정<input inputmode="numeric" data-i="${i}" data-k="handicap" value="${r.handicap ?? 0}"></label>
          <label>최종<input inputmode="numeric" data-i="${i}" data-k="final" value="${r.final ?? ""}"></label>
        </div>
      </div>`
      )
      .join("")}
    <button class="btn sm ghost" id="rvAdd" style="margin-top:8px">+ 한 줄 추가</button>
    <div class="hint">순위를 비워두면 최종성적으로 계산합니다(같은 점수는 공동 순위).</div>
    <div class="btn-row">
      <button class="btn" id="rvSave">저장</button>
      <button class="btn ghost" id="rvCancel">취소</button>
    </div>
  </section>`;
}

/* 사진을 줄여서 base64로 (긴 변 1568px) */
function shrinkImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve({ media_type: "image/jpeg", data: c.toDataURL("image/jpeg", 0.88).split(",")[1] });
    };
    img.onerror = () => reject(new Error("사진을 열 수 없습니다."));
    img.src = url;
  });
}

function shareText(ev) {
  const lines = [
    `⛳ ${fmtDate(ev.event_date)} ${ev.start_time}`,
    [ev.place, ev.title].filter(Boolean).join(" · "),
    `방 ${ev.rooms_count}개 (최대 ${ev.capacity}명)`,
    ``,
    `참가 / 보류 / 비참가 선택 👉 ${location.origin}`,
    `정식 마감: ${prevDayLabel(ev.event_date)} 23:59 (보류는 이때까지만 유효)`,
    `마감 후에는 대기 신청만 가능하고, 방이 확보되는 대로 확정합니다.`,
    ``,
    `현재 참가 ${ev.yes_count} · 보류 ${ev.hold_count} · 대기 ${ev.wait_count}`,
  ];
  return lines.filter((x) => x !== undefined).join("\n");
}

/* ---------- 공지 ---------- */

function noticesHTML() {
  const master = isAdmin(S.me);
  let html = "";

  if (master) {
    html +=
      S.noticeForm === "new"
        ? noticeFormHTML(null)
        : `<button class="btn wide ghost" id="openNotice" style="margin-bottom:14px">+ 공지 쓰기</button>`;
  }

  if (!S.notices.length) {
    html += `<div class="empty">아직 공지가 없습니다.${master ? "" : "<br>마스터가 공지를 올리면 여기에 표시됩니다."}</div>`;
    return html;
  }

  html += S.notices
    .map((n) =>
      S.noticeForm === n.id
        ? noticeFormHTML(n)
        : `<article class="card notice${n.pinned ? " pinned" : ""}">
            <div class="n-head">
              ${n.pinned ? '<span class="pin">고정</span>' : ""}
              <h2 style="margin:0">${esc(n.title)}</h2>
            </div>
            <div class="meta">${esc(n.author_name || "마스터")} · ${fmtWhen(n.created_at)}${n.updated_at ? " (수정됨)" : ""}</div>
            ${n.body ? `<div class="n-body">${esc(n.body)}</div>` : ""}
            ${
              master
                ? `<div class="btn-row">
                    <button class="btn sm ghost" data-nedit="${n.id}">수정</button>
                    <button class="btn sm ghost" data-npin="${n.id}" data-pinned="${n.pinned ? 1 : 0}">${
                      n.pinned ? "고정 해제" : "맨 위 고정"
                    }</button>
                    <button class="btn sm danger" data-ndel="${n.id}">삭제</button>
                  </div>`
                : ""
            }
          </article>`
    )
    .join("");
  return html;
}

function noticeFormHTML(n) {
  const edit = !!n;
  return `
  <section class="card">
    <h2>${edit ? "공지 수정" : "공지 쓰기"}</h2>
    <div class="field"><label for="ntTitle">제목</label><input id="ntTitle" value="${edit ? esc(n.title) : ""}" placeholder="예: 10월 월례회 안내"></div>
    <div class="field">
      <label for="ntBody">내용</label>
      <textarea id="ntBody" rows="6" placeholder="일시, 구장, 회비 등을 적어주세요.">${edit ? esc(n.body || "") : ""}</textarea>
    </div>
    <div class="field">
      <label><input type="checkbox" id="ntPin" ${edit && n.pinned ? "checked" : ""} style="width:auto;margin-right:6px">맨 위에 고정하기</label>
      <div class="hint">고정한 공지는 일정 화면 위에도 함께 보입니다.</div>
    </div>
    <div class="btn-row">
      <button class="btn" id="ntSave" data-id="${edit ? n.id : ""}">${edit ? "저장" : "올리기"}</button>
      <button class="btn ghost" id="ntCancel">닫기</button>
    </div>
  </section>`;
}

/* ---------- 회원 ---------- */

function membersHTML() {
  const master = isAdmin(S.me);
  const pending = S.members.filter((m) => m.status === "pending");
  const ROLE_ORDER = { master: 0, dev: 1, member: 2, guest: 3 };
  const active = S.members
    .filter((m) => m.status === "approved")
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || nm(a).localeCompare(nm(b), "ko", { numeric: true }));
  const blocked = S.members.filter((m) => m.status === "rejected");

  let html = "";
  if (master && pending.length) {
    html += `<section class="card" style="border-color:var(--flag)">
      <h2>승인 대기 ${pending.length}명</h2>
      <div class="mlist">${pending
        .map(
          (m) => `<div class="mrow">
            <div>
              <div class="nm">${esc(nm(m))}${m.nickname ? ` <span class="sub">${esc(m.name)}</span>` : ""}</div>
              <div class="sub">${esc(m.login_id)}${m.phone ? " · " + esc(m.phone) : ""}${m.memo ? " · " + esc(m.memo) : ""}</div>
            </div>
            <div class="acts">
              <button class="btn sm" data-approve="${m.id}" data-role="member">정회원 승인</button>
              <button class="btn sm ghost" data-approve="${m.id}" data-role="guest">게스트 승인</button>
              <button class="btn sm danger" data-reject="${m.id}">거절</button>
            </div>
          </div>`
        )
        .join("")}</div>
    </section>`;
  }

  if (master) {
    const idle = active.filter((m) => m.activity === 0 && m.id !== S.me.id && !isAdmin(m));
    html += `<section class="card tools">
      <h2>계정 정리</h2>
      ${
        S.selMode
          ? `<div class="hint">삭제할 계정을 체크하세요. 마스터·개발자 계정은 지울 수 없습니다. 지난 대회 결과는 '비회원'으로 남습니다.</div>
            <div class="btn-row">
              <button class="btn sm ghost" id="selAll">마스터·개발자 빼고 전체 선택</button>
              <button class="btn sm ghost" id="selIdle">활동 없는 계정 선택 (${idle.length})</button>
              <button class="btn sm ghost" id="selTest">테스트 계정 선택</button>
              <button class="btn sm danger" id="selDelete" ${S.sel.size ? "" : "disabled"}>선택 삭제 (${S.sel.size})</button>
              <button class="btn sm ghost" id="selCancel">닫기</button>
            </div>`
          : `<div class="hint">가입만 하고 쓰지 않는 계정을 한 번에 지울 수 있습니다. 활동 없는 계정 ${idle.length}명.</div>
            <div class="btn-row"><button class="btn sm ghost" id="selStart">정리 시작</button></div>`
      }
    </section>`;
  }

  html += `<section class="card">
    <h2>회원 ${active.length}명</h2>
    <div class="mlist">${
      active.length
        ? active.map((m) => memberRowHTML(m, master)).join("")
        : `<div class="empty">아직 승인된 회원이 없습니다.</div>`
    }</div>
  </section>`;

  if (master && blocked.length) {
    html += `<section class="card">
      <h2>정지된 계정 ${blocked.length}명</h2>
      <div class="mlist">${blocked
        .map(
          (m) => `<div class="mrow">
            <div><div class="nm">${esc(m.name)}</div><div class="sub">${esc(m.login_id)}</div></div>
            <div class="acts">
              <button class="btn sm ghost" data-approve="${m.id}" data-role="guest">다시 승인</button>
              <button class="btn sm danger" data-del="${m.id}">삭제</button>
            </div>
          </div>`
        )
        .join("")}</div>
    </section>`;
  }
  if (S.me.role === "dev") html += testToolsHTML();
  return html;
}

function memberRowHTML(m, master) {
  const canDel = master && m.id !== S.me.id && !isAdmin(m);
  const tags = `${m.is_test ? '<span class="tag ok">테스트</span>' : ""}${
    master && m.activity === 0 ? ' <span class="tag">활동 없음</span>' : ""
  }`;
  return `<div class="mrow ${S.selMode && S.sel.has(m.id) ? "picked" : ""}">
    ${
      master && S.selMode
        ? `<input type="checkbox" class="selChk" data-sel="${m.id}" ${S.sel.has(m.id) ? "checked" : ""} ${canDel ? "" : "disabled"}>`
        : ""
    }
    <div style="min-width:0">
      <div class="nm">${esc(nm(m))} <span class="role-pill ${m.role}">${ROLE_LABEL[m.role]}</span> ${tags}</div>
      ${
        master
          ? `<div class="sub">${esc(m.name)} · ${esc(m.login_id)}${m.phone ? " · " + esc(m.phone) : ""}${
              m.gz_mask ? " · 골프존 " + esc(m.gz_mask) : ""
            }${m.nickname ? "" : ' · <span style="color:var(--flag)">닉네임 없음</span>'}</div>`
          : ""
      }
    </div>
    ${
      master && !S.selMode
        ? `<div class="acts">
            <select data-role-of="${m.id}" style="padding:5px 8px;border:1px solid var(--line);border-radius:7px">
              ${["master", "dev", "member", "guest"]
                .map((r) => `<option value="${r}" ${m.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`)
                .join("")}
            </select>
            <button class="btn sm ghost" data-nick="${m.id}" data-cur="${esc(m.nickname || "")}">닉네임</button>
            <button class="btn sm ghost" data-alias="${m.id}">인식</button>
            ${m.id !== S.me.id ? `<button class="btn sm danger" data-block="${m.id}">정지</button>` : ""}
            ${canDel ? `<button class="btn sm danger" data-del="${m.id}">삭제</button>` : ""}
          </div>`
        : ""
    }
  </div>
  ${master && S.aliasOpen === m.id && !S.selMode ? aliasPanelHTML(m) : ""}`;
}

function aliasPanelHTML(m) {
  return `<div class="alias-panel">
    <div class="field" style="margin:0 0 10px">
      <label>골프존 결과표 아이디 (별표 포함 그대로, 예: giveufi**)</label>
      <div class="btn-row" style="margin:4px 0 0;flex-wrap:nowrap">
        <input id="gzEdit" value="${esc(m.gz_mask || "")}" placeholder="비워두면 사용 안 함">
        <button class="btn sm" id="gzSave" data-id="${m.id}">저장</button>
      </div>
    </div>
    <label class="sub">이 회원으로 인식하는 이름 (예전 닉네임 · 결과표에 찍힌 닉네임)</label>
    <div class="chips">${
      S.aliases.length
        ? S.aliases
            .map((a) => `<span class="chip">${esc(a.alias)}<button data-aldel="${a.id}" data-mid="${m.id}" title="삭제">×</button></span>`)
            .join("")
        : '<span class="sub">없음</span>'
    }</div>
    <div class="hint">사진 인식에서 다른 사람으로 잘못 연결됐다면: ① 결과 화면 → 결과 수정에서 올바른 회원으로 바꿔 저장하면 여기 정보도 자동으로 옮겨집니다.
    ② 잘못 붙은 이름·골프존 아이디는 여기서 직접 지우거나 고칠 수 있습니다.</div>
  </div>`;
}

function testToolsHTML() {
  const n = S.members.filter((m) => m.is_test).length;
  return `<section class="card tools">
    <h2>🧪 테스트 도구</h2>
    <div class="hint">테스트1~테스트20 계정(아이디 test1~test20, 비밀번호 1234)과 지난 대회 기록(랜덤 스코어·상금)을 만듭니다.
    30분 뒤 시작하는 '방배정 테스트' 일정도 함께 만들어져, 20분 전에 자동 배정·시상 추첨되는 것을 확인할 수 있습니다.
    실제 회원·대회에는 영향이 없고, 아래 버튼 하나로 전부 지울 수 있습니다.</div>
    <div class="meta">현재 테스트 계정 ${n}명</div>
    <div class="btn-row">
      <button class="btn sm" id="testMake" ${S.testBusy ? "disabled" : ""}>${S.testBusy ? "만드는 중…" : n ? "지난 대회 8회 더 만들기" : "테스트 데이터 만들기"}</button>
      ${n ? `<button class="btn sm danger" id="testClear" ${S.testBusy ? "disabled" : ""}>테스트 데이터 전부 삭제</button>` : ""}
    </div>
  </section>`;
}

/* ---------- 내 정보 ---------- */

function myHTML() {
  return `
  <section class="card">
    <h2>내 정보</h2>
    <div class="meta">로그인 아이디 ${esc(S.me.login_id)}</div>
    <div class="meta">이름 ${esc(S.me.name)}</div>
    ${S.me.gz_mask ? `<div class="meta">골프존 결과표 아이디 ${esc(S.me.gz_mask)}</div>` : ""}
    <div class="meta">연락처 ${esc(S.me.phone || "-")}</div>
    <div class="meta">등급 ${ROLE_LABEL[S.me.role]}</div>
  </section>
  <section class="card${S.me.nickname ? "" : " next"}">
    <h2>닉네임</h2>
    <div class="field">
      <input id="myNick" maxlength="20" value="${esc(S.me.nickname || "")}" placeholder="골프존 닉네임과 똑같이">
      <div class="hint">골프존에서 닉네임을 바꾸면 여기서도 똑같이 바꿔주세요. 대회 결과 사진에서 이 닉네임으로 내 기록을 찾습니다.
      예전 닉네임은 자동으로 기억해 두어 지난 기록은 그대로 이어집니다. 로그인 아이디는 바뀌지 않습니다.</div>
    </div>
    <button class="btn" id="nickSave">닉네임 저장</button>
  </section>
  <section class="card">
    <h2>비밀번호 바꾸기</h2>
    <div class="field"><label for="pwCur">현재 비밀번호</label><input id="pwCur" type="password"></div>
    <div class="field"><label for="pwNew">새 비밀번호</label><input id="pwNew" type="password"></div>
    <button class="btn" id="pwSave">바꾸기</button>
  </section>`;
}

/* ---------- 이벤트 바인딩 ---------- */

function bindBody() {
  const on = (sel, fn, evt = "click") =>
    document.querySelectorAll(sel).forEach((el) => el.addEventListener(evt, fn));
  const bind = (id, fn, evt = "click") => {
    const el = $(id);
    if (el) el.addEventListener(evt, fn);
  };

  on("[data-gomy]", () => {
    S.tab = "my";
    render();
  });

  bindResults(on, bind);
  bindRecords(on, bind);

  bind("nickSave", async () => {
    try {
      const r = await api("/me", { method: "PATCH", body: { nickname: $("myNick").value.trim() } });
      S.me = r.me;
      render();
      toast("닉네임을 저장했습니다.");
    } catch (err) {
      toast(err.message, true);
    }
  });

  bindMemberTools(on, bind);

  on("[data-nick]", async (e) => {
    const b = e.currentTarget;
    const v = prompt("골프존 닉네임과 똑같이 입력하세요.", b.dataset.cur || "");
    if (v == null) return;
    try {
      await api(`/members/${b.dataset.nick}`, { method: "PATCH", body: { nickname: v.trim() } });
      await loadMembers();
      render();
      toast("닉네임을 바꿨습니다.");
    } catch (err) {
      toast(err.message, true);
    }
  });

  on("[data-gonotice]", () => {
    S.tab = "notice";
    markNoticesSeen();
    render();
    loadTab();
  });

  on("[data-open]", (e) => {
    if (e.target.closest("[data-rsvp]")) return;
    openEvent(Number(e.currentTarget.dataset.open));
  });

  // 본인 참가 의사
  on("[data-rsvp]", async (e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api(`/events/${btn.dataset.ev}/rsvp`, { method: "POST", body: { status: btn.dataset.rsvp } });
      toast(r.message || `${ST_LABEL[r.status]}(으)로 등록했습니다.`);
      await refresh();
    } catch (err) {
      toast(err.message, true);
      btn.disabled = false;
    }
  });

  // 마스터가 남의 상태 바꾸기
  on("[data-set]", async (e) => {
    e.stopPropagation();
    const b = e.currentTarget;
    try {
      const r = await api(`/events/${S.eventId}/rsvp`, {
        method: "POST",
        body: { status: b.dataset.set, member_id: Number(b.dataset.mid) },
      });
      S.detail = r.event;
      await loadEvents();
      renderBody();
    } catch (err) {
      toast(err.message, true);
    }
  });

  bind("backList", () => {
    S.view = "list";
    S.detail = null;
    S.showEditEvent = false;
    S.review = null;
    if (S.backTo === "records") {
      S.backTo = null;
      S.tab = "records";
      render();
      loadStats().then(renderBody);
      return;
    }
    renderBody();
    loadEvents().then(renderBody);
  });

  bind("openNew", () => {
    S.showNewEvent = true;
    renderBody();
  });
  bind("editEvent", () => {
    S.showEditEvent = true;
    renderBody();
  });
  bind("cancelForm", () => {
    S.showNewEvent = false;
    S.showEditEvent = false;
    renderBody();
  });
  bind(
    "nRepeat",
    () => {
      $("repeatBox").style.display = $("nRepeat").checked ? "block" : "none";
    },
    "change"
  );
  bind("saveEvent", createEvent);
  bind("updateEvent", updateEvent);

  bind(
    "qRooms",
    async (e) => {
      try {
        const r = await api(`/events/${S.eventId}`, { method: "PATCH", body: { rooms_count: Number(e.target.value) } });
        S.detail = r.event;
        await loadEvents();
        renderBody();
        toast(`방 ${r.event.rooms_count}개로 설정했습니다. (최대 ${r.event.capacity}명)`);
      } catch (err) {
        toast(err.message, true);
        await refresh();
      }
    },
    "change"
  );

  bind("shareBtn", async () => {
    const text = shareText(S.detail);
    try {
      await navigator.clipboard.writeText(text);
      toast("단체방에 붙여넣을 공지문을 복사했습니다.");
    } catch (_) {
      prompt("아래 내용을 복사해서 단체방에 붙여넣으세요.", text);
    }
  });

  bind("doAssign", async () => {
    if (S.detail.assigned_at && !confirm("이미 배정된 방을 지우고 다시 섞습니다. 진행할까요?")) return;
    $("doAssign").disabled = true;
    try {
      const r = await api(`/events/${S.eventId}/assign`, { method: "POST", body: {} });
      S.detail = r.event;
      renderBody();
      toast("방을 배정했습니다.");
    } catch (err) {
      toast(err.message, true);
      if ($("doAssign")) $("doAssign").disabled = false;
    }
  });

  bind("doUnassign", async () => {
    try {
      S.detail = (await api(`/events/${S.eventId}/unassign`, { method: "POST", body: {} })).event;
      renderBody();
    } catch (err) {
      toast(err.message, true);
    }
  });

  bind("toggleClose", async () => {
    try {
      await api(`/events/${S.eventId}`, { method: "PATCH", body: { closed: !S.detail.closed } });
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  bind("delEvent", async () => {
    if (!confirm("이 일정과 신청 내역을 모두 지웁니다. 진행할까요?")) return;
    try {
      await api(`/events/${S.eventId}`, { method: "DELETE", body: {} });
      S.view = "list";
      S.detail = null;
      await loadEvents();
      renderBody();
      toast("일정을 삭제했습니다.");
    } catch (err) {
      toast(err.message, true);
    }
  });

  /* 공지 */
  bind("openNotice", () => {
    S.noticeForm = "new";
    renderBody();
  });
  bind("ntCancel", () => {
    S.noticeForm = null;
    renderBody();
  });
  bind("ntSave", async (e) => {
    const id = e.currentTarget.dataset.id;
    const payload = { title: $("ntTitle").value.trim(), body: $("ntBody").value, pinned: $("ntPin").checked };
    if (!payload.title) return toast("제목을 입력하세요.", true);
    try {
      if (id) await api(`/notices/${id}`, { method: "PATCH", body: payload });
      else await api("/notices", { method: "POST", body: payload });
      S.noticeForm = null;
      await loadNotices();
      markNoticesSeen();
      render();
      toast(id ? "공지를 수정했습니다." : "공지를 올렸습니다.");
    } catch (err) {
      toast(err.message, true);
    }
  });
  on("[data-nedit]", (e) => {
    S.noticeForm = Number(e.currentTarget.dataset.nedit);
    renderBody();
  });
  on("[data-npin]", async (e) => {
    const b = e.currentTarget;
    try {
      await api(`/notices/${b.dataset.npin}`, { method: "PATCH", body: { pinned: b.dataset.pinned !== "1" } });
      await loadNotices();
      renderBody();
    } catch (err) {
      toast(err.message, true);
    }
  });
  on("[data-ndel]", async (e) => {
    if (!confirm("이 공지를 지웁니다. 진행할까요?")) return;
    try {
      await api(`/notices/${e.currentTarget.dataset.ndel}`, { method: "DELETE", body: {} });
      await loadNotices();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });

  /* 회원 */
  on("[data-approve]", async (e) => {
    const b = e.currentTarget;
    try {
      await api(`/members/${b.dataset.approve}`, { method: "PATCH", body: { status: "approved", role: b.dataset.role } });
      await loadMembers();
      render();
      toast("승인했습니다.");
    } catch (err) {
      toast(err.message, true);
    }
  });

  on("[data-reject]", async (e) => {
    try {
      await api(`/members/${e.currentTarget.dataset.reject}`, { method: "PATCH", body: { status: "rejected" } });
      await loadMembers();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });

  on("[data-block]", async (e) => {
    if (!confirm("이 회원의 로그인을 정지합니다. 진행할까요?")) return;
    try {
      await api(`/members/${e.currentTarget.dataset.block}`, { method: "PATCH", body: { status: "rejected" } });
      await loadMembers();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });

  on("[data-del]", async (e) => {
    if (!confirm("계정을 완전히 삭제합니다. 되돌릴 수 없습니다.")) return;
    try {
      await api(`/members/${e.currentTarget.dataset.del}`, { method: "DELETE", body: {} });
      await loadMembers();
      render();
    } catch (err) {
      toast(err.message, true);
    }
  });

  on(
    "[data-role-of]",
    async (e) => {
      const el = e.currentTarget;
      try {
        await api(`/members/${el.dataset.roleOf}`, { method: "PATCH", body: { role: el.value } });
        if (Number(el.dataset.roleOf) === S.me.id) S.me = (await api("/me")).me; // 내 등급을 바꾼 경우 바로 반영
        toast("등급을 바꿨습니다.");
      } catch (err) {
        toast(err.message, true);
      }
      await loadMembers();
      render();
    },
    "change"
  );

  bind("pwSave", async () => {
    try {
      await api("/me/password", { method: "POST", body: { current: $("pwCur").value, next: $("pwNew").value } });
      toast("비밀번호를 바꿨습니다.");
      $("pwCur").value = $("pwNew").value = "";
    } catch (err) {
      toast(err.message, true);
    }
  });
}

async function createEvent() {
  const date = $("nDate").value;
  const time = $("nTime").value;
  if (!date || !time) return toast("날짜와 시작 시각을 입력하세요.", true);

  let dates = [date];
  if ($("nRepeat") && $("nRepeat").checked) {
    const end = $("nEnd").value;
    const dows = [...document.querySelectorAll(".dowChk:checked")].map((c) => Number(c.value));
    if (!end || !dows.length) return toast("종료일과 요일을 골라주세요.", true);
    dates = [];
    let cur = new Date(date + "T00:00:00Z");
    const last = new Date(end + "T00:00:00Z");
    while (cur <= last && dates.length < 200) {
      if (dows.includes(cur.getUTCDay())) dates.push(cur.toISOString().slice(0, 10));
      cur = new Date(cur.getTime() + 86400000);
    }
    if (!dates.length) return toast("해당 요일에 맞는 날짜가 없습니다.", true);
  }

  try {
    const r = await api("/events", {
      method: "POST",
      body: {
        dates,
        start_time: time,
        title: $("nTitle").value.trim(),
        place: $("nPlace").value.trim(),
        rooms_count: Number($("nRooms").value),
        spread_guests: $("nSpread").checked,
        entry_fee: Number($("nFee").value) || 0,
      },
    });
    S.showNewEvent = false;
    await loadEvents();
    renderBody();
    toast(`일정 ${r.created}건을 만들었습니다.`);
  } catch (err) {
    toast(err.message, true);
  }
}

async function updateEvent() {
  const date = $("nDate").value;
  const time = $("nTime").value;
  if (!date || !time) return toast("날짜와 시작 시각을 입력하세요.", true);
  try {
    const r = await api(`/events/${S.eventId}`, {
      method: "PATCH",
      body: {
        event_date: date,
        start_time: time,
        title: $("nTitle").value.trim(),
        place: $("nPlace").value.trim(),
        rooms_count: Number($("nRooms").value),
        spread_guests: $("nSpread").checked,
        entry_fee: Number($("nFee").value) || 0,
      },
    });
    S.detail = r.event;
    S.showEditEvent = false;
    await loadEvents();
    renderBody();
    toast("일정을 수정했습니다.");
  } catch (err) {
    toast(err.message, true);
  }
}

/* ---------- 대회 결과 이벤트 ---------- */

function bindResults(on, bind) {
  const copy = async (text, okMsg) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch (_) {
      prompt("아래 내용을 복사해서 단체방에 붙여넣으세요.", text);
    }
  };
  bind("copyAssign", () => copy(assignText(S.detail), "방배정·시상 공지를 복사했습니다."));
  bind("copyResult", () => copy(resultText(S.detail), "결과 공지를 복사했습니다."));

  bind("redrawPrize", async (e) => {
    const n = prompt(
      "몇 명 기준으로 시상 금액을 다시 뽑을까요?\n(이미 공지한 금액이 바뀌니 꼭 필요할 때만 쓰세요)",
      e.currentTarget.dataset.n
    );
    if (n == null) return;
    try {
      S.detail = (await api(`/events/${S.eventId}/prize`, { method: "POST", body: { count: Number(n) } })).event;
      renderBody();
      toast("시상 금액을 다시 뽑았습니다.");
    } catch (err) {
      toast(err.message, true);
    }
  });

  bind("pickPhotos", () => $("ocrFiles").click());
  bind(
    "ocrFiles",
    async (e) => {
      const files = [...e.target.files].slice(0, 6);
      if (!files.length) return;
      S.ocrBusy = true;
      renderBody();
      try {
        const images = await Promise.all(files.map(shrinkImage));
        const r = await api(`/events/${S.eventId}/ocr`, { method: "POST", body: { images } });
        if (!S.members.length) await loadMembers();
        S.review = {
          title: r.title,
          date: r.date,
          rows: r.rows.map((x) => ({
            member_id: x.member_id,
            match: x.match,
            raw_nick: x.nickname,
            gz_mask: x.gz_mask,
            rank_label: x.rank_label,
            stroke: x.stroke,
            handicap: x.handicap,
            final: x.final,
          })),
        };
      } catch (err) {
        toast(err.message, true);
      } finally {
        S.ocrBusy = false;
        renderBody();
      }
    },
    "change"
  );

  const startManual = (fromExisting) => {
    const ev = S.detail;
    let rows;
    if (fromExisting && ev.results.length) {
      rows = ev.results.map((r) => ({
        member_id: r.member_id,
        raw_nick: r.raw_nick || r.nickname,
        gz_mask: r.gz_mask,
        rank_label: r.rank_label,
        stroke: r.stroke,
        handicap: r.handicap,
        final: r.final,
      }));
    } else {
      const people = ev.rooms.length
        ? ev.rooms.flatMap((r) => r.members)
        : ev.responses.filter((x) => x.status === "yes");
      rows = people.map((m) => ({ member_id: m.id, raw_nick: nm(m), rank_label: "", stroke: "", handicap: 0, final: "" }));
      if (!rows.length) rows = [{ member_id: null, raw_nick: "", rank_label: "", stroke: "", handicap: 0, final: "" }];
    }
    S.review = { rows };
    renderBody();
  };
  bind("manualResults", () => startManual(false));
  bind("editResults", () => startManual(true));

  bind("delResults", async () => {
    if (!confirm("이 대회의 결과 기록을 지웁니다. 진행할까요?")) return;
    try {
      S.detail = (await api(`/events/${S.eventId}/results`, { method: "DELETE", body: {} })).event;
      renderBody();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 검토 표 입력값 반영
  on(
    ".review [data-k]",
    (e) => {
      const el = e.currentTarget;
      const row = S.review.rows[Number(el.dataset.i)];
      const k = el.dataset.k;
      row[k] = k === "member_id" ? (el.value ? Number(el.value) : null) : el.value.trim();
      if (k === "member_id") {
        row.match = null;
        if (!row.raw_nick && row.member_id) row.raw_nick = nm(S.members.find((m) => m.id === row.member_id));
        renderBody();
      }
      // 타수·보정을 고치면 최종을 자동 계산
      if ((k === "stroke" || k === "handicap") && row.stroke !== "" && !isNaN(Number(row.stroke))) {
        row.final = String(Number(row.stroke) + (Number(row.handicap) || 0));
        const f = document.querySelector(`.review [data-i="${el.dataset.i}"][data-k="final"]`);
        if (f) f.value = row.final;
      }
    },
    "change"
  );
  on("[data-rvdel]", (e) => {
    S.review.rows.splice(Number(e.currentTarget.dataset.rvdel), 1);
    renderBody();
  });
  bind("rvAdd", () => {
    S.review.rows.push({ member_id: null, raw_nick: "", rank_label: "", stroke: "", handicap: 0, final: "" });
    renderBody();
  });
  bind("rvCancel", () => {
    S.review = null;
    renderBody();
  });
  bind("rvSave", async () => {
    const rows = S.review.rows;
    const ids = rows.map((r) => r.member_id).filter(Boolean);
    if (new Set(ids).size !== ids.length) return toast("같은 회원이 두 줄에 연결돼 있습니다.", true);
    const un = rows.filter((r) => !r.member_id).length;
    if (un && !confirm(`회원과 연결 안 된 ${un}명은 비회원으로 저장되어 개인 기록에 남지 않습니다. 저장할까요?`)) return;
    $("rvSave").disabled = true;
    try {
      S.detail = (await api(`/events/${S.eventId}/results`, { method: "PUT", body: { rows } })).event;
      S.review = null;
      S.stats = null;
      renderBody();
      toast("결과를 저장했습니다.");
    } catch (err) {
      toast(err.message, true);
      if ($("rvSave")) $("rvSave").disabled = false;
    }
  });
}

/* ---------- 기록 탭 ---------- */

function statsScope() {
  const st = S.stats;
  const evs = st.events.filter((e) => S.recPeriod === "all" || e.event_date.startsWith(S.recPeriod));
  const ids = new Set(evs.map((e) => e.id));
  return { evs, rows: st.results.filter((r) => ids.has(r.event_id)) };
}

function memberName(id) {
  const m = S.stats.members.find((x) => x.id === id);
  return m ? nm(m) : "(탈퇴)";
}

function rankingData() {
  const { evs, rows } = statsScope();
  const fee = Object.fromEntries(evs.map((e) => [e.id, e.entry_fee || 0]));
  const map = new Map();
  for (const r of rows) {
    if (!r.member_id) continue;
    let s = map.get(r.member_id);
    if (!s) map.set(r.member_id, (s = { id: r.member_id, n: 0, win: 0, podium: 0, sumF: 0, sumS: 0, best: null, prize: 0, fee: 0 }));
    s.n++;
    if (r.rank_no === 1) s.win++;
    if (r.prize > 0) s.podium++;
    s.sumF += r.final;
    s.sumS += r.stroke;
    s.best = s.best == null ? r.final : Math.min(s.best, r.final);
    s.prize += r.prize;
    s.fee += fee[r.event_id] || 0;
  }
  return [...map.values()]
    .map((s) => ({ ...s, avgF: s.sumF / s.n, avgS: s.sumS / s.n, net: s.prize - s.fee }))
    .sort((a, b) => a.avgF - b.avgF || b.n - a.n);
}

function h2hData(aId, basis) {
  const { evs, rows } = statsScope();
  const evMap = Object.fromEntries(evs.map((e) => [e.id, e]));
  const byEvent = {};
  for (const r of rows) (byEvent[r.event_id] = byEvent[r.event_id] || []).push(r);
  const opp = new Map();
  for (const [eid, list] of Object.entries(byEvent)) {
    const me = list.find((x) => x.member_id === aId);
    if (!me) continue;
    for (const o of list) {
      if (!o.member_id || o.member_id === aId) continue;
      let s = opp.get(o.member_id);
      if (!s) opp.set(o.member_id, (s = { id: o.member_id, w: 0, d: 0, l: 0, games: [] }));
      const a = me[basis], b = o[basis];
      const res = a < b ? "w" : a > b ? "l" : "d";
      s[res]++;
      s.games.push({ ev: evMap[eid], a, b, res });
    }
  }
  return [...opp.values()]
    .map((s) => ({ ...s, n: s.w + s.d + s.l, rate: (s.w + s.d * 0.5) / (s.w + s.d + s.l) }))
    .sort((x, y) => y.n - x.n || y.rate - x.rate);
}

function recordsHTML() {
  const st = S.stats;
  if (!st) return `<div class="empty">불러오는 중…</div>`;
  const master = isAdmin(S.me);
  const years = [...new Set(st.events.map((e) => e.event_date.slice(0, 4)))].sort().reverse();

  let html = `<div class="seg">
      ${[["rank", "랭킹"], ["h2h", "맞대결"], ["events", "대회 기록"]]
        .map(([k, l]) => `<button class="${S.recView === k ? "on" : ""}" data-rv="${k}">${l}</button>`)
        .join("")}
    </div>
    <div class="rec-filter">
      <select id="recPeriod">
        <option value="all">전체 기간</option>
        ${years.map((y) => `<option value="${y}" ${S.recPeriod === y ? "selected" : ""}>${y}년</option>`).join("")}
      </select>
      <span class="meta" style="margin:0">대회 ${statsScope().evs.length}회</span>
    </div>`;

  if (master && st.pending.length && S.recView !== "h2h") {
    html += `<section class="card" style="border-color:var(--flag)">
      <h2>결과 미입력 대회 ${st.pending.length}건</h2>
      <div class="mlist">${st.pending
        .map(
          (e) => `<div class="mrow"><div><div class="nm">${fmtDate(e.event_date)} ${esc(e.start_time)}</div>
            <div class="sub">${esc([e.place, e.title].filter(Boolean).join(" · "))}</div></div>
            <div class="acts"><button class="btn sm" data-openev="${e.id}">결과 올리기</button></div></div>`
        )
        .join("")}</div></section>`;
  }

  if (!st.events.length) return html + `<div class="empty">아직 저장된 대회 결과가 없습니다.</div>`;

  if (S.recView === "rank") {
    const data = rankingData();
    const mine = data.find((x) => x.id === S.me.id);
    if (mine)
      html += `<section class="card next my-sum">
        <div class="ms"><b>${mine.n}</b><span>참가</span></div>
        <div class="ms"><b>${mine.avgF.toFixed(1)}</b><span>평균 최종</span></div>
        <div class="ms"><b>${mine.win}</b><span>우승</span></div>
        <div class="ms"><b class="${mine.net >= 0 ? "plus" : "minus"}">${mine.net >= 0 ? "+" : ""}${(mine.net / 1000).toFixed(0)}천</b><span>상금 손익</span></div>
      </section>`;
    html += `<div class="tbl-wrap card" style="padding:0"><table class="tbl">
      <thead><tr><th>#</th><th class="l">닉네임</th><th>참가</th><th>평균</th><th>베스트</th><th>우승</th><th>입상</th><th>상금</th></tr></thead>
      <tbody>${data
        .map(
          (s, i) => `<tr class="${s.id === S.me.id ? "self" : ""}" data-h2h="${s.id}">
          <td>${i + 1}</td><td class="l">${esc(memberName(s.id))}</td><td>${s.n}</td>
          <td><b>${s.avgF.toFixed(1)}</b></td><td>${s.best}</td><td>${s.win || ""}</td><td>${s.podium || ""}</td>
          <td>${s.prize ? (s.prize / 1000).toFixed(0) + "천" : ""}</td></tr>`
        )
        .join("")}</tbody></table></div>
      <div class="hint">평균·베스트는 최종성적(보정 포함) 기준, 낮을수록 좋습니다. 이름을 누르면 맞대결 전적을 봅니다.</div>`;
  }

  if (S.recView === "h2h") {
    const aId = S.h2hMember || S.me.id;
    const opts = [...st.members].sort((a, b) => nm(a).localeCompare(nm(b), "ko"));
    const data = h2hData(aId, S.h2hBasis);
    const tot = data.reduce((t, s) => ({ w: t.w + s.w, d: t.d + s.d, l: t.l + s.l }), { w: 0, d: 0, l: 0 });
    html += `<section class="card">
      <div class="row2">
        <div class="field" style="margin:0"><label>기준 회원</label>
          <select id="h2hMember">${opts.map((m) => `<option value="${m.id}" ${m.id === aId ? "selected" : ""}>${esc(nm(m))}</option>`).join("")}</select></div>
        <div class="field" style="margin:0"><label>비교 기준</label>
          <select id="h2hBasis">
            <option value="final" ${S.h2hBasis === "final" ? "selected" : ""}>최종성적 (보정 포함)</option>
            <option value="stroke" ${S.h2hBasis === "stroke" ? "selected" : ""}>스트로크 (보정 없이)</option>
          </select></div>
      </div>
      <div class="h2h-total">통산 <b class="w">${tot.w}승</b> <b class="d">${tot.d}무</b> <b class="l">${tot.l}패</b></div>
    </section>`;
    if (!data.length) html += `<div class="empty">같은 대회에 함께 나간 기록이 없습니다.</div>`;
    html += data
      .map(
        (s) => `<div class="card h2h-row" data-h2hopen="${s.id}">
        <div class="h2h-line">
          <span class="nm">vs ${esc(memberName(s.id))}</span>
          <span class="rec"><b class="w">${s.w}</b>승 <b class="d">${s.d}</b>무 <b class="l">${s.l}</b>패</span>
          <span class="rate">${Math.round(s.rate * 100)}%</span>
        </div>
        <div class="bar"><i class="w" style="width:${(s.w / s.n) * 100}%"></i><i class="d" style="width:${(s.d / s.n) * 100}%"></i><i class="l" style="width:${(s.l / s.n) * 100}%"></i></div>
        ${
          S.h2hOpen === s.id
            ? `<div class="games">${s.games
                .sort((x, y) => (y.ev.event_date > x.ev.event_date ? 1 : -1))
                .map(
                  (g) => `<div class="g"><span>${fmtDate(g.ev.event_date)}</span><span>${g.a} : ${g.b}</span>
                  <span class="${g.res}">${g.res === "w" ? "승" : g.res === "l" ? "패" : "무"}</span></div>`
                )
                .join("")}</div>`
            : ""
        }
      </div>`
      )
      .join("");
    html += `<div class="hint">같은 대회에 함께 참가한 경우만 비교합니다. 점수가 낮은 쪽이 승리, 같으면 무승부.</div>`;
  }

  if (S.recView === "events") {
    const { evs, rows } = statsScope();
    html += evs
      .map((e) => {
        const list = rows.filter((r) => r.event_id === e.id).sort((a, b) => a.rank_no - b.rank_no);
        const top = list.filter((r) => r.rank_no <= 3);
        const my = list.find((r) => r.member_id === S.me.id);
        return `<article class="card" data-openev="${e.id}" style="cursor:pointer">
          <div class="when"><span class="date">${fmtDate(e.event_date)}</span><span class="meta" style="margin:0">${esc([e.place, e.title].filter(Boolean).join(" · "))} · ${e.players}명</span></div>
          <div class="podium">${top
            .map((r) => `<span><b>${esc(r.rank_label)}</b> ${esc(r.member_id ? memberName(r.member_id) : r.raw_nick)} ${r.final}</span>`)
            .join("")}</div>
          ${my ? `<div class="meta">내 성적: ${esc(my.rank_label)}위 · 최종 ${my.final}${my.prize ? " · " + won(my.prize) : ""}</div>` : ""}
        </article>`;
      })
      .join("");
  }
  return html;
}

function bindRecords(on, bind) {
  on("[data-rv]", (e) => {
    S.recView = e.currentTarget.dataset.rv;
    renderBody();
  });
  bind(
    "recPeriod",
    (e) => {
      S.recPeriod = e.target.value;
      renderBody();
    },
    "change"
  );
  bind(
    "h2hMember",
    (e) => {
      S.h2hMember = Number(e.target.value);
      S.h2hOpen = null;
      renderBody();
    },
    "change"
  );
  bind(
    "h2hBasis",
    (e) => {
      S.h2hBasis = e.target.value;
      renderBody();
    },
    "change"
  );
  on("[data-h2h]", (e) => {
    S.h2hMember = Number(e.currentTarget.dataset.h2h);
    S.h2hOpen = null;
    S.recView = "h2h";
    renderBody();
  });
  on("[data-h2hopen]", (e) => {
    const id = Number(e.currentTarget.dataset.h2hopen);
    S.h2hOpen = S.h2hOpen === id ? null : id;
    renderBody();
  });
  on("[data-openev]", (e) => {
    e.stopPropagation();
    openEvent(Number(e.currentTarget.dataset.openev), "records");
  });
}

/* ---------- 회원 정리 · 인식 정보 · 테스트 도구 ---------- */

function bindMemberTools(on, bind) {
  const redraw = () => renderBody();
  bind("selStart", () => {
    S.selMode = true;
    S.sel = new Set();
    S.aliasOpen = null;
    redraw();
  });
  bind("selCancel", () => {
    S.selMode = false;
    S.sel = new Set();
    redraw();
  });
  const deletable = (m) => m.status === "approved" && m.id !== S.me.id && !isAdmin(m);
  bind("selAll", () => {
    S.members.filter(deletable).forEach((m) => S.sel.add(m.id));
    redraw();
  });
  bind("selIdle", () => {
    S.members.filter((m) => deletable(m) && m.activity === 0).forEach((m) => S.sel.add(m.id));
    redraw();
  });
  bind("selTest", () => {
    S.members.filter((m) => deletable(m) && m.is_test).forEach((m) => S.sel.add(m.id));
    redraw();
  });
  on(
    ".selChk",
    (e) => {
      const id = Number(e.currentTarget.dataset.sel);
      if (e.currentTarget.checked) S.sel.add(id);
      else S.sel.delete(id);
      redraw();
    },
    "change"
  );
  bind("selDelete", async () => {
    const names = S.members.filter((m) => S.sel.has(m.id)).map(nm);
    if (!confirm(`${names.length}명 계정을 삭제합니다. 되돌릴 수 없습니다.\n\n${names.slice(0, 15).join(", ")}${names.length > 15 ? " 외" : ""}`)) return;
    try {
      const r = await api("/members-delete", { method: "POST", body: { ids: [...S.sel] } });
      S.sel = new Set();
      S.selMode = false;
      await loadMembers();
      render();
      toast(`${r.deleted}명 계정을 삭제했습니다.`);
    } catch (err) {
      toast(err.message, true);
    }
  });

  on("[data-alias]", async (e) => {
    const id = Number(e.currentTarget.dataset.alias);
    if (S.aliasOpen === id) {
      S.aliasOpen = null;
      return redraw();
    }
    try {
      S.aliases = (await api(`/members/${id}/aliases`)).aliases;
      S.aliasOpen = id;
      redraw();
    } catch (err) {
      toast(err.message, true);
    }
  });
  on("[data-aldel]", async (e) => {
    const b = e.currentTarget;
    try {
      await api(`/members/${b.dataset.mid}/aliases/${b.dataset.aldel}`, { method: "DELETE", body: {} });
      S.aliases = (await api(`/members/${b.dataset.mid}/aliases`)).aliases;
      redraw();
    } catch (err) {
      toast(err.message, true);
    }
  });
  bind("gzSave", async (e) => {
    try {
      await api(`/members/${e.currentTarget.dataset.id}`, { method: "PATCH", body: { gz_mask: $("gzEdit").value.trim() } });
      await loadMembers();
      redraw();
      toast("골프존 아이디를 저장했습니다.");
    } catch (err) {
      toast(err.message, true);
    }
  });

  bind("testMake", async () => {
    S.testBusy = true;
    redraw();
    try {
      const r = await api("/test-data", { method: "POST", body: { events: 8, upcoming: true } });
      await Promise.all([loadMembers(), loadEvents()]);
      S.stats = null;
      toast(`테스트 계정 ${r.accounts}명 · 지난 대회 ${r.events}회${r.upcoming ? " · 배정 테스트 " + r.upcoming : ""} 생성`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      S.testBusy = false;
      render();
    }
  });
  bind("testClear", async () => {
    if (!confirm("테스트 계정과 테스트 대회를 모두 지웁니다. 진행할까요?")) return;
    S.testBusy = true;
    redraw();
    try {
      const r = await api("/test-data", { method: "DELETE", body: {} });
      await Promise.all([loadMembers(), loadEvents()]);
      S.stats = null;
      toast(`테스트 계정 ${r.accounts}명 · 대회 ${r.events}건을 삭제했습니다.`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      S.testBusy = false;
      render();
    }
  });
}

/* ---------- 데이터 로딩 ---------- */

async function loadEvents() {
  S.events = (await api("/events")).events;
}
async function loadMembers() {
  S.members = (await api("/members")).members;
}
async function loadStats() {
  S.stats = await api("/stats");
}
async function loadNotices() {
  S.notices = (await api("/notices")).notices;
}
async function loadTab() {
  try {
    if (S.tab === "schedule") await Promise.all([loadEvents(), loadNotices()]);
    if (S.tab === "notice") await loadNotices();
    if (S.tab === "members") await loadMembers();
    if (S.tab === "records") await Promise.all([loadStats(), S.members.length ? null : loadMembers()]);
    renderBody();
  } catch (e) {
    toast(e.message, true);
  }
}
async function loadAll() {
  try {
    await Promise.all([loadEvents(), loadMembers(), loadNotices()]);
    render();
  } catch (e) {
    toast(e.message, true);
  }
}
async function openEvent(id, from) {
  S.backTo = from || null;
  if (S.tab !== "schedule") {
    S.tab = "schedule";
    render();
  }
  S.review = null;
  S.eventId = id;
  S.view = "event";
  S.detail = null;
  S.showEditEvent = false;
  renderBody();
  try {
    S.detail = (await api(`/events/${id}`)).event;
    if (!S.members.length) await loadMembers().catch(() => {});
    renderBody();
  } catch (e) {
    toast(e.message, true);
    S.view = "list";
    renderBody();
  }
}
async function refresh() {
  if (S.view === "event" && S.eventId) S.detail = (await api(`/events/${S.eventId}`)).event;
  await loadEvents();
  renderBody();
}

function signOut(silent) {
  api("/logout", { method: "POST", body: {} }).catch(() => {});
  localStorage.removeItem("sg_token");
  S.token = "";
  S.me = null;
  S.events = [];
  S.members = [];
  S.notices = [];
  S.view = "list";
  render();
  if (!silent) toast("로그아웃했습니다.");
}

/* ---------- 타이머 ---------- */

function tickCountdowns() {
  document.querySelectorAll("[data-cd]").forEach((el) => {
    const ts = Number(el.dataset.cd);
    const t = untilText(ts);
    if (!t) {
      el.textContent = el.dataset.over || "";
      el.className = "countdown urgent";
      return;
    }
    el.textContent = (el.dataset.pre || "") + t + (el.dataset.post || "");
  });
}
setInterval(tickCountdowns, 1000);

// 마감·배정 시각 전후로는 서버를 자주 확인해 상태를 바로 받아온다
setInterval(async () => {
  if (!S.me) return;
  const near = (e) =>
    e &&
    !e.assigned_at &&
    (Math.abs(Date.now() - e.deadline_ts) < 120000 || Date.now() > e.assign_ts - 120000);
  try {
    if (S.view === "event" && S.detail && near(S.detail) && !S.showEditEvent) {
      const was = S.detail.assigned_at;
      S.detail = (await api(`/events/${S.eventId}`)).event;
      renderBody();
      if (!was && S.detail.assigned_at) toast("방이 배정됐습니다.");
    } else if (S.view === "list" && S.tab === "schedule" && S.events.some(near) && !S.showNewEvent) {
      await loadEvents();
      renderBody();
    }
  } catch (_) {}
}, 15000);

/* ---------- 시작 ---------- */

(async function boot() {
  if (S.token) {
    try {
      S.me = (await api("/me")).me;
      render();
      await loadAll();
      return;
    } catch (_) {
      localStorage.removeItem("sg_token");
      S.token = "";
    }
  }
  render();
})();
