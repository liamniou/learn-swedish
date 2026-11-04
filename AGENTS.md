# Adding a new homework lesson

The user sends homework (links, PDFs, screenshots) about twice a week. Each homework becomes **one lesson folder**.

1. Create `lessons/NN-slug/` (next number, short Swedish slug, e.g. `02-familj`).
2. Add `lesson.json` (format below) and, if there's theory, a `notes.html` fragment.
3. Append the folder name to `lessons/index.json`.
4. Run `node scripts/validate.mjs`. It must pass.
5. Commit and push to `main`. The *Build and publish image* workflow publishes `ghcr.io/liamniou/learn-swedish:YYYY.M.D.<run>`. Get the tag and digest from the run summary, or with `gh run view --log | grep -o 'learn-swedish:[0-9.]*@sha256:[0-9a-f]*'`.
6. Deploy: in `~/git/gitops` (`liamniou/gitops`), `git pull`, set that `image:` tag@digest in `eva00/learn-swedish/compose.yaml`, then commit (`learn-swedish: <tag>`) and push to `main`. doco-cd on eva00 redeploys within about 60 seconds. Verify with `curl http://192.168.0.237:7480/lessons/index.json`.

Never rename an existing lesson folder or change an existing word's `sv` value. Progress is keyed by `lessonId/sv`, so a rename resets that word's progress.

Progress is stored server-side (`/api/sync`). Don't change the progress key format or the entry shape (`box`, `due`, `right`, `wrong`, `t`) without migrating `/home/lestar/_volumes/learn-swedish/data/state.json`. Exercise results are keyed by `lessonId#drillTitle` (or `lessonId#id` when the drill has an `id`), so renaming a drill title resets its result. Give a drill an `id` before renaming it. Written exercise answers are keyed by `lessonId#exerciseId`, so never change an exercise `id`.

## lesson.json

```jsonc
{
  "title": "Правила чтения",          // Russian title (shown in the UI)
  "titleSv": "Uttalsregler",          // optional
  "date": "2026-10-25",               // date homework was given, YYYY-MM-DD
  "summary": "…",                     // optional, one or two sentences
  "notes": "notes.html",              // optional theory fragment in the same folder
  "audio": [{ "id": "rivstart-a1a2-k1-03", "label": "Трек 3 · упр. H, стр. 11" }],  // optional in-page players; ids only, never URLs
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
  "exercises": [                       // optional written book exercises (answers saved, re-openable)
    {
      "id": "f",                       // stable, a-z0-9-
      "title": "Упр. F (стр. 14): Vilka ord hör du?",
      "audio": "rivstart-a1a2-k1-05",  // optional player above the task
      "task": "Lyssna. Vilka ord hör du? Kryssa för rätt alternativ.",  // book instruction (Swedish)
      "taskRu": "…",
      "parts": [
        { "label": "1", "type": "check", "options": ["pensionär", "kock"], "answer": ["kock"], "note": "shown after checking" },
        { "label": "2", "type": "blanks", "text": "Ravi kommer från {{Indien}}. Han talar {{engelska|English}} och {{}}." },
        { "label": "3", "type": "write", "prompt": "Skriv 5 exempel med inte.", "rows": 5 }
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

Use `exercises` whenever the book task is written (tick, fill in, write). Part types:

- `check`: tick boxes. `answer` lists the correct options.
- `blanks`: `{{answer|alternative}}` is a checked gap, `{{}}` is a free gap (saved, not checked).
- `write`: free text, saved, not checked.

Answers autosave as a draft. "Проверить" marks right and wrong answers, and the exercise stays viewable with them until the user edits or clears it.

A drill can be tied to a track: `"audio": "<audio id>"` plus an optional `"intro"`. The player then sits above the questions and keeps playing between them. Use `"ordered": true` so questions follow the recording.

`drills` are generic. The `focus` substring is highlighted in `word`, so the same structure works for grammar questions (e.g. word = sentence with a gap, focus = "___"). Each drill gets its own button on the lesson page. Set `"ordered": true` on a drill to keep item order (e.g. answers that follow an audio track).

## Textbook audio

The repo and the GHCR image are public, so never commit textbook audio, scans, transcripts or direct audio URLs. Audio plays inside the portal through `/api/audio/<id>`. The server resolves the id on eva00 under `/home/lestar/_volumes/learn-swedish/data/`:

- `audio/<id>.mp3`, if present, is served directly (with seeking).
- Otherwise `audio-sources.json` (`{ "<id>": "https://…" }`) maps the id to an upstream URL, which the server streams.

To add a track:

1. Sign in to the NoK portal with the `konto.nok.se` item from Vaultwarden.
2. Open the chapter's *Ljudfiler* page and play the track.
3. Read the `files.nokportalen.se/audios/transcoded/<uuid>` URL from the page's network requests.
4. Add it to `audio-sources.json` on eva00 (`ssh lestar@192.168.0.237`).

Track ids: `rivstart-a1a2-k<chapter>-<track, 2 digits>`. The track number is the ((N)) printed in the book next to the exercise. The DOM or network order on the Ljudfiler page doesn't match track order. To map a track to its file, hook `HTMLMediaElement.prototype.play` in the page, click that track's play button, and record `currentSrc`.

The *Hörförståelsetexter* PDF in the extra material (Hörförståelsetexter → Ladda ner) has transcripts for checking answers. Its headings are `<textbook section> <exercise letter>`, e.g. `3 F` = section 3, exercise F, not track numbers.

## Content guidelines

- Translations and all UI text are in **Russian**.
- Include every word from the homework. Skip words that already exist in earlier lessons unless they're the point of the exercise.
- Write theory notes in your own words. Don't copy source material verbatim. Credit sources in `sources`.
- `notes.html` is an HTML fragment (no `<html>`/`<body>`). Use `<h2>`, `<p>`, `<ul>`, `<table>`, and `<div class="callout">`. Wrap Swedish in `<i lang="sv">`.
- Pronunciation notation: [щ] for the tj sound, [ɧ] for the sj sound, [й], [ŋ].
