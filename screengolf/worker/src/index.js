// 스크린골프 예약 Cron Worker
// 1분마다 깨어나서 두 가지를 합니다.
//  1) 마감(전날 23:59)이 지난 일정의 '보류'를 비참가로 정리
//  2) 시작 20분 전이 된 일정의 방을 확정 참가자로 배정

import { runSchedule } from "../../shared/assign.js";

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runSchedule(env).then(
        ({ dropped, assigned }) => {
          if (dropped) console.log(`[cron] 보류 ${dropped}명 자동 제외`);
          if (assigned) console.log(`[cron] 일정 ${assigned}건 배정 완료`);
        },
        (e) => console.error("[cron] 실패:", e)
      )
    );
  },

  // 브라우저로 열어 동작을 확인하거나 수동으로 한 번 돌릴 때 사용합니다.
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      const { dropped, assigned } = await runSchedule(env);
      return new Response(`보류 정리: ${dropped}명 / 배정한 일정: ${assigned}건`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("스크린골프 예약 Worker가 돌고 있습니다. 수동 실행은 /run", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
