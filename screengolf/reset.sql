DELETE FROM room_members WHERE member_id IN (SELECT id FROM members WHERE memo = '__TEST__');
DELETE FROM signups WHERE member_id IN (SELECT id FROM members WHERE memo = '__TEST__');
DELETE FROM sessions WHERE member_id IN (SELECT id FROM members WHERE memo = '__TEST__');
DELETE FROM member_aliases WHERE member_id IN (SELECT id FROM members WHERE memo = '__TEST__');
UPDATE results SET member_id = NULL WHERE member_id IN (SELECT id FROM members WHERE memo = '__TEST__');
DELETE FROM members WHERE memo = '__TEST__';
SELECT COUNT(*) AS 남은_회원수 FROM members;
