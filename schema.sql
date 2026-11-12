-- Sauna Control D1 schema. Safe to re-run.

CREATE TABLE IF NOT EXISTS sessions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at      INTEGER NOT NULL,          -- epoch ms, heater on
  start_temp_f    REAL,
  target_f        REAL NOT NULL,
  predicted_min   REAL,                      -- preheat prediction at start
  fx_predicted_min REAL,                     -- the controller's own time-to-target estimate
  reached_at      INTEGER,                   -- first reading >= target
  ended_at        INTEGER,
  end_reason      TEXT,                      -- manual | max_time | controller | preheat_cap | error
  heater_on_ms    INTEGER DEFAULT 0,         -- session heater-on time (excl. bake-out)
  bakeout_ms      INTEGER DEFAULT 0,
  schedule_id     INTEGER,
  target_changed  INTEGER DEFAULT 0,
  went_offline    INTEGER DEFAULT 0,
  stopped_manually_preheat INTEGER DEFAULT 0,
  at_temp_min     REAL,
  left_at         INTEGER,                   -- owner tapped "I'm leaving"; it dried out until ended_at                      -- time at temperature chosen at start
  element_on_ms   INTEGER                    -- time the element was actually energized (it cycles), incl. bake-out
);

CREATE TABLE IF NOT EXISTS readings (
  session_id INTEGER NOT NULL,
  t          INTEGER NOT NULL,
  temp_f     REAL NOT NULL,
  humidity   REAL,
  heat_on    INTEGER                         -- element energized at this reading (1/0), null if unknown
);
CREATE INDEX IF NOT EXISTS readings_session ON readings(session_id, t);

CREATE TABLE IF NOT EXISTS schedules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  hot_by         INTEGER NOT NULL,           -- epoch ms
  target_f       REAL NOT NULL,
  bakeout_after  INTEGER DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | started | cancelled | failed
  start_at       INTEGER,                    -- latest computed start time
  predicted_min  REAL,
  created_at     INTEGER NOT NULL,
  session_id     INTEGER
);

CREATE TABLE IF NOT EXISTS push_subs (
  endpoint   TEXT PRIMARY KEY,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  role       TEXT NOT NULL,                  -- owner | friend
  created_at INTEGER NOT NULL,
  name       TEXT                             -- the friend's name, if they'd given it
);

CREATE TABLE IF NOT EXISTS comers (
  session_id INTEGER NOT NULL,
  client_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  at         INTEGER NOT NULL,
  phone      TEXT,                           -- optional, owner-only; for the "text them" button
  for_at     INTEGER,                        -- when they're coming; null = now
  PRIMARY KEY (session_id, client_id)
);

-- "Turn it on" requests while the sauna is off. Each lasts an hour; when the sauna starts,
-- live requests become "I'm coming" entries and the table is emptied.
CREATE TABLE IF NOT EXISTS requests (
  client_id TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  at        INTEGER NOT NULL,
  phone     TEXT,                             -- optional, owner-only
  for_at    INTEGER                           -- when they'd like to go; null = now
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS login_attempts (
  ip TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip, at);

CREATE TABLE IF NOT EXISTS wishlist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  url        TEXT,                            -- optional http(s) link
  created_at INTEGER NOT NULL
);

-- Every thermometer reading (every 30 s while on, about every 30 min while off), for the live "past hour" graph. Trimmed after 2 days.
CREATE TABLE IF NOT EXISTS temps (
  t       INTEGER PRIMARY KEY,
  temp_f  REAL NOT NULL,
  heat_on INTEGER
);
