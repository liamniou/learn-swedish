'use strict';

const DAY = 864e5;
// Spaced-repetition intervals (days) per box; box 0 = still learning.
const INTERVALS = [0, 1, 3, 7, 14, 30, 60, 120];
const LEARNED_BOX = 3;
const SESSION_SIZE = 15;
const KEYS = { progress: 'sv.progress.v1', settings: 'sv.settings.v1', daily: 'sv.daily.v1', pending: 'sv.pending.v1', resetAt: 'sv.resetAt.v1' };

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const app = $('#app');

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { localStorage.setItem(k, JSON.stringify(v)); },
};

let lessons = [];
let cards = [];
let progress = store.get(KEYS.progress, {});
const settings = Object.assign({ dir: 'sv-ru', lesson: 'all', newPerDay: 20, newPerDayT: 0 }, store.get(KEYS.settings, {}));
const saveSettings = () => store.set(KEYS.settings, settings);
const saveProgress = () => store.set(KEYS.progress, progress);

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
  pending: new Set(store.get(KEYS.pending, [])),
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
    if (this.inflight) { await this.inflight; if (!full && !this.pending.size) return; }
    this.inflight = this._run(full).finally(() => { this.inflight = null; });
    return this.inflight;
  },

  async _run(full) {
    const keys = full ? Object.keys(progress) : [...this.pending];
    const body = {
      progress: Object.fromEntries(keys.filter(k => progress[k]).map(k => [k, progress[k]])),
      daily: daily(),
      settings: { newPerDay: settings.newPerDay, t: settings.newPerDayT },
    };
    this.setStatus('syncing');
    try {
      const r = await fetch('api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const server = await r.json();
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
      store.set(KEYS.resetAt, server.resetAt);
    }
    const merged = { ...server.progress };
    for (const [k, p] of Object.entries(progress)) {
      if (!merged[k] || (p.t || 0) > (merged[k].t || 0)) merged[k] = p;
    }
    progress = merged;
    saveProgress();
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
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const server = await r.json();
    progress = {};
    this.pending.clear();
    store.set(KEYS.pending, []);
    localStorage.removeItem(KEYS.daily);
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
  if (document.visibilityState === 'visible') sync.run().then(ok => ok && refreshIdle());
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

function grade(c, g) {
  const key = pk(c);
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

function intervalLabel(c, g) {
  if (g === 0) return 'сейчас';
  const box = Math.min((prog(c)?.box ?? 0) + g, INTERVALS.length - 1);
  const d = INTERVALS[box];
  return `${d} ${plural(d, 'день', 'дня', 'дней')}`;
}

// ---------- Shared UI ----------

function frontHTML(c) {
  return `<div class="tag">${esc(c.section)}</div>
    <div class="word" ${svFirst() ? 'lang="sv"' : ''}>${esc(front(c))}</div>
    <div class="tap muted">нажмите, чтобы перевернуть</div>`;
}

function exampleHTML(c) {
  if (!c.ex) return '';
  return `<div class="ex"><div class="sv" lang="sv">${esc(c.ex)}</div><div class="muted">${esc(c.exRu)}</div></div>`;
}

function backHTML(c) {
  return `<div class="muted">${esc(front(c))}</div>
    <div class="answer" ${svFirst() ? '' : 'lang="sv"'}>${esc(back(c))}</div>
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
        return `<a class="lesson-card" href="#/lesson/${esc(l.id)}">
          <div class="title">${esc(l.title)} ${l.titleSv ? `<span class="muted" lang="sv">· ${esc(l.titleSv)}</span>` : ''}</div>
          <div class="pct">${pct}%</div>
          <div class="meta">${fmtDate(l.date)} · ${words(lc.total)}${l.drills?.length ? ' · тренажёр' : ''}</div>
          ${bar(lc.learned, lc.total, '')}
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
    const blob = new Blob([JSON.stringify({ progress, settings: { newPerDay: settings.newPerDay }, daily: daily() }, null, 1)], { type: 'application/json' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `svenska-progress-${today()}.json` });
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
  app.innerHTML = `
    <a class="back" href="#/">← Все уроки</a>
    <h1>${esc(l.title)}</h1>
    <div class="muted">${l.titleSv ? `<span lang="sv">${esc(l.titleSv)}</span> · ` : ''}${fmtDate(l.date)} · ${words(lessonCards.length)}</div>
    ${l.summary ? `<p>${esc(l.summary)}</p>` : ''}
    ${l.listen?.length ? `<div class="listen">
      <b>🎧 Слушать</b>
      ${l.listen.map(a => `<a class="btn" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label)} ↗</a>`).join('')}
      ${l.listenNote ? `<div class="small muted">${esc(l.listenNote)}</div>` : ''}
    </div>` : ''}
    <div class="row" style="margin-top:14px">
      <button class="btn primary" id="study">Учить слова урока</button>
      ${(l.drills || []).map((d, i) => d.items.length ? `<a class="btn" href="#/drill/${esc(id)}/${i}">🎯 ${esc(d.title)}</a>` : '').join('')}
    </div>
    <div class="tabs">
      ${l.notes ? '<button data-tab="notes">Теория</button>' : ''}
      <button data-tab="words">Слова (${lessonCards.length})</button>
    </div>
    <div id="tab"></div>
    ${l.sources?.length ? `<div class="sources">Источники: ${l.sources.map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : esc(s.label)).join(' · ')}</div>` : ''}`;

  $('#study').onclick = () => { settings.lesson = id; saveSettings(); syncHeader(); location.hash = '#/review'; };

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
            <td lang="sv">${esc(w.sv)}</td>
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

function runChoice({ items, restart, title }) {
  let i = 0, score = 0;
  const wrong = [];
  const ask = () => {
    if (i >= items.length) return finish();
    const it = items[i];
    let answered = false;
    app.innerHTML = `<div class="session">
      <div class="session-head"><span>${i + 1} / ${items.length}</span>${bar(i, items.length)}<span>✓ ${score}</span></div>
      <div class="q-card">
        <div class="q-label muted">${esc(it.label || title || '')}</div>
        <div class="q-prompt" ${it.lang ? `lang="${it.lang}"` : ''}>${it.promptHTML}</div>
        ${it.sub ? `<div class="q-sub">${esc(it.sub)}</div>` : ''}
      </div>
      <div class="options">${it.options.map((o, k) => `<button class="opt" data-k="${k}"><span class="key">${k + 1}</span><span>${esc(o)}</span></button>`).join('')}</div>
      <div id="fb"></div>
      <div class="kbd-help">1–${it.options.length} — выбрать ответ · Enter — дальше</div>
    </div>`;
    const buttons = $$('.opt');
    const choose = k => {
      if (answered) return;
      answered = true;
      const ok = it.options[k] === it.answer;
      if (ok) score++; else wrong.push(it);
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
    const pct = Math.round(score / items.length * 100);
    app.innerHTML = `<div class="session"><div class="panel result">
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
      options: shuffle([answer, ...picks]),
      answer,
      explainHTML: `${c.hint ? `<div class="small">🗣 ${esc(c.hint)}</div>` : ''}${exampleHTML(c)}`,
      reviewHTML: `<b lang="sv">${esc(c.sv)}</b> — ${esc(c.ru)}`,
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
  runChoice({ items, restart: () => drillPage(id, idx) });
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
      input.readOnly = true;
      $('#fb').innerHTML = `<div class="feedback ${r.status}">
          <div><b class="${r.status === 'ok' ? 'good-t' : r.status === 'almost' ? 'almost-t' : 'bad-t'}">${esc(r.msg)}</b> <b lang="sv">${esc(c.sv)}</b></div>
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
      ${wrong.length ? `<div class="mistakes"><b>Повторите:</b><ul>${wrong.map(c => `<li><b lang="sv">${esc(c.sv)}</b> — ${esc(c.ru)}</li>`).join('')}</ul></div>` : ''}
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

const routes = { '': home, lesson: lessonPage, cards: cardsPage, review: reviewPage, quiz: quizPage, type: typePage, drill: drillPage };

function route() {
  onKey = null;
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
}

document.addEventListener('keydown', e => {
  if (!onKey || e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t.matches?.('input, textarea, select')) return;
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
  syncHeader();
  $('#lesson-filter').onchange = e => { settings.lesson = e.target.value; saveSettings(); route(); };
  $('#dir-toggle').onclick = () => { settings.dir = svFirst() ? 'ru-sv' : 'sv-ru'; saveSettings(); syncHeader(); route(); };
  window.addEventListener('hashchange', route);
  // Wait briefly for server progress so the first screen shows the right counts.
  const first = sync.run({ full: true });
  const settled = await Promise.race([first.then(() => true), new Promise(r => setTimeout(r, 2500, false))]);
  route();
  if (!settled) first.then(ok => ok && refreshIdle());
})();
