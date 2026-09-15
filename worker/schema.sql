-- IKC Driver Briefing Check-in : D1 schema
-- Apply with:  npx wrangler d1 execute ikc-checkin --remote --file=./schema.sql

DROP TABLE IF EXISTS checkins;
DROP TABLE IF EXISTS entries;
DROP TABLE IF EXISTS people;
DROP TABLE IF EXISTS events;

CREATE TABLE events (
  id          TEXT PRIMARY KEY,          -- short public slug used in the QR url
  name        TEXT NOT NULL,
  event_date  TEXT,                      -- ISO yyyy-mm-dd
  status      TEXT NOT NULL DEFAULT 'open',  -- open | closed
  created_at  TEXT NOT NULL
);

-- One row per PERSON per event. A person may hold several entries (classes);
-- checking in once satisfies all of them.
CREATE TABLE people (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_key  TEXT NOT NULL,             -- CRN when present, else normalised name
  entrant     TEXT NOT NULL,
  guardian    TEXT,
  is_junior   INTEGER NOT NULL DEFAULT 0,-- 1 when guardian is not "Not Applicable"
  crn         TEXT,
  email       TEXT,
  mobile      TEXT,
  home_club   TEXT,
  UNIQUE (event_id, person_key)
);

-- One row per SPREADSHEET ROW (a class entry).
CREATE TABLE entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id   INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  kart_no     TEXT NOT NULL,
  class       TEXT NOT NULL,
  transponder TEXT,
  kart        TEXT,
  engine      TEXT,
  member_type TEXT,
  row_no      INTEGER                    -- original row order, for stable sorting
);

CREATE TABLE checkins (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id     TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id    INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  device_id    TEXT,                      -- browser token, the de-dupe key
  ip           TEXT,                      -- recorded for admin visibility only
  user_agent   TEXT,
  source       TEXT NOT NULL DEFAULT 'self',   -- self | admin
  -- The driver ticked "I have read the driver briefing notes". Enforced by the
  -- API, not just the page, so it stands up as a record.
  acknowledged INTEGER NOT NULL DEFAULT 0,
  ack_text     TEXT,                      -- exact wording shown at the time
  created_at   TEXT NOT NULL,
  UNIQUE (event_id, person_id)
);

CREATE INDEX idx_people_event    ON people   (event_id);
CREATE INDEX idx_entries_event   ON entries  (event_id);
CREATE INDEX idx_entries_person  ON entries  (person_id);
CREATE INDEX idx_entries_class   ON entries  (event_id, class);
CREATE INDEX idx_checkins_event  ON checkins (event_id);
CREATE INDEX idx_checkins_device ON checkins (event_id, device_id);
