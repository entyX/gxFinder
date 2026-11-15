# gxFinder

Live standings and analytics for every public game on GX.games.

```
npm start          # http://localhost:4173
npm run dev        # restarts on server changes
```

Node 18+, no dependencies. The first run reads the whole GX.games catalogue (~80 requests, ~20 s); after that it loads from `data/index.json` and refreshes every 30 minutes.

## How it works

- `server.js` crawls `api.gx.games/gxc/v3/games` (the public API the GX.games site uses), keeps the catalogue in memory, and computes every board and per-category rank locally. It also serves the site and proxies game details, since the GX.games API doesn't allow browser cross-origin requests.
- A snapshot of plays/players is saved to `data/snapshots/` every 6 hours (last 60 kept). Weekly deltas and the "Plays over time" chart come from these, so they fill in the longer the server runs.
- `public/` is a dependency-free single-page app (hash routing).

## API

| Endpoint | |
|---|---|
| `GET /api/meta` | Build status, catalogue totals, category list |
| `GET /api/games?sort=&tag=&studio=&q=&offset=&limit=` | Ranked list. `sort`: plays, players, week, time, session, rating, newest, updated |
| `GET /api/search?q=` | Top 8 matches by name or studio |
| `GET /api/game/:shortId` | Full report: board ranks, category ranks, rivals, studio, history, details |

The GX.games API is undocumented and may change; `server.js` is the only place that talks to it.
