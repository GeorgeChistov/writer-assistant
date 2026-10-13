/* Помощник писателя — логика приложения */
(function () {
'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const LS = { book: 'wa_book', settings: 'wa_settings', history: 'wa_history', chat: 'wa_chat', notes: 'wa_notes' };
const P = window.PROMPTS;

// ================= утилиты =================
function load(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn('save failed', k, e); return false; } }
function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
function wordCount(t) { const m = String(t || '').match(/[^\s]+/g); return m ? m.length : 0; }
function fmtNum(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); }
function fmtDate(ts) { const d = new Date(ts); return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) + ', ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }
function safeName(s) { return String(s).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80).replace(/[.\s]+$/, '') || 'результат'; }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

let toastTimer = null;
function toast(msg, ms) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.add('hidden'), ms || 2800);
}

function ask(message, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const wrap = el('div', 'modal-wrap', '<div class="modal" role="dialog"><div class="modal-text"></div><div class="modal-btns"><button type="button" class="btn m-cancel">Отмена</button><button type="button" class="btn-primary m-ok"></button></div></div>');
    $('.modal-text', wrap).textContent = message; const ok = $('.m-ok', wrap); ok.textContent = opts.ok || 'Да'; if (opts.danger) ok.classList.add('danger');
    const onKey = e => { if (e.key === 'Escape') done(false); };
    const done = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    document.addEventListener('keydown', onKey);
    $('.m-cancel', wrap).onclick = () => done(false); ok.onclick = () => done(true);
    wrap.addEventListener('click', e => { if (e.target === wrap) done(false); });
    document.body.appendChild(wrap); ok.focus();
  });
}
function askText(message, value, opts) {
  opts = opts || {};
  return new Promise(resolve => {
    const wrap = el('div', 'modal-wrap', '<div class="modal" role="dialog"><div class="modal-text"></div><input type="text" class="m-input"><div class="modal-btns"><button type="button" class="btn m-cancel">Отмена</button><button type="button" class="btn-primary m-ok"></button></div></div>');
    $('.modal-text', wrap).textContent = message; const inp = $('.m-input', wrap); inp.value = value || ''; const ok = $('.m-ok', wrap); ok.textContent = opts.ok || 'Сохранить';
    const onKey = e => { if (e.key === 'Escape') done(null); };
    const done = v => { wrap.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    document.addEventListener('keydown', onKey);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); done(inp.value); } });
    $('.m-cancel', wrap).onclick = () => done(null); ok.onclick = () => done(inp.value);
    wrap.addEventListener('click', e => { if (e.target === wrap) done(null); });
    document.body.appendChild(wrap); inp.focus(); inp.select();
  });
}
function hashText(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h.toString(16) + ':' + str.length; }
const PART_SIZE = 60000;
function splitParts(text, size) {
  text = String(text || ''); const out = []; let i = 0;
  while (i < text.length) { let end = Math.min(i + size, text.length); const c = text.charCodeAt(end); if (end < text.length && c >= 0xDC00 && c <= 0xDFFF) end += 1; out.push(text.slice(i, end)); i = end; }
  return out.length ? out : [''];
}
function trimChat(list) { let total = 0; const out = []; for (let i = list.length - 1; i >= 0 && out.length < 40; i--) { total += (list[i].text || '').length; if (total > 100000 && out.length) break; out.unshift(list[i]); } return out; }

async function downloadFile(name, text) {
  if (Store.downloads) {
    try { await Store.downloads.save({ filename: name, data: text }); toast('Файл сохранён'); }
    catch (e) { if (!e || (e.code !== 'declined' && e.code !== 'rate_limited')) toast('Не удалось сохранить файл' + (e && e.message ? ': ' + e.message : ''), 5000); }
    return;
  }
  if (Store.mode === 'cloud') { toast('Сохранение файлов здесь недоступно. Нажмите «Скопировать» и вставьте текст в документ.', 5000); return; }
  const blob = new Blob(['\ufeff' + text], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

async function readTextFile(file) {
  const buf = await file.arrayBuffer();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch (e) { try { return new TextDecoder('windows-1251').decode(buf); } catch (e2) { return new TextDecoder().decode(buf); } }
}

// ================= Markdown → HTML =================
function inline(s) {
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/__([^_\n]+)__/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(«"'])\*([^*\n]+)\*(?=[\s.,;:!?)»"']|$)/g, '$1<i>$2</i>');
  s = s.replace(/(^|[\s(«"'])_([^_\n]+)_(?=[\s.,;:!?)»"']|$)/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  return s;
}
function splitRow(line) {
  let l = line.trim(); if (l.startsWith('|')) l = l.slice(1); if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
}
function renderList(items) {
  let idx = 0;
  function build(level) {
    const ordered = /^\d/.test(items[idx].marker); let h = '';
    while (idx < items.length) {
      const it = items[idx];
      if (it.indent < level) break;
      if (it.indent > level) { const inner = build(it.indent); if (/<\/li>$/.test(h)) h = h.replace(/<\/li>$/, inner + '</li>'); else h += '<li>' + inner + '</li>'; continue; }
      h += '<li>' + inline(esc(it.text)) + '</li>'; idx++;
    }
    return (ordered ? '<ol>' : '<ul>') + h + (ordered ? '</ol>' : '</ul>');
  }
  return build(items[0].indent);
}
function md(src) {
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  const out = []; let i = 0; let para = [];
  const flush = () => { if (para.length) { out.push('<p>' + inline(esc(para.join(' '))) + '</p>'); para = []; } };
  while (i < lines.length) {
    const line = lines[i]; let m;
    if (/^\s*```/.test(line)) { flush(); const code = []; i++; while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i++; } i++; out.push('<pre><code>' + esc(code.join('\n')) + '</code></pre>'); continue; }
    if ((m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line))) { flush(); const l = Math.min(m[1].length + 1, 6); out.push('<h' + l + '>' + inline(esc(m[2].replace(/\s*#+\s*$/, ''))) + '</h' + l + '>'); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush(); const header = splitRow(line); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(splitRow(lines[i])); i++; }
      out.push('<table><thead><tr>' + header.map(c => '<th>' + inline(esc(c)) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map(r => '<tr>' + r.map(c => '<td>' + inline(esc(c)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      continue;
    }
    if (/^\s*>/.test(line)) { flush(); const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) { q.push(lines[i].replace(/^\s*>\s?/, '')); i++; } out.push('<blockquote>' + md(q.join('\n')) + '</blockquote>'); continue; }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush(); const items = [];
      while (i < lines.length) {
        const l = lines[i]; const mm = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
        if (mm) { items.push({ indent: mm[1].length, marker: mm[2], text: mm[3] }); i++; }
        else if (/^\s+\S/.test(l) && items.length) { items[items.length - 1].text += ' ' + l.trim(); i++; }
        else break;
      }
      out.push(renderList(items)); continue;
    }
    if (!line.trim()) { flush(); i++; continue; }
    para.push(line.trim()); i++;
  }
  flush(); return out.join('\n');
}
function mdToPlain(src) {
  return String(src || '').replace(/\r\n?/g, '\n')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    .replace(/(^|[\s(«"'])\*([^*\n]+)\*(?=[\s.,;:!?)»"']|$)/g, '$1$2')
    .replace(/(^|[\s(«"'])_([^_\n]+)_(?=[\s.,;:!?)»"']|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/^\s*\|?\s*:?-{2,}[-|:\s]*$/gm, '')
    .replace(/^\s*\|\s*/gm, '').replace(/\s*\|\s*$/gm, '').replace(/\s*\|\s*/g, '  |  ')
    .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '$1 ($2)')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/gm, '')
    .replace(/\n{3,}/g, '\n\n').trim();
}
async function copyResult(text) {
  const html = md(text), plain = mdToPlain(text);
  try {
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
    } else { await navigator.clipboard.writeText(plain); }
    toast('Скопировано'); return;
  } catch (e) { /* ниже — запасной способ */ }
  try { await navigator.clipboard.writeText(plain); toast('Скопировано'); return; } catch (e) { /* ниже */ }
  const ta = document.createElement('textarea'); ta.value = plain; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); toast('Скопировано'); } catch (e) { toast('Не удалось скопировать — выделите текст и нажмите Ctrl+C / Cmd+C'); }
  ta.remove();
}


// ================= браузерное хранилище (IndexedDB) =================
const LocalDB = {
  db: null,
  async open() {
    if (this.db) return this.db;
    if (!window.indexedDB) throw new Error('IndexedDB недоступен');
    this.db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('writer-assistant', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
        ['history', 'images', 'audio'].forEach(n => { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n, { keyPath: 'id' }); });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error || new Error('IndexedDB: ошибка открытия'));
      r.onblocked = () => reject(new Error('IndexedDB занят другой вкладкой'));
    });
    return this.db;
  },
  tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(store, mode); let result;
      const req = fn(t.objectStore(store));
      if (req) req.onsuccess = () => { result = req.result; };
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error || new Error('IndexedDB: ошибка записи'));
      t.onabort = () => reject(t.error || new Error('Браузер отказался сохранить данные: возможно, закончилось место'));
    });
  },
  get(key) { return this.tx('kv', 'readonly', st => st.get(key)); },
  set(key, value) { return this.tx('kv', 'readwrite', st => st.put(value, key)); },
  all(store) { return this.tx(store, 'readonly', st => st.getAll()); },
  put(store, value) { return this.tx(store, 'readwrite', st => st.put(value)); },
  del(store, id) { return this.tx(store, 'readwrite', st => st.delete(id)); },
  clear(store) { return this.tx(store, 'readwrite', st => st.clear()); }
};
function b64ToBlob(b64, mime) { const bin = atob(b64); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return new Blob([u8], { type: mime }); }
function blobToDataUrl(blob) { return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error || new Error('Не удалось прочитать файл')); r.readAsDataURL(blob); }); }
async function fileToBase64(f) { const u = await blobToDataUrl(f); return u.split(',')[1] || ''; }
function isRussian(text) { const t = String(text || '').replace(/\[[^\]]*\]|<[^>]*>/g, ''); return (t.match(/[А-Яа-яЁё]/g) || []).length >= (t.match(/[A-Za-z]/g) || []).length; }
const MEDIA_OFF = 'Иллюстрации и озвучка здесь недоступны: браузер не даёт сохранять файлы. Откройте помощника в обычном окне Chrome или Safari, не в приватном режиме.';

// ---- картинки: Gemini (Nano Banana) прямо из браузера ----
async function geminiImage(prompt, aspect) {
  const s = getSettings();
  if (!s.apiKey) throw new Error('Не задан ключ Gemini. Вставьте его в «Настройках».');
  const url = s.baseUrl + '/v1beta/models/' + encodeURIComponent(s.imageModel) + ':generateContent';
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect || '16:9' } } };
  let res;
  try { res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey }, body: JSON.stringify(body) }); }
  catch (e) { throw new Error(friendly(new Error('NETWORK'))); }
  if (!res.ok) {
    let detail = ''; try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch (e) { /* без деталей */ }
    const err = new Error('HTTP'); err.status = res.status; err.detail = detail; throw new Error(friendly(err));
  }
  const j = await res.json(); const c = (j.candidates || [])[0] || {};
  for (const p of ((c.content || {}).parts || [])) if (p.inlineData && p.inlineData.data) { const mime = p.inlineData.mimeType || 'image/png'; return { blob: b64ToBlob(p.inlineData.data, mime), mime }; }
  const reason = c.finishReason || (j.promptFeedback && j.promptFeedback.blockReason) || '';
  throw new Error('Модель не вернула картинку' + (reason ? ' (' + reason + ')' : '') + '. Попробуйте изменить описание.');
}

// ---- озвучка: ElevenLabs прямо из браузера ----
const ELEVEN = 'https://api.elevenlabs.io';
function elevenErrorText(status, d) {
  const det = d && d.detail;
  if (det && typeof det === 'object' && !Array.isArray(det)) {
    const code = String(det.status || det.code || ''); const msg = String(det.message || '');
    if (code === 'invalid_api_key' || code === 'api_key_id_used_as_api_key') return 'Ключ ElevenLabs не подходит. Нужен ключ, который начинается с sk_: создайте его в кабинете ElevenLabs.';
    if (code === 'quota_exceeded') return 'В ElevenLabs закончились знаки на этот месяц.';
    if (code === 'voice_limit_reached') return 'Достигнут лимит голосов на тарифе ElevenLabs. Удалите ненужный голос.';
    if (/clon/i.test(code) || /clon/i.test(msg)) return 'Клонированные голоса недоступны на вашем тарифе ElevenLabs. Нужен тариф Starter или выше.';
    return 'ElevenLabs: ' + (msg || code || ('ошибка ' + status));
  }
  if (Array.isArray(det)) return 'ElevenLabs: ' + det.slice(0, 3).map(x => (x && x.msg) || JSON.stringify(x)).join('; ');
  if (status === 401) return 'Ключ ElevenLabs не подходит.';
  return 'ElevenLabs: ' + (det || ('ошибка ' + status));
}
async function elevenFetch(path, opts) {
  opts = opts || {};
  const key = getSettings().elevenKey;
  if (!key) throw new Error('Не задан ключ ElevenLabs. Вставьте его в «Настройках»: ключ начинается с sk_.');
  const headers = { 'xi-api-key': key }; let body = opts.body;
  if (opts.json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(opts.json); }
  if (opts.binary) headers.Accept = 'audio/mpeg';
  let res;
  try { res = await fetch(ELEVEN + path, { method: opts.method || 'GET', headers, body }); }
  catch (e) { throw new Error('Нет связи с ElevenLabs. Проверьте интернет и попробуйте ещё раз.'); }
  if (!res.ok) { let d = null; try { d = await res.json(); } catch (e) { /* без деталей */ } throw new Error(elevenErrorText(res.status, d)); }
  if (opts.binary) return res.arrayBuffer();
  return (res.headers.get('content-type') || '').includes('json') ? res.json() : null;
}
function splitForTts(text, limit) {
  limit = limit || 2500;
  const paras = String(text || '').split(/\n+/).map(p => p.trim()).filter(Boolean); const chunks = []; let cur = '';
  for (const p of paras) {
    if (p.length > limit) {
      const sents = p.match(/[^.!?…]+[.!?…]+["»”')\]]*\s*|[^.!?…]+$/g) || [p];
      for (const sn of sents) { if (cur.length + sn.length > limit && cur) { chunks.push(cur.trim()); cur = ''; } cur += sn; }
      cur += '\n'; continue;
    }
    if (cur.length + p.length + 1 > limit && cur) { chunks.push(cur.trim()); cur = ''; }
    cur += p + '\n';
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
function voiceSettings(model, manner) {
  const v3 = /^eleven_v3/.test(model);
  if (manner === 'expressive') return { stability: v3 ? 0.0 : 0.3, similarity_boost: 0.8, style: v3 ? 0.0 : 0.6, use_speaker_boost: true };
  if (manner === 'calm') return { stability: v3 ? 1.0 : 0.75, similarity_boost: 0.8, style: v3 ? 0.0 : 0.1, use_speaker_boost: true };
  return { stability: 0.5, similarity_boost: 0.75, style: v3 ? 0.0 : 0.2, use_speaker_boost: true };
}

// ---- глава с иллюстрациями (собирается прямо в браузере) ----
const LAYOUT_CSS = "body{font-family:Georgia,'Times New Roman',serif;max-width:760px;margin:0 auto;padding:32px 20px 80px;line-height:1.65;color:#1f1d1a;background:#faf7f2;font-size:18px}h1{font-size:2rem;margin:0 0 4px}.sub{color:#6c665d;margin-bottom:28px}h2{font-size:1.4rem;margin:40px 0 14px}p{margin:0 0 14px;text-indent:1.5em}figure{margin:26px 0;text-align:center}figure img{max-width:100%;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.12)}figcaption{color:#6c665d;font-size:.92rem;margin-top:8px;font-style:italic}";
async function buildLayoutHtml(chapterId) {
  const chapters = chapterId === 'all' ? book.chapters : book.chapters.filter(c => c.id === chapterId);
  const ids = new Set(chapters.map(c => c.id));
  const recs = (await Store.listImages()).sort((a, b) => a.ts - b.ts).filter(r => (chapterId === 'all' && !r.chapter_id) || ids.has(r.chapter_id));
  const urls = new Map(); for (const r of recs) urls.set(r.id, await blobToDataUrl(await (await fetch(r.url)).blob()));
  const fig = r => '<figure><img src="' + urls.get(r.id) + '" alt="' + esc(r.caption || '') + '"><figcaption>' + esc(r.caption || '') + (r.style_label ? ' · ' + esc(r.style_label) : '') + '</figcaption></figure>';
  let body = '<h1>' + esc(book.title || 'Рукопись') + '</h1><div class="sub">' + esc(book.series || '') + '</div>';
  if (chapterId === 'all') recs.filter(r => !r.chapter_id).forEach(r => { body += fig(r); });
  chapters.forEach(ch => {
    const own = recs.filter(r => r.chapter_id === ch.id);
    const anchored = own.filter(r => String(r.anchor || '').trim()); const done = new Set();
    body += '<h2>' + esc(ch.title) + '</h2>';
    own.filter(r => !String(r.anchor || '').trim()).forEach(r => { body += fig(r); });
    ch.text.split('\n').forEach(p => {
      if (!p.trim()) return;
      body += '<p>' + esc(p) + '</p>';
      anchored.forEach(r => { if (done.has(r.id)) return; const key = String(r.anchor).trim().slice(0, 60); if (key && p.indexOf(key) >= 0) { body += fig(r); done.add(r.id); } });
    });
    anchored.forEach(r => { if (!done.has(r.id)) body += fig(r); });
  });
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>' + esc(book.title || 'Рукопись') + ': с иллюстрациями</title><style>' + LAYOUT_CSS + '</style></head><body>' + body + '</body></html>';
}

async function showLayout(chapterId) {
  const wrap = el('div', 'reader-wrap', '<div class="reader" role="dialog"><div class="reader-bar"><b>Глава с иллюстрациями</b><span class="grow"></span><button type="button" class="btn r-dl" disabled>Скачать</button><button type="button" class="btn r-close">Закрыть</button></div><div class="reader-body"><div class="muted" style="padding:24px">Собираю главу…</div></div></div>');
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); };
  document.addEventListener('keydown', onKey); $('.r-close', wrap).onclick = close;
  document.body.appendChild(wrap);
  let html;
  try { html = await buildLayoutHtml(chapterId || 'all'); }
  catch (e) { $('.reader-body', wrap).innerHTML = '<div class="error" style="margin:16px">Не удалось собрать главу: ' + esc(e.message || String(e)) + '</div>'; return; }
  const frame = document.createElement('iframe'); frame.className = 'reader-frame'; frame.title = 'Глава с иллюстрациями'; frame.srcdoc = html;
  const body = $('.reader-body', wrap); body.innerHTML = ''; body.appendChild(frame);
  const dl = $('.r-dl', wrap); dl.disabled = false;
  const ch = book.chapters.find(c => c.id === chapterId);
  dl.onclick = () => downloadFile(safeName((book.title || 'Рукопись') + ' — ' + (ch ? ch.title : 'вся книга') + ' с иллюстрациями') + '.html', html);
}

// ---- передача задания со страницы claude.ai в мастерскую (через адрес ссылки) ----
function b64url(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function b64urlDecode(str) { let s = str.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; }
async function packHandoff(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (typeof CompressionStream === 'undefined') return '0' + b64url(bytes);
  const out = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer();
  return '1' + b64url(new Uint8Array(out));
}
async function unpackHandoff(str) {
  let bytes = b64urlDecode(str.slice(1));
  if (str[0] === '1') bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
  return JSON.parse(new TextDecoder().decode(bytes));
}
function handoffUrl(packed) { return String((window.CONFIG || {}).webUrl || '').replace(/#.*$/, '') + '#wa=' + packed; }
function handoffLink(a, payloadFn) {
  let timer = null;
  const refresh = () => {
    a.dataset.ready = ''; clearTimeout(timer);
    timer = setTimeout(async () => { try { a.href = handoffUrl(await packHandoff(payloadFn())); a.dataset.ready = '1'; } catch (e) { console.error(e); } }, 150);
  };
  a.addEventListener('click', e => { if (a.dataset.ready !== '1') { e.preventDefault(); toast('Секунду, готовлю ссылку. Нажмите ещё раз.'); refresh(); } });
  return refresh;
}

// ================= хранилище: база SQLite через локальный сервер или браузер =================
const Store = {
  mode: 'local', dbPath: '', db: null, user: null, uid: null, downloads: null, sample: null, cloudIndex: new Map(), queue: Promise.resolve(),
  idb: false, objUrls: new Map(), voicesCache: null,
  async init() {
    if (window.claude && typeof window.claude.use === 'function') {
      let db = null; try { db = await window.claude.use('db'); } catch (e) { db = null; }
      if (db) {
        this.mode = 'cloud'; this.db = db;
        try { this.user = await window.claude.use('user'); this.uid = this.user ? await this.user.id() : null; } catch (e) { this.uid = null; }
        try { this.downloads = await window.claude.use('downloads'); } catch (e) { this.downloads = null; }
        try { this.sample = await window.claude.use('sample'); } catch (e) { this.sample = null; }
        if (this.sample) { try { const lim = await this.sample.limits(); if (lim && lim.maxPromptBytes) Engine.maxBytes = lim.maxPromptBytes; } catch (e) { /* лимит по умолчанию */ } }
        return this.cloudLoad();
      }
    }
    if (/^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) {
      try { const r = await fetch('/api/ping', { cache: 'no-store' }); if (r.ok) { const j = await r.json(); if (j && j.ok) { this.mode = 'server'; this.dbPath = j.db || ''; } } } catch (e) { /* сервера нет — работаем через браузер */ }
    }
    if (this.mode === 'server') {
      const st = await this.req('GET', 'state');
      if (!st.seeded) {
        // Первый запуск с базой: переносим то, что было в браузере, или берём рукопись из book.js
        const src = load(LS.book, null) || window.BOOK_DEFAULT || { title: '', series: '', author: '', chapters: [] };
        st.book = { title: src.title || '', series: src.series || '', author: src.author || '' };
        st.chapters = (src.chapters || []).map(c => ({ id: c.id || uid(), title: c.title, text: c.text }));
        st.notes = load(LS.notes, []); st.chat = load(LS.chat, []); st.settings = load(LS.settings, {});
        await this.req('PUT', 'book', Object.assign({}, st.book, { chapters: st.chapters }));
        if (st.notes.length) await this.req('PUT', 'notes', st.notes);
        if (st.chat.length) await this.req('PUT', 'chat', st.chat);
        if (Object.keys(st.settings).length) await this.req('PUT', 'settings', st.settings);
        const lh = load(LS.history, []); for (const h of lh.slice().reverse()) await this.req('POST', 'history', h);
      }
      return { book: Object.assign({}, st.book, { chapters: st.chapters || [] }), settings: st.settings || {}, notes: st.notes || [], chat: st.chat || [], images: st.images || [], audio: st.audio || [], kv: st.kv || {} };
    }
    // ---- браузер: IndexedDB (картинки и записи тоже хранятся здесь) ----
    try { await LocalDB.open(); this.idb = true; } catch (e) { this.idb = false; console.warn('IndexedDB недоступен', e); }
    if (this.idb) {
      let bookV = await LocalDB.get('book');
      if (bookV === undefined) {
        // перенос данных из старой версии, хранившей всё в localStorage
        const lsBook = load(LS.book, null);
        if (lsBook) { bookV = lsBook; await LocalDB.set('book', lsBook); }
        for (const k of ['notes', 'chat', 'settings']) { const v = load(LS[k], null); if (v) await LocalDB.set(k, v); }
        for (const h of load(LS.history, [])) await LocalDB.put('history', h);
      }
      const [settings, notesV, chatV, bible, imgs, auds] = await Promise.all([LocalDB.get('settings'), LocalDB.get('notes'), LocalDB.get('chat'), LocalDB.get('kv:visual_bible'), LocalDB.all('images'), LocalDB.all('audio')]);
      const byTs = (a, b) => b.ts - a.ts;
      return { book: bookV || null, settings: settings || {}, notes: notesV || [], chat: chatV || [], images: imgs.map(r => this.mediaRow(r)).sort(byTs), audio: auds.map(r => this.mediaRow(r)).sort(byTs), kv: { visual_bible: bible || '' } };
    }
    return { book: load(LS.book, null), settings: load(LS.settings, {}), notes: load(LS.notes, []), chat: load(LS.chat, []) };
  },
  mediaRow(r) { const o = {}; for (const k in r) if (k !== 'blob') o[k] = r[k]; if (r.blob) o.url = this.objUrl(r.id, r.blob); return o; },
  objUrl(id, blob) { if (!this.objUrls.has(id)) this.objUrls.set(id, URL.createObjectURL(blob)); return this.objUrls.get(id); },
  dropUrl(id) { const u = this.objUrls.get(id); if (u) { try { URL.revokeObjectURL(u); } catch (e) { /* уже освобождён */ } this.objUrls.delete(id); } },
  persist() { try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* не поддерживается */ } },
  // ---- облако: хранилище страницы claude.ai ----
  serial(fn) { const run = this.queue.then(fn, fn); this.queue = run.catch(() => {}); return run; },
  async cloudLoad() {
    const db = this.db;
    const [bookSnap, chSnap, notesSnap, chatSnap, bibleSnap] = await Promise.all([
      db.doc('state/book').get(), db.collection('chapters').orderBy('position').get(), db.doc('state/notes').get(), db.doc('state/chat').get(), db.doc('kv/visual_bible').get()]);
    const chapters = await Promise.all(chSnap.docs.map(async d => {
      const m = d.data() || {}; const n = m.parts || 0;
      const parts = await Promise.all(Array.from({ length: n }, (_, k) => db.doc('chapters/' + d.id + '/parts/p' + k).get()));
      const text = parts.map(p => (p.exists && p.data() && p.data().text) || '').join('');
      this.cloudIndex.set(d.id, { title: m.title || '', position: m.position || 0, parts: n, hash: hashText(text) });
      return { id: d.id, title: m.title || '', text };
    }));
    const b = bookSnap.exists ? bookSnap.data() : {};
    let settings = null;
    if (this.uid) { try { const sn = await db.doc('data/users/' + this.uid + '/settings').get(); settings = sn.exists ? deepCopy(sn.data()) : {}; } catch (e) { settings = null; } }
    if (!settings) settings = load(LS.settings, {});
    return {
      book: { title: b.title || '', series: b.series || '', author: b.author || '', about: b.about || '', chapters },
      settings, notes: deepCopy((notesSnap.exists && notesSnap.data().items) || []), chat: deepCopy((chatSnap.exists && chatSnap.data().messages) || []),
      kv: { visual_bible: (bibleSnap.exists && (bibleSnap.data() || {}).value) || '' },
      empty: !bookSnap.exists && chapters.length === 0
    };
  },
  async cloudSaveBook(b) {
    const db = this.db;
    await db.doc('state/book').set({ title: b.title || '', series: b.series || '', author: b.author || '', about: b.about || '', updatedAt: Date.now() });
    const seen = new Set();
    for (let i = 0; i < b.chapters.length; i++) {
      const ch = b.chapters[i]; seen.add(ch.id);
      const prev = this.cloudIndex.get(ch.id); const h = hashText(ch.text); const parts = splitParts(ch.text, PART_SIZE);
      const textChanged = !prev || prev.hash !== h;
      if (!prev || prev.title !== ch.title || prev.position !== i || textChanged) await db.doc('chapters/' + ch.id).set({ title: ch.title, position: i, parts: parts.length, chars: ch.text.length, updatedAt: Date.now() });
      if (textChanged) {
        for (let k = 0; k < parts.length; k++) await db.doc('chapters/' + ch.id + '/parts/p' + k).set({ text: parts[k] });
        for (let k = parts.length; k < (prev ? prev.parts : 0); k++) await db.doc('chapters/' + ch.id + '/parts/p' + k).delete();
      }
      this.cloudIndex.set(ch.id, { title: ch.title, position: i, parts: parts.length, hash: h });
    }
    for (const [id, prev] of Array.from(this.cloudIndex.entries())) {
      if (seen.has(id)) continue;
      for (let k = 0; k < prev.parts; k++) await db.doc('chapters/' + id + '/parts/p' + k).delete();
      await db.doc('chapters/' + id).delete(); this.cloudIndex.delete(id);
    }
  },
  async cloudAddHistory(e) {
    const db = this.db; const parts = splitParts(e.text, PART_SIZE);
    await db.doc('history/' + e.id).set({ ts: e.ts, section: e.section, title: e.title, chars: e.text.length, parts: parts.length });
    for (let k = 0; k < parts.length; k++) await db.doc('history/' + e.id + '/parts/p' + k).set({ text: parts[k] });
  },
  async cloudDeleteHistory(id, parts) {
    const db = this.db;
    for (let k = 0; k < (parts || 0); k++) await db.doc('history/' + id + '/parts/p' + k).delete();
    await db.doc('history/' + id).delete();
  },
  async getHistoryText(item) {
    if (item.text != null) return item.text;
    if (this.mode !== 'cloud') return '';
    const parts = await Promise.all(Array.from({ length: item.parts || 0 }, (_, k) => this.db.doc('history/' + item.id + '/parts/p' + k).get()));
    item.text = parts.map(p => (p.exists && p.data() && p.data().text) || '').join('');
    return item.text;
  },
  media() { return this.mode === 'server' || (this.mode === 'local' && this.idb); },
  mediaKind() { if (this.media()) return 'direct'; if (this.mode === 'cloud' && (window.CONFIG || {}).webUrl) return 'handoff'; return 'none'; },
  async listImages() {
    if (this.mode === 'server') return this.req('GET', 'images');
    return (await LocalDB.all('images')).map(r => this.mediaRow(r)).sort((a, b) => b.ts - a.ts);
  },
  async generateImages(body) {
    if (this.mode === 'server') return this.req('POST', 'images/generate', body);
    const count = Math.max(1, Math.min(parseInt(body.count, 10) || 2, 4)); const results = new Array(count);
    for (let i = 0; i < count; i += 2) await Promise.all([i, i + 1].filter(k => k < count).map(async k => { results[k] = await geminiImage(body.prompt, body.aspect); }));
    const rows = []; const now = Date.now();
    for (let i = 0; i < count; i++) {
      const rec = { id: 'img_' + uid(), ts: now + i, chapter_id: body.chapter_id || '', chapter_title: body.chapter_title || '', anchor: String(body.anchor || '').slice(0, 300), fragment: String(body.fragment || '').slice(0, 3000),
        caption: body.caption || '', style: body.style || '', style_label: body.style_label || '', prompt: body.prompt, aspect: body.aspect || '16:9', variant: i + 1, mime: results[i].mime, blob: results[i].blob };
      await LocalDB.put('images', rec); rows.push(this.mediaRow(rec));
    }
    this.persist(); return rows;
  },
  async deleteImage(id) { if (this.mode === 'server') return this.req('DELETE', 'images/' + encodeURIComponent(id)); await LocalDB.del('images', id); this.dropUrl(id); },
  async listVoices(refresh) {
    if (this.mode === 'server') return this.req('GET', 'eleven/voices' + (refresh ? '/refresh' : ''));
    if (!refresh && this.voicesCache && Date.now() - this.voicesCache.ts < 300000) return this.voicesCache.data;
    const d = await elevenFetch('/v1/voices');
    const voices = (d.voices || []).map(v => { const l = v.labels || {}; return { id: v.voice_id, name: v.name, category: v.category, gender: l.gender, accent: l.accent, age: l.age, description: l.description || v.description, use_case: l.use_case, preview: v.preview_url }; });
    let usage = null;
    try { const sub = await elevenFetch('/v1/user/subscription'); usage = { tier: sub.tier, status: sub.status, character_count: sub.character_count, character_limit: sub.character_limit, can_use_instant_voice_cloning: sub.can_use_instant_voice_cloning, voice_limit: sub.voice_limit, voice_slots_used: sub.voice_slots_used }; } catch (e) { usage = null; }
    const data = { voices, usage }; this.voicesCache = { ts: Date.now(), data }; return data;
  },
  async addVoice(body) {
    if (this.mode === 'server') { const files = []; for (const f of body.files) files.push({ name: f.name, type: f.type || 'audio/mpeg', data: await fileToBase64(f) }); return this.req('POST', 'eleven/voices/add', { name: body.name, description: body.description, files }); }
    const fd = new FormData(); fd.append('name', body.name); fd.append('remove_background_noise', 'true'); if (body.description) fd.append('description', body.description);
    body.files.forEach(f => fd.append('files', f, f.name));
    const d = await elevenFetch('/v1/voices/add', { method: 'POST', body: fd }); this.voicesCache = null;
    return { voice_id: d && d.voice_id, name: body.name };
  },
  async deleteVoice(id) { if (this.mode === 'server') return this.req('DELETE', 'eleven/voices/' + encodeURIComponent(id)); await elevenFetch('/v1/voices/' + encodeURIComponent(id), { method: 'DELETE' }); this.voicesCache = null; return { ok: true }; },
  async tts(body) {
    if (this.mode === 'server') return this.req('POST', 'audio/tts', body);
    const model = body.model_id || getSettings().elevenModel;
    const chunks = splitForTts(body.text); if (!chunks.length) throw new Error('Нечего озвучивать: текст пустой');
    const parts = [];
    for (let i = 0; i < chunks.length; i++) {
      const payload = { text: chunks[i], model_id: model, voice_settings: voiceSettings(model, body.manner) };
      if (!/^eleven_multilingual/.test(model) && isRussian(body.text)) payload.language_code = 'ru';
      if (!/^eleven_v[34]/.test(model)) { if (i > 0) payload.previous_text = chunks[i - 1].slice(-300); if (i < chunks.length - 1) payload.next_text = chunks[i + 1].slice(0, 300); }
      parts.push(await elevenFetch('/v1/text-to-speech/' + encodeURIComponent(body.voice_id) + '?output_format=mp3_44100_128', { method: 'POST', json: payload, binary: true }));
    }
    const rec = { id: 'aud_' + uid(), ts: Date.now(), chapter_id: body.chapter_id || '', chapter_title: body.chapter_title || '', title: body.title || 'Озвучка', voice_id: body.voice_id, voice_name: body.voice_name || '',
      model_id: model, manner: body.manner || 'neutral', chars: body.text.length, text: body.text, mime: 'audio/mpeg', blob: new Blob(parts, { type: 'audio/mpeg' }) };
    await LocalDB.put('audio', rec); this.voicesCache = null; this.persist();
    return Object.assign(this.mediaRow(rec), { chunks: chunks.length });
  },
  async listAudio() { if (this.mode === 'server') return this.req('GET', 'audio'); return (await LocalDB.all('audio')).map(r => this.mediaRow(r)).sort((a, b) => b.ts - a.ts); },
  async deleteAudio(id) { if (this.mode === 'server') return this.req('DELETE', 'audio/' + encodeURIComponent(id)); await LocalDB.del('audio', id); this.dropUrl(id); },
  async getKv(key) {
    if (this.mode === 'cloud') { const sn = await this.db.doc('kv/' + key).get(); return sn.exists ? (sn.data() || {}).value : null; }
    if (this.mode === 'server') { const r = await this.req('GET', 'kv/' + encodeURIComponent(key)); return r ? r.value : null; }
    if (this.idb) { const v = await LocalDB.get('kv:' + key); return v === undefined ? null : v; }
    return load('wa_kv_' + key, null);
  },
  async setKv(key, value) { if (this.mode === 'cloud') return this.serial(() => this.db.doc('kv/' + key).set({ value: value })); if (this.mode === 'server') return this.req('PUT', 'kv/' + encodeURIComponent(key), { value: value }); if (this.idb) return LocalDB.set('kv:' + key, value); save('wa_kv_' + key, value); },

  async req(method, path, data) {
    const opts = { method, cache: 'no-store' };
    if (data !== undefined) { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(data); }
    const r = await fetch('/api/' + path, opts);
    if (!r.ok) { let m = ''; try { m = (await r.json()).error || ''; } catch (e) { /* без деталей */ } throw new Error(m || ('HTTP ' + r.status)); }
    return (r.headers.get('content-type') || '').includes('json') ? r.json() : null;
  },
  bg(promise, what) { return promise.catch(e => { console.error(e); toast('Не удалось сохранить ' + what + ' в базе: ' + e.message, 5000); }); },
  saveBook(b) {
    if (this.mode === 'cloud') { const snap = deepCopy(b); return this.bg(this.serial(() => this.cloudSaveBook(snap)), 'рукопись'); }
    if (this.mode === 'server') return this.bg(this.req('PUT', 'book', b), 'рукопись');
    if (this.idb) return this.bg(LocalDB.set('book', b), 'рукопись');
    if (!save(LS.book, b)) toast('Не удалось сохранить рукопись: в браузере закончилось место.', 6000);
  },
  saveSettings(st) {
    if (this.mode === 'cloud') { if (this.uid) { const snap = deepCopy(st); return this.bg(this.serial(() => this.db.doc('data/users/' + this.uid + '/settings').set(snap)), 'настройки'); } save(LS.settings, st); return; }
    if (this.mode === 'server') return this.bg(this.req('PUT', 'settings', st), 'настройки');
    if (this.idb) return this.bg(LocalDB.set('settings', st), 'настройки'); save(LS.settings, st);
  },
  saveNotes(n) {
    if (this.mode === 'cloud') { const snap = deepCopy(n); return this.bg(this.serial(() => this.db.doc('state/notes').set({ items: snap, updatedAt: Date.now() })), 'память'); }
    if (this.mode === 'server') return this.bg(this.req('PUT', 'notes', n), 'память');
    if (this.idb) return this.bg(LocalDB.set('notes', n), 'память'); save(LS.notes, n);
  },
  saveChat(c) {
    if (this.mode === 'cloud') { const snap = trimChat(deepCopy(c)); return this.bg(this.serial(() => this.db.doc('state/chat').set({ messages: snap, updatedAt: Date.now() })), 'разговор'); }
    if (this.mode === 'server') return this.bg(this.req('PUT', 'chat', c), 'разговор');
    if (this.idb) return this.bg(LocalDB.set('chat', c), 'разговор'); save(LS.chat, c);
  },
  async getHistory() {
    if (this.mode === 'cloud') { const snap = await this.db.collection('history').orderBy('ts', 'desc').limit(200).get(); return snap.docs.map(d => Object.assign({ id: d.id }, deepCopy(d.data() || {}))); }
    if (this.mode === 'server') return this.req('GET', 'history');
    if (this.idb) return (await LocalDB.all('history')).sort((a, b) => b.ts - a.ts); return load(LS.history, []);
  },
  addHistory(e) {
    if (this.mode === 'cloud') return this.bg(this.serial(() => this.cloudAddHistory(e)), 'ответ');
    if (this.mode === 'server') return this.bg(this.req('POST', 'history', e), 'ответ');
    if (this.idb) return this.bg(LocalDB.put('history', e), 'ответ');
    const h = load(LS.history, []); h.unshift(e); while (h.length > 60) h.pop(); while (!save(LS.history, h) && h.length > 1) h.pop();
  },
  async deleteHistory(id, parts) {
    if (this.mode === 'cloud') return this.serial(() => this.cloudDeleteHistory(id, parts));
    if (this.mode === 'server') return this.req('DELETE', 'history/' + encodeURIComponent(id));
    if (this.idb) return LocalDB.del('history', id); save(LS.history, load(LS.history, []).filter(x => x.id !== id));
  },
  async clearHistory() {
    if (this.mode === 'cloud') { const snap = await this.db.collection('history').get(); return this.serial(async () => { for (const d of snap.docs) await this.cloudDeleteHistory(d.id, (d.data() || {}).parts || 0); }); }
    if (this.mode === 'server') return this.req('DELETE', 'history');
    if (this.idb) return LocalDB.clear('history'); save(LS.history, []);
  }
};

// ================= рукопись =================
let book = { title: '', series: '', author: '', chapters: [] };
let assetsMem = { images: [], audio: [] };
let kvMem = {};
function sysOpts(extra) { return Object.assign({ assets: assetsMem }, extra || {}); }
let settingsMem = {};
let notes = [];
const pickers = [];
function saveBook() { Store.saveBook(book); renderBookDependent(); }
function renderBookDependent() {
  $('#brandBook').textContent = book.title ? '«' + book.title + '»' + (book.series ? ' · ' + book.series : '') : 'Книга без названия';
  pickers.forEach(p => p.refresh());
  renderChapters(); renderSummaryInfo();
  const bb = $('#bookBanner'); if (bb) bb.classList.toggle('hidden', book.chapters.length > 0);
}

// ================= настройки =================
const DEFAULTS = { apiKey: '', model: 'gemini-3.8-flash', baseUrl: 'https://generativelanguage.googleapis.com', thinking: 'auto', elevenKey: '', imageModel: 'gemini-nano-banana-2.1', elevenModel: 'eleven_v4', textHome: 'here', claudeUrl: '' };
function getSettings() {
  const cfg = window.CONFIG || {}; const ls = settingsMem || {}; const s = Object.assign({}, DEFAULTS);
  ['apiKey', 'model', 'baseUrl', 'thinking', 'elevenKey', 'imageModel', 'elevenModel', 'textHome', 'claudeUrl'].forEach(k => { if (cfg[k]) s[k] = cfg[k]; if (ls[k]) s[k] = ls[k]; });
  s.elevenSource = ls.elevenKey ? 'app' : (cfg.elevenKey ? 'file' : 'none');
  s.apiKey = String(s.apiKey).trim(); s.model = String(s.model).trim(); s.baseUrl = String(s.baseUrl).trim().replace(/\/+$/, '');
  s.keySource = ls.apiKey ? 'app' : (cfg.apiKey ? 'file' : 'none');
  return s;
}
function updateKeyState() {
  const s = getSettings(); const claude = Engine.kind() === 'claude';
  $('#keyBanner').classList.toggle('hidden', claude || !!s.apiKey);
  $('#sidebarFoot').innerHTML = (textsElsewhere() ? 'Тексты: <b>claude.ai</b>, подписка Claude<br>Здесь: картинки и озвучка' : 'Модель: <b>' + esc(Engine.label()) + '</b>') + '<br>' + (claude ? 'Через ваш аккаунт claude.ai' : 'Ключ: ' + (s.apiKey ? '<span style="color:#1f8a4c">подключён ✔</span>' : '<span style="color:#c0392b">не задан ✘</span>')) +
    '<br>Данные: ' + (Store.mode === 'server' ? '<span style="color:#1f8a4c">база SQLite ✔</span>' : Store.mode === 'cloud' ? '<span style="color:#1f8a4c">облако claude.ai ✔</span>' : Store.idb ? '<span style="color:#1f8a4c">в этом браузере ✔</span>' : '<span style="color:#b7791f">только до закрытия страницы</span>');
}

// ================= Gemini =================
async function callGemini({ systemText, contents, onChunk, signal }) {
  const s = getSettings();
  const url = s.baseUrl + '/v1beta/models/' + encodeURIComponent(s.model) + ':streamGenerateContent?alt=sse';
  const body = { systemInstruction: { parts: [{ text: systemText }] }, contents: contents };
  if (s.thinking !== 'auto' && /^gemini-3/.test(s.model)) body.generationConfig = { thinkingConfig: { thinkingLevel: s.thinking } };
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey }, body: JSON.stringify(body), signal });
  } catch (e) { if (e.name === 'AbortError') throw e; throw new Error('NETWORK'); }
  if (!res.ok) {
    let detail = '';
    try { const j = await res.json(); detail = (j.error && j.error.message) || JSON.stringify(j).slice(0, 300); } catch (e) { try { detail = await res.text(); } catch (e2) { /* нет деталей */ } }
    const err = new Error('HTTP'); err.status = res.status; err.detail = detail; throw err;
  }
  const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
  let finish = null, blocked = null;
  const handle = (obj) => {
    if (obj.error) { const err = new Error('HTTP'); err.status = obj.error.code || 500; err.detail = obj.error.message || ''; throw err; }
    if (obj.promptFeedback && obj.promptFeedback.blockReason) blocked = obj.promptFeedback.blockReason;
    const c = obj.candidates && obj.candidates[0]; if (!c) return;
    if (c.content && c.content.parts) for (const p of c.content.parts) { if (p.text && !p.thought) onChunk(p.text); }
    if (c.finishReason) finish = c.finishReason;
  };
  const processLine = (line) => {
    line = line.trim(); if (!line.startsWith('data:')) return;
    const json = line.slice(5).trim(); if (!json || json === '[DONE]') return;
    let obj; try { obj = JSON.parse(json); } catch (e) { return; } handle(obj);
  };
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx; while ((idx = buf.indexOf('\n')) >= 0) { processLine(buf.slice(0, idx)); buf = buf.slice(idx + 1); }
  }
  if (buf.trim()) processLine(buf);
  return { finishReason: finish, blocked: blocked };
}
function friendly(e) {
  if (!e) return 'Неизвестная ошибка';
  if (e.message === 'NETWORK' && Store.mode === 'cloud') return 'Эта страница не может обращаться к серверам Google напрямую. Помощник здесь работает через Claude, но сейчас эта возможность недоступна: откройте страницу на сайте или в приложении claude.ai, войдя в свой аккаунт.';
  if (e.message === 'SAMPLE') {
    const d = e.detail ? '\n\n(' + String(e.detail).slice(0, 300) + ')' : '';
    switch (e.code) {
      case 'not_granted': return 'Вы не разрешили этой странице обращаться к Claude. Обновите страницу и при следующем запросе нажмите «Разрешить».';
      case 'sampling_disabled': return 'Claude недоступен для вашего аккаунта на этой странице.';
      case 'rate_limited': return 'Достигнут лимит использования Claude на вашем аккаунте. Подождите немного и попробуйте снова.';
      case 'prompt_too_large': return 'Текст слишком большой для одного запроса. Возьмите фрагмент поменьше.';
      case 'session_expired': return 'Сессия claude.ai истекла. Войдите в аккаунт заново и обновите страницу.';
      case 'refused': return 'Claude отказался выполнять этот запрос. Измените формулировку или текст.';
      case 'empty_completion': return 'Ответ оказался пустым. Попробуйте переформулировать задание.';
      case 'upstream_error': return 'Временная ошибка связи с Claude. Попробуйте ещё раз через минуту.' + d;
      default: return 'Ошибка при обращении к Claude (' + e.code + ').' + d;
    }
  }
  if (e.message === 'NETWORK') return 'Нет связи с сервером. Проверьте интернет (и VPN, если он нужен для доступа к Google), затем попробуйте ещё раз.';
  if (e.message === 'HTTP') {
    const d = e.detail ? '\n\nОтвет сервера: ' + String(e.detail).slice(0, 400) : '';
    switch (e.status) {
      case 400: return (/API key|API_KEY/i.test(e.detail || '') ? 'Ключ доступа не подходит. Откройте «Настройки» и вставьте ключ заново — целиком, без пробелов.' : 'Сервер не принял запрос.') + d;
      case 401: case 403: return 'Доступ запрещён. Проверьте ключ в «Настройках»: возможно, он отключён или не имеет доступа к этой модели.' + d;
      case 404: return 'Модель не найдена. Проверьте название модели в «Настройках» (например, gemini-3.8-flash).' + d;
      case 429: return 'Слишком много запросов или закончилась квота. Подождите минуту и попробуйте снова.' + d;
      case 500: case 502: case 503: case 504: return 'Сервер Google временно перегружен. Подождите немного и повторите.' + d;
      default: return 'Ошибка ' + e.status + '.' + d;
    }
  }
  return 'Что-то пошло не так: ' + (e.message || e);
}

// ================= движок: Gemini по ключу или Claude внутри страницы claude.ai =================
const Engine = {
  maxBytes: 262144,
  kind() { return Store.sample ? 'claude' : 'gemini'; },
  tier() { const t = getSettings().thinking; return t === 'low' ? 'quick' : t === 'high' ? 'complex' : 'default'; },
  label() { return this.kind() === 'claude' ? 'Claude (claude.ai)' : getSettings().model; }
};
const ENC = new TextEncoder();
function bytesOf(str) { return ENC.encode(String(str || '')).length; }
function chunkByBytes(text, maxBytes) {
  const paras = String(text || '').split('\n'); const chunks = []; let cur = '', curB = 0;
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; curB = 0; };
  for (const p of paras) {
    const pb = bytesOf(p) + 1;
    if (pb > maxBytes) {
      const sents = p.match(/[^.!?…]+[.!?…]+["»”')]*\s*|[^.!?…]+$/g) || [p];
      for (const sn of sents) { const sb = bytesOf(sn); if (curB + sb > maxBytes && cur) push(); cur += sn; curB += sb; }
      cur += '\n'; curB += 1; continue;
    }
    if (curB + pb > maxBytes && cur) push();
    cur += p + '\n'; curB += pb;
  }
  push(); return chunks.length ? chunks : [''];
}
function sampleError(e) {
  if (e && e.code === 'cancelled') { const err = new Error('cancelled'); err.name = 'AbortError'; return err; }
  const err = new Error('SAMPLE'); err.code = (e && e.code) || 'upstream_error'; err.detail = (e && e.message) || ''; return err;
}
async function sampleText(prompt, tier, signal) {
  try { const r = await Store.sample(prompt, { modelTier: tier || 'default', cache: false, signal }); return r.text; }
  catch (e) { throw sampleError(e); }
}
async function callModel({ systemText, userText, turns, onChunk, signal, tier }) {
  if (Engine.kind() === 'gemini') {
    const contents = turns ? turns : [{ role: 'user', parts: [{ text: userText }] }];
    return callGemini({ systemText, contents, onChunk, signal });
  }
  let input;
  if (turns) {
    const list = turns.map(t => ({ role: t.role === 'model' ? 'assistant' : 'user', content: t.parts[0].text }));
    let total = bytesOf(systemText) + list.reduce((n, t) => n + bytesOf(t.content), 0);
    while (list.length > 1 && total > Engine.maxBytes - 4000) { total -= bytesOf(list[0].content); list.shift(); }
    while (list.length > 1 && list[0].role !== 'user') list.shift();
    input = [{ role: 'user', content: systemText }].concat(list);
  } else input = systemText + '\n\n' + userText;
  try {
    const r = await Store.sample(input, { onText: u => { if (u.delta) onChunk(u.delta); }, signal, modelTier: tier || Engine.tier(), cache: false });
    return { finishReason: r.truncated ? 'MAX_TOKENS' : 'STOP', blocked: null };
  } catch (e) { throw sampleError(e); }
}

// ---- материалы рукописи для режима Claude (весь текст в один запрос не помещается) ----
let summaryMem = null;
function manuscriptHash() { return hashText(book.chapters.map(c => c.title + '\u0001' + c.text).join('\u0002')); }
async function ensureSummary(progress, signal, force) {
  const h = manuscriptHash();
  if (!force && summaryMem && summaryMem.hash === h) return summaryMem;
  if (!force && !summaryMem && Store.mode === 'cloud') {
    try { const sn = await Store.db.doc('state/summary').get(); if (sn.exists) summaryMem = deepCopy(sn.data()); } catch (e) { /* сводки ещё нет */ }
    if (summaryMem && summaryMem.hash === h) return summaryMem;
  }
  if (!book.chapters.some(c => c.text && c.text.trim())) { summaryMem = { text: '', hash: h, ts: Date.now(), chars: 0 }; return summaryMem; }
  const full = book.chapters.map(c => '=== ' + c.title + ' ===\n' + c.text.trim()).join('\n\n');
  const chunks = chunkByBytes(full, Engine.maxBytes - 16000);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    progress('Читаю рукопись и составляю сводку' + (chunks.length > 1 ? ' (часть ' + (i + 1) + ' из ' + chunks.length + ')' : '') + '… Это делается один раз, пока текст не изменится.');
    parts.push(await sampleText(P.summarize({ part: i + 1, total: chunks.length, text: chunks[i] }), 'default', signal));
  }
  let text = parts[0];
  if (parts.length > 1) { progress('Объединяю сводку…'); text = await sampleText(P.mergeSummaries(parts), 'default', signal); }
  summaryMem = { text, hash: h, ts: Date.now(), chars: text.length };
  if (Store.mode === 'cloud') Store.bg(Store.serial(() => Store.db.doc('state/summary').set(deepCopy(summaryMem))), 'сводку');
  renderSummaryInfo();
  return summaryMem;
}
async function cloudMaterials(job, progress, signal) {
  const summary = await ensureSummary(progress, signal, false);
  const core = P.system(book, notes, sysOpts({ manuscript: 'none' }));
  const parts = ['## СВОДКА РУКОПИСИ\n' + (summary.text || '(рукопись пока пуста)')];
  if (job.kind !== 'target' && book.chapters.length) {
    const first = book.chapters[0], last = book.chapters[book.chapters.length - 1];
    const head = (first.text || '').slice(0, 12000);
    if (head) parts.push('## ФРАГМЕНТ: НАЧАЛО РУКОПИСИ («' + first.title + '», первые ' + fmtNum(head.length) + ' знаков)\n' + head);
    const tail = (last.text || '').slice(-20000);
    if (tail && !(first === last && (last.text || '').length <= 12000)) parts.push('## ФРАГМЕНТ: ПОСЛЕДНИЕ СТРАНИЦЫ («' + last.title + '», последние ' + fmtNum(tail.length) + ' знаков — на этом рукопись пока остановилась)\n' + tail);
  }
  const context = parts.join('\n\n');
  const used = bytesOf(core) + bytesOf(context) + 10000 + 6000;
  return { context, pieceBudget: Math.max(20000, Engine.maxBytes - used), summary };
}

// ================= окно результата =================
function ResultBox(container) {
  container.innerHTML = '';
  const box = el('div', 'result hidden',
    '<div class="result-head"><div class="result-title"></div><div class="result-status"></div></div>' +
    '<div class="md"></div>' +
    '<div class="result-actions hidden"><button type="button" class="btn act-copy">Скопировать</button><button type="button" class="btn act-save">Сохранить файл</button></div>' +
    '<button type="button" class="btn btn-stop hidden">Остановить</button>');
  container.appendChild(box);
  const mdEl = $('.md', box), statusEl = $('.result-status', box), titleEl = $('.result-title', box), actions = $('.result-actions', box), stopBtn = $('.btn-stop', box);
  let text = '', title = '', controller = null, timer = null, lastRender = 0;
  function render() { timer = null; lastRender = Date.now(); mdEl.innerHTML = md(text); }
  function schedule() { if (timer) return; const wait = Math.max(0, 180 - (Date.now() - lastRender)); timer = setTimeout(render, wait); }
  function status(s, busy) { statusEl.textContent = s || ''; statusEl.classList.toggle('busy', !!busy); }
  $('.act-copy', box).onclick = () => copyResult(text);
  $('.act-save', box).onclick = () => downloadFile(safeName(title) + '.txt', mdToPlain(text));
  stopBtn.onclick = () => { if (controller) controller.abort(); };
  return {
    start(t, ctrl) { title = t; text = ''; controller = ctrl; box.classList.remove('hidden'); titleEl.textContent = t; status('Думаю…', true); mdEl.innerHTML = ''; actions.classList.add('hidden'); stopBtn.classList.toggle('hidden', !ctrl); box.scrollIntoView({ behavior: 'smooth', block: 'start' }); },
    setController(ctrl) { controller = ctrl; stopBtn.classList.toggle('hidden', !ctrl); },
    append(s) { text += s; schedule(); },
    status: status,
    done(msg) { if (timer) clearTimeout(timer); render(); status(msg || 'Готово', false); actions.classList.toggle('hidden', !text.trim()); stopBtn.classList.add('hidden'); },
    fail(msg) { if (timer) clearTimeout(timer); render(); status('Ошибка', false); mdEl.insertAdjacentHTML('beforeend', '<div class="error">' + esc(msg) + '</div>'); stopBtn.classList.add('hidden'); actions.classList.toggle('hidden', !text.trim()); },
    getText() { return text; }
  };
}

// ================= запуск заданий =================
function ensureKey() {
  if (Engine.kind() === 'claude' || getSettings().apiKey) return true;
  toast('Сначала вставьте ключ доступа в «Настройках»', 4000); showSection('settings'); return false;
}
async function runSequence(o) {
  const { section, title, box, button, steps, systemExtra, history } = o;
  if (!ensureKey() || !steps.length) return null;
  const ctrl = o.ctrl || new AbortController();
  if (o.started) box.setController(ctrl); else box.start(title, ctrl);
  if (button) button.disabled = true;
  const base = (Engine.kind() === 'claude' ? P.system(book, notes, sysOpts({ manuscript: 'none' })) : P.system(book, notes, sysOpts())) + (systemExtra ? '\n\n' + systemExtra : '');
  let stopped = false, failed = false;
  try {
    for (let i = 0; i < steps.length; i++) {
      const st = steps[i]; box.status(st.status || 'Пишу…', true);
      if (i > 0) box.append(st.prefix != null ? st.prefix : '\n\n');
      if (st.lead) box.append(st.lead);
      const sys = base + (st.context ? '\n\n' + st.context : '');
      const r = await callModel({ systemText: sys, userText: st.prompt, signal: ctrl.signal, tier: st.tier, onChunk: t => box.append(t) });
      if (r.blocked) box.append('\n\n_(Ответ заблокирован фильтром безопасности: ' + r.blocked + ')_');
      if (r.finishReason === 'MAX_TOKENS') box.append('\n\n_(Ответ оборвался: достигнут предел длины. Попробуйте взять фрагмент поменьше.)_');
    }
  } catch (e) { if (e.name === 'AbortError') stopped = true; else { failed = true; box.fail(friendly(e)); } }
  if (button) button.disabled = false;
  if (!failed) box.done(stopped ? 'Остановлено' : 'Готово');
  const text = box.getText();
  if (history !== false && text.trim()) addHistory({ section, title: title + (stopped ? ' (не закончено)' : failed ? ' (с ошибкой)' : ''), text });
  return failed ? null : text;
}
async function runJob(job) {
  // job: { section, title, box, button, status, kind: 'whole' | 'target', target, makePrompt(target, part, total) }
  if (!ensureKey()) return null;
  if (Engine.kind() === 'gemini') {
    return runSequence({ section: job.section, title: job.title, box: job.box, button: job.button, steps: [{ prompt: job.makePrompt(job.target, 1, 1), status: job.status }] });
  }
  const ctrl = new AbortController(); job.box.start(job.title, ctrl); if (job.button) job.button.disabled = true;
  let mat;
  try { mat = await cloudMaterials(job, msg => job.box.status(msg, true), ctrl.signal); }
  catch (e) { if (job.button) job.button.disabled = false; if (e.name === 'AbortError') job.box.done('Остановлено'); else job.box.fail(friendly(e)); return null; }
  let steps;
  if (job.kind === 'target') {
    const pieces = chunkByBytes(job.target.text, mat.pieceBudget); const n = pieces.length;
    steps = pieces.map((piece, i) => ({
      context: mat.context,
      status: (job.status || 'Пишу…') + (n > 1 ? ' Часть ' + (i + 1) + ' из ' + n + '.' : ''),
      prefix: n > 1 ? '\n\n---\n\n' : '\n\n',
      lead: n > 1 ? '## Часть ' + (i + 1) + ' из ' + n + '\n\n' : '',
      prompt: job.makePrompt({ kind: 'text', text: piece, label: job.target.label + (n > 1 ? ' (часть ' + (i + 1) + ' из ' + n + ')' : '') }, i + 1, n)
    }));
  } else {
    steps = [{ context: mat.context, status: job.status, prompt: job.makePrompt(null, 1, 1) }];
  }
  return runSequence({ section: job.section, title: job.title, box: job.box, button: job.button, steps, ctrl, started: true });
}
async function runTranslation(o) {
  if (!ensureKey()) return null;
  if (Engine.kind() === 'gemini') return runSequence(o);
  const ctrl = new AbortController(); o.box.start(o.title, ctrl); if (o.button) o.button.disabled = true;
  try { const mat = await cloudMaterials({ kind: 'target' }, msg => o.box.status(msg, true), ctrl.signal); o.steps.forEach(st => { st.context = mat.context; }); }
  catch (e) { if (o.button) o.button.disabled = false; if (e.name === 'AbortError') o.box.done('Остановлено'); else o.box.fail(friendly(e)); return null; }
  return runSequence(Object.assign({}, o, { ctrl, started: true }));
}
function runTask(o) { return runJob({ section: o.section, title: o.title, box: o.box, button: o.button, status: o.status, kind: 'whole', target: null, makePrompt: () => o.prompt }); }

function splitText(text, max) {
  const paras = String(text).split(/\n+/); const chunks = []; let cur = '';
  const push = () => { if (cur.trim()) chunks.push(cur.trim()); cur = ''; };
  for (const p of paras) {
    if (p.length > max) {
      const sents = p.match(/[^.!?…]+[.!?…]+["»”')]*\s*|[^.!?…]+$/g) || [p];
      for (const s of sents) { if ((cur + s).length > max) push(); cur += s; }
      cur += '\n'; continue;
    }
    if ((cur + p).length > max) push();
    cur += p + '\n';
  }
  push(); return chunks;
}

// ================= элементы выбора =================
function optionGroup(container, items, opts) {
  opts = opts || {}; let selected = new Set(opts.selected || (items[0] ? [items[0].id] : []));
  container.innerHTML = ''; container.classList.add(opts.chips ? 'chips' : 'options');
  items.forEach(it => {
    const b = el('button', opts.chips ? 'chip' : 'opt'); b.type = 'button'; b.dataset.id = it.id;
    b.innerHTML = opts.chips ? esc(it.label) : '<b>' + esc(it.label) + '</b>' + (it.hint ? '<span>' + esc(it.hint) + '</span>' : '');
    b.onclick = () => {
      if (opts.multi) { if (selected.has(it.id)) { if (selected.size > 1) selected.delete(it.id); } else selected.add(it.id); }
      else selected = new Set([it.id]);
      paint(); if (opts.onChange) opts.onChange(get());
    };
    container.appendChild(b);
  });
  function paint() { $$('.opt,.chip', container).forEach(b => b.classList.toggle('on', selected.has(b.dataset.id))); }
  function get() { return opts.multi ? Array.from(selected) : Array.from(selected)[0]; }
  paint(); return { get, set(id) { if (items.some(it => it.id === id)) { selected = new Set([id]); paint(); } } };
}
function targetPicker(container, opts) {
  opts = opts || {}; let mode = 'chapters'; let checked = null;
  container.innerHTML = '<div class="seg"><button type="button" class="seg-btn on" data-m="chapters">Из рукописи</button><button type="button" class="seg-btn" data-m="text">Вставить свой текст</button></div>' +
    '<div class="chapter-pick"></div><div class="target-text hidden"><textarea rows="8" placeholder="Вставьте сюда текст: главу, сцену или даже один абзац"></textarea></div>';
  const list = $('.chapter-pick', container), textWrap = $('.target-text', container), ta = $('textarea', container);
  $$('.seg-btn', container).forEach(b => b.onclick = () => {
    mode = b.dataset.m; $$('.seg-btn', container).forEach(x => x.classList.toggle('on', x === b));
    list.classList.toggle('hidden', mode !== 'chapters'); textWrap.classList.toggle('hidden', mode !== 'text');
  });
  function refresh() {
    const ids = book.chapters.map(c => c.id);
    if (!checked) checked = new Set(opts.selectAll ? ids : (ids.length ? [ids[ids.length - 1]] : []));
    else { checked = new Set(Array.from(checked).filter(id => ids.includes(id))); if (!checked.size && ids.length) checked.add(ids[ids.length - 1]); }
    list.innerHTML = '';
    if (!book.chapters.length) { list.innerHTML = '<div class="muted">Рукопись пока пуста — добавьте главы в разделе «Рукопись» или вставьте текст.</div>'; return; }
    book.chapters.forEach(c => {
      const lab = el('label', 'check', '<input type="checkbox"' + (checked.has(c.id) ? ' checked' : '') + '> <span>' + esc(c.title) + '</span><span class="cnt">' + fmtNum(wordCount(c.text)) + ' слов</span>');
      $('input', lab).onchange = (e) => { if (e.target.checked) checked.add(c.id); else checked.delete(c.id); };
      list.appendChild(lab);
    });
  }
  function get() {
    if (mode === 'text') { const t = ta.value.trim(); if (!t) { toast('Вставьте текст в поле или выберите главу из рукописи'); return null; } return { kind: 'text', text: t, label: 'вставленный текст' }; }
    const chs = book.chapters.filter(c => checked.has(c.id));
    if (!chs.length) { toast('Отметьте хотя бы одну главу'); return null; }
    return { kind: 'chapters', ids: chs.map(c => c.id), titles: chs.map(c => c.title), text: chs.map(c => c.title + '\n\n' + c.text.trim()).join('\n\n'), label: chs.map(c => c.title).join(', ') };
  }
  refresh(); const api = { get, refresh }; pickers.push(api); return api;
}
function modesOf(obj) { return Object.keys(obj).map(k => ({ id: k, label: obj[k].label, hint: obj[k].hint })); }
function netLabel(nets) { return nets.map(n => n === 'vk' ? 'ВКонтакте' : 'Telegram').join(' + '); }

// ================= разделы =================
const SECTIONS = [
  { id: 'home', icon: '🏠', title: 'Главная' },
  { id: 'review', icon: '📝', title: 'Замечания к рукописи', desc: 'Что хорошо, что поправить, где ошибки' },
  { id: 'structure', icon: '🧭', title: 'Структура книги', desc: 'Карта сцен, план, слабые места, что писать дальше' },
  { id: 'translate', icon: '🌍', title: 'Перевод', desc: 'Глава или фрагмент на другом языке' },
  { id: 'blurb', icon: '📖', title: 'Описание книги', desc: 'Аннотация, синопсис, названия, портрет читателя' },
  { id: 'promo', icon: '📣', title: 'Посты и продвижение', desc: 'Контент-план и готовые посты для ВК и Telegram' },
  { id: 'letters', icon: '✉️', title: 'Письма издателям', desc: 'Предложение, сопроводительное, питч, напоминание' },
  { id: 'images', icon: '🎨', title: 'Иллюстрации', desc: 'Картинки по тексту: сцена, глава, герой, обложка', media: true },
  { id: 'audio', icon: '🎧', title: 'Озвучка', desc: 'Чтение текста голосами ElevenLabs или вашим голосом', media: true },
  { id: 'chat', icon: '💬', title: 'Свободный разговор', desc: 'Любой вопрос о книге' },
  { id: 'manuscript', icon: '📚', title: 'Рукопись', service: true },
  { id: 'memory', icon: '🧠', title: 'Память помощника', service: true },
  { id: 'history', icon: '🕘', title: 'История', service: true },
  { id: 'settings', icon: '⚙️', title: 'Настройки', service: true },
  { id: 'help', icon: '❓', title: 'Помощь', service: true }
];
let currentSection = 'home';
const TEXT_SECTIONS = ['review', 'structure', 'translate', 'blurb', 'promo', 'letters', 'chat'];
function textsElsewhere() { return Store.mode === 'local' && getSettings().textHome === 'claude'; }
function showSection(id) {
  currentSection = id;
  $$('.section').forEach(s => s.classList.toggle('hidden', s.id !== 'sec-' + id));
  $$('.nav-btn').forEach(b => b.classList.toggle('on', b.dataset.id === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (id === 'history') renderHistory();
  if (id === 'settings') fillSettings();
  if (id === 'chat') scrollChat();
}
function initNav() {
  const nav = $('#nav'); nav.innerHTML = ''; let sepDone = false;
  const away = textsElsewhere();
  const shown = SECTIONS.filter(s => !(s.media && Store.mediaKind() === 'none') && !(away && TEXT_SECTIONS.indexOf(s.id) >= 0));
  shown.forEach(s => {
    if (s.service && !sepDone) { nav.appendChild(el('div', 'nav-sep')); sepDone = true; }
    const b = el('button', 'nav-btn', '<span class="ic">' + s.icon + '</span><span>' + esc(s.title) + '</span>'); b.type = 'button'; b.dataset.id = s.id; b.onclick = () => showSection(s.id); nav.appendChild(b);
  });
  const cards = $('#homeCards'); cards.innerHTML = '';
  shown.filter(s => s.desc).forEach(s => {
    const c = el('button', 'card', '<span class="ic">' + s.icon + '</span><b>' + esc(s.title) + '</b><span>' + esc(s.desc) + '</span>'); c.type = 'button'; c.onclick = () => showSection(s.id); cards.appendChild(c);
  });
  $$('[data-go]').forEach(b => b.onclick = () => showSection(b.dataset.go));
  $$('.nav-btn').forEach(b => b.classList.toggle('on', b.dataset.id === currentSection));
}
function renumberSteps(sec) { let n = 0; $$('.step', sec).forEach(st => { const num = $('.num', st); if (num && !st.classList.contains('hidden')) num.textContent = String(++n); }); }
function applyTextHome() {
  const away = textsElsewhere(); const cu = getSettings().claudeUrl;
  initNav();
  if (away && TEXT_SECTIONS.indexOf(currentSection) >= 0) showSection('home');
  const th = $('#textHint');
  if (away) { th.innerHTML = '📝 <b>Тексты</b> готовит Claude на странице claude.ai по вашей подписке: разбор рукописи, посты, письма, задания для картинок и разметку озвучки' + (cu ? '. <a href="' + esc(cu) + '" target="_blank" rel="noopener">Открыть страницу claude.ai</a>' : '') + '. Здесь Nano Banana рисует, а ElevenLabs озвучивает.'; th.classList.remove('hidden'); }
  else th.classList.add('hidden');
  if (Store.mode !== 'local') return;
  const hide = (node, h) => { if (node) node.classList.toggle('hidden', h); };
  hide($('#imgKinds').closest('.step'), away); hide($('#imgTarget').closest('.step'), away); hide($('#imgExtra'), away);
  hide($('#imgPromptBtn').closest('.run-row'), away); hide($('#imgBible').closest('.step'), away); hide($('#audPrepBtn'), away);
  if (away) $('#imgPromptStep').classList.remove('hidden');
  const ii = $('#imgModeInfo'), ai = $('#audModeInfo');
  if (away) {
    ii.innerHTML = 'Задание для художника готовит Claude на странице claude.ai и присылает сюда кнопкой «Нарисовать в мастерской». Можно и самому описать картинку в поле ниже.'; ii.classList.remove('hidden');
    ai.innerHTML = 'Интонации расставляет Claude на странице claude.ai и присылает текст сюда кнопкой «Озвучить в мастерской». Можно и вставить текст самому.'; ai.classList.remove('hidden');
  } else { ii.classList.add('hidden'); ai.classList.add('hidden'); }
  renumberSteps($('#sec-images')); renumberSteps($('#sec-audio'));
  updateKeyState();
}

// ---- 1. Замечания
function initReview() {
  const og = optionGroup($('#reviewModes'), modesOf(P.reviewModes));
  const tp = targetPicker($('#reviewTarget')); const box = ResultBox($('#reviewResult'));
  $('#reviewRun').onclick = () => {
    const target = tp.get(); if (!target) return; const mode = og.get();
    const extra = $('#reviewExtra').value.trim();
    runJob({ section: 'review', title: 'Замечания (' + P.reviewModes[mode].label.toLowerCase() + '): ' + target.label, box, button: $('#reviewRun'), status: 'Читаю и разбираю текст…', kind: 'target', target, makePrompt: t => P.review({ mode, target: t, extra }) });
  };
}
// ---- 2. Структура
function initStructure() {
  const og = optionGroup($('#stModes'), modesOf(P.structureModes));
  const tp = targetPicker($('#stTarget'), { selectAll: true }); const box = ResultBox($('#stResult'));
  $('#stRun').onclick = () => {
    const target = tp.get(); if (!target) return; const mode = og.get();
    const extra = $('#stExtra').value.trim(); const whole = (mode === 'outline' || mode === 'next');
    runJob({ section: 'structure', title: 'Структура (' + P.structureModes[mode].label.toLowerCase() + '): ' + target.label, box, button: $('#stRun'), status: 'Изучаю структуру…', kind: whole ? 'whole' : 'target', target, makePrompt: t => P.structure({ mode, target: t, extra }) });
  };
}
// ---- 3. Перевод
function initTranslate() {
  const langs = P.languages.map(l => ({ id: l.code, label: l.label })).concat([{ id: 'other', label: 'Другой язык…' }]);
  const og = optionGroup($('#trLangs'), langs, { chips: true, onChange: v => $('#trOtherWrap').classList.toggle('hidden', v !== 'other') });
  const style = optionGroup($('#trStyle'), [
    { id: 'literary', label: 'Литературный', hint: 'Естественно и красиво, как написал бы носитель языка' },
    { id: 'literal', label: 'Точный', hint: 'Максимально близко к оригиналу' }]);
  const tp = targetPicker($('#trTarget')); const box = ResultBox($('#trResult'));
  $('#trRun').onclick = () => {
    const target = tp.get(); if (!target) return;
    let langName; const code = og.get();
    if (code === 'other') { langName = $('#trOther').value.trim(); if (!langName) { toast('Напишите, на какой язык переводить'); return; } }
    else langName = P.languages.find(l => l.code === code).name;
    const chunks = splitText(target.text, 14000);
    const steps = chunks.map((c, i) => ({ status: chunks.length > 1 ? 'Перевожу часть ' + (i + 1) + ' из ' + chunks.length + '…' : 'Перевожу…', prompt: P.translate({ langName, text: c, part: i + 1, total: chunks.length, style: style.get() }) }));
    if ($('#trNotes').checked) steps.push({ status: 'Пишу советы переводчика…', prefix: '\n\n---\n\n## Советы переводчика\n\n', prompt: P.translateNotesOnly({ langName, label: target.label }) });
    runTranslation({ section: 'translate', title: 'Перевод на ' + langName + ': ' + target.label, box, button: $('#trRun'), steps });
  };
}
// ---- 4. Описание
function initBlurb() {
  const og = optionGroup($('#blModes'), modesOf(P.blurbModes)); const box = ResultBox($('#blResult'));
  $('#blRun').onclick = () => { const mode = og.get(); runTask({ section: 'blurb', title: P.blurbModes[mode].label, prompt: P.blurb({ mode, extra: $('#blExtra').value.trim() }), box, button: $('#blRun'), status: 'Пишу…' }); };
}
// ---- 5. Посты
function initPromo() {
  const nets = optionGroup($('#promoNets'), [{ id: 'vk', label: 'ВКонтакте' }, { id: 'tg', label: 'Telegram' }], { chips: true, multi: true, selected: ['vk', 'tg'] });
  const goal = optionGroup($('#promoGoal'), P.promoGoals); const box = ResultBox($('#promoResult'));
  $('#promoPlan').onclick = () => {
    const o = { networks: nets.get(), goal: P.promoGoalText[goal.get()], period: $('#promoPeriod').value, extra: $('#promoExtra').value.trim() };
    runTask({ section: 'promo', title: 'Контент-план (' + netLabel(o.networks) + ', ' + o.period + ')', prompt: P.promoPlan(o), box, button: $('#promoPlan'), status: 'Составляю план…' });
  };
  $('#promoPosts').onclick = () => {
    const count = parseInt($('#promoCount').value, 10) || 10;
    const o = { networks: nets.get(), goal: P.promoGoalText[goal.get()], count, extra: $('#promoExtra').value.trim() };
    runTask({ section: 'promo', title: count + ' постов (' + netLabel(o.networks) + ')', prompt: P.promoPosts(o), box, button: $('#promoPosts'), status: 'Пишу посты…' });
  };
}
// ---- 6. Письма
function initLetters() {
  const og = optionGroup($('#ltTypes'), modesOf(P.letterTypes)); const box = ResultBox($('#ltResult'));
  $('#ltRun').onclick = () => {
    const type = og.get();
    const o = { type, publisher: $('#ltPublisher').value.trim(), addressee: $('#ltAddressee').value.trim(), bio: $('#ltBio').value.trim(), attachments: $('#ltAttach').value.trim(), extra: $('#ltExtra').value.trim() };
    runTask({ section: 'letters', title: P.letterTypes[type].label + (o.publisher ? ' — ' + o.publisher : ''), prompt: P.letter(o), box, button: $('#ltRun'), status: 'Пишу письмо…' });
  };
}
// ---- 7. Разговор
let chat = []; let chatCtrl = null;
function scrollChat() { const log = $('#chatLog'); if (log) log.scrollTop = log.scrollHeight; }
function renderChat() {
  const log = $('#chatLog'); log.innerHTML = '';
  if (!chat.length) { log.appendChild(el('div', 'chat-empty', 'Спросите что угодно о книге. Например: «Как зовут всех героев первой главы?», «Придумай 5 вариантов имени для нового персонажа», «Что читатель уже знает о прошлом главного героя?»')); return; }
  chat.forEach(m => { const b = el('div', 'msg ' + m.role); if (m.role === 'user') b.textContent = m.text; else b.innerHTML = '<div class="md">' + md(m.text) + '</div>'; log.appendChild(b); });
  scrollChat();
}
function chatContents() {
  const recent = chat.slice(-30); const out = [];
  recent.forEach(m => { const last = out[out.length - 1]; if (last && last.role === m.role) last.parts[0].text += '\n\n' + m.text; else out.push({ role: m.role, parts: [{ text: m.text }] }); });
  if (out.length && out[0].role !== 'user') out.shift();
  return out;
}
async function sendChat() {
  const ta = $('#chatText'); const msg = ta.value.trim(); if (!msg || chatCtrl) return;
  if (!ensureKey()) return;
  chat.push({ role: 'user', text: msg, ts: Date.now() }); ta.value = ''; Store.saveChat(chat); renderChat();
  const bubble = el('div', 'msg model', '<span class="muted">Думаю…</span>'); $('#chatLog').appendChild(bubble); scrollChat();
  const ctrl = new AbortController(); chatCtrl = ctrl; $('#chatSend').disabled = true; $('#chatStop').classList.remove('hidden');
  let text = '', timer = null;
  const paint = () => { timer = null; bubble.innerHTML = '<div class="md">' + md(text) + '</div>'; scrollChat(); };
  try {
    let systemText;
    if (Engine.kind() === 'claude') {
      const mat = await cloudMaterials({ kind: 'whole' }, msg => { bubble.innerHTML = '<span class="muted">' + esc(msg) + '</span>'; }, ctrl.signal);
      systemText = P.system(book, notes, sysOpts({ manuscript: 'none' })) + '\n\n' + mat.context + '\n\n' + P.chatIntro;
    } else systemText = P.system(book, notes, sysOpts()) + '\n\n' + P.chatIntro;
    const r = await callModel({ systemText, turns: chatContents(), signal: ctrl.signal, onChunk: t => { text += t; if (!timer) timer = setTimeout(paint, 150); } });
    if (r.finishReason === 'MAX_TOKENS') text += '\n\n_(ответ оборвался — достигнут предел длины)_';
    if (timer) clearTimeout(timer); paint();
  } catch (e) {
    if (timer) clearTimeout(timer); paint();
    if (e.name !== 'AbortError') bubble.insertAdjacentHTML('beforeend', '<div class="error">' + esc(friendly(e)) + '</div>');
  }
  if (text.trim()) { chat.push({ role: 'model', text, ts: Date.now() }); Store.saveChat(chat); }
  else if (!bubble.querySelector('.error')) bubble.remove();
  $('#chatSend').disabled = false; $('#chatStop').classList.add('hidden'); chatCtrl = null;
}
function initChat() {
  renderChat();
  $('#chatSend').onclick = sendChat;
  $('#chatText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } });
  $('#chatStop').onclick = () => { if (chatCtrl) chatCtrl.abort(); };
  $('#chatReset').onclick = async () => { if (chatCtrl) chatCtrl.abort(); if (!chat.length || await ask('Начать разговор заново? Текущая переписка будет удалена.', { ok: 'Начать заново', danger: true })) { chat = []; Store.saveChat(chat); renderChat(); } };
}

// ---- Рукопись
function renderChapters() {
  const list = $('#chapterList'); list.innerHTML = '';
  const total = book.chapters.reduce((n, c) => n + wordCount(c.text), 0);
  $('#bkStats').textContent = book.chapters.length ? '— всего ' + fmtNum(total) + ' слов' : '';
  if (!book.chapters.length) { list.innerHTML = '<div class="muted">Пока ни одной главы. Добавьте текст ниже.</div>'; return; }
  book.chapters.forEach((c, i) => {
    const row = el('div', 'row');
    row.innerHTML = '<div class="grow"><div class="title">' + esc(c.title) + '</div><div class="muted small">' + fmtNum(wordCount(c.text)) + ' слов · ' + fmtNum(c.text.length) + ' знаков</div></div>' +
      '<div class="btns"><button type="button" class="btn-sm b-show">Показать</button><button type="button" class="btn-sm b-ren">Переименовать</button><button type="button" class="btn-sm b-rep">Заменить текст</button>' +
      '<button type="button" class="btn-sm b-up" title="Выше">▲</button><button type="button" class="btn-sm b-down" title="Ниже">▼</button><button type="button" class="btn-sm b-del" style="color:#c0392b">Удалить</button></div>';
    $('.b-show', row).onclick = () => { let pv = $('.preview', row); if (pv) { pv.remove(); $('.b-show', row).textContent = 'Показать'; return; } pv = el('div', 'preview full'); pv.textContent = c.text; row.appendChild(pv); $('.b-show', row).textContent = 'Скрыть'; };
    $('.b-ren', row).onclick = async () => { const t = await askText('Новое название главы:', c.title); if (t && t.trim()) { c.title = t.trim(); saveBook(); } };
    $('.b-rep', row).onclick = () => { $('#chTitle').value = c.title; $('#chText').value = c.text; $('#chAdd').textContent = 'Сохранить изменения в «' + c.title + '»'; $('#chAdd').dataset.replace = c.id; $('#chTitle').scrollIntoView({ behavior: 'smooth', block: 'center' }); toast('Отредактируйте текст ниже и нажмите «Сохранить изменения»', 4000); };
    $('.b-up', row).onclick = () => { if (i > 0) { book.chapters.splice(i - 1, 0, book.chapters.splice(i, 1)[0]); saveBook(); } };
    $('.b-down', row).onclick = () => { if (i < book.chapters.length - 1) { book.chapters.splice(i + 1, 0, book.chapters.splice(i, 1)[0]); saveBook(); } };
    $('.b-del', row).onclick = async () => { if (await ask('Удалить «' + c.title + '» из рукописи помощника? Ваши файлы на компьютере не затрагиваются.', { ok: 'Удалить', danger: true })) { book.chapters.splice(i, 1); saveBook(); } };
    list.appendChild(row);
  });
}
async function originalBook() {
  if (window.BOOK_DEFAULT) return deepCopy(window.BOOK_DEFAULT);
  try { const r = await fetch('book.json', { cache: 'no-store' }); if (r.ok) return await r.json(); } catch (e) { /* файла нет */ }
  return null;
}
function fillBookFields() { $('#bkTitle').value = book.title || ''; $('#bkSeries').value = book.series || ''; $('#bkAuthor').value = book.author || ''; $('#bkAbout').value = book.about || ''; }
function resetChapterForm() { $('#chTitle').value = ''; $('#chText').value = ''; $('#chFile').value = ''; $('#chAdd').textContent = 'Добавить главу'; delete $('#chAdd').dataset.replace; }
function initManuscript() {
  fillBookFields();
  $('#bkSave').onclick = () => { book.title = $('#bkTitle').value.trim(); book.series = $('#bkSeries').value.trim(); book.author = $('#bkAuthor').value.trim(); book.about = $('#bkAbout').value.trim(); saveBook(); toast('Сохранено'); };
  $('#bkAboutAuto').onclick = async () => {
    if (!book.chapters.length) { toast('Сначала добавьте в рукопись хотя бы одну главу'); return; }
    const btn = $('#bkAboutAuto'); btn.disabled = true; $('#bkAboutStatus').textContent = 'Читаю рукопись…';
    try { const t = await llmText(P.bookPassport()); $('#bkAbout').value = t.trim(); $('#bkAboutStatus').textContent = 'Готово. Проверьте текст и нажмите «Сохранить».'; }
    catch (e) { $('#bkAboutStatus').textContent = ''; toast(friendly(e), 6000); }
    btn.disabled = false;
  };
  $('#bkReset').classList.toggle('hidden', !window.BOOK_DEFAULT && Store.mode !== 'cloud');
  $('#chFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    try {
      let text;
      if (/\.docx$/i.test(f.name)) text = await window.DOCX.docxToText(await f.arrayBuffer());
      else if (/\.(txt|md|text)$/i.test(f.name)) text = await readTextFile(f);
      else { toast('Поддерживаются файлы .docx и .txt'); return; }
      if (!text.trim()) { toast('В файле не нашлось текста'); return; }
      $('#chText').value = text; if (!$('#chTitle').value.trim()) $('#chTitle').value = f.name.replace(/\.[^.]+$/, '');
      toast('Файл прочитан: ' + fmtNum(wordCount(text)) + ' слов. Проверьте название и нажмите «Добавить главу».', 4500);
    } catch (err) { toast('Не удалось прочитать файл: ' + (err.message || err), 5000); }
  };
  $('#chAdd').onclick = () => {
    const title = $('#chTitle').value.trim(); const text = $('#chText').value.trim();
    if (!text) { toast('Вставьте текст главы или загрузите файл'); return; }
    const replaceId = $('#chAdd').dataset.replace;
    if (replaceId) { const c = book.chapters.find(x => x.id === replaceId); if (c) { c.title = title || c.title; c.text = text; } }
    else book.chapters.push({ id: uid(), title: title || ('Глава ' + (book.chapters.length + 1)), text });
    saveBook(); resetChapterForm(); toast(replaceId ? 'Глава обновлена' : 'Глава добавлена');
  };
  $('#bkReset').onclick = async () => {
    if (!await ask('Вернуть исходную рукопись (первую главу из файла)? Все добавленные здесь главы будут удалены.', { ok: 'Вернуть', danger: true })) return;
    const src = await originalBook(); if (!src) { toast('Исходная рукопись недоступна: файл с первой главой не найден.', 5000); return; }
    book = src; if (!book.chapters) book.chapters = [];
    fillBookFields(); saveBook(); resetChapterForm(); toast('Рукопись восстановлена');
  };
  $('#bkExport').onclick = () => { const txt = (book.title ? book.title.toUpperCase() + '\n\n' : '') + book.chapters.map(c => c.title + '\n\n' + c.text.trim()).join('\n\n\n'); downloadFile(safeName(book.title || 'рукопись') + '.txt', txt); };
  renderChapters(); initSummaryUI();
}
function renderSummaryInfo() {
  const step = $('#summaryStep'); if (!step) return;
  const claude = Engine.kind() === 'claude'; step.classList.toggle('hidden', !claude); if (!claude) return;
  const info = $('#summaryInfo');
  if (!summaryMem || !summaryMem.text) info.innerHTML = '<div class="muted">Сводка ещё не составлена — помощник сделает её сам при первом задании.</div>';
  else info.innerHTML = '<div>' + (summaryMem.hash === manuscriptHash() ? '<b>Сводка актуальна</b>' : '<b>Текст изменился</b> — сводка обновится при следующем задании') + ' · составлена ' + fmtDate(summaryMem.ts) + ' · ' + fmtNum(summaryMem.chars || summaryMem.text.length) + ' знаков</div>';
}
function initSummaryUI() {
  $('#summaryRebuild').onclick = async () => {
    const btn = $('#summaryRebuild'); btn.disabled = true; const info = $('#summaryInfo');
    try { await ensureSummary(msg => { info.innerHTML = '<div class="muted">' + esc(msg) + '</div>'; }, undefined, true); toast('Сводка составлена'); }
    catch (e) { info.innerHTML = '<div class="error">' + esc(friendly(e)) + '</div>'; }
    btn.disabled = false; renderSummaryInfo();
  };
  if (Engine.kind() === 'claude' && Store.mode === 'cloud' && !summaryMem) {
    Store.db.doc('state/summary').get().then(sn => { if (sn.exists) summaryMem = deepCopy(sn.data()); renderSummaryInfo(); }).catch(() => renderSummaryInfo());
  } else renderSummaryInfo();
}


// ---- Память помощника
function renderNotes() {
  const list = $('#noteList'); list.innerHTML = '';
  $('#noteStats').textContent = notes.length ? '— ' + notes.length + ' ' + plural(notes.length, 'запись', 'записи', 'записей') : '';
  if (!notes.length) { list.innerHTML = '<div class="muted">Пока пусто. Запишите первое решение или факт, который помощник должен помнить.</div>'; return; }
  notes.slice().reverse().forEach(n => {
    const row = el('div', 'row');
    row.innerHTML = '<div class="grow"><div>' + esc(n.text) + '</div><div class="muted small">' + fmtDate(n.ts) + '</div></div><div class="btns"><button type="button" class="btn-sm b-del" style="color:#c0392b">Удалить</button></div>';
    $('.b-del', row).onclick = () => { notes = notes.filter(x => x.id !== n.id); Store.saveNotes(notes); renderNotes(); };
    list.appendChild(row);
  });
}
function plural(n, one, few, many) { const m10 = n % 10, m100 = n % 100; if (m10 === 1 && m100 !== 11) return one; if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few; return many; }
function renderStorageInfo() {
  const box = $('#storageInfo');
  if (Store.mode === 'cloud') box.innerHTML = '<div class="ok-box" style="margin-top:0">Данные хранятся в облаке вместе с этой страницей (хранилище claude.ai). Рукопись, история, разговоры и память доступны с любого устройства, где вы вошли в свой аккаунт. Ключ доступа хранится отдельно, в вашем личном разделе, и другим людям не виден.</div>';
  else if (Store.mode === 'server') box.innerHTML = '<div class="ok-box" style="margin-top:0">Данные хранятся в базе SQLite: файл <b>' + esc(Store.dbPath || 'data/помощник.sqlite') + '</b> в папке помощника. Рукопись, история, разговоры, память и настройки сохраняются туда автоматически. Чтобы сделать копию, достаточно скопировать этот файл.</div>';
  else if (Store.idb) box.innerHTML = '<div class="ok-box" style="margin-top:0">Данные хранятся в этом браузере, на этом устройстве: рукопись, история, разговоры, память, картинки и записи. Закрытие страницы им не вредит, но очистка данных браузера их сотрёт, поэтому время от времени скачивайте резервную копию. Чтобы перенести всё на другое устройство, скачайте копию здесь и загрузите её там. Картинки и записи в копию не входят: нужные скачайте из галерей.</div>';
  else box.innerHTML = '<div class="banner" style="margin:0">Этот браузер не даёт сохранять данные надёжно, возможно, открыт приватный режим. Рукопись и ответы могут пропасть после закрытия страницы.</div>';
}
function initMemory() {
  $('#noteAdd').onclick = () => {
    const t = $('#noteText').value.trim(); if (!t) { toast('Напишите, что нужно запомнить'); return; }
    notes.push({ id: uid(), ts: Date.now(), text: t }); Store.saveNotes(notes); $('#noteText').value = ''; renderNotes(); toast('Запомнил. Теперь это учитывается в каждом ответе.');
  };
  $('#noteText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#noteAdd').click(); } });
  $('#backupBtn').onclick = async () => {
    try {
      let dump;
      if (Store.mode === 'server') dump = await Store.req('GET', 'export');
      else {
        const hist = await Store.getHistory(); for (const h of hist) h.text = await Store.getHistoryText(h);
        dump = { book: { title: book.title || '', series: book.series || '', author: book.author || '', about: book.about || '' }, chapters: book.chapters, settings: Object.assign({}, settingsMem), notes, chat, history: hist, kv: { visual_bible: kvMem.visual_bible || '' }, exported_at: Date.now() };
      }
      if (dump.settings) { delete dump.settings.apiKey; delete dump.settings.elevenKey; }
      delete dump.images; delete dump.audio;
      const d = new Date(); const stamp = d.toISOString().slice(0, 10);
      downloadFile('помощник-копия-' + stamp + '.json', JSON.stringify(dump, null, 1));
    } catch (e) { toast('Не удалось сделать копию: ' + e.message, 5000); }
  };
  $('#restoreBtn').onclick = () => $('#restoreFile').click();
  $('#restoreFile').onchange = async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = ''; if (!f) return;
    let obj; try { obj = JSON.parse(await readTextFile(f)); } catch (err) { toast('Не удалось прочитать файл: это не похоже на резервную копию помощника', 6000); return; }
    if (!await ask('Загрузить резервную копию? Рукопись, описание книги, память и разговор заменятся данными из файла. Ответы из истории добавятся к текущим.', { ok: 'Загрузить' })) return;
    try { const n = await importBackup(obj); toast('Копия загружена: глав в рукописи ' + n.chapters + ', ответов в истории ' + n.history, 6000); }
    catch (err) { toast(err.message || String(err), 7000); }
  };
  renderNotes(); renderStorageInfo();
}
async function importBackup(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Это не похоже на резервную копию помощника');
  const b = obj.book || {};
  const chapters = Array.isArray(obj.chapters) ? obj.chapters : (Array.isArray(b.chapters) ? b.chapters : null);
  if (!chapters) throw new Error('В файле нет рукописи: это не похоже на резервную копию помощника');
  book = { title: String(b.title || ''), series: String(b.series || ''), author: String(b.author || ''), about: String(b.about || ''),
    chapters: chapters.filter(c => c && c.text).map(c => ({ id: String(c.id || uid()), title: String(c.title || ''), text: String(c.text) })) };
  saveBook(); fillBookFields();
  if (Array.isArray(obj.notes)) { notes = obj.notes.filter(n => n && n.text).map(n => ({ id: String(n.id || uid()), ts: n.ts || Date.now(), text: String(n.text) })); Store.saveNotes(notes); renderNotes(); }
  if (Array.isArray(obj.chat)) { chat = obj.chat.filter(m => m && m.text && (m.role === 'user' || m.role === 'model')).map(m => ({ role: m.role, text: String(m.text), ts: m.ts || Date.now() })); Store.saveChat(chat); renderChat(); }
  let hc = 0;
  if (Array.isArray(obj.history)) for (const h of obj.history) { if (!h || !h.text) continue; await Store.addHistory({ id: String(h.id || uid()), ts: h.ts || Date.now(), section: h.section || '', title: h.title || '', text: String(h.text) }); hc++; }
  const bible = obj.kv && obj.kv.visual_bible;
  if (bible) { kvMem.visual_bible = bible; try { await Store.setKv('visual_bible', bible); } catch (e) { /* не критично */ } const ta = $('#imgBible'); if (ta) ta.value = bible; }
  return { chapters: book.chapters.length, history: hc };
}

// ---- История
const SECTION_TITLE = {}; SECTIONS.forEach(s => SECTION_TITLE[s.id] = s.title);
function addHistory(e) {
  Store.addHistory({ id: uid(), ts: Date.now(), section: e.section, title: e.title, text: String(e.text).slice(0, 400000) });
}
async function renderHistory() {
  const list = $('#historyList'); list.innerHTML = '<div class="muted">Загружаю…</div>';
  let h = [];
  try { h = await Store.getHistory(); } catch (e) { list.innerHTML = '<div class="error">Не удалось загрузить историю: ' + esc(e.message) + '</div>'; return; }
  list.innerHTML = '';
  if (!h.length) { list.innerHTML = '<div class="muted">Пока пусто. Здесь будут появляться все ответы помощника.</div>'; return; }
  h.forEach(item => {
    const row = el('div', 'row');
    const sizeText = item.text != null ? fmtNum(wordCount(item.text)) + ' слов' : fmtNum(item.chars || 0) + ' знаков';
    row.innerHTML = '<div class="grow"><div class="title">' + esc(item.title) + '</div><div class="muted small">' + esc(SECTION_TITLE[item.section] || item.section) + ' · ' + fmtDate(item.ts) + ' · ' + sizeText + '</div></div>' +
      '<div class="btns"><button type="button" class="btn-sm b-open">Открыть</button><button type="button" class="btn-sm b-copy">Скопировать</button><button type="button" class="btn-sm b-save">Сохранить файл</button><button type="button" class="btn-sm b-del" style="color:#c0392b">Удалить</button></div>';
    $('.b-open', row).onclick = async () => { let v = $('.md', row); if (v) { v.remove(); $('.b-open', row).textContent = 'Открыть'; return; } v = el('div', 'md full'); v.innerHTML = '<span class="muted">Загружаю…</span>'; row.appendChild(v); v.innerHTML = md(await Store.getHistoryText(item)); $('.b-open', row).textContent = 'Свернуть'; };
    $('.b-copy', row).onclick = async () => copyResult(await Store.getHistoryText(item));
    $('.b-save', row).onclick = async () => downloadFile(safeName(item.title) + '.txt', mdToPlain(await Store.getHistoryText(item)));
    $('.b-del', row).onclick = async () => { try { await Store.deleteHistory(item.id, item.parts); } catch (e) { toast('Не удалось удалить: ' + e.message); } renderHistory(); };
    list.appendChild(row);
  });
}
function initHistory() { $('#historyClear').onclick = async () => { if (await ask('Удалить всю историю ответов?', { ok: 'Удалить', danger: true })) { try { await Store.clearHistory(); } catch (e) { toast('Не удалось очистить: ' + e.message); } renderHistory(); } }; }

// ---- Настройки
function fillSettings() {
  const s = getSettings(); const ls = settingsMem || {}; const claude = Engine.kind() === 'claude';
  $('#setClaudeInfo').classList.toggle('hidden', !claude); $('#setGeminiWrap').classList.toggle('hidden', claude); $('#setBaseWrap').classList.toggle('hidden', claude);
  $('#setKey').value = ls.apiKey || '';
  $('#setSource').textContent = s.keySource === 'app' ? (Store.mode === 'cloud' ? 'Ключ сохранён в вашем личном разделе этой страницы — другим людям он не виден.' : 'Используется ключ, сохранённый в приложении.') : s.keySource === 'file' ? 'Используется ключ из файла config.js. Если вставить ключ сюда, он будет главнее.' : 'Ключ пока не задан.';
  const known = $$('#setModel option').map(o => o.value);
  if (known.includes(s.model)) { $('#setModel').value = s.model; $('#setModelCustomWrap').classList.add('hidden'); }
  else { $('#setModel').value = 'custom'; $('#setModelCustom').value = s.model; $('#setModelCustomWrap').classList.remove('hidden'); }
  $('#setThinking').value = s.thinking; $('#setBase').value = s.baseUrl;
  $('#setEleven').value = ls.elevenKey || '';
  $('#setElevenSource').textContent = s.elevenSource === 'app' ? 'Используется ключ ElevenLabs, сохранённый в приложении.' : s.elevenSource === 'file' ? 'Используется ключ ElevenLabs из файла config.js.' : 'Ключ ElevenLabs не задан — озвучка не будет работать.';
  $('#setImageModel').value = s.imageModel || ''; $('#setElevenModel').value = s.elevenModel || 'eleven_v4';
  $('#setTextHome').value = s.textHome === 'claude' ? 'claude' : 'here';
}
function readSettingsForm() {
  const model = $('#setModel').value === 'custom' ? $('#setModelCustom').value.trim() : $('#setModel').value;
  return Object.assign({}, settingsMem, { textHome: $('#setTextHome').value === 'claude' ? 'claude' : 'here', apiKey: $('#setKey').value.trim(), model: model || DEFAULTS.model, thinking: $('#setThinking').value, baseUrl: ($('#setBase').value.trim() || DEFAULTS.baseUrl).replace(/\/+$/, ''), elevenKey: $('#setEleven').value.trim(), imageModel: $('#setImageModel').value.trim() || DEFAULTS.imageModel, elevenModel: $('#setElevenModel').value || DEFAULTS.elevenModel });
}
function initSettings() {
  $('#setModel').onchange = () => $('#setModelCustomWrap').classList.toggle('hidden', $('#setModel').value !== 'custom');
  $('#setElevenShow').onclick = () => { const i = $('#setEleven'); i.type = i.type === 'password' ? 'text' : 'password'; $('#setElevenShow').textContent = i.type === 'password' ? 'Показать' : 'Скрыть'; };
  $('#setKeyShow').onclick = () => { const i = $('#setKey'); i.type = i.type === 'password' ? 'text' : 'password'; $('#setKeyShow').textContent = i.type === 'password' ? 'Показать' : 'Скрыть'; };
  $('#setSave').onclick = () => { settingsMem = readSettingsForm(); Store.saveSettings(settingsMem); applyTextHome(); updateKeyState(); fillSettings(); $('#setStatus').innerHTML = ''; toast('Настройки сохранены'); };
  $('#setReset').onclick = async () => { if (await ask('Сбросить настройки? Ключ, сохранённый в приложении, будет удалён.', { ok: 'Сбросить', danger: true })) { settingsMem = {}; Store.saveSettings(settingsMem); updateKeyState(); fillSettings(); $('#setStatus').innerHTML = ''; } };
  $('#setTest').onclick = async () => {
    settingsMem = readSettingsForm(); Store.saveSettings(settingsMem); updateKeyState(); const s = getSettings(); const st = $('#setStatus');
    if (Engine.kind() === 'claude') {
      st.innerHTML = '<div class="muted" style="margin-top:10px">Проверяю… Если появится запрос на разрешение — нажмите «Разрешить».</div>'; $('#setTest').disabled = true;
      try { const t = await sampleText('Ответь одной короткой фразой по-русски: ты готов помогать писателю?', 'quick'); st.innerHTML = '<div class="ok-box">Подключение работает. Claude отвечает: «' + esc(t.trim().slice(0, 120)) + '». Можно пользоваться помощником.</div>'; }
      catch (e) { st.innerHTML = '<div class="error">' + esc(friendly(e)) + '</div>'; }
      $('#setTest').disabled = false; return;
    }
    if (!s.apiKey) { st.innerHTML = '<div class="error">Сначала вставьте ключ.</div>'; return; }
    st.innerHTML = '<div class="muted" style="margin-top:10px">Проверяю…</div>'; $('#setTest').disabled = true;
    try {
      const testModel = textsElsewhere() ? s.imageModel : s.model;
      const res = await fetch(s.baseUrl + '/v1beta/models/' + encodeURIComponent(testModel), { headers: { 'x-goog-api-key': s.apiKey } });
      if (res.ok) st.innerHTML = '<div class="ok-box">Подключение работает. Модель <b>' + esc(testModel) + '</b> доступна — можно пользоваться помощником.</div>';
      else { let detail = ''; try { const j = await res.json(); detail = (j.error && j.error.message) || ''; } catch (e) { /* нет деталей */ } const err = new Error('HTTP'); err.status = res.status; err.detail = detail; st.innerHTML = '<div class="error">' + esc(friendly(err)) + '</div>'; }
    } catch (e) { st.innerHTML = '<div class="error">' + esc(friendly(new Error('NETWORK'))) + '</div>'; }
    if (getSettings().elevenKey && Store.media()) {
      try { const r = await Store.listVoices(true); const u = r.usage; st.insertAdjacentHTML('beforeend', '<div class="ok-box">ElevenLabs работает' + (u && u.character_limit ? ': тариф ' + esc(u.tier || '?') + ', осталось ' + fmtNum(Math.max(0, u.character_limit - (u.character_count || 0))) + ' знаков в этом месяце' : '') + '.</div>'); }
      catch (e) { st.insertAdjacentHTML('beforeend', '<div class="error">' + esc(e.message || String(e)) + '</div>'); }
    }
    $('#setTest').disabled = false;
  };
}

// ================= помощники для медиа =================
async function llmText(prompt, opts) {
  opts = opts || {};
  if (!ensureKey()) throw new Error('Нет ключа');
  let sys;
  if (opts.bare) sys = P.system(book, notes, sysOpts({ manuscript: 'skip' }));
  else if (Engine.kind() === 'claude') { const mat = await cloudMaterials({ kind: 'whole' }, opts.progress || (() => {}), opts.signal); sys = P.system(book, notes, sysOpts({ manuscript: 'none' })) + '\n\n' + mat.context; }
  else sys = P.system(book, notes, sysOpts());
  let text = '';
  await callModel({ systemText: sys, userText: prompt, signal: opts.signal, tier: opts.tier, onChunk: t => { text += t; if (opts.onText) opts.onText(text); } });
  return text;
}
function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (fence) t = fence[1].trim();
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) t = t.slice(a, b + 1);
  try { return JSON.parse(t); } catch (e) { return null; }
}
function findChapterByText(frag) {
  if (!frag) return '';
  const key = frag.trim().slice(0, 80);
  for (const c of book.chapters) if (key && c.text.indexOf(key) >= 0) return c.id;
  return '';
}
async function refreshAssets() {
  if (!Store.media()) return;
  try { assetsMem.images = await Store.listImages(); } catch (e) { /* оставим как есть */ }
  try { assetsMem.audio = await Store.listAudio(); } catch (e) { /* оставим как есть */ }
}

// ---- 8. Иллюстрации
let imagesCache = null;
let imgUI = null;
function renderImageCards(container, rows) {
  container.innerHTML = '';
  rows.forEach(im => {
    const card = el('div', 'img-card');
    card.innerHTML = '<a href="' + esc(im.url) + '" target="_blank" rel="noopener"><img src="' + esc(im.url) + '" alt="" loading="lazy"></a>' +
      '<div class="img-cap">' + esc(im.caption || 'Без подписи') + '</div>' +
      '<div class="muted small">' + esc(im.style_label || '') + (im.chapter_title ? ' · ' + esc(im.chapter_title) : ' · к книге') + ' · ' + fmtDate(im.ts) + '</div>' +
      '<div class="btns"><a class="btn-sm" href="' + esc(im.url) + '" download="' + esc(safeName(im.caption || 'иллюстрация') + (im.file ? im.file.slice(im.file.lastIndexOf('.')) : /png/.test(im.mime || '') ? '.png' : /webp/.test(im.mime || '') ? '.webp' : '.jpg')) + '">Скачать</a><button type="button" class="btn-sm b-prompt">Описание</button><button type="button" class="btn-sm b-del" style="color:#c0392b">Удалить</button></div>' +
      '<div class="preview hidden"></div>';
    $('.b-prompt', card).onclick = () => { const pv = $('.preview', card); pv.textContent = (im.anchor ? 'Фрагмент: «' + im.anchor + '…»\n\n' : '') + im.prompt; pv.classList.toggle('hidden'); };
    $('.b-del', card).onclick = async () => {
      if (!await ask('Удалить эту картинку?', { ok: 'Удалить', danger: true })) return;
      try { await Store.deleteImage(im.id); } catch (e) { toast('Не удалось удалить: ' + e.message); return; }
      card.remove(); imagesCache = null; renderGallery(); refreshAssets();
    };
    container.appendChild(card);
  });
}
async function renderGallery() {
  if (!Store.media()) return;
  try { imagesCache = await Store.listImages(); } catch (e) { $('#imgGallery').innerHTML = '<div class="error">' + esc(e.message) + '</div>'; return; }
  assetsMem.images = imagesCache;
  $('#imgGalleryStats').textContent = imagesCache.length ? '— ' + imagesCache.length + ' ' + plural(imagesCache.length, 'картинка', 'картинки', 'картинок') : '— пока пусто';
  renderImageCards($('#imgGallery'), imagesCache);
  const sel = $('#imgLayoutChapter'); sel.innerHTML = '<option value="all">Вся книга</option>' + book.chapters.map(c => '<option value="' + esc(c.id) + '">' + esc(c.title) + '</option>').join('');
}
function chapterOf(target, fallbackFrag) {
  // глава, к которой относится картинка или запись
  const ho = target && target.handoff;
  if (ho) {
    let id = ho.chapter_id || ''; const title = ho.chapter_title || '';
    if (id && !book.chapters.some(c => c.id === id)) { const byTitle = book.chapters.find(c => c.title === title); if (byTitle) id = byTitle.id; }
    return { id, title };
  }
  const frag = fallbackFrag || '';
  const id = target ? (target.kind === 'chapters' ? target.ids[0] : findChapterByText(frag)) : '';
  return { id, title: id ? ((book.chapters.find(c => c.id === id) || {}).title || '') : '' };
}
function initImages() {
  const mk = Store.mediaKind(); const direct = mk === 'direct', handoff = mk === 'handoff';
  $('#imagesUnavailable').classList.toggle('hidden', mk !== 'none');
  let refreshHandoff = () => {};
  const kinds = optionGroup($('#imgKinds'), modesOf(P.imageKinds));
  const tp = targetPicker($('#imgTarget'));
  const styles = optionGroup($('#imgStyles'), P.imageStyles.map(st => ({ id: st.id, label: st.label, hint: st.hint })), { onChange: () => refreshHandoff() });
  const aspect = optionGroup($('#imgAspect'), [{ id: '16:9', label: 'Широкий 16:9' }, { id: '3:4', label: 'Страница 3:4' }, { id: '1:1', label: 'Квадрат 1:1' }, { id: '9:16', label: 'Вертикальный 9:16' }], { chips: true, onChange: () => refreshHandoff() });
  let current = null;
  $('#imgBible').value = kvMem.visual_bible || '';
  if (handoff) {
    // claude.ai: задание готовит Claude по подписке, рисует мастерская
    $('#imgDrawBtn').classList.add('hidden'); $('#imgHandoff').classList.remove('hidden');
    $('#imgResults').classList.add('hidden'); $('#imgGallery').closest('.step').classList.add('hidden');
    const ii = $('#imgModeInfo'); ii.innerHTML = 'Здесь Claude готовит задание для художника по вашей подписке. Рисует Nano Banana в мастерской: она откроется в новой вкладке, там проверьте задание и нажмите «Нарисовать». Готовые картинки хранятся в мастерской.'; ii.classList.remove('hidden');
    refreshHandoff = handoffLink($('#imgHandoff'), () => {
      const styleObj = P.imageStyles.find(st => st.id === styles.get()) || P.imageStyles[0];
      const t = current && current.target; const frag = t && t.kind === 'text' ? t.text : ''; const ch = chapterOf(t, frag);
      return { v: 1, kind: 'draw', caption: $('#imgCaption').value.trim(), prompt: $('#imgPrompt').value.trim(), style: styleObj.id, aspect: aspect.get(), count: parseInt($('#imgCount').value, 10) || 2,
        chapter_id: ch.id, chapter_title: ch.title, anchor: frag ? frag.trim().slice(0, 200) : '', fragment: frag.slice(0, 3000), claudeUrl: (window.CONFIG || {}).claudeUrl || '' };
    });
    $('#imgHandoff').addEventListener('click', e => { if (!$('#imgPrompt').value.trim()) { e.preventDefault(); toast('Сначала придумайте задание для художника'); } });
    ['#imgCaption', '#imgPrompt'].forEach(sel => $(sel).addEventListener('input', () => refreshHandoff()));
    $('#imgCount').addEventListener('change', () => refreshHandoff());
  }
  $('#imgPromptBtn').onclick = async () => {
    if (mk === 'none') { toast(MEDIA_OFF, 6000); return; }
    let kind = kinds.get(); let target = null;
    if (kind === 'scene' || kind === 'chapter' || kind === 'place') { target = tp.get(); if (!target) return; }
    if (kind === 'scene' && target && target.kind === 'chapters') kind = 'chapter';
    const styleObj = P.imageStyles.find(st => st.id === styles.get());
    const o = { kind, aspect: aspect.get(), extra: $('#imgExtra').value.trim(), bible: $('#imgBible').value.trim() };
    if (target) { if (target.kind === 'text') o.text = target.text; else { o.titles = target.titles; if (kind === 'place') o.text = target.text.slice(0, 20000); } }
    const btn = $('#imgPromptBtn'); btn.disabled = true; $('#imgPromptStatus').textContent = 'Придумываю задание…';
    try {
      const raw = await llmText(P.imagePrompt(o));
      const j = parseJsonLoose(raw);
      if (!j || !j.prompt) throw new Error('Не удалось разобрать ответ помощника. Нажмите ещё раз.');
      $('#imgCaption').value = j.caption || ''; $('#imgPrompt').value = String(j.prompt).trim();
      current = { kind, target, aspect: o.aspect, styleId: styleObj.id };
      $('#imgPromptStep').classList.remove('hidden'); $('#imgPromptStep').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#imgPromptStatus').textContent = ''; refreshHandoff();
    } catch (e) { $('#imgPromptStatus').textContent = ''; toast(e.message === 'HTTP' || e.message === 'NETWORK' || e.message === 'SAMPLE' ? friendly(e) : (e.message || String(e)), 7000); }
    btn.disabled = false;
  };
  $('#imgDrawBtn').onclick = async () => {
    if (!direct) { toast(MEDIA_OFF, 6000); return; }
    const prompt = $('#imgPrompt').value.trim(); if (!prompt) { toast('Опишите картинку'); return; }
    const count = parseInt($('#imgCount').value, 10) || 2;
    const styleObj = P.imageStyles.find(st => st.id === styles.get()) || P.imageStyles[0];
    const fullPrompt = prompt + '\n\nStyle: ' + styleObj.en + '. No text, no captions, no letters, no watermark.';
    const t = current && current.target; const ho = current && current.handoff;
    const frag = ho ? String(ho.fragment || '') : (t && t.kind === 'text' ? t.text : '');
    const ch = chapterOf(ho ? current : t, frag);
    const body = { prompt: fullPrompt, aspect: aspect.get(), count, caption: $('#imgCaption').value.trim(), style: styleObj.id, style_label: styleObj.label,
      chapter_id: ch.id, chapter_title: ch.title, anchor: ho ? String(ho.anchor || '') : (frag ? frag.trim().slice(0, 200) : ''), fragment: frag.slice(0, 3000) };
    const btn = $('#imgDrawBtn'); btn.disabled = true; $('#imgStatus').textContent = 'Рисую (' + count + ')… обычно 15–40 секунд';
    try {
      const rows = await Store.generateImages(body);
      renderImageCards($('#imgResults'), rows); $('#imgResults').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#imgStatus').textContent = 'Готово — сохранено в галерею'; renderGallery(); refreshAssets();
    } catch (e) { $('#imgStatus').textContent = ''; toast(e.message || String(e), 8000); }
    btn.disabled = false;
  };
  $('#imgBibleAuto').onclick = async () => {
    const btn = $('#imgBibleAuto'); btn.disabled = true; $('#imgBibleStatus').textContent = 'Читаю рукопись…';
    try { const txt = await llmText(P.visualBible()); $('#imgBible').value = txt.trim(); $('#imgBibleStatus').textContent = 'Готово — проверьте и нажмите «Сохранить»'; }
    catch (e) { $('#imgBibleStatus').textContent = ''; toast(friendly(e), 6000); }
    btn.disabled = false;
  };
  $('#imgBibleSave').onclick = async () => {
    const v = $('#imgBible').value.trim(); kvMem.visual_bible = v;
    if (Store.media() || Store.mode === 'cloud') { try { await Store.setKv('visual_bible', v); toast('Сохранено'); } catch (e) { toast('Не удалось сохранить: ' + e.message); } }
    else toast('Сохранено до закрытия страницы');
  };
  $('#imgLayoutBtn').onclick = () => { if (!direct) return; showLayout($('#imgLayoutChapter').value || 'all'); };
  imgUI = { styles, aspect, setCurrent: c => { current = c; } };
  if (direct) renderGallery();
}

// ---- 9. Озвучка
let voicePreviewEl = null;
let audUI = null;
const HANDOFF_MAX = 20000;
function initAudio() {
  const mk = Store.mediaKind(); const direct = mk === 'direct', handoff = mk === 'handoff';
  $('#audioUnavailable').classList.toggle('hidden', mk !== 'none');
  let refreshHandoff = () => {};
  const manner = optionGroup($('#audManner'), modesOf(P.narrationManners), { onChange: () => refreshHandoff() });
  const tp = targetPicker($('#audTarget'));
  let voices = [], usage = null, selected = null, scriptTarget = null;
  function paintSelected() { $$('#voiceList .voice-card').forEach(c => { const on = selected && c.dataset.id === selected.id; c.classList.toggle('on', !!on); const b = $('.b-pick', c); if (b) { b.textContent = on ? 'Выбран' : 'Выбрать'; b.classList.toggle('on', !!on); } }); }
  function preview(v, btn) {
    if (!v.preview) { toast('У этого голоса нет образца'); return; }
    if (!voicePreviewEl) { voicePreviewEl = document.createElement('audio'); voicePreviewEl.onended = () => $$('.b-play').forEach(b => b.textContent = '▶ Прослушать'); }
    if (voicePreviewEl.src === v.preview && !voicePreviewEl.paused) { voicePreviewEl.pause(); btn.textContent = '▶ Прослушать'; return; }
    $$('.b-play').forEach(b => b.textContent = '▶ Прослушать');
    voicePreviewEl.src = v.preview; voicePreviewEl.play().then(() => { btn.textContent = '■ Стоп'; }).catch(() => toast('Не удалось воспроизвести образец'));
  }
  function voiceCard(v) {
    const card = el('div', 'voice-card'); card.dataset.id = v.id;
    const parts = String(v.name || '').split(' - ');
    const cloneBlocked = v.category === 'cloned' && usage && usage.can_use_instant_voice_cloning === false;
    const meta = [v.gender === 'female' ? 'женский' : v.gender === 'male' ? 'мужской' : '', v.accent ? v.accent : '', v.category === 'cloned' ? 'ваш клон' : v.category === 'generated' ? 'создан вами' : v.category === 'professional' ? 'из библиотеки' : '', cloneBlocked ? '⚠ на вашем тарифе ElevenLabs клоны недоступны' : ''].filter(Boolean).join(' · ');
    card.innerHTML = '<div class="voice-name">' + esc(parts[0]) + '</div><div class="voice-desc">' + esc(parts.slice(1).join(' - ') || v.description || '') + (meta ? '<br>' + esc(meta) : '') + '</div>' +
      '<div class="btns"><button type="button" class="btn-sm b-play">▶ Прослушать</button><button type="button" class="btn-sm b-pick">Выбрать</button>' + (v.category === 'cloned' || v.category === 'generated' ? '<button type="button" class="btn-sm b-del" style="color:#c0392b">Удалить</button>' : '') + '</div>';
    $('.b-play', card).onclick = () => preview(v, $('.b-play', card));
    $('.b-pick', card).onclick = () => { if (cloneBlocked) { toast('Этот голос — клон, а на тарифе pay-as-you-go ElevenLabs клоны не озвучивают. Нужен тариф Starter или выше.', 6000); return; } selected = v; paintSelected(); };
    const del = $('.b-del', card);
    if (del) del.onclick = async () => { if (!await ask('Удалить голос «' + v.name + '» из вашего аккаунта ElevenLabs?', { ok: 'Удалить', danger: true })) return; try { await Store.deleteVoice(v.id); toast('Голос удалён'); if (selected && selected.id === v.id) selected = null; loadVoices(true); } catch (e) { toast(e.message, 6000); } };
    return card;
  }
  function renderVoices() {
    const box = $('#voiceList'); box.innerHTML = '';
    const mine = voices.filter(v => v.category === 'cloned' || v.category === 'generated');
    const female = voices.filter(v => v.category === 'premade' && v.gender === 'female').slice(0, 5);
    const male = voices.filter(v => v.category === 'premade' && v.gender === 'male').slice(0, 5);
    const used = new Set(mine.concat(female, male).map(v => v.id));
    const others = voices.filter(v => !used.has(v.id));
    [['Ваши голоса', mine], ['Женские', female], ['Мужские', male]].forEach(([title, list]) => {
      if (!list.length) return; box.appendChild(el('div', 'voice-group', esc(title))); const g = el('div', 'voice-grid'); list.forEach(v => g.appendChild(voiceCard(v))); box.appendChild(g);
    });
    if (others.length) { const d = el('details', 'adv'); d.innerHTML = '<summary>Ещё голоса из вашей библиотеки (' + others.length + ')</summary>'; const g = el('div', 'voice-grid'); g.style.marginTop = '10px'; others.forEach(v => g.appendChild(voiceCard(v))); d.appendChild(g); box.appendChild(d); }
    if (!voices.length) box.innerHTML = '<div class="muted">Голоса не загрузились. Проверьте ключ ElevenLabs в «Настройках».</div>';
    if (!selected && voices.length) selected = male.find(v => /George/i.test(v.name)) || male[0] || female[0] || voices[0];
    paintSelected();
    if (usage && usage.character_limit) {
      const left = Math.max(0, (usage.character_limit || 0) - (usage.character_count || 0));
      $('#audioUsage').innerHTML = 'ElevenLabs: тариф <b>' + esc(usage.tier || '?') + '</b> · осталось <b>' + fmtNum(left) + '</b> из ' + fmtNum(usage.character_limit) + ' знаков' + (usage.can_use_instant_voice_cloning ? '' : ' · <span style="color:#b7791f">клонирование голоса на этом тарифе недоступно</span>');
    } else $('#audioUsage').textContent = '';
  }
  async function loadVoices(refresh) {
    if (!direct) return;
    $('#voiceList').innerHTML = '<div class="muted">Загружаю голоса…</div>';
    try { const r = await Store.listVoices(refresh); voices = r.voices || []; usage = r.usage || null; renderVoices(); }
    catch (e) { $('#voiceList').innerHTML = '<div class="error">' + esc(e.message) + '</div>'; }
  }
  function showScript(text, target) { scriptTarget = target; $('#audScript').value = text; $('#audScriptStep').classList.remove('hidden'); $('#audScriptStep').scrollIntoView({ behavior: 'smooth', block: 'start' }); updateCost(text.length); refreshHandoff(); }
  function updateCost(n) {
    const lim = usage && usage.character_limit ? usage.character_limit : 0;
    $('#audStatus').textContent = n ? fmtNum(n) + ' знаков' + (lim ? ' ≈ ' + Math.max(1, Math.round(n / lim * 100)) + '% месячного лимита' : '') : '';
  }
  function recordTitle(text, target) {
    const ho = target && target.handoff; if (ho && ho.title) return ho.title;
    const ch = chapterOf(target, target && target.text);
    const plain = text.replace(/\[[^\]]*\]|<break[^>]*>/g, '').replace(/\s+/g, ' ').replace(/^[«"'“„\s]+/, '').trim();
    return (ch.title || (target && target.label) || 'Озвучка') + ': «' + plain.slice(0, 50) + (plain.length > 50 ? '…' : '') + '»';
  }
  async function confirmLength(n) { if (n <= 6000) return true; return ask('Текст длинный: ' + fmtNum(n) + ' знаков. Озвучка потратит заметную часть месячного лимита ElevenLabs. Продолжить?', { ok: 'Продолжить' }); }
  function tooLongForHandoff(n) { if (handoff && n > HANDOFF_MAX) { toast('Для озвучки выберите фрагмент до 20 000 знаков: это почти весь месячный лимит ElevenLabs.', 6000); return true; } return false; }
  if (handoff) {
    // claude.ai: интонации расставляет Claude по подписке, читает мастерская
    $('#voiceList').closest('.step').classList.add('hidden'); $('#audGallery').closest('.step').classList.add('hidden');
    $('#audSpeakBtn').classList.add('hidden'); $('#audHandoff').classList.remove('hidden');
    const ai = $('#audModeInfo'); ai.innerHTML = 'Здесь Claude расставляет интонации по вашей подписке. Читает ElevenLabs в мастерской: она откроется в новой вкладке, там выберите голос и нажмите «Озвучить». Записи хранятся в мастерской.'; ai.classList.remove('hidden');
    refreshHandoff = handoffLink($('#audHandoff'), () => {
      const text = $('#audScript').value.trim(); const ch = chapterOf(scriptTarget, scriptTarget && scriptTarget.text);
      return { v: 1, kind: 'speak', text, manner: manner.get(), chapter_id: ch.id, chapter_title: ch.title, title: recordTitle(text, scriptTarget), claudeUrl: (window.CONFIG || {}).claudeUrl || '' };
    });
    $('#audHandoff').addEventListener('click', e => { const n = $('#audScript').value.trim().length; if (!n) { e.preventDefault(); toast('Текст пустой'); } else if (tooLongForHandoff(n)) e.preventDefault(); });
    renumberSteps($('#sec-audio'));
  }
  $('#audScript').addEventListener('input', () => { updateCost($('#audScript').value.length); refreshHandoff(); });
  $('#audPrepBtn').onclick = async () => {
    if (mk === 'none') { toast(MEDIA_OFF, 6000); return; }
    const target = tp.get(); if (!target) return;
    if (tooLongForHandoff(target.text.length)) return;
    if (!await confirmLength(target.text.length)) return;
    const btn = $('#audPrepBtn'); btn.disabled = true; $('#audPrepStatus').textContent = 'Расставляю интонации…';
    try { const script = await llmText(P.narrationScript({ text: target.text, manner: manner.get(), model: getSettings().elevenModel }), { bare: true }); showScript(script.trim(), target); $('#audPrepStatus').textContent = ''; }
    catch (e) { $('#audPrepStatus').textContent = ''; toast(friendly(e), 6000); }
    btn.disabled = false;
  };
  $('#audSkipBtn').onclick = async () => {
    if (mk === 'none') { toast(MEDIA_OFF, 6000); return; }
    const target = tp.get(); if (!target) return;
    if (tooLongForHandoff(target.text.length)) return;
    if (!await confirmLength(target.text.length)) return; showScript(target.text.trim(), target);
  };
  $('#audSpeakBtn').onclick = async () => {
    if (!direct) { toast(MEDIA_OFF, 6000); return; }
    if (!selected) { toast('Сначала выберите голос'); return; }
    const text = $('#audScript').value.trim(); if (!text) { toast('Текст пустой'); return; }
    const ch = chapterOf(scriptTarget, scriptTarget && scriptTarget.text);
    const body = { voice_id: selected.id, voice_name: String(selected.name).split(' - ')[0], text, model_id: getSettings().elevenModel, manner: manner.get(), chapter_id: ch.id, chapter_title: ch.title, title: recordTitle(text, scriptTarget) };
    const btn = $('#audSpeakBtn'); btn.disabled = true; $('#audStatus').textContent = 'Озвучиваю… примерно ' + Math.max(10, Math.round(text.length / 60)) + ' секунд';
    try {
      const row = await Store.tts(body);
      $('#audResult').innerHTML = ''; $('#audResult').appendChild(audioItem(row, true)); $('#audResult').scrollIntoView({ behavior: 'smooth', block: 'start' });
      $('#audStatus').textContent = 'Готово — запись сохранена'; renderAudioGallery(); refreshAssets(); loadVoices(true);
    } catch (e) { $('#audStatus').textContent = ''; toast(e.message || String(e), 8000); }
    btn.disabled = false;
  };
  function audioItem(row, fresh) {
    const it = el('div', 'audio-item');
    it.innerHTML = '<div><b>' + esc(row.title || 'Озвучка') + '</b><div class="muted small">голос: ' + esc(row.voice_name || '') + ' · ' + fmtNum(row.chars || 0) + ' знаков · ' + esc(row.model_id || '') + ' · ' + fmtDate(row.ts) + '</div></div>' +
      '<audio controls preload="metadata" src="' + esc(row.url) + '"></audio>' +
      '<div class="btns"><a class="btn-sm" href="' + esc(row.url) + '" download="' + esc(safeName(row.title || 'озвучка') + '.mp3') + '">Скачать mp3</a>' + (row.text ? '<button type="button" class="btn-sm b-text">Текст</button>' : '') + '<button type="button" class="btn-sm b-del" style="color:#c0392b">Удалить</button></div><div class="preview hidden"></div>';
    const bt = $('.b-text', it); if (bt) bt.onclick = () => { const pv = $('.preview', it); pv.textContent = row.text; pv.classList.toggle('hidden'); };
    $('.b-del', it).onclick = async () => { if (!await ask('Удалить эту запись?', { ok: 'Удалить', danger: true })) return; try { await Store.deleteAudio(row.id); } catch (e) { toast('Не удалось удалить: ' + e.message); return; } it.remove(); renderAudioGallery(); refreshAssets(); };
    if (fresh) { const a = $('audio', it); a.autoplay = true; }
    return it;
  }
  async function renderAudioGallery() {
    if (!direct) return;
    let rows; try { rows = await Store.listAudio(); } catch (e) { $('#audGallery').innerHTML = '<div class="error">' + esc(e.message) + '</div>'; return; }
    assetsMem.audio = rows;
    $('#audStats').textContent = rows.length ? '— ' + rows.length + ' ' + plural(rows.length, 'запись', 'записи', 'записей') : '— пока пусто';
    const g = $('#audGallery'); g.innerHTML = ''; rows.forEach(r => g.appendChild(audioItem(r, false)));
  }
  $('#voiceCreate').onclick = async () => {
    if (!direct) return;
    const files = Array.from($('#voiceFiles').files || []); const name = $('#voiceName').value.trim() || 'Мой голос';
    if (!files.length) { toast('Выберите аудиофайл с записью голоса'); return; }
    if (usage && usage.can_use_instant_voice_cloning === false) { if (!await ask('На вашем тарифе ElevenLabs клонирование голоса недоступно — запрос, скорее всего, будет отклонён. Всё равно попробовать?', { ok: 'Попробовать' })) return; }
    const btn = $('#voiceCreate'); btn.disabled = true; $('#voiceStatus').textContent = 'Загружаю запись и создаю голос… около минуты';
    try {
      const r = await Store.addVoice({ name, files, description: 'Голос автора' + (book.title ? ' книги «' + book.title + '»' : '') });
      $('#voiceStatus').textContent = 'Голос создан'; toast('Голос «' + name + '» создан');
      await loadVoices(true); const v = voices.find(x => x.id === r.voice_id); if (v) { selected = v; paintSelected(); }
    } catch (e) { $('#voiceStatus').textContent = ''; toast(e.message || String(e), 8000); }
    btn.disabled = false;
  };
  audUI = { manner, showScript };
  if (direct) { loadVoices(false); renderAudioGallery(); }
}

// ---- приём задания со страницы claude.ai (мастерская)
async function receiveHandoff() {
  const h = location.hash || ''; if (h.indexOf('#wa=') !== 0) return;
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* адрес не меняем */ }
  if (Store.mediaKind() !== 'direct') { toast(MEDIA_OFF, 6000); return; }
  let obj; try { obj = await unpackHandoff(h.slice(4)); } catch (e) { toast('Не удалось прочитать задание из ссылки. Нажмите кнопку на странице claude.ai ещё раз.', 7000); return; }
  if (!obj || obj.v !== 1) return;
  let changed = false;
  if (obj.claudeUrl && settingsMem.claudeUrl !== obj.claudeUrl) { settingsMem.claudeUrl = obj.claudeUrl; changed = true; }
  if (settingsMem.textHome !== 'claude') { settingsMem.textHome = 'claude'; changed = true; setTimeout(() => toast('Тексты теперь готовит Claude на странице claude.ai, а здесь рисуются картинки и озвучивается текст. Изменить можно в «Настройках».', 8000), 400); }
  if (changed) { Store.saveSettings(settingsMem); applyTextHome(); }
  if (obj.kind === 'draw' && imgUI) {
    showSection('images');
    if (obj.style) imgUI.styles.set(obj.style); if (obj.aspect) imgUI.aspect.set(obj.aspect);
    $('#imgCount').value = ['1', '2', '4'].indexOf(String(obj.count)) >= 0 ? String(obj.count) : '2';
    $('#imgCaption').value = obj.caption || ''; $('#imgPrompt').value = obj.prompt || '';
    imgUI.setCurrent({ handoff: obj });
    $('#imgPromptStep').classList.remove('hidden');
    $('#imgStatus').textContent = 'Задание пришло со страницы claude.ai. Проверьте и нажмите «Нарисовать».';
    setTimeout(() => $('#imgPromptStep').scrollIntoView({ behavior: 'smooth', block: 'start' }), 350);
  } else if (obj.kind === 'speak' && audUI) {
    showSection('audio');
    if (obj.manner) audUI.manner.set(obj.manner);
    audUI.showScript(String(obj.text || ''), { handoff: obj });
    setTimeout(() => { $('#audStatus').textContent = 'Текст пришёл со страницы claude.ai. Выберите голос выше и нажмите «Озвучить». ' + $('#audStatus').textContent; $('#audScriptStep').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 350);
  }
}

// ================= старт =================
async function init() {
  $('#sidebarFoot').textContent = 'Загружаю…';
  let st;
  try { st = await Store.init(); }
  catch (e) {
    console.error(e); Store.mode = 'local';
    toast('Не удалось связаться с базой данных (' + e.message + '). Данные будут храниться в браузере.', 6000);
    st = { book: load(LS.book, null), settings: load(LS.settings, {}), notes: load(LS.notes, []), chat: load(LS.chat, []) };
  }
  book = st.book || deepCopy(window.BOOK_DEFAULT || { title: '', series: '', author: '', chapters: [] });
  if (!book.chapters) book.chapters = [];
  settingsMem = st.settings || {}; notes = st.notes || []; chat = st.chat || [];
  assetsMem = { images: st.images || [], audio: st.audio || [] }; kvMem = st.kv || {};
  if (st.empty && Store.mode === 'cloud') {
    // Облачное хранилище пустое: владелец страницы получает исходную рукопись из book.json
    let owner = false; try { owner = Store.user ? await Store.user.isOwner() : false; } catch (e) { owner = false; }
    if (owner) { const src = await originalBook(); if (src && src.chapters && src.chapters.length) { book = src; Store.saveBook(book); } }
  }
  if (!book.about) {
    // описание книги раньше было зашито в код; теперь оно хранится вместе с рукописью
    let src = window.BOOK_DEFAULT || null;
    if (!src && Store.mode === 'cloud') { try { src = await originalBook(); } catch (e) { src = null; } }
    if (src && src.about && src.title && src.title === book.title) { book.about = src.about; Store.saveBook(book); }
  }
  $$('[data-modes]').forEach(e => e.classList.toggle('hidden', String(e.dataset.modes).split(' ').indexOf(Store.mode) < 0));
  const webUrl = (window.CONFIG || {}).webUrl;
  if (Store.mode === 'cloud' && webUrl) { const h = $('#webHint'); h.innerHTML = '🎨🎧 <b>Иллюстрации и озвучка.</b> Задание для художника и разметку интонаций Claude готовит здесь, по вашей подписке. Рисует и читает мастерская: <a href="' + esc(webUrl) + '" target="_blank" rel="noopener">' + esc(webUrl) + '</a>. Ключи Google и ElevenLabs хранятся там.'; h.classList.remove('hidden'); }
  initNav(); initReview(); initStructure(); initTranslate(); initBlurb(); initPromo(); initLetters(); initImages(); initAudio(); initChat(); initManuscript(); initMemory(); initHistory(); initSettings();
  renderBookDependent(); updateKeyState(); showSection('home');
  applyTextHome();
  receiveHandoff();
  window.addEventListener('hashchange', () => { receiveHandoff(); });
}
window.__wa = { md: md, mdToPlain: mdToPlain, splitText: splitText, chunkByBytes: chunkByBytes, bytesOf: bytesOf, Engine: Engine, getBook: () => book, getSettings: getSettings, getNotes: () => notes, Store: Store, LocalDB: LocalDB, importBackup: (o) => importBackup(o), packHandoff: packHandoff, unpackHandoff: unpackHandoff, handoffUrl: handoffUrl };
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
