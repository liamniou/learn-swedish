# Svenska: учим шведский

A Swedish learning portal with a Russian UI. It runs on `eva00` at http://192.168.0.237:7480 and is deployed through [liamniou/gitops](https://github.com/liamniou/gitops) (`eva00/learn-swedish`).

Features: flip cards (sv ↔ ru), spaced-repetition review, multiple-choice quiz, a typing quiz (with å/ä/ö buttons and en/ett checks), lesson theory notes, example sentences, and per-lesson pronunciation drills.

## How it works

- The frontend is plain HTML, CSS and JS (`index.html`, `assets/`, `lessons/`). There is no build step.
- `server/server.mjs` is a dependency-free Node server. It serves the frontend and stores progress in `$DATA_DIR/state.json`, with daily snapshots `state-YYYY-MM-DD.json` (the last 30 are kept).
- The browser keeps a localStorage cache and syncs through `POST /api/sync`. Every card entry has a timestamp, and the newest one wins, so several devices can be used at once. Changes made offline are queued and sent once the server is reachable. The cloud icon in the header shows sync status.
- Import and reset (in the home page settings) replace the server state for all devices.

API: `GET /api/health`, `GET /api/state`, `POST /api/sync`, `PUT /api/state`, `GET /api/audio/<id>`.

Lesson audio plays inside the portal. Track ids map to files or upstream URLs in the private data folder, never in git (see [AGENTS.md](AGENTS.md)).

## Run locally

```bash
node server/server.mjs        # http://localhost:8080, data in ./data
node scripts/validate.mjs     # check lesson files
```

## Deploy

1. Push to `main`. The [build workflow](.github/workflows/build.yml) validates lessons and publishes `ghcr.io/liamniou/learn-swedish:YYYY.M.D.<run>`. The job summary shows the tag and digest.
2. In `liamniou/gitops`, update the image tag and digest in `eva00/learn-swedish/compose.yaml`, then push. doco-cd redeploys within about a minute.

Progress data lives on eva00 in `/home/lestar/_volumes/learn-swedish/data`.

## Adding homework

See [AGENTS.md](AGENTS.md).
