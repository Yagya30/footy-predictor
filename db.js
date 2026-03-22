const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "footy.db"));

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    name      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin       TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS matches (
    id          INTEGER PRIMARY KEY,
    competition TEXT NOT NULL,
    matchday    INTEGER,
    home_team   TEXT NOT NULL,
    away_team   TEXT NOT NULL,
    utc_date    TEXT NOT NULL,
    status      TEXT DEFAULT 'SCHEDULED',
    home_score  INTEGER,
    away_score  INTEGER,
    synced_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS predictions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     INTEGER NOT NULL REFERENCES players(id),
    match_id      INTEGER NOT NULL REFERENCES matches(id),
    home_score    INTEGER NOT NULL,
    away_score    INTEGER NOT NULL,
    points        INTEGER DEFAULT 0,
    submitted_at  TEXT DEFAULT (datetime('now')),
    UNIQUE(player_id, match_id)
  );
`);

console.log("✅ Database ready — tables created/verified");

module.exports = db;