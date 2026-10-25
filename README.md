# Svenska: учим шведский

A static Swedish learning portal (Russian UI), hosted on GitHub Pages: https://liamniou.github.io/learn-swedish/

Features: flip cards (sv ↔ ru), spaced-repetition review (progress kept in `localStorage`), multiple-choice quiz, a typing quiz (with å/ä/ö buttons and en/ett checks), lesson theory notes, example sentences, and per-lesson pronunciation drills.

There is no build step. It's plain HTML, CSS and JS.

## Run locally

```bash
python3 -m http.server 8000   # then open http://localhost:8000
node scripts/validate.mjs     # check lesson files
```

## Adding homework

See [AGENTS.md](AGENTS.md) for the lesson format.
