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
  for (const a of l.listen || []) if (!a.label || !/^https?:\/\//.test(a.url || '')) err(id, `listen entry needs label and http(s) url: ${JSON.stringify(a)}`);

  const seen = new Set();
  for (const [si, s] of (l.sections || []).entries()) {
    const where = `${id} section[${si}] "${s.title}"`;
    if (!s.title) err(where, 'missing title');
    if (!Array.isArray(s.words) || !s.words.length) { err(where, 'needs words'); continue; }
    for (const w of s.words) {
      if (!w.sv || !w.ru) err(where, `word missing sv/ru: ${JSON.stringify(w)}`);
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
