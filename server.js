require("dotenv").config();
const db = require("./db");
const express = require("express");
const fetch = require("node-fetch");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const API_KEY = process.env.FOOTBALL_API_KEY;
const BASE_URL = "https://api.football-data.org/v4";

const COMPETITIONS = {
  PL:  { name: "Premier League",   country: "England",  emoji: "🏴󠁧󠁢󠁥󠁮󠁧󠁿" },
  PD:  { name: "La Liga",          country: "Spain",    emoji: "🇪🇸" },
  SA:  { name: "Serie A",          country: "Italy",    emoji: "🇮🇹" },
  BL1: { name: "Bundesliga",       country: "Germany",  emoji: "🇩🇪" },
  FL1: { name: "Ligue 1",          country: "France",   emoji: "🇫🇷" },
  CL:  { name: "Champions League", country: "Europe",   emoji: "⭐" },
};

async function fetchMatches(competitionCode) {
  const url = `${BASE_URL}/competitions/${competitionCode}/matches?status=SCHEDULED&limit=10`;
  const res = await fetch(url, {
    headers: { "X-Auth-Token": API_KEY }
  });

  if (res.status === 403) throw { code: 403, message: "API key invalid or competition not available on your plan." };
  if (res.status === 429) throw { code: 429, message: "Rate limit hit. Wait a minute and try again." };
  if (!res.ok) throw { code: res.status, message: `Failed to fetch ${competitionCode}` };

  const data = await res.json();
  return data.matches || [];
}

app.get("/api/fixtures", async (req, res) => {
  try {
    const results = {};

    for (const [code, info] of Object.entries(COMPETITIONS)) {
      try {
        const matches = await fetchMatches(code);
        results[code] = {
          ...info,
          matches: matches.slice(0, 10).map(m => ({
            id: m.id,
            homeTeam: m.homeTeam.name,
            awayTeam: m.awayTeam.name,
            utcDate: m.utcDate,
            status: m.status,
            matchday: m.matchday,
          }))
        };
      } catch (err) {
        results[code] = { ...info, matches: [], error: err.message };
      }
    }

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Player login / register ──────────────────────────────────────────
app.post("/api/player/login", (req, res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN required." });
  if (pin.length < 4) return res.status(400).json({ error: "PIN must be at least 4 digits." });

  let player = db.prepare("SELECT * FROM players WHERE name = ?").get(name.trim());

  if (!player) {
    db.prepare("INSERT INTO players (name, pin) VALUES (?, ?)").run(name.trim(), pin);
    player = db.prepare("SELECT * FROM players WHERE name = ?").get(name.trim());
    return res.json({ success: true, player: { id: player.id, name: player.name }, isNew: true });
  }

  if (player.pin !== pin) {
    return res.status(401).json({ error: "Wrong PIN for this name." });
  }

  res.json({ success: true, player: { id: player.id, name: player.name }, isNew: false });
});

// ── Save fixtures to DB then return them ─────────────────────────────
app.post("/api/matches/sync", async (req, res) => {
  const { competition } = req.body;
  if (!competition) return res.status(400).json({ error: "Competition code required." });

  try {
    const url = `${BASE_URL}/competitions/${competition}/matches?status=SCHEDULED&limit=10`;
    const r = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
    if (!r.ok) throw new Error("Failed to fetch fixtures.");
    const data = await r.json();
    const matches = data.matches || [];

    const insert = db.prepare(`
      INSERT INTO matches (id, competition, matchday, home_team, away_team, utc_date, status)
      VALUES (@id, @competition, @matchday, @home_team, @away_team, @utc_date, @status)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status, synced_at=datetime('now')
    `);

    const insertMany = db.transaction((ms) => {
      for (const m of ms) insert.run({
        id: m.id,
        competition,
        matchday: m.matchday,
        home_team: m.homeTeam.name,
        away_team: m.awayTeam.name,
        utc_date: m.utcDate,
        status: m.status,
      });
    });
    insertMany(matches);

    const saved = db.prepare("SELECT * FROM matches WHERE competition = ? AND status = 'SCHEDULED' ORDER BY utc_date LIMIT 10").all(competition);
    res.json({ success: true, matches: saved });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Submit predictions ───────────────────────────────────────────────
app.post("/api/predictions", (req, res) => {
  const { playerId, predictions } = req.body;
  if (!playerId || !predictions?.length) {
    return res.status(400).json({ error: "Player and predictions required." });
  }

  const insert = db.prepare(`
    INSERT INTO predictions (player_id, match_id, home_score, away_score)
    VALUES (@playerId, @matchId, @homeScore, @awayScore)
    ON CONFLICT(player_id, match_id) DO UPDATE SET
      home_score=excluded.home_score,
      away_score=excluded.away_score,
      submitted_at=datetime('now')
  `);

  const insertAll = db.transaction((preds) => {
    for (const p of preds) insert.run(p);
  });

  try {
    insertAll(predictions.map(p => ({
      playerId,
      matchId: p.matchId,
      homeScore: p.homeScore,
      awayScore: p.awayScore,
    })));
    res.json({ success: true, saved: predictions.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get existing predictions for a player ───────────────────────────
app.get("/api/predictions/:playerId", (req, res) => {
  const preds = db.prepare(`
    SELECT match_id, home_score, away_score FROM predictions WHERE player_id = ?
  `).all(req.params.playerId);
  res.json(preds);
});

// ── Fetch real results + score all predictions ───────────────────────
app.post("/api/results/sync", async (req, res) => {
  const { competition } = req.body;
  if (!competition) return res.status(400).json({ error: "Competition code required." });

  try {
    const url = `${BASE_URL}/competitions/${competition}/matches?status=FINISHED&limit=10`;
    const r = await fetch(url, { headers: { "X-Auth-Token": API_KEY } });
    if (!r.ok) throw new Error("Failed to fetch results from API.");
    const data = await r.json();
    const finished = data.matches || [];

    if (!finished.length) {
      return res.json({ success: true, message: "No finished matches found.", scored: 0 });
    }

    // Update match results in DB
    const updateMatch = db.prepare(`
      INSERT INTO matches (id, competition, matchday, home_team, away_team, utc_date, status, home_score, away_score)
      VALUES (@id, @competition, @matchday, @home_team, @away_team, @utc_date, 'FINISHED', @home, @away)
      ON CONFLICT(id) DO UPDATE SET
        status     = 'FINISHED',
        home_score = @home,
        away_score = @away
    `);

    // Score a single prediction
    const scorePred = db.prepare(`
      UPDATE predictions SET points = @points
      WHERE player_id = @playerId AND match_id = @matchId
    `);

    let totalScored = 0;

    const syncAll = db.transaction(() => {
      for (const m of finished) {
        const home = m.score?.fullTime?.home;
        const away = m.score?.fullTime?.away;
        if (home === null || away === null || home === undefined) continue;

        updateMatch.run({
          id: m.id,
          competition,
          matchday: m.matchday,
          home_team: m.homeTeam.name,
          away_team: m.awayTeam.name,
          utc_date: m.utcDate,
          home: m.score?.fullTime?.home,
          away: m.score?.fullTime?.away,
        });

        // Get all predictions for this match
        const preds = db.prepare(
          "SELECT * FROM predictions WHERE match_id = ?"
        ).all(m.id);

        for (const pred of preds) {
          let points = 0;

          const actualResult  = Math.sign(home - away);
          const predResult    = Math.sign(pred.home_score - pred.away_score);

          if (pred.home_score === home && pred.away_score === away) {
            points = 3; // exact score
          } else if (actualResult === predResult) {
            points = 1; // correct result
          }

          scorePred.run({ points, playerId: pred.player_id, matchId: pred.match_id });
          totalScored++;
        }
      }
    });

    syncAll();

    res.json({
      success: true,
      message: `Synced ${finished.length} results, scored ${totalScored} predictions.`,
      scored: totalScored,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get scored predictions for a player ─────────────────────────────
app.get("/api/results/:playerId", (req, res) => {
  const rows = db.prepare(`
    SELECT
      m.home_team, m.away_team, m.home_score AS actual_home, m.away_score AS actual_away,
      m.competition, m.matchday,
      pr.home_score AS pred_home, pr.away_score AS pred_away, pr.points
    FROM predictions pr
    JOIN matches m ON m.id = pr.match_id
    WHERE pr.player_id = ? AND m.status = 'FINISHED'
    ORDER BY m.utc_date DESC
  `).all(req.params.playerId);
  res.json(rows);
});

// ── Overall leaderboard snapshot ─────────────────────────────────────
app.get("/api/leaderboard", (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name,
      COALESCE(SUM(pr.points), 0) AS total_points,
      COUNT(pr.id)                AS predictions_made,
      SUM(CASE WHEN pr.points = 3 THEN 1 ELSE 0 END) AS exact_scores,
      SUM(CASE WHEN pr.points = 1 THEN 1 ELSE 0 END) AS correct_results
    FROM players p
    LEFT JOIN predictions pr ON pr.player_id = p.id
    GROUP BY p.id
    ORDER BY total_points DESC
  `).all();
  res.json(rows);
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`⚽ Footy Predictor running at http://localhost:${PORT}`);
});