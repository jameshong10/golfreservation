# 주오맨 GOLF — 스크린골프 동호회 예약

동호회원이 날짜별로 참가를 신청하고, **시작 20분 전에 방이 자동으로 랜덤 배정**되는 웹앱입니다.
Cloudflare Pages(무료) + D1(무료) 위에서 돌아가고, GitHub에 push하면 자동 배포됩니다.

---

## 진행 흐름

```
[마스터]  날짜 · 시작 시각 · 구장 · 쓸 방 수(1~6) 등록
    ↓
[회원]    참가 / 보류 / 비참가 중 하나 선택
    ↓
전날 23:59  정식 신청 마감
            보류인 채로 넘어간 사람은 자동으로 빠짐
    ↓
[당일]    추가 신청은 대기 신청으로 접수
          구장에서 방을 더 받으면 → 마스터가 방 수를 늘리고 대기자를 확정
    ↓
시작 20분 전  확정 인원만 1~6번 방에 랜덤 배정
```

## 주요 기능

| 기능 | 설명 |
|---|---|
| 마스터 승인 가입 | 누구나 가입 신청만 가능. 마스터가 승인해야 로그인됨 |
| 등급 | 마스터 / 정회원 / 게스트 3단계 |
| 일정 | 마스터가 날짜·시작 시각·구장·방 수(1~6)를 등록 (여러 날 한 번에 생성 가능) |
| 참가 의사 | **참가 / 보류 / 비참가** 버튼 하나로 선택. 마스터는 미응답자까지 한눈에 확인 |
| 정식 마감 | **전날 23:59**. 보류인 채로 마감을 넘기면 자동으로 비참가 처리 |
| 당일 대기 | 마감 후 신청은 **대기**로 접수. 방이 확보되면 마스터가 확정 |
| 정원 | 방 수 x 4명. 정원이 차면 참가 신청도 자동으로 대기가 됨 |
| 방 배정 | **시작 20분 전 정시에 Cron이 확정 인원만 랜덤 배정** (1~6번 방) |
| 단체방 공지문 | 일정·마감·현재 인원을 한 번에 복사해 카톡 단체방에 붙여넣기 |
| 공지 | 마스터만 작성·수정·삭제. 맨 위 고정하면 일정 화면에도 함께 표시 |
| **AI 카톡 대화 읽기** | 단체방 답글을 붙여넣으면 **Jev**가 사람별 참가/보류/불참을 읽고 회원과 연결. 마스터가 확인 후 한 번에 반영 |
| **AI 회원 찾기** | 결과 사진의 닉네임이 코드로 안 맞으면 **Jev**가 회원을 추정 ("AI 추정 90%"). 저장 전 마스터가 확인 |
| 등급 | 마스터 / 개발자(마스터 권한 + 테스트 도구) / 정회원 / 게스트 |

### 인원별 방 나누기 규칙

인원을 4명 이하 방으로 나누되 **최대한 고르게** 나눕니다. 방은 최대 6개입니다.

```
 4명 → 4        8명 → 4+4       12명 → 4+4+4      20명 → 4+4+4+4+4
 5명 → 3+2      9명 → 3+3+3     13명 → 4+3+3+3    24명 → 4+4+4+4+4+4 (최대)
 6명 → 3+3     10명 → 4+3+3     14명 → 4+4+3+3
 7명 → 4+3     11명 → 4+4+3     15명 → 4+4+4+3
```

## 설치 (한 번만)

### 준비

```bash
npm install -g wrangler
wrangler login
```

### 1. GitHub에 올리기

```bash
cd screengolf
git init
git add .
git commit -m "스크린골프 동호회 예약 시스템"
git branch -M main
git remote add origin https://github.com/본인계정/screengolf.git
git push -u origin main
```

### 2. D1 데이터베이스 만들기

```bash
wrangler d1 create screengolf
```

출력된 `database_id` 값을 복사해 **`wrangler.toml`의 `database_id`** 자리에 붙여넣습니다.

이어서 테이블을 만듭니다.

```bash
wrangler d1 execute screengolf --remote --file=./schema.sql
```

바뀐 `wrangler.toml`도 push합니다.

```bash
git add wrangler.toml && git commit -m "D1 연결" && git push
```

### 3. 배정 Cron Worker 올리기

Pages에는 정해진 시각에 도는 기능이 없어서, 배정 전용 Worker를 따로 올립니다.

`worker/wrangler.toml`의 `database_id`에 **2번에서 받은 것과 똑같은 값**을 넣고:

```bash
cd worker
wrangler deploy
cd ..
```

1분마다 깨어나서 두 가지를 합니다.

- 마감(전날 23:59)이 지난 일정의 **보류를 비참가로 정리**
- 시작 20분 전이 된 일정의 **방 배정**
동작 확인은 배포 후 나온 주소 뒤에 `/run`을 붙여 열어보면 됩니다.

```
https://screengolf-cron.<계정>.workers.dev/run
```

### 4. Cloudflare Pages에 연결

Cloudflare 대시보드 → **Workers & Pages → Create → Pages → Connect to Git**

- 저장소: 방금 올린 `screengolf`
- **빌드 명령어: 비워둠**
- **빌드 출력 디렉터리: `public`**

`wrangler.toml`에 D1 설정이 들어 있어서 별도 바인딩 설정은 필요 없습니다.
만약 대시보드에서 직접 설정해야 한다면 **Settings → Bindings → D1 database**에서
변수 이름 `DB`, 데이터베이스 `screengolf`를 Production과 Preview 양쪽에 추가하세요.

### 5. 마스터 계정 만들기

배포된 주소(`https://screengolf.pages.dev`)에 접속해 **가입 신청**을 합니다.
**맨 처음 가입한 사람이 자동으로 마스터가 되고 바로 로그인**됩니다.
이후 가입자는 모두 승인 대기 상태로 들어옵니다.

---

## AI 설정 (TypeSafe Jev)

Jev는 **글자만 읽는 판단 모델**이라 사진은 못 읽습니다. 그래서 역할을 이렇게 나눕니다.

| 기능 | 쓰는 키 | 없으면 |
|---|---|---|
| 카톡 대화 → 참가 의사 | `TYPESAFE_API_KEY` (Jev) | 버튼을 눌러도 '키 없음' 안내 |
| 결과표 닉네임 → 회원 추정 | `TYPESAFE_API_KEY` (Jev) | 코드 매칭만 (닉네임·예전 닉네임·골프존 ID) |
| 결과 사진 읽기 (OCR) | `GEMINI_API_KEY` 또는 `ANTHROPIC_API_KEY` | '직접 입력'만 가능 |

키는 서버(Cloudflare)에만 둡니다. 브라우저 코드에는 절대 넣지 마세요.

```bash
wrangler pages secret put TYPESAFE_API_KEY --project-name screengolf
# (선택) 모델 고정: JEV_MODEL = jev-1.13.0   기본값은 jev-latest
```

또는 대시보드 → Pages 프로젝트 → **Settings → Variables and Secrets**에 `TYPESAFE_API_KEY` 추가 후 다시 배포.
Jev 호출은 요청 한 번에 여러 질문을 묶어 보내고, 확률이 낮은 판단(매칭 60% 미만, 참가 의사 55% 미만)은 자동 반영하지 않습니다.
기준값은 `shared/jev.js` 맨 위 `JEV_MATCH_MIN` / `JEV_RSVP_MIN`.

---

## 운영 DB 초기화 (마스터 + 개발자만 남기기)

`reset.sql`은 **마스터 계정과 홍그리1(→ 개발자 등급)만 남기고** 회원·일정·신청·방배정·결과·공지를 전부 지운 뒤,
테스트 계정 **test1 ~ test20 (비밀번호 1234, 닉네임 테스트1~20)** 을 만듭니다. 되돌릴 수 없으니 꼭 백업부터 하세요.

```bash
# 0) 남을 계정 미리 확인 — 마스터와 홍그리1이 보여야 합니다
wrangler d1 execute screengolf --remote --command "SELECT id, login_id, name, nickname, role FROM members WHERE role='master' OR nickname='홍그리1' OR name='홍그리1' OR login_id='홍그리1'"
# 1) 백업
wrangler d1 export screengolf --remote --output=backup.sql
# 2) 초기화
wrangler d1 execute screengolf --remote --file=./reset.sql
```

테스트 계정은 개발자 로그인 → 회원 탭 → 🧪 테스트 도구에서 언제든 지우거나(테스트 데이터 전부 삭제) 다시 만들 수 있습니다.

---

## 이후 수정

파일을 고치고 push하면 Cloudflare가 자동으로 다시 배포합니다.

```bash
git add . && git commit -m "수정 내용" && git push
```

스키마를 바꿨을 때만 추가로:

```bash
wrangler d1 execute screengolf --remote --file=./schema.sql
```

---

## 설정값 바꾸기

배정 관련 설정은 `shared/assign.js` 맨 위에 있습니다. (고치면 Pages와 Worker에 함께 적용됩니다)

```js
export const ROOM_MAX = 4;          // 한 방 최대 인원
export const MAX_ROOMS = 6;         // 구장의 방 개수 (1~6번 방)
export const ASSIGN_LEAD_MIN = 20;  // 시작 몇 분 전에 배정할지
```

정식 마감 시각(전날 23:59)은 같은 파일의 `deadlineTs()`에 있습니다.

로그인 유지 기간은 `functions/api/[[path]].js`의 `SESSION_DAYS`입니다.

Worker를 고쳤을 때는 push만으로는 반영되지 않으니 다시 배포하세요.

```bash
cd worker && wrangler deploy && cd ..
```

---

## 동작 점검

배포 전에 로컬에서 핵심 로직을 한 번에 확인할 수 있습니다. (Node 22 이상)

```bash
node test.mjs
```

가입 승인·권한, 참가/보류/비참가 집계, Jev 연동(가짜 응답), reset.sql 초기화, 전날 23:59 보류 자동 제외, 당일 대기 접수,
정원 초과 차단, 대기자 확정, 시작 20분 전 Cron 배정, 방 6개 제한을 검사합니다.

## 알아두실 점

- **자동 배정 방식**: Cron Worker가 1분마다 확인해 시작 20분 전에 배정합니다.
  Cloudflare Cron은 보통 정시에 돌지만 서버 사정에 따라 1~2분 늦을 수 있습니다.
  혹시 Worker가 멈춰 있어도, 배정 시각이 지난 뒤 누군가 앱을 열면 그 순간 대신 배정되므로
  결과가 빠지는 일은 없습니다. 급할 땐 마스터가 **지금 배정하기**를 눌러도 됩니다.
- 마스터가 일정의 **날짜·시간을 바꾸면** 이미 배정된 방은 지워지고, 새 시각 20분 전에 다시 배정됩니다.
- 확정 참가자가 0명이면 배정하지 않습니다.
- **보류는 기록이 남습니다.** 자동 제외된 사람은 참가 현황에서 취소선으로 표시되고,
  본인 화면에도 "보류 상태로 마감을 넘겨 빠졌다"는 안내가 뜹니다.
- 당일에 참가자가 취소하면 그 자리는 비지만, 대기자를 자동으로 끌어올리지는 않습니다.
  구장 방 사정을 마스터가 확인하고 직접 확정하는 쪽이 안전하기 때문입니다.
- 시각은 모두 한국 시간(KST) 기준입니다.
- 무료 한도: Cloudflare Pages 하루 10만 요청, D1 하루 읽기 500만 행 — 동호회 규모에서는 남습니다.

## 파일 구조

```
screengolf/
├── public/
│   ├── index.html
│   ├── style.css           ← 디자인 (라이트/다크 자동, 휴대폰은 아래 탭바)
│   └── app.js
├── functions/
│   └── api/
│       └── [[path]].js     ← 모든 API
├── shared/
│   ├── assign.js           ← 방 배정 로직 (Pages·Worker 공용)
│   └── jev.js              ← TypeSafe Jev 연동 (카톡 대화 · 회원 찾기)
├── worker/
│   ├── src/index.js        ← 1분마다 도는 Cron
│   └── wrangler.toml
├── schema.sql
├── reset.sql               ← 운영 DB 초기화 + 테스트 계정
├── wrangler.toml
├── test.mjs
└── README.md
```
