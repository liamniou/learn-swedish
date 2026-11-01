# Adding a new homework lesson

The user sends homework (links, PDFs, screenshots) about twice a week. Each homework becomes **one lesson folder**.

1. Create `lessons/NN-slug/` (next number, short Swedish slug, e.g. `02-familj`).
2. Add `lesson.json` (format below) and, if there's theory, a `notes.html` fragment.
3. Append the folder name to `lessons/index.json`.
4. Run `node scripts/validate.mjs`. It must pass.
5. Commit and push to `main`. The *Build and publish image* workflow publishes `ghcr.io/liamniou/learn-swedish:YYYY.M.D.<run>`. Get the tag and digest from the run summary, or with `gh run view --log | grep -o 'learn-swedish:[0-9.]*@sha256:[0-9a-f]*'`.
6. Deploy: in `~/git/gitops` (`liamniou/gitops`), `git pull`, set that `image:` tag@digest in `eva00/learn-swedish/compose.yaml`, then commit (`learn-swedish: <tag>`) and push to `main`. doco-cd on eva00 redeploys within about 60 seconds. Verify with `curl http://192.168.0.237:7480/lessons/index.json`.

Never rename an existing lesson folder or change an existing word's `sv` value. Progress is keyed by `lessonId/sv`, so a rename resets that word's progress.

Progress is stored server-side (`/api/sync`). Don't change the progress key format or the entry shape (`box`, `due`, `right`, `wrong`, `t`) without migrating `/home/lestar/_volumes/learn-swedish/data/state.json`.

## lesson.json

```jsonc
{
  "title": "Правила чтения",          // Russian title (shown in the UI)
  "titleSv": "Uttalsregler",          // optional
  "date": "2026-10-25",               // date homework was given, YYYY-MM-DD
  "summary": "…",                     // optional, one or two sentences
  "notes": "notes.html",              // optional theory fragment in the same folder
  "listen": [{ "label": "Rivstart, трек 3 (стр. 11)", "url": "https://…" }],  // optional audio links (shown as "🎧 Слушать")
  "listenNote": "…",                  // optional hint under the audio links
  "sources": [{ "label": "…", "url": "…" }],
  "sections": [
    {
      "title": "Упражнение № 2",
      "note": "optional",
      "words": [
        {
          "sv": "ett hjärta",          // nouns WITH en/ett, verbs WITH att
          "ru": "сердце",
          "hint": "hj → [й]",          // optional pronunciation or grammar hint
          "ex": "Mitt hjärta slår snabbt.",  // optional example sentence (simple, correct Swedish)
          "exRu": "Моё сердце бьётся быстро."
        }
      ]
    }
  ],
  "drills": [                          // optional multiple-choice drills
    {
      "title": "Как читается выделенное?",
      "items": [
        { "word": "känna", "focus": "k", "ru": "знать", "answer": "[щ]",
          "options": ["[к]", "[щ]", "[ɧ]", "[х]"], "why": "k перед ä → [щ]" }
      ]
    }
  ]
}
```

`drills` are generic. The `focus` substring is highlighted in `word`, so the same structure works for grammar questions (e.g. word = sentence with a gap, focus = "___"). Each drill gets its own button on the lesson page. Set `"ordered": true` on a drill to keep item order (e.g. answers that follow an audio track).

## Textbook audio

Never download or commit textbook audio, scans or full texts: the repo and image are public, and the books forbid copying. Link to the digital book with `listen` instead. The NoK portal login is the `konto.nok.se` item in Vaultwarden.

## Content guidelines

- Translations and all UI text are in **Russian**.
- Include every word from the homework. Skip words that already exist in earlier lessons unless they're the point of the exercise.
- Write theory notes in your own words. Don't copy source material verbatim. Credit sources in `sources`.
- `notes.html` is an HTML fragment (no `<html>`/`<body>`). Use `<h2>`, `<p>`, `<ul>`, `<table>`, and `<div class="callout">`. Wrap Swedish in `<i lang="sv">`.
- Pronunciation notation: [щ] for the tj sound, [ɧ] for the sj sound, [й], [ŋ].
