-- 운영 DB 초기화: 마스터 + 개발자(홍그리1)만 남기고 전부 지운 뒤, 테스트 계정 test1~test20을 만든다.
--
--   ⚠ 일정 · 참가 신청 · 방 배정 · 대회 결과 · 공지가 모두 지워집니다. 되돌릴 수 없으니 먼저 백업하세요.
--   wrangler d1 export screengolf --remote --output=backup.sql
--   wrangler d1 execute screengolf --remote --file=./reset.sql
--
-- 테스트 계정: 아이디 test1 ~ test20 / 비밀번호 1234 / 닉네임 테스트1 ~ 테스트20 (정회원)
-- 개발자 계정의 '테스트 데이터 전부 삭제' 버튼으로 언제든 지울 수 있습니다.

-- 1. 홍그리1 → 개발자 등급
UPDATE members SET role = 'dev', status = 'approved'
 WHERE nickname = '홍그리1' OR name = '홍그리1' OR login_id = '홍그리1';

-- 2. 마스터 · 홍그리1 말고는 모두 삭제 (닉네임이 비어 있는 계정도 지워지도록 IFNULL)
DELETE FROM members
 WHERE NOT (role = 'master' OR IFNULL(nickname, '') = '홍그리1' OR name = '홍그리1' OR login_id = '홍그리1');

-- 3. 남은 계정에 딸린 것 말고는 모두 비우기
DELETE FROM sessions       WHERE member_id NOT IN (SELECT id FROM members);
DELETE FROM member_aliases WHERE member_id NOT IN (SELECT id FROM members);
DELETE FROM room_members;
DELETE FROM rooms;
DELETE FROM signups;
DELETE FROM results;
DELETE FROM events;
DELETE FROM notices;

-- 4. 테스트 계정 20개 (비밀번호 1234 — 앱과 같은 PBKDF2 해시)
INSERT OR IGNORE INTO members (login_id, name, nickname, gz_mask, pw_hash, pw_salt, role, status, memo, created_at)
SELECT 'test' || n, '테스트' || n, '테스트' || n, 'test' || n || '**',
       'gUtyAD7qE8zCkNl+JxtxeFqgsecpuLAnqabCREzY+J0=', 'b7221a1d138f47a6c37eaebe32158a34',
       'member', 'approved', '__TEST__', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM c WHERE n < 20) SELECT n FROM c);

-- 결과 확인
SELECT id, login_id, name, nickname, role FROM members ORDER BY
  CASE role WHEN 'master' THEN 0 WHEN 'dev' THEN 1 ELSE 2 END, id;
