'use strict';

const DAY = 864e5;
// Spaced-repetition intervals (days) per box; box 0 = still learning.
const INTERVALS = [0, 1, 3, 7, 14, 30, 60, 120];
const LEARNED_BOX = 2;
const SESSION_SIZE = 15;
const KEYS = { progress: 'sv.progress.v1', settings: 'sv.settings.v1', daily: 'sv.daily.v1', pending: 'sv.pending.v1', resetAt: 'sv.resetAt.v1', drills: 'sv.drills.v1', answers: 'sv.answers.v1' };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');

// localStorage cache, namespaced per user (`u:<id>:` prefix) so several people can share a device.
const store = {
  ns: '',
  get(k, d) { try { return JSON.parse(localStorage.getItem(this.ns + k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(this.ns + k, JSON.stringify(v)); },
  remove(k) { localStorage.removeItem(this.ns + k); },
};
const LAST_USER = 'sv.lastUser';

let currentUser = null;
let lessons = [];
let cards = [];
let progress = {};
// Exercise results per drill: { last, best, total, runs, t }.
let drillResults = {};
const saveDrills = () => store.set(KEYS.drills, drillResults);
// Written book exercises: { v: {partIdx: value}, checked, score, total, t }.
let answers = {};
const saveAnswers = () => store.set(KEYS.answers, answers);
let settings = {};
const saveSettings = () => store.set(KEYS.settings, settings);
const saveProgress = () => store.set(KEYS.progress, progress);

function useUser(u) {
  currentUser = u;
  store.ns = u ? `u:${u.id}:` : '';
  progress = u ? store.get(KEYS.progress, {}) : {};
  drillResults = u ? store.get(KEYS.drills, {}) : {};
  answers = u ? store.get(KEYS.answers, {}) : {};
  settings = Object.assign({ dir: 'sv-ru', lesson: 'all', newPerDay: 20, newPerDayT: 0 }, u ? store.get(KEYS.settings, {}) : {});
  clearTimeout(sync.timer);
  sync.pending = new Set(u ? store.get(KEYS.pending, []) : []);
  sync.setStatus('idle');
  if (u) localStorage.setItem(LAST_USER, JSON.stringify(u));
  else localStorage.removeItem(LAST_USER);
  // Pre-login caches were shared by everyone on the device; the server copy is authoritative.
  for (const k of Object.values(KEYS)) localStorage.removeItem(k);
}

let onKey = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const shuffle = a => { a = [...a]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const today = () => new Date().toLocaleDateString('sv-SE');
const fmtDate = d => d ? new Date(d + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
};
const words = n => `${n} ${plural(n, 'слово', 'слова', 'слов')}`;

function daily() {
  const d = store.get(KEYS.daily, {});
  return d.date === today() ? Object.assign({ newSeen: 0, extra: 0 }, d) : { date: today(), newSeen: 0, extra: 0 };
}
const saveDaily = d => { store.set(KEYS.daily, d); sync.push(); };

// ---------- Server sync ----------
// localStorage is a cache; the server (/api/sync) is the source of truth.
// Each progress entry carries a timestamp `t`; both sides keep the newest per card.
const sync = {
  status: 'idle', // idle | syncing | ok | offline | error
  pending: new Set(),
  timer: null,
  inflight: null,

  mark(key) {
    this.pending.add(key);
    store.set(KEYS.pending, [...this.pending]);
    this.push();
  },

  push(delay = 400) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), delay);
  },

  async run({ full = false } = {}) {
    if (!currentUser) return false;
    if (this.inflight) { await this.inflight; if (!full && !this.pending.size) return; }
    this.inflight = this._run(full).finally(() => { this.inflight = null; });
    return this.inflight;
  },

  async _run(full) {
    const user = currentUser;
    const keys = full ? Object.keys(progress) : [...this.pending];
    const body = {
      progress: Object.fromEntries(keys.filter(k => progress[k]).map(k => [k, progress[k]])),
      daily: daily(),
      settings: { newPerDay: settings.newPerDay, t: settings.newPerDayT },
      drills: drillResults,
      answers,
    };
    this.setStatus('syncing');
    try {
      const r = await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (r.status === 401) { sessionExpired(); return false; }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const server = await r.json();
      if (currentUser !== user) return false;
      keys.forEach(k => this.pending.delete(k));
      store.set(KEYS.pending, [...this.pending]);
      this.apply(server);
      this.setStatus(this.pending.size ? 'syncing' : 'ok');
      if (this.pending.size) this.push(0);
      return true;
    } catch (err) {
      console.warn('sync failed', err);
      this.setStatus(navigator.onLine === false || err instanceof TypeError ? 'offline' : 'error');
      this.push(30000);
      return false;
    }
  },

  // Adopt server state, keeping local entries that are newer or not yet pushed.
  apply(server) {
    if (server.resetAt > store.get(KEYS.resetAt, 0)) {
      for (const [k, p] of Object.entries(progress)) if ((p.t || 0) <= server.resetAt) delete progress[k];
      for (const [k, r] of Object.entries(drillResults)) if ((r.t || 0) <= server.resetAt) delete drillResults[k];
      for (const [k, a] of Object.entries(answers)) if ((a.t || 0) <= server.resetAt) delete answers[k];
      store.set(KEYS.resetAt, server.resetAt);
    }
    const merged = { ...server.progress };
    for (const [k, p] of Object.entries(progress)) {
      if (!merged[k] || (p.t || 0) > (merged[k].t || 0)) merged[k] = p;
    }
    progress = merged;
    saveProgress();
    drillResults = mergeDrillResults(drillResults, server.drills || {});
    saveDrills();
    for (const [k, a] of Object.entries(server.answers || {})) {
      if (!answers[k] || (a.t || 0) > (answers[k].t || 0)) answers[k] = a;
    }
    saveAnswers();
    const sd = server.daily || {};
    if (sd.date === today()) {
      const d = daily();
      store.set(KEYS.daily, { date: sd.date, newSeen: Math.max(d.newSeen, sd.newSeen || 0), extra: Math.max(d.extra, sd.extra || 0) });
    }
    const ss = server.settings || {};
    if ((ss.t || 0) > settings.newPerDayT) {
      settings.newPerDay = ss.newPerDay;
      settings.newPerDayT = ss.t;
      saveSettings();
    }
  },

  async replace(data) {
    const r = await fetch('api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    if (r.status === 401) { sessionExpired(); throw new Error('нужно войти заново'); }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const server = await r.json();
    progress = {};
    drillResults = {};
    answers = {};
    this.pending.clear();
    store.set(KEYS.pending, []);
    store.remove(KEYS.daily);
    this.apply(server);
  },

  setStatus(s) {
    this.status = s;
    const el = $('#sync');
    if (!el) return;
    const map = {
      idle: ['', ''],
      syncing: ['⟳', 'Синхронизация…'],
      ok: ['☁︎', 'Прогресс сохранён на сервере'],
      offline: ['⚠︎', 'Нет связи с сервером — прогресс сохранён локально и будет отправлен позже'],
      error: ['⚠︎', 'Ошибка синхронизации — прогресс сохранён локально'],
    };
    el.textContent = map[s][0];
    el.title = map[s][1];
    el.dataset.state = s;
  },
};

window.addEventListener('online', () => sync.push(0));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && currentUser) sync.run().then(ok => ok && refreshIdle());
});
// Re-render passive pages after a background sync brought in changes from another device.
function refreshIdle() {
  const name = location.hash.replace(/^#\/?/, '').split('/')[0];
  if (name === '' || name === 'lesson') route();
}

const pk = (c, dir = settings.dir) => `${c.id}|${dir}`;
const prog = c => progress[pk(c)];
const pool = () => settings.lesson === 'all' ? cards : cards.filter(c => c.lessonId === settings.lesson);
const svFirst = () => settings.dir === 'sv-ru';
const front = c => svFirst() ? c.sv : c.ru;
const back = c => svFirst() ? c.ru : c.sv;
const kind = c => (c.sv.match(/^(att|en|ett)\s/) || [])[1] || 'other';

// ---------- Data ----------

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

async function load() {
  const index = await getJSON('lessons/index.json');
  lessons = await Promise.all(index.lessons.map(async id => ({ ...(await getJSON(`lessons/${id}/lesson.json`)), id })));
  // Oldest first so new cards are introduced in homework order.
  lessons.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.id.localeCompare(b.id));
  cards = [];
  for (const l of lessons) {
    for (const s of l.sections || []) {
      for (const w of s.words) cards.push({ ...w, id: `${l.id}/${w.sv}`, lessonId: l.id, section: s.title });
    }
  }
  if (settings.lesson !== 'all' && !lessons.some(l => l.id === settings.lesson)) settings.lesson = 'all';
}

// ---------- Spaced repetition ----------

function counts(list = pool()) {
  const now = Date.now();
  const r = { due: 0, fresh: 0, learning: 0, learned: 0, total: list.length };
  for (const c of list) {
    const p = prog(c);
    if (!p) { r.fresh++; continue; }
    if (p.due <= now) r.due++;
    if (p.box >= LEARNED_BOX) r.learned++; else r.learning++;
  }
  return r;
}

function newAllowance() {
  const d = daily();
  return Math.max(0, settings.newPerDay + d.extra - d.newSeen);
}

function buildQueue() {
  const now = Date.now();
  const due = [], fresh = [];
  for (const c of pool()) {
    const p = prog(c);
    if (!p) fresh.push(c);
    else if (p.due <= now) due.push(c);
  }
  due.sort((a, b) => prog(a).due - prog(b).due);
  return [...shuffle(due), ...fresh.slice(0, newAllowance())];
}

function grade(c, g, dir = settings.dir) {
  const key = pk(c, dir);
  let p = progress[key];
  if (!p) {
    p = { box: 0, due: 0, right: 0, wrong: 0 };
    const d = daily(); d.newSeen++; saveDaily(d);
  }
  if (g === 0) { p.box = 0; p.due = Date.now(); p.wrong++; }
  else { p.box = Math.min(p.box + g, INTERVALS.length - 1); p.due = Date.now() + INTERVALS[p.box] * DAY; p.right++; }
  p.t = Date.now();
  progress[key] = p;
  saveProgress();
  sync.mark(key);
}

// Test/typing answers feed spaced repetition too. A mistake always sends the word back to review;
// a correct answer only counts when the word is new or due, so extra practice can't inflate levels.
function practice(c, ok, dir = settings.dir) {
  if (!ok) return grade(c, 0, dir);
  const p = progress[pk(c, dir)];
  if (!p || p.due <= Date.now()) grade(c, 1, dir);
}

const drillKey = (l, d) => `${l.id}#${d.id || d.title}`;

function mergeDrillResults(a, b) {
  const out = { ...a };
  for (const [k, r] of Object.entries(b)) {
    const cur = out[k];
    if (!cur) { out[k] = r; continue; }
    const newer = (r.t || 0) > (cur.t || 0) ? r : cur;
    out[k] = { ...newer, best: Math.max(cur.best || 0, r.best || 0), runs: Math.max(cur.runs || 0, r.runs || 0) };
  }
  return out;
}

function recordDrill(l, d, score, total) {
  const key = drillKey(l, d);
  const cur = drillResults[key] || { best: 0, runs: 0 };
  drillResults[key] = { last: score, best: Math.max(cur.best, score), total, runs: cur.runs + 1, t: Date.now() };
  saveDrills();
  sync.push(0);
}

function drillsDone(l) {
  const ds = (l.drills || []).filter(d => d.items.length);
  const xs = l.exercises || [];
  const done = ds.filter(d => drillResults[drillKey(l, d)]).length + xs.filter(x => answers[exKey(l, x)]?.checked).length;
  return { done, total: ds.length + xs.length };
}

function intervalLabel(c, g) {
  if (g === 0) return 'сейчас';
  const box = Math.min((prog(c)?.box ?? 0) + g, INTERVALS.length - 1);
  const d = INTERVALS[box];
  return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
}

// ---------- Shared UI ----------

const pronHTML = (c, cls = 'pron') => c.pron ? `<div class="${cls}" title="Произношение">[${esc(c.pron)}]</div>` : '';
const pronInline = c => c.pron ? ` <span class="pron-i">[${esc(c.pron)}]</span>` : '';

function frontHTML(c) {
  return `<div class="tag">${esc(c.section)}</div>
    <div class="word" ${svFirst() ? 'lang="sv"' : ''}>${esc(front(c))}</div>
    ${svFirst() ? pronHTML(c) : ''}
    <div class="tap muted">нажмите, чтобы перевернуть</div>`;
}

function exampleHTML(c) {
  if (!c.ex) return '';
  return `<div class="ex"><div class="sv" lang="sv">${esc(c.ex)}</div><div class="muted">${esc(c.exRu)}</div></div>`;
}

function backHTML(c) {
  return `<div class="muted">${esc(front(c))}</div>
    <div class="answer" ${svFirst() ? '' : 'lang="sv"'}>${esc(back(c))}</div>
    ${pronHTML(c)}
    ${c.hint ? `<div class="hint">🗣 ${esc(c.hint)}</div>` : ''}
    ${exampleHTML(c)}`;
}

function flipCard(c) {
  return `<div class="flip" id="flip"><div class="flip-inner">
    <div class="face front">${frontHTML(c)}</div>
    <div class="face back">${backHTML(c)}</div>
  </div></div>`;
}

function setCard(el, c) {
  el.classList.add('no-anim');
  el.classList.remove('flipped');
  $('.front', el).innerHTML = frontHTML(c);
  $('.back', el).innerHTML = backHTML(c);
  void el.offsetWidth;
  el.classList.remove('no-anim');
}

function bar(done, total, cls = 'primary') {
  const pct = total ? Math.round(done / total * 100) : 0;
  return `<div class="bar ${cls}"><i style="width:${pct}%"></i></div>`;
}

function bar2(learned, learning, total) {
  const w = n => total ? `${n / total * 100}%` : '0';
  return `<div class="bar two"><i class="learned" style="width:${w(learned)}"></i><i class="learning" style="width:${w(learning)}"></i></div>`;
}

function emptyState(emoji, title, text, actions = '') {
  app.innerHTML = `<div class="panel empty"><div class="big-emoji">${emoji}</div><h2>${title}</h2><p class="muted">${text}</p><div class="row center">${actions}</div></div>`;
}

function scopeLabel() {
  return settings.lesson === 'all' ? 'все уроки' : `урок «${lessons.find(l => l.id === settings.lesson)?.title}»`;
}

// ---------- Pages ----------

function home() {
  const c = counts();
  const todayCount = c.due + Math.min(c.fresh, newAllowance());
  const recent = [...lessons].reverse();
  app.innerHTML = `
    <section class="panel hero">
      <div>
        <h1>Hej! 👋</h1>
        <div class="muted">Сейчас: ${esc(scopeLabel())} · ${svFirst() ? 'шведский → русский' : 'русский → шведский'}</div>
      </div>
      <div class="stats">
        <div class="stat"><b>${todayCount}</b><span>на сегодня</span></div>
        <div class="stat"><b>${c.learning}</b><span>в процессе</span></div>
        <div class="stat"><b>${c.learned}</b><span>выучено</span></div>
        <div class="stat"><b>${c.total}</b><span>всего слов</span></div>
      </div>
      <div class="row"><a class="btn primary big" href="#/review">${todayCount ? `Повторить (${todayCount})` : 'Повторение'}</a></div>
    </section>

    <section class="modes">
      <a class="mode" href="#/cards"><div class="icon">🃏</div><b>Карточки</b><span>Свободный просмотр слов</span></a>
      <a class="mode" href="#/quiz"><div class="icon">✅</div><b>Тест</b><span>Выберите правильный перевод</span></a>
      <a class="mode" href="#/type"><div class="icon">⌨️</div><b>Написание</b><span>Напишите слово по-шведски</span></a>
    </section>

    <h2>Уроки</h2>
    <div class="lessons">
      ${recent.map(l => {
        const lc = counts(cards.filter(x => x.lessonId === l.id));
        const pct = lc.total ? Math.round(lc.learned / lc.total * 100) : 0;
        const dd = drillsDone(l);
        return `<a class="lesson-card" href="#/lesson/${esc(l.id)}">
          <div class="title">${esc(l.title)} ${l.titleSv ? `<span class="muted" lang="sv">· ${esc(l.titleSv)}</span>` : ''}</div>
          <div class="pct" title="выучено">${pct}%</div>
          <div class="meta">${fmtDate(l.date)} · ${words(lc.total)}: выучено ${lc.learned}, в процессе ${lc.learning}${dd.total ? ` · упражнения ${dd.done}/${dd.total}` : ''}</div>
          ${bar2(lc.learned, lc.learning, lc.total)}
        </a>`;
      }).join('')}
    </div>

    <details class="settings">
      <summary>Настройки и прогресс</summary>
      <div class="panel">
        <label class="row">Новых слов в день <input type="number" id="new-per-day" min="1" max="200" value="${settings.newPerDay}" style="width:90px"></label>
        <div class="row">
          <button class="btn" id="export">Экспорт прогресса</button>
          <label class="btn">Импорт<input type="file" id="import" accept="application/json" hidden></label>
          <span class="spacer"></span>
          <button class="btn danger" id="reset">Сбросить прогресс</button>
        </div>
        <div class="small muted">Прогресс хранится на сервере и синхронизируется между устройствами. Экспорт — резервная копия в файл.</div>
      </div>
    </details>`;

  $('#new-per-day').onchange = e => {
    settings.newPerDay = Math.max(1, Math.min(200, parseInt(e.target.value, 10) || 20));
    settings.newPerDayT = Date.now();
    saveSettings(); sync.push(0); home();
  };
  $('#export').onclick = () => {
    const blob = new Blob([JSON.stringify({ progress, drills: drillResults, answers, settings: { newPerDay: settings.newPerDay }, daily: daily() }, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `svenska-progress-${currentUser.id}-${today()}.json` });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $('#import').onchange = async e => {
    try {
      const data = JSON.parse(await e.target.files[0].text());
      if (!data.progress) throw new Error('нет поля progress');
      if (!confirm('Заменить текущий прогресс на всех устройствах данными из файла?')) return;
      await sync.replace(data);
      alert('Прогресс импортирован'); home();
    } catch (err) { alert('Не удалось импортировать: ' + err.message); }
  };
  $('#reset').onclick = async () => {
    if (!confirm('Сбросить весь прогресс на всех устройствах? Это нельзя отменить.')) return;
    try { await sync.replace({ progress: {} }); home(); }
    catch (err) { alert('Не удалось сбросить: ' + err.message); }
  };
}

async function lessonPage(id) {
  const l = lessons.find(x => x.id === id);
  if (!l) return emptyState('🤷', 'Урок не найден', '', '<a class="btn" href="#/">На главную</a>');
  const lessonCards = cards.filter(c => c.lessonId === id);
  const lstat = counts(lessonCards);
  app.innerHTML = `
    <a class="back" href="#/">← Все уроки</a>
    <h1>${esc(l.title)}</h1>
    <div class="muted">${l.titleSv ? `<span lang="sv">${esc(l.titleSv)}</span> · ` : ''}${fmtDate(l.date)} · ${words(lessonCards.length)}: выучено ${lstat.learned}, в процессе ${lstat.learning}</div>
    ${l.summary ? `<p>${esc(l.summary)}</p>` : ''}
    ${l.audio?.length ? `<div class="listen">${l.audio.map(playerHTML).join('')}</div>` : ''}
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="study">Учить слова урока</button>
      ${(l.drills || []).map((d, i) => {
        if (!d.items.length) return '';
        const r = drillResults[drillKey(l, d)];
        const res = r ? `<span class="drill-res${r.best === r.total ? ' full' : ''}">${r.best === r.total ? '✓ ' : ''}${r.best}/${r.total}</span>` : '';
        return `<a class="btn" href="#/drill/${esc(id)}/${i}">🎯 ${esc(d.title)}${res}</a>`;
      }).join('')}
      ${(l.exercises || []).map(x => `<a class="btn" href="#/ex/${esc(id)}/${esc(x.id)}">📝 ${esc(x.title)}${exStatusHTML(l, x)}</a>`).join('')}
    </div>
    <div class="tabs">
      ${l.notes ? '<button data-tab="notes">Теория</button>' : ''}
      <button data-tab="words">Слова (${lessonCards.length})</button>
    </div>
    <div id="tab"></div>
    ${l.sources?.length ? `<div class="sources">Источники: ${l.sources.map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : esc(s.label)).join(' · ')}</div>` : ''}`;

  $('#study').onclick = () => { settings.lesson = id; saveSettings(); syncHeader(); location.hash = '#/review'; };
  initPlayers(app);

  let notesHTML = null;
  const show = async tab => {
    $$('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const el = $('#tab');
    if (tab === 'notes') {
      if (notesHTML === null) {
        el.innerHTML = '<p class="muted">Загрузка…</p>';
        try {
          const r = await fetch(`lessons/${id}/${l.notes}`, { cache: 'no-cache' });
          notesHTML = r.ok ? await r.text() : '<p class="muted">Не удалось загрузить теорию.</p>';
        } catch { notesHTML = '<p class="muted">Не удалось загрузить теорию.</p>'; }
      }
      el.innerHTML = `<div class="notes panel">${notesHTML}</div>`;
    } else {
      el.innerHTML = `<input type="search" id="q" placeholder="Поиск…" style="width:100%;margin-bottom:6px">
        ${l.sections.map(s => `<h3>${esc(s.title)}</h3>
          ${s.note ? `<p class="muted small">${esc(s.note)}</p>` : ''}
          <div class="table-wrap"><table class="words"><tbody>
          ${s.words.map(w => `<tr data-q="${esc((w.sv + ' ' + w.ru).toLowerCase())}">
            <td><span lang="sv">${esc(w.sv)}</span>${pronHTML(w, 'pron-t')}</td>
            <td>${esc(w.ru)}${w.hint ? `<div class="hint-text">🗣 ${esc(w.hint)}</div>` : ''}</td>
            <td class="ex">${w.ex ? `<span lang="sv"><i>${esc(w.ex)}</i></span><br>${esc(w.exRu)}` : ''}</td>
          </tr>`).join('')}
          </tbody></table></div>`).join('')}`;
      $('#q').oninput = e => {
        const q = e.target.value.toLowerCase().trim();
        $$('tr[data-q]').forEach(tr => { tr.hidden = q && !tr.dataset.q.includes(q); });
      };
    }
  };
  $$('.tabs button').forEach(b => b.onclick = () => show(b.dataset.tab));
  show(l.notes ? 'notes' : 'words');
}

function cardsPage() {
  let deck = pool();
  if (!deck.length) return emptyState('📭', 'Нет слов', 'Выберите другой урок.');
  let i = 0;
  app.innerHTML = `<div class="session">
    <div class="session-head"><span id="pos"></span><span class="spacer"></span>
      <button class="chip" id="shuffle">🔀 Перемешать</button></div>
    ${flipCard(deck[0])}
    <div class="row center">
      <button class="btn" id="prev">← Назад</button>
      <button class="btn primary" id="turn">Перевернуть</button>
      <button class="btn" id="next">Дальше →</button>
    </div>
    <div class="kbd-help">Пробел — перевернуть · ← → — листать</div>
  </div>`;
  const flip = $('#flip');
  const show = () => { setCard(flip, deck[i]); $('#pos').textContent = `${i + 1} / ${deck.length}`; };
  const turn = () => flip.classList.toggle('flipped');
  const go = d => { i = (i + d + deck.length) % deck.length; show(); };
  flip.onclick = turn;
  $('#turn').onclick = turn;
  $('#prev').onclick = () => go(-1);
  $('#next').onclick = () => go(1);
  $('#shuffle').onclick = () => { deck = shuffle(deck); i = 0; show(); };
  onKey = e => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); turn(); }
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'ArrowLeft') go(-1);
  };
  show();
}

function reviewPage() {
  const queue = buildQueue();
  if (!queue.length) {
    const c = counts();
    const next = pool().map(prog).filter(Boolean).reduce((m, p) => Math.min(m, p.due), Infinity);
    const nextTxt = Number.isFinite(next) ? `Следующее повторение: ${new Date(next).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}.` : '';
    emptyState('🎉', 'На сегодня всё!', `${nextTxt} ${c.fresh ? `Ещё ${words(c.fresh)} ждут изучения.` : ''}`,
      `${c.fresh ? '<button class="btn primary" id="more">+10 новых слов</button>' : ''}
       <a class="btn" href="#/quiz">Тест</a><a class="btn" href="#/cards">Карточки</a>`);
    const more = $('#more');
    if (more) more.onclick = () => { const d = daily(); d.extra += 10; saveDaily(d); reviewPage(); };
    return;
  }
  const total = queue.length;
  let done = 0;
  app.innerHTML = `<div class="session">
    <div class="session-head"><span id="pos"></span>${bar(0, total)}<span id="kind"></span></div>
    ${flipCard(queue[0])}
    <div id="controls"></div>
    <div class="kbd-help">Пробел — показать ответ · 1 / 2 / 3 — оценка</div>
  </div>`;
  const flip = $('#flip');
  let revealed = false;

  const render = () => {
    const c = queue[0];
    revealed = false;
    setCard(flip, c);
    $('#pos').textContent = `${done} / ${total}`;
    $('.session-head .bar > i').style.width = `${Math.round(done / total * 100)}%`;
    $('#kind').textContent = prog(c) ? '' : 'новое';
    $('#controls').innerHTML = '<button class="btn primary big" id="reveal" style="width:100%">Показать ответ</button>';
    $('#reveal').onclick = reveal;
  };
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    flip.classList.add('flipped');
    const c = queue[0];
    $('#controls').innerHTML = `<div class="grades">
      <button class="btn again" data-g="0">Не помню<small>${intervalLabel(c, 0)}</small></button>
      <button class="btn good" data-g="1">Помню<small>${intervalLabel(c, 1)}</small></button>
      <button class="btn easy" data-g="2">Легко<small>${intervalLabel(c, 2)}</small></button>
    </div>`;
    $$('#controls [data-g]').forEach(b => b.onclick = () => answer(+b.dataset.g));
  };
  const answer = g => {
    const c = queue.shift();
    grade(c, g);
    if (g === 0) queue.splice(Math.min(3, queue.length), 0, c);
    else done++;
    if (!queue.length) return reviewDone(total);
    render();
  };
  flip.onclick = () => revealed ? flip.classList.toggle('flipped') : reveal();
  onKey = e => {
    if (!revealed && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); reveal(); }
    else if (revealed && ['1', '2', '3'].includes(e.key)) answer(+e.key - 1);
    else if (revealed && e.key === ' ') { e.preventDefault(); flip.classList.toggle('flipped'); }
  };
  render();
}

function reviewDone(total) {
  emptyState('✨', 'Отлично!', `Повторено: ${words(total)}.`,
    '<a class="btn primary" href="#/">На главную</a><a class="btn" href="#/quiz">Тест</a>');
}

function runChoice({ items, restart, title, root = app, onFinish }) {
  let i = 0, score = 0;
  const wrong = [];
  const ask = () => {
    if (i >= items.length) return finish();
    const it = items[i];
    let answered = false;
    root.innerHTML = `<div class="session">
      <div class="session-head"><span>${i + 1} / ${items.length}</span>${bar(i, items.length)}<span>✓ ${score}</span></div>
      <div class="q-card">
        <div class="q-label muted">${esc(it.label || title || '')}</div>
        <div class="q-prompt" ${it.lang ? `lang="${it.lang}"` : ''}>${it.promptHTML}</div>
        ${it.sub ? `<div class="q-sub">${esc(it.sub)}</div>` : ''}
      </div>
      <div class="options">${it.options.map((o, k) => `<button class="opt" data-k="${k}"><span class="key">${k + 1}</span><span>${esc(o)}</span></button>`).join('')}</div>
      <div id="fb"></div>
      <div class="kbd-help">1–${it.options.length} — выбрать ответ · Enter — дальше${$('.player') ? ' · P — аудио' : ''}</div>
    </div>`;
    const buttons = $$('.opt');
    const choose = k => {
      if (answered) return;
      answered = true;
      const ok = it.options[k] === it.answer;
      if (ok) score++; else wrong.push(it);
      it.onAnswer?.(ok);
      buttons.forEach((b, j) => {
        b.disabled = true;
        if (it.options[j] === it.answer) b.classList.add('correct');
        else if (j === k) b.classList.add('wrong');
      });
      $('#fb').innerHTML = `<div class="feedback ${ok ? 'ok' : 'bad'}">
          <div>${ok ? '<b class="good-t">Верно!</b>' : `<b class="bad-t">Неверно.</b> Правильно: <b>${esc(it.answer)}</b>`}</div>
          ${it.explainHTML || ''}
        </div>
        <button class="btn primary big" id="next" style="width:100%;margin-top:12px">Дальше →</button>`;
      $('#next').onclick = next;
    };
    const next = () => { i++; ask(); };
    buttons.forEach(b => b.onclick = () => choose(+b.dataset.k));
    onKey = e => {
      if (!answered && /^[1-9]$/.test(e.key) && +e.key <= it.options.length) choose(+e.key - 1);
      else if (answered && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); next(); }
    };
  };
  const finish = () => {
    onKey = null;
    onFinish?.(score, items.length);
    const pct = Math.round(score / items.length * 100);
    root.innerHTML = `<div class="session"><div class="panel result">
      <div class="big-emoji">${pct >= 90 ? '🏆' : pct >= 60 ? '👍' : '💪'}</div>
      <div class="score">${score} / ${items.length}</div>
      <div class="muted">${pct}% правильных ответов</div>
      ${wrong.length ? `<div class="mistakes"><b>Ошибки:</b><ul>${wrong.map(w => `<li>${w.reviewHTML}</li>`).join('')}</ul></div>` : ''}
      <div class="row center" style="margin-top:16px">
        <button class="btn primary" id="again">Ещё раз</button>
        <a class="btn" href="#/">На главную</a>
      </div>
    </div></div>`;
    $('#again').onclick = restart;
  };
  ask();
}

function quizPage() {
  const p = pool();
  if (p.length < 4) return emptyState('📭', 'Мало слов', 'Для теста нужно минимум 4 слова.');
  const items = shuffle(p).slice(0, SESSION_SIZE).map(c => {
    const answer = back(c);
    const others = shuffle(p.filter(x => back(x) !== answer));
    const same = others.filter(x => kind(x) === kind(c));
    const picks = [...new Set([...same, ...others].map(back))].slice(0, 3);
    return {
      label: svFirst() ? 'Выберите перевод' : 'Как сказать по-шведски?',
      lang: svFirst() ? 'sv' : '',
      promptHTML: esc(front(c)),
      sub: svFirst() && c.pron ? `[${c.pron}]` : '',
      options: shuffle([answer, ...picks]),
      answer,
      explainHTML: `<div><b lang="sv">${esc(c.sv)}</b>${pronInline(c)}</div>${c.hint ? `<div class="small">🗣 ${esc(c.hint)}</div>` : ''}${exampleHTML(c)}`,
      reviewHTML: `<b lang="sv">${esc(c.sv)}</b>${pronInline(c)} — ${esc(c.ru)}`,
      onAnswer: ok => practice(c, ok),
    };
  });
  runChoice({ items, restart: quizPage });
}

function drillPage(id, idx) {
  const l = lessons.find(x => x.id === id);
  const drills = (l?.drills || []).filter((d, i) => idx === undefined || i === +idx);
  const all = drills.flatMap(d => d.items.map(it => ({ ...it, group: d.title })));
  if (!all.length) return emptyState('🤷', 'Нет упражнений', '', '<a class="btn" href="#/">На главную</a>');
  // Drills that follow an audio track keep their original order.
  const ordered = drills.length === 1 && drills[0].ordered;
  const items = (ordered ? all : shuffle(all)).map(it => {
    const idx = it.word.indexOf(it.focus);
    const promptHTML = idx < 0 ? esc(it.word)
      : `${esc(it.word.slice(0, idx))}<mark>${esc(it.focus)}</mark>${esc(it.word.slice(idx + it.focus.length))}`;
    return {
      label: it.group || 'Как читается выделенное?',
      lang: 'sv',
      promptHTML,
      sub: it.ru,
      options: shuffle(it.options),
      answer: it.answer,
      explainHTML: it.why ? `<div class="small">${esc(it.why)}</div>` : '',
      reviewHTML: `<b lang="sv">${esc(it.word)}</b>: <b>${esc(it.focus)}</b> → ${esc(it.answer)}${it.why ? ` <span class="muted">(${esc(it.why)})</span>` : ''}`,
    };
  });
  const track = drills.length === 1 && drills[0].audio ? l.audio?.find(a => a.id === drills[0].audio) : null;
  const onFinish = drills.length === 1 ? (score, total) => recordDrill(l, drills[0], score, total) : undefined;
  if (!track) return runChoice({ items, restart: () => drillPage(id, idx), onFinish });
  // The player lives outside the quiz container so playback continues between questions.
  app.innerHTML = `<div class="session listen-head">
      ${playerHTML(track)}
      ${drills[0].intro ? `<div class="small muted">${esc(drills[0].intro)}</div>` : ''}
    </div>
    <div id="quiz"></div>`;
  initPlayers(app);
  runChoice({ items, restart: () => drillPage(id, idx), root: $('#quiz'), onFinish });
}

// ---------- Audio ----------
// Tracks are streamed by the server from api/audio/<id>; the source URLs are private to the server.

const fmtTime = s => Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00';
const RATES = [1, 0.85, 0.7];

function playerHTML(a) {
  return `<div class="player" data-id="${esc(a.id)}">
    <div class="player-label">🎧 ${esc(a.label)}</div>
    <audio preload="metadata" src="api/audio/${encodeURIComponent(a.id)}"></audio>
    <div class="player-controls">
      <button class="play" type="button" aria-label="Играть" title="Играть / пауза (P)">▶</button>
      <button class="chip back5" type="button" title="Назад на 5 секунд">↺ 5 с</button>
      <input class="seek" type="range" min="0" max="0" step="0.1" value="0" aria-label="Позиция">
      <span class="time">0:00 / 0:00</span>
      <button class="chip rate" type="button" title="Скорость">1×</button>
    </div>
    <div class="player-error small" hidden>Не удалось загрузить аудио.</div>
  </div>`;
}

function initPlayers(root) {
  $$('.player', root).forEach(p => {
    const audio = $('audio', p), play = $('.play', p), seek = $('.seek', p), time = $('.time', p), rate = $('.rate', p);
    let dragging = false;
    const update = () => {
      if (!dragging) seek.value = audio.currentTime;
      time.textContent = `${fmtTime(audio.currentTime)} / ${fmtTime(audio.duration)}`;
    };
    audio.addEventListener('loadedmetadata', () => { seek.max = audio.duration || 0; update(); });
    audio.addEventListener('timeupdate', update);
    audio.addEventListener('play', () => {
      play.textContent = '⏸'; play.setAttribute('aria-label', 'Пауза');
      $$('audio').forEach(o => o !== audio && o.pause());
    });
    audio.addEventListener('pause', () => { play.textContent = '▶'; play.setAttribute('aria-label', 'Играть'); });
    audio.addEventListener('ended', () => { audio.currentTime = 0; });
    audio.addEventListener('error', () => { $('.player-error', p).hidden = false; play.disabled = true; });
    play.onclick = () => audio.paused ? audio.play() : audio.pause();
    // Mouse clicks must not leave focus on player controls, or Enter/1-4 would hit them instead of the quiz.
    $$('button', p).forEach(b => { b.onmousedown = e => e.preventDefault(); });
    seek.addEventListener('change', () => seek.blur());
    $('.back5', p).onclick = () => { audio.currentTime = Math.max(0, audio.currentTime - 5); };
    rate.onclick = () => {
      const next = RATES[(RATES.indexOf(audio.playbackRate) + 1) % RATES.length];
      audio.playbackRate = next;
      rate.textContent = `${String(next).replace('.', ',')}×`;
    };
    seek.oninput = () => { dragging = true; time.textContent = `${fmtTime(+seek.value)} / ${fmtTime(audio.duration)}`; };
    seek.onchange = () => { audio.currentTime = +seek.value; dragging = false; };
  });
}

// Typing: compare ignoring case, punctuation and articles; flag missing å/ä/ö and wrong en/ett.
const norm = s => s.toLowerCase().replace(/[!?.,:;"«»()]/g, '').replace(/\s+/g, ' ').trim();
const article = s => (norm(s).match(/^(en|ett|att)\s/) || [])[1] || '';
const core = s => norm(s).replace(/^(en|ett|att)\s+/, '').replace(/-$/, '');
const fold = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function checkTyped(input, target) {
  const a = core(input), b = core(target);
  if (!a) return { status: 'bad', msg: 'Правильно:' };
  if (a === b) {
    const ai = article(input), at = article(target);
    if (ai && at && ai !== at) return { status: 'almost', msg: 'Слово верно, но артикль другой:' };
    if (!ai && (at === 'en' || at === 'ett')) return { status: 'ok', msg: 'Верно! Запомните артикль:' };
    return { status: 'ok', msg: 'Верно!' };
  }
  if (fold(a) === fold(b)) return { status: 'almost', msg: 'Почти! Проверьте å, ä, ö:' };
  return { status: 'bad', msg: 'Правильно:' };
}

function typePage() {
  const p = pool();
  if (!p.length) return emptyState('📭', 'Нет слов', 'Выберите другой урок.');
  const items = shuffle(p).slice(0, SESSION_SIZE);
  let i = 0, score = 0;
  const wrong = [];

  const ask = () => {
    if (i >= items.length) return finish();
    const c = items[i];
    let checked = false;
    app.innerHTML = `<div class="session">
      <div class="session-head"><span>${i + 1} / ${items.length}</span>${bar(i, items.length)}<span>✓ ${score}</span></div>
      <div class="q-card">
        <div class="q-label muted">Напишите по-шведски (с артиклем en/ett, если это существительное)</div>
        <div class="q-prompt">${esc(c.ru)}</div>
      </div>
      <div class="type-input">
        <input type="text" id="answer" lang="sv" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="på svenska…">
        <div class="row">
          <div class="letters">${['å', 'ä', 'ö'].map(ch => `<button type="button" data-ch="${ch}">${ch}</button>`).join('')}</div>
          <span class="spacer"></span>
          <button class="btn" id="skip">Не знаю</button>
          <button class="btn primary" id="check">Проверить</button>
        </div>
      </div>
      <div id="fb"></div>
      <div class="kbd-help">Enter — проверить / дальше</div>
    </div>`;
    const input = $('#answer');
    input.focus();
    $$('.letters button').forEach(b => {
      b.onmousedown = e => e.preventDefault();
      b.onclick = () => {
        const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
        input.value = input.value.slice(0, s) + b.dataset.ch + input.value.slice(e);
        input.setSelectionRange(s + 1, s + 1);
        input.focus();
      };
    });
    const check = (giveUp = false) => {
      if (checked) return next();
      checked = true;
      const r = giveUp ? { status: 'bad', msg: 'Правильно:' } : checkTyped(input.value, c.sv);
      if (r.status === 'ok') score++; else wrong.push(c);
      if (r.status !== 'almost') practice(c, r.status === 'ok', 'ru-sv');
      input.readOnly = true;
      $('#fb').innerHTML = `<div class="feedback ${r.status}">
          <div><b class="${r.status === 'ok' ? 'good-t' : r.status === 'almost' ? 'almost-t' : 'bad-t'}">${esc(r.msg)}</b> <b lang="sv">${esc(c.sv)}</b>${pronInline(c)}</div>
          ${c.hint ? `<div class="small">🗣 ${esc(c.hint)}</div>` : ''}
          ${exampleHTML(c)}
        </div>`;
      $('#check').textContent = 'Дальше →';
      $('#skip').hidden = true;
    };
    const next = () => { i++; ask(); };
    $('#check').onclick = () => check();
    $('#skip').onclick = () => check(true);
    input.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); check(); } };
    onKey = e => { if (checked && e.key === 'Enter') next(); };
  };

  const finish = () => {
    onKey = null;
    app.innerHTML = `<div class="session"><div class="panel result">
      <div class="big-emoji">${score === items.length ? '🏆' : '✍️'}</div>
      <div class="score">${score} / ${items.length}</div>
      ${wrong.length ? `<div class="mistakes"><b>Повторите:</b><ul>${wrong.map(c => `<li><b lang="sv">${esc(c.sv)}</b>${pronInline(c)} — ${esc(c.ru)}</li>`).join('')}</ul></div>` : ''}
      <div class="row center" style="margin-top:16px">
        <button class="btn primary" id="again">Ещё раз</button>
        <a class="btn" href="#/">На главную</a>
      </div>
    </div></div>`;
    $('#again').onclick = typePage;
  };
  ask();
}

// ---------- Router & header ----------

// ---------- Written book exercises ----------
// Part types: "check" (tick boxes), "blanks" (text with {{answer|alt}} gaps; {{}} = free gap),
// "write" (free text; with `answer` variants it is compared to a model and can be self-credited).
// Answers autosave to the server and stay viewable after checking.

const exKey = (l, x) => `${l.id}#${x.id}`;
const emptyValues = v => Object.values(v || {}).every(a => Array.isArray(a) ? a.every(s => !String(s).trim()) : !String(a).trim());
// Cleared exercises are stored as an empty entry (not deleted) so the clear syncs to other devices.
const hasAnswers = a => !!a && (a.checked || !emptyValues(a.v));
const GAP_RE = /\{\{([^}]*)\}\}/g;

function exStatusHTML(l, x) {
  const a = answers[exKey(l, x)];
  if (!hasAnswers(a)) return '';
  if (!a.checked) return '<span class="drill-res">черновик</span>';
  if (!a.total) return '<span class="drill-res full">✓</span>';
  return `<span class="drill-res${a.score === a.total ? ' full' : ''}">${a.score === a.total ? '✓ ' : ''}${a.score}/${a.total}</span>`;
}

function gapStatus(value, alts) {
  const v = norm(value || '');
  if (!v) return 'bad';
  const keys = alts.map(norm);
  if (keys.includes(v)) return 'ok';
  if (keys.map(fold).includes(fold(v))) return 'almost';
  return 'bad';
}

const normSentence = s => norm(String(s || '').replace(/[–—-]/g, ' ')).replace(/\bidag\b/g, 'i dag');
const tokens = s => normSentence(s).split(' ').filter(Boolean);

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Picks the model variant closest to the user's answer (character edit distance).
function closestVariant(value, variants) {
  const v = normSentence(value);
  let best = variants[0], bestDist = Infinity;
  for (const m of variants) {
    const d = levenshtein(v, normSentence(m));
    if (d < bestDist) { best = m; bestDist = d; }
  }
  return best;
}

function writeStatus(value, variants) {
  const v = normSentence(value);
  if (!v) return 'empty';
  const keys = variants.map(normSentence);
  if (keys.includes(v)) return 'ok';
  if (keys.map(fold).includes(fold(v))) return 'almost';
  return 'compare';
}

// Highlights words in `text` that are not part of the longest common word sequence with `other`,
// so wrong, missing and misplaced words all show up.
function diffHTML(text, other, cls) {
  const parts = String(text || '').split(/(\s+)/);
  const idx = [], a = [];
  parts.forEach((p, k) => { const t = normSentence(p); if (t) { idx.push(k); a.push(t); } });
  const b = tokens(other);
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  }
  const keep = new Set();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) { keep.add(idx[i]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  return parts.map((p, k) => !p.trim() || keep.has(k) || !normSentence(p) ? esc(p) : `<span class="${cls}">${esc(p)}</span>`).join('');
}

// Returns per-part marks plus score/total; parts without an answer key are not scored.
// `self` holds parts the user credited as correct after comparing with the model answer.
function gradeExercise(x, values, self = {}) {
  let score = 0, total = 0;
  const marks = x.parts.map((part, i) => {
    const v = values[i];
    if (part.type === 'check' && part.answer) {
      const picked = new Set(v || []), key = new Set(part.answer);
      const opts = part.options.map(o => picked.has(o) ? (key.has(o) ? 'hit' : 'false') : (key.has(o) ? 'miss' : ''));
      const ok = !opts.includes('false') && !opts.includes('miss');
      total++; if (ok) score++;
      return { ok, opts };
    }
    if (part.type === 'blanks') {
      const gaps = [...part.text.matchAll(GAP_RE)].map((m, j) => {
        const alts = m[1].split('|').map(t => t.trim()).filter(Boolean);
        if (!alts.length) return '';
        const st = gapStatus((v || [])[j], alts);
        total++; if (st === 'ok') score++;
        return st;
      });
      return { gaps };
    }
    if (part.type === 'write' && part.answer?.length) {
      const status = writeStatus(v, part.answer);
      const credited = status === 'ok' || (!!self[i] && status !== 'empty');
      total++; if (credited) score++;
      return { status, credited, model: closestVariant(v, part.answer) };
    }
    return {};
  });
  return { marks, score, total };
}

function partHTML(part, i, value, mark, locked) {
  const dis = locked ? 'disabled' : '';
  if (part.type === 'check') {
    const picked = new Set(value || []);
    return `<div class="ws-part ws-check${mark ? (mark.ok ? ' ok' : ' bad') : ''}">
      ${part.label ? `<div class="ws-label">${esc(part.label)}</div>` : ''}
      ${part.options.map((o, k) => `<label class="ws-opt ${mark?.opts?.[k] || ''}" lang="sv">
        <input type="checkbox" data-part="${i}" value="${esc(o)}" ${picked.has(o) ? 'checked' : ''} ${dis}>
        <span>${esc(o)}</span></label>`).join('')}
      ${mark && part.note ? `<div class="ws-note">${esc(part.note)}</div>` : ''}
    </div>`;
  }
  if (part.type === 'blanks') {
    let j = 0, last = 0, html = '';
    for (const m of part.text.matchAll(GAP_RE)) {
      html += esc(part.text.slice(last, m.index));
      last = m.index + m[0].length;
      const k = j++;
      const alts = m[1].split('|').map(t => t.trim()).filter(Boolean);
      const st = mark?.gaps?.[k] || '';
      const size = Math.max(6, ...alts.map(a => a.length + 2));
      html += `<input class="gap ${st}" type="text" data-part="${i}" data-gap="${k}" size="${size}" value="${esc((value || [])[k] || '')}"
        autocomplete="off" autocapitalize="off" spellcheck="false" lang="sv" ${dis}>`;
      if (st && st !== 'ok') html += `<span class="gap-key">${esc(alts[0])}</span>`;
    }
    html += esc(part.text.slice(last));
    return `<div class="ws-part ws-blanks">${part.label ? `<span class="ws-label">${esc(part.label)}</span> ` : ''}<span lang="sv">${html}</span>
      ${mark && part.note ? `<div class="ws-note">${esc(part.note)}</div>` : ''}</div>`;
  }
  const head = `<div class="ws-head">${part.label ? `<span class="ws-num">${esc(part.label)}</span>` : ''}${part.prompt ? `<span class="ws-prompt">${esc(part.prompt)}</span>` : ''}</div>`;
  if (locked && mark?.status) {
    const others = part.answer.filter(a => a !== mark.model);
    const statusLabel = { ok: '✓ Верно', almost: 'Почти: проверьте å, ä, ö', compare: 'Сравните с образцом', empty: 'Нет ответа' }[mark.status];
    const cls = mark.credited ? 'ok' : mark.status === 'empty' ? 'bad' : 'almost';
    return `<div class="ws-part ws-write ${cls}">
      ${head}
      <div class="ws-mine" lang="sv">${mark.status === 'empty' ? '<span class="muted">—</span>' : mark.status === 'ok' ? esc(value) : diffHTML(value, mark.model, 'diff-x')}</div>
      ${mark.status !== 'ok' ? `<div class="ws-model"><span class="muted small">Образец:</span> <span lang="sv">${mark.status === 'empty' ? esc(mark.model) : diffHTML(mark.model, value, 'diff-m')}</span></div>` : ''}
      ${others.length && mark.status !== 'ok' ? `<div class="ws-model small muted">Также верно: <span lang="sv">${others.map(esc).join(' · ')}</span></div>` : ''}
      ${part.note ? `<div class="ws-note">${esc(part.note)}</div>` : ''}
      <div class="ws-status">
        <span class="small ${mark.credited ? 'good-t' : 'muted'}">${mark.credited && mark.status !== 'ok' ? '✓ Засчитано' : statusLabel}</span>
        ${mark.status !== 'ok' && mark.status !== 'empty' ? `<button type="button" class="chip ws-credit" data-part="${i}">${mark.credited ? 'Отменить' : '✓ Засчитать'}</button>` : ''}
      </div>
    </div>`;
  }
  return `<div class="ws-part ws-write">
    ${head}
    <textarea data-part="${i}" rows="${part.rows || 4}" lang="sv" spellcheck="false" ${dis}>${esc(value || '')}</textarea>
  </div>`;
}

function exercisePage(lessonId, exId) {
  const l = lessons.find(x => x.id === lessonId);
  const x = l?.exercises?.find(e => e.id === exId);
  if (!x) return emptyState('🤷', 'Упражнение не найдено', '', '<a class="btn" href="#/">На главную</a>');
  const key = exKey(l, x);
  const track = x.audio ? l.audio?.find(a => a.id === x.audio) : null;
  const scored = gradeExercise(x, {}).total > 0;
  const hasLetters = x.parts.some(p => p.type !== 'check');

  app.innerHTML = `<div class="session ws">
    <a class="back" href="#/lesson/${esc(l.id)}">← ${esc(l.title)}</a>
    <h1>${esc(x.title)}</h1>
    ${track ? playerHTML(track) : ''}
    <div class="ws-task">
      ${x.task ? `<div lang="sv"><b>${esc(x.task)}</b></div>` : ''}
      ${x.taskRu ? `<div class="muted">${esc(x.taskRu)}</div>` : ''}
    </div>
    <form id="ws" class="ws-parts" autocomplete="off"></form>
    ${hasLetters ? `<div class="letters" id="ws-letters">${['å', 'ä', 'ö'].map(ch => `<button type="button" data-ch="${ch}">${ch}</button>`).join('')}</div>` : ''}
    <div id="ws-result"></div>
    <div class="row" id="ws-actions"></div>
  </div>`;
  initPlayers(app);

  const form = $('#ws');
  let lastFocus = null;
  const values = () => {
    const v = {};
    x.parts.forEach((p, i) => {
      if (p.type === 'check') v[i] = $$(`input[data-part="${i}"]`, form).filter(c => c.checked).map(c => c.value);
      else if (p.type === 'blanks') v[i] = $$(`input[data-part="${i}"]`, form).map(g => g.value);
      else v[i] = $(`textarea[data-part="${i}"]`, form)?.value || '';
    });
    return v;
  };
  const save = entry => {
    answers[key] = { ...(entry || { v: {}, checked: false }), t: Date.now() };
    saveAnswers();
    sync.push(300);
  };

  const render = () => {
    const a = answers[key];
    const locked = !!a?.checked;
    const g = locked ? gradeExercise(x, a.v || {}, a.self || {}) : null;
    form.innerHTML = x.parts.map((p, i) => partHTML(p, i, a?.v?.[i], g?.marks[i], locked)).join('');
    if ($('#ws-letters')) $('#ws-letters').hidden = locked;
    $('#ws-result').innerHTML = !locked ? '' : g.total
      ? `<div class="feedback ${g.score === g.total ? 'ok' : g.score >= g.total / 2 ? 'almost' : 'bad'}">
          <div><b>${g.score} / ${g.total}</b> ${g.score === g.total ? '— всё верно!' : ''}</div>
          <div class="small muted">Сохранено ${new Date(a.t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</div>
        </div>`
      : `<div class="feedback ok"><div><b>Сохранено</b></div><div class="small muted">${new Date(a.t).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}</div></div>`;
    $('#ws-actions').innerHTML = locked
      ? `<button class="btn" id="ws-edit" type="button">✏️ Изменить ответы</button>
         <button class="btn danger" id="ws-clear" type="button">Начать заново</button>
         <span class="spacer"></span><a class="btn" href="#/lesson/${esc(l.id)}">К уроку</a>`
      : `<button class="btn primary big" id="ws-check" type="button">${scored ? 'Проверить' : 'Сохранить'}</button>
         <span class="small muted" id="ws-saved">${hasAnswers(a) ? 'Черновик сохранён' : ''}</span>`;

    if (locked) {
      $$('.ws-credit', form).forEach(b => b.onclick = () => {
        const self = { ...(a.self || {}) };
        if (self[b.dataset.part]) delete self[b.dataset.part]; else self[b.dataset.part] = true;
        const { score, total } = gradeExercise(x, a.v || {}, self);
        save({ ...a, self, score, total });
        render();
      });
      $('#ws-edit').onclick = () => { save({ v: a.v, checked: false }); render(); };
      $('#ws-clear').onclick = () => {
        if (!confirm('Удалить ваши ответы и начать заново?')) return;
        save(null); render();
      };
    } else {
      $('#ws-check').onclick = () => {
        const v = values();
        if (emptyValues(v) && !confirm('Ответов нет. Всё равно проверить?')) return;
        const { score, total } = gradeExercise(x, v);
        save({ v, checked: true, score, total });
        render();
        $('#ws-result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
    }
  };

  let draftTimer = null;
  form.addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      const v = values();
      save(emptyValues(v) ? null : { v, checked: false });
      const el = $('#ws-saved');
      if (el) el.textContent = emptyValues(v) ? '' : 'Черновик сохранён';
    }, 500);
  });
  form.addEventListener('focusin', e => { if (e.target.matches('input[type="text"], textarea')) lastFocus = e.target; });
  form.addEventListener('submit', e => e.preventDefault());
  $$('#ws-letters button').forEach(b => {
    b.onmousedown = e => e.preventDefault();
    b.onclick = () => {
      const el = lastFocus;
      if (!el || el.disabled) return;
      const s0 = el.selectionStart ?? el.value.length, s1 = el.selectionEnd ?? s0;
      el.value = el.value.slice(0, s0) + b.dataset.ch + el.value.slice(s1);
      el.setSelectionRange(s0 + 1, s0 + 1);
      el.focus();
      form.dispatchEvent(new Event('input'));
    };
  });
  render();
}

const routes = { '': home, lesson: lessonPage, cards: cardsPage, review: reviewPage, quiz: quizPage, type: typePage, drill: drillPage, ex: exercisePage };

function route() {
  onKey = null;
  if (!currentUser) return loginPage();
  const [name = '', ...args] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.route === name));
  (routes[name] || home)(...args);
  window.scrollTo(0, 0);
}

function syncHeader() {
  const sel = $('#lesson-filter');
  sel.innerHTML = `<option value="all">Все уроки</option>` +
    [...lessons].reverse().map(l => `<option value="${esc(l.id)}">${esc(l.title)}</option>`).join('');
  sel.value = settings.lesson;
  $('#dir-toggle').textContent = svFirst() ? 'SV → RU' : 'RU → SV';
  $('#user').textContent = currentUser ? `👤 ${currentUser.name}` : '';
  $('#user').title = currentUser ? `${currentUser.name} — выйти` : '';
  document.body.classList.toggle('locked', !currentUser);
}

// ---------- Login ----------

async function api(path, opts) {
  const r = await fetch(path, opts);
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ok: r.ok, data };
}

function sessionExpired() {
  if (!currentUser) return;
  useUser(null);
  syncHeader();
  loginPage('Сессия закончилась — войдите снова.');
}

async function logout() {
  if (!confirm(`Выйти из профиля ${currentUser.name}?`)) return;
  await fetch('api/logout', { method: 'POST' }).catch(() => {});
  useUser(null);
  history.replaceState(null, '', '#/');
  syncHeader();
  loginPage();
}

async function loginPage(message = '') {
  onKey = null;
  syncHeader();
  app.innerHTML = '<p class="muted">Загрузка…</p>';
  let list;
  try {
    const r = await api('api/users');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    list = r.data;
  } catch {
    app.innerHTML = '<div class="panel empty"><div class="big-emoji">📡</div><h2>Нет связи с сервером</h2><p class="muted">Проверьте подключение и обновите страницу.</p></div>';
    return;
  }
  if (!list.length) {
    app.innerHTML = '<div class="panel empty"><div class="big-emoji">🔒</div><h2>Нет пользователей</h2><p class="muted">Добавьте пользователей в users.json на сервере.</p></div>';
    return;
  }

  let picked = list.length === 1 ? list[0] : null;
  let pin = '';
  let busy = false;
  const render = (error = '') => {
    app.innerHTML = `<div class="login panel">
      <div class="login-flag"><span class="flag"></span></div>
      <h1>Hej! Кто учится?</h1>
      ${message ? `<p class="muted">${esc(message)}</p>` : ''}
      <div class="login-users">${list.map(u => `<button class="login-user${picked?.id === u.id ? ' active' : ''}" data-id="${esc(u.id)}" type="button">
        <span class="avatar">${esc(u.name[0].toUpperCase())}</span><span>${esc(u.name)}</span></button>`).join('')}</div>
      ${picked ? `<div class="pin-label">PIN для ${esc(picked.name)}</div>
        <div class="pin-dots" aria-label="Введено ${pin.length} из ${picked.pinLength}">${Array.from({ length: picked.pinLength }, (_, i) => `<i class="${i < pin.length ? 'on' : ''}"></i>`).join('')}</div>
        <div class="pin-error" role="alert">${esc(error)}</div>
        <div class="pin-pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map(k => k
          ? `<button type="button" data-k="${k}" ${busy ? 'disabled' : ''}>${k}</button>` : '<span></span>').join('')}</div>` : ''}
    </div>`;
    $$('.login-user').forEach(b => b.onclick = () => { picked = list.find(u => u.id === b.dataset.id); pin = ''; render(); });
    $$('.pin-pad button').forEach(b => {
      b.onmousedown = e => e.preventDefault();
      b.onclick = () => press(b.dataset.k);
    });
  };
  const press = k => {
    if (!picked || busy) return;
    if (k === '⌫') pin = pin.slice(0, -1);
    else if (/^\d$/.test(k) && pin.length < picked.pinLength) pin += k;
    render();
    if (pin.length === picked.pinLength) submit();
  };
  const submit = async () => {
    busy = true;
    render();
    let r;
    try { r = await api('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user: picked.id, pin }) }); }
    catch { r = { status: 0, data: {} }; }
    busy = false;
    pin = '';
    if (r.ok) return startSession(r.data);
    render(r.status === 429 ? `Слишком много попыток. Подождите ${Math.ceil((r.data.retryAfter || 60) / 60)} мин.`
      : r.status === 401 ? 'Неверный PIN' : 'Нет связи с сервером');
    $('.pin-dots')?.classList.add('shake');
  };
  onKey = e => {
    if (/^\d$/.test(e.key)) press(e.key);
    else if (e.key === 'Backspace') press('⌫');
  };
  render();
}

async function startSession(user) {
  useUser(user);
  syncHeader();
  // Wait briefly for server progress so the first screen shows the right counts.
  const first = sync.run({ full: true });
  const settled = await Promise.race([first.then(() => true), new Promise(r => setTimeout(r, 2500, false))]);
  route();
  if (!settled) first.then(ok => ok && refreshIdle());
}

document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.matches?.('input:not([type="range"]):not([type="checkbox"]), textarea, select')) return;
  // P (any keyboard layout) toggles the first audio player on the page.
  if (e.code === 'KeyP') {
    const btn = $('.player .play:not(:disabled)');
    if (btn) { e.preventDefault(); btn.click(); }
    return;
  }
  if (!onKey || t.matches?.('input')) return;
  if (t.matches?.('button:not(:disabled), a[href]') && (e.key === 'Enter' || e.key === ' ')) return;
  onKey(e);
});

(async () => {
  try {
    await load();
  } catch (err) {
    app.innerHTML = `<div class="panel"><h2>Не удалось загрузить уроки</h2><p class="muted">${esc(err.message)}</p>
      <p class="small muted">Локально запустите сервер: <code>node server/server.mjs</code></p></div>`;
    return;
  }
  $('#lesson-filter').onchange = e => { settings.lesson = e.target.value; saveSettings(); route(); };
  $('#dir-toggle').onclick = () => { settings.dir = svFirst() ? 'ru-sv' : 'sv-ru'; saveSettings(); syncHeader(); route(); };
  $('#user').onclick = logout;
  window.addEventListener('hashchange', route);

  let me = null;
  try {
    const r = await api('api/me');
    if (r.ok) me = r.data;
  } catch {
    // Offline: keep working from the last user's local cache; sync resumes when the server is back.
    try { me = JSON.parse(localStorage.getItem(LAST_USER)); } catch { me = null; }
  }
  if (me) return startSession(me);
  useUser(null);
  loginPage();
})();
