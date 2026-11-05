# Adding a new homework lesson

The user sends homework (links, PDFs, screenshots) about twice a week. Each homework becomes **one lesson folder**. Every new message with homework material is a new lesson, even if it's on the same day or topic as the previous one. Never add new material to an existing lesson unless the user explicitly asks.

1. Create `lessons/NN-slug/` (next number, short Swedish slug, e.g. `02-familj`).
2. Add `lesson.json` (format below) and, if there's theory, a `notes.html` fragment.
3. Append the folder name to `lessons/index.json`.
4. Run `node scripts/validate.mjs`. It must pass.
5. Commit and push to `main`. The *Build and publish image* workflow publishes `ghcr.io/liamniou/learn-swedish:YYYY.M.D.<run>`. Get the tag and digest from the run summary, or with `gh run view --log | grep -o 'learn-swedish:[0-9.]*@sha256:[0-9a-f]*'`.
6. Deploy: in `~/git/gitops` (`liamniou/gitops`), `git pull`, set that `image:` tag@digest in `eva00/learn-swedish/compose.yaml`, then commit (`learn-swedish: <tag>`) and push to `main`. doco-cd on eva00 redeploys within about 60 seconds. Verify with `curl http://192.168.0.237:7480/lessons/index.json`.

Never rename an existing lesson folder or change an existing word's `sv` value. Progress is keyed by `lessonId/sv`, so a rename resets that word's progress.

Progress is stored server-side (`/api/sync`). Don't change the progress key format or the entry shape (`box`, `due`, `right`, `wrong`, `t`) without migrating every `/home/lestar/_volumes/learn-swedish/data/users/<id>/state.json`. Exercise results are keyed by `lessonId#drillTitle` (or `lessonId#id` when the drill has an `id`), so renaming a drill title resets its result. Give a drill an `id` before renaming it. Written exercise answers are keyed by `lessonId#exerciseId`, so never change an exercise `id`.

## Users

Users and PINs live only on eva00 in `/home/lestar/_volumes/learn-swedish/data/users.json`, never in git (the repo, image and gitops repo are all public):

```json
{ "users": [ { "id": "stas", "name": "Stas", "pin": "1234" }, { "id": "marina", "name": "Marina", "pin": "5678" } ] }
```

- `id` is lowercase a-z0-9-, `pin` is 4–8 digits. The server re-reads the file when it changes, so no restart is needed.
- Changing a PIN logs that user out on all devices. Removing a user blocks login but keeps `data/users/<id>/`.
- Each user's progress is in `data/users/<id>/state.json`, with daily snapshots next to it. The pre-users `data/state.json` was migrated to the first user (`stas`) and kept as `state.legacy.json`.
- `data/session-secret` signs login cookies. Deleting it logs everyone out.
- After 5 wrong PINs from one IP, login is locked, starting at 30 s and growing to 15 min.

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
          "pron": "йэ́(р)та",           // REQUIRED: Cyrillic pronunciation, stress with ́
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
        { "label": "3", "type": "write", "prompt": "Skriv 5 exempel med inte.", "rows": 5 },
        { "label": "4", "type": "write", "prompt": "Я не понимаю учителя.", "rows": 2,
          "answer": ["Jag förstår inte läraren.", "Jag förstår inte min lärare."], "note": "…" }
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
- `write`: free text. Without `answer` it's only saved. With `answer` (model variants, e.g. translations) the answer is compared with the closest variant. An exact match (ignoring case and punctuation, `idag` = `i dag`) is counted. Otherwise the differing words are highlighted and the user can press «Засчитать». List all reasonable variants, and in `note` explain grammar the learner hasn't covered yet (e.g. definite forms).

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

- **Every word needs `pron`**, its pronunciation in Cyrillic (the validator enforces it). Mark stress with a combining acute (U+0301) on multi-syllable words. Use [ɧ] for the sj sound, [щ] for the tj sound, [ŋ] for ng, `(р)` for the near-silent r in rn/rt/rd/rl, and ш for rs. Write long u as ю and short u as у. Long o is usually у, but loanwords like ekonom use о. Check rules before writing a hint: dj/gj/lj/hj → [й] only at the start of a word.
- Verbs go in as `att` + infinitive, with the present form and its pronunciation in `hint` (`jag bor [бур]`).
- `scripts/format-lessons.py lessons/*/lesson.json` keeps lesson files at one line per word, item or part.

- Translations and all UI text are in **Russian**.
- Include every word from the homework. Skip words that already exist in earlier lessons unless they're the point of the exercise.
- Write theory notes in your own words. Don't copy source material verbatim. Credit sources in `sources`.
- `notes.html` is an HTML fragment (no `<html>`/`<body>`). Use `<h2>`, `<p>`, `<ul>`, `<table>`, and `<div class="callout">`. Wrap Swedish in `<i lang="sv">`.
- Pronunciation notation: [щ] for the tj sound, [ɧ] for the sj sound, [й], [ŋ].
