# Adding a new homework lesson

The user sends homework (links, PDFs, screenshots) about twice a week. Each homework becomes **one lesson folder**.

1. Create `lessons/NN-slug/` (next number, short Swedish slug, e.g. `02-familj`).
2. Add `lesson.json` (format below) and, if there's theory, a `notes.html` fragment.
3. Append the folder name to `lessons/index.json`.
4. Run `node scripts/validate.mjs`. It must pass.
5. Commit and push to `main`. GitHub Pages deploys automatically.

Never rename an existing lesson folder or change an existing word's `sv` value. Progress is keyed by `lessonId/sv`, so a rename resets that word's progress.

## lesson.json

```jsonc
{
  "title": "Правила чтения",          // Russian title (shown in the UI)
  "titleSv": "Uttalsregler",          // optional
  "date": "2026-10-25",               // date homework was given, YYYY-MM-DD
  "summary": "…",                     // optional, one or two sentences
  "notes": "notes.html",              // optional theory fragment in the same folder
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

`drills` are generic. The `focus` substring is highlighted in `word`, so the same structure works for grammar questions (e.g. word = sentence with a gap, focus = "___").

## Content guidelines

- Translations and all UI text are in **Russian**.
- Include every word from the homework. Skip words that already exist in earlier lessons unless they're the point of the exercise.
- Write theory notes in your own words. Don't copy source material verbatim. Credit sources in `sources`.
- `notes.html` is an HTML fragment (no `<html>`/`<body>`). Use `<h2>`, `<p>`, `<ul>`, `<table>`, and `<div class="callout">`. Wrap Swedish in `<i lang="sv">`.
- Pronunciation notation: [щ] for the tj sound, [ɧ] for the sj sound, [й], [ŋ].
