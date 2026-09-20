/* 스크린골프 동호회 예약 — 프론트엔드 */

const DOW = ["일", "월", "화", "수", "목", "금", "토"];
const ROLE_LABEL = { master: "마스터", member: "정회원", guest: "게스트" };
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
};

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
        <span>${esc(S.me.name)} · ${ROLE_LABEL[S.me.role]}</span>
        <button id="btnOut">로그아웃</button>
      </div>
    </header>
    <div class="shell">
      <nav class="tabs" role="tablist">
        <button role="tab" aria-selected="${S.tab === "schedule"}" data-tab="schedule">일정</button>
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
  const master = S.me.role === "master";
  const pinned = S.notices.filter((n) => n.pinned).slice(0, 2);
  let html = "";

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
        (m) => `<span class="chip ${m.role === "guest" ? "guest" : ""} st-${status}">${esc(m.name)}${
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
        (m) => `<span class="chip st-none">${esc(m.name)}${
          master ? `<button data-set="yes" data-mid="${m.id}" title="참가로 등록">＋</button>` : ""
        }</span>`
      )
      .join("")}</div>
  </div>`;
}

function eventHTML() {
  const ev = S.detail;
  if (!ev) return `<div class="empty">불러오는 중…</div>`;
  const master = S.me.role === "master";
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
                  <span class="seat">${i + 1}</span>${esc(m.name)}
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
  <button class="btn ghost sm" id="backList" style="margin-bottom:14px">← 목록으로</button>
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
            <button class="btn sm ghost" id="editEvent">날짜·시간 수정</button>
            <button class="btn sm ghost" id="toggleClose">${ev.closed ? "신청 다시 열기" : "신청 즉시 마감"}</button>
            <button class="btn sm danger" id="delEvent">일정 삭제</button>
          </div>
        </section>`
      : ""
  }`;
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
  const master = S.me.role === "master";
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
  const master = S.me.role === "master";
  const pending = S.members.filter((m) => m.status === "pending");
  const active = S.members.filter((m) => m.status === "approved");
  const blocked = S.members.filter((m) => m.status === "rejected");

  let html = "";
  if (master && pending.length) {
    html += `<section class="card" style="border-color:var(--flag)">
      <h2>승인 대기 ${pending.length}명</h2>
      <div class="mlist">${pending
        .map(
          (m) => `<div class="mrow">
            <div>
              <div class="nm">${esc(m.name)}</div>
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

  html += `<section class="card">
    <h2>회원 ${active.length}명</h2>
    <div class="mlist">${
      active.length
        ? active
            .map(
              (m) => `<div class="mrow">
          <div>
            <div class="nm">${esc(m.name)} <span class="role-pill ${m.role}">${ROLE_LABEL[m.role]}</span></div>
            ${master ? `<div class="sub">${esc(m.login_id)}${m.phone ? " · " + esc(m.phone) : ""}</div>` : ""}
          </div>
          ${
            master
              ? `<div class="acts">
                  <select data-role-of="${m.id}" style="padding:5px 8px;border:1px solid var(--line);border-radius:7px">
                    ${["master", "member", "guest"]
                      .map((r) => `<option value="${r}" ${m.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`)
                      .join("")}
                  </select>
                  <button class="btn sm danger" data-block="${m.id}">정지</button>
                </div>`
              : ""
          }
        </div>`
            )
            .join("")
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
  return html;
}

/* ---------- 내 정보 ---------- */

function myHTML() {
  return `
  <section class="card">
    <h2>내 정보</h2>
    <div class="meta">아이디 ${esc(S.me.login_id)}</div>
    <div class="meta">이름 ${esc(S.me.name)}</div>
    <div class="meta">연락처 ${esc(S.me.phone || "-")}</div>
    <div class="meta">등급 ${ROLE_LABEL[S.me.role]}</div>
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

/* ---------- 데이터 로딩 ---------- */

async function loadEvents() {
  S.events = (await api("/events")).events;
}
async function loadMembers() {
  S.members = (await api("/members")).members;
}
async function loadNotices() {
  S.notices = (await api("/notices")).notices;
}
async function loadTab() {
  try {
    if (S.tab === "schedule") await Promise.all([loadEvents(), loadNotices()]);
    if (S.tab === "notice") await loadNotices();
    if (S.tab === "members") await loadMembers();
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
async function openEvent(id) {
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
