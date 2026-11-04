#!/usr/bin/env node
// Validates lessons/index.json and every lesson folder. Usage: node scripts/validate.mjs
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const err = (where, msg) => errors.push(`${where}: ${msg}`);
const readJSON = p => JSON.parse(readFileSync(p, 'utf8'));

const index = readJSON(join(root, 'lessons/index.json'));
if (!Array.isArray(index.lessons)) err('index.json', '"lessons" must be an array');
if (new Set(index.lessons).size !== index.lessons.length) err('index.json', 'duplicate lesson ids');

let totalWords = 0, totalDrills = 0;
for (const id of index.lessons) {
  const dir = join(root, 'lessons', id);
  const file = join(dir, 'lesson.json');
  if (!existsSync(file)) { err(id, 'missing lesson.json'); continue; }
  let l;
  try { l = readJSON(file); } catch (e) { err(id, `invalid JSON: ${e.message}`); continue; }

  if (!l.title) err(id, 'missing title');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(l.date || '')) err(id, 'date must be YYYY-MM-DD');
  if (l.notes && !existsSync(join(dir, l.notes))) err(id, `notes file not found: ${l.notes}`);
  if (!Array.isArray(l.sections) || !l.sections.length) err(id, 'needs at least one section');
  const audioIds = new Set();
  for (const a of l.audio || []) {
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(a.id || '')) err(id, `audio id must be lowercase a-z0-9-: ${JSON.stringify(a)}`);
    if (!a.label) err(id, `audio "${a.id}" needs a label`);
    if (a.url || a.src) err(id, `audio "${a.id}": no URLs in lessons; map ids in data/audio-sources.json on the server`);
    audioIds.add(a.id);
  }
  for (const d of l.drills || []) if (d.audio && !audioIds.has(d.audio)) err(id, `drill "${d.title}" uses unknown audio "${d.audio}"`);

  const exIds = new Set();
  for (const x of l.exercises || []) {
    const where = `${id} exercise "${x.id}"`;
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(x.id || '')) err(where, 'id must be lowercase a-z0-9-');
    if (exIds.has(x.id)) err(where, 'duplicate exercise id');
    exIds.add(x.id);
    if (!x.title) err(where, 'missing title');
    if (x.audio && !audioIds.has(x.audio)) err(where, `unknown audio "${x.audio}"`);
    if (!Array.isArray(x.parts) || !x.parts.length) { err(where, 'needs parts'); continue; }
    for (const [pi, part] of x.parts.entries()) {
      const w = `${where} part[${pi}]`;
      if (part.type === 'check') {
        if (!Array.isArray(part.options) || part.options.length < 2) err(w, 'check needs 2+ options');
        if (new Set(part.options).size !== part.options?.length) err(w, 'duplicate options');
        for (const a of part.answer || []) if (!part.options?.includes(a)) err(w, `answer "${a}" not among options`);
      } else if (part.type === 'blanks') {
        if (!/\{\{[^}]*\}\}/.test(part.text || '')) err(w, 'blanks text needs at least one {{gap}}');
      } else if (part.type === 'write') {
        if (!part.prompt && !part.label) err(w, 'write needs a prompt or label');
        if (part.answer !== undefined && (!Array.isArray(part.answer) || !part.answer.length || part.answer.some(a => typeof a !== 'string' || !a.trim()))) err(w, 'write answer must be a non-empty array of strings');
      } else err(w, `unknown part type "${part.type}"`);
    }
  }

  const seen = new Set();
  for (const [si, s] of (l.sections || []).entries()) {
    const where = `${id} section[${si}] "${s.title}"`;
    if (!s.title) err(where, 'missing title');
    if (!Array.isArray(s.words) || !s.words.length) { err(where, 'needs words'); continue; }
    for (const w of s.words) {
      if (!w.sv || !w.ru) err(where, `word missing sv/ru: ${JSON.stringify(w)}`);
      if (!w.pron) err(where, `"${w.sv}" needs "pron" (Cyrillic pronunciation, stress with ́)`);
      if (seen.has(w.sv)) err(where, `duplicate word "${w.sv}"`);
      seen.add(w.sv);
      if (w.ex && !w.exRu) err(where, `"${w.sv}" has ex but no exRu`);
      totalWords++;
    }
  }

  for (const [di, d] of (l.drills || []).entries()) {
    for (const it of d.items || []) {
      const where = `${id} drill[${di}] "${it.word}"`;
      if (!it.word.includes(it.focus)) err(where, `focus "${it.focus}" not found in word`);
      if (!it.options?.includes(it.answer)) err(where, 'answer not among options');
      if (new Set(it.options).size !== it.options?.length) err(where, 'duplicate options');
      totalDrills++;
    }
  }
}

if (errors.length) {
  console.error(errors.map(e => `✗ ${e}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${index.lessons.length} lesson(s), ${totalWords} words, ${totalDrills} drill items`);
