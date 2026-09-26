CREATE TABLE IF NOT EXISTS jackpots ( id INTEGER PRIMARY KEY AUTOINCREMENT, event_id INTEGER NOT NULL, kind TEXT NOT NULL, label TEXT NOT NULL, amount INTEGER NOT NULL DEFAULT 0, note TEXT, winner_id INTEGER, winner_name TEXT, hole_no INTEGER, won_at TEXT, carried_to INTEGER, created_by INTEGER, created_at TEXT NOT NULL );
CREATE INDEX IF NOT EXISTS idx_jackpots_event ON jackpots(event_id);
ALTER TABLE members ADD COLUMN dues_year INTEGER;
