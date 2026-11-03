/* V Studio — "Từ điển phát âm" (pronunciation dictionary): rules that rewrite
   names, jargon and abbreviations before synthesis. Backend: v_studio/lexicon.py
   (/api/lexicon…), applied server-side by /api/tts. Uses app.js internals
   exported as window.VStudio. */
'use strict';
(() => {
  const V = window.VStudio;
  if (!V) return;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = V.esc;

  const X = { rules: [], enabled: true, max: 2000, saveTimer: null, pending: false, previewTimer: null, preview: null, filter: '' };
  let _k = 0;
  const withKey = (r) => ({ src: '', dst: '', word: true, case: false, on: true, ...r, _k: 'r' + (++_k) });
  const payload = () => ({
    enabled: X.enabled,
    rules: X.rules.filter(r => r.src.trim()).map(({ src, dst, word, case: c, on }) => ({ src: src.trim(), dst: dst.trim(), word, case: c, on })),
  });

  // ── persistence ──────────────────────────────────────────────────────────
  async function load() {
    try {
      const j = await V.apiJson('/api/lexicon');
      X.rules = j.rules.map(withKey); X.enabled = j.enabled; X.max = j.max;
      $('#lexEnabled').checked = X.enabled; $('#lexPath').textContent = j.path;
      render(); schedulePreview(0);
    } catch (e) { V.toast('Không mở được từ điển phát âm: ' + e.message, true); }
  }
  function markDirty() {
    X.pending = true; $('#lexSaved').textContent = 'Đang lưu…';
    clearTimeout(X.saveTimer); X.saveTimer = setTimeout(save, 500);
    renderCount(); markDupes(); schedulePreview();
  }
  async function save() {
    clearTimeout(X.saveTimer);
    try {
      await V.apiJson('/api/lexicon', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
      X.pending = false; $('#lexSaved').textContent = 'Đã lưu';
    } catch (e) { $('#lexSaved').textContent = 'Chưa lưu được'; V.toast(e.message, true); }
  }
  window.addEventListener('pagehide', () => {
    if (!X.pending) return;
    try { fetch('/api/lexicon', { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) }); } catch { /* */ }
  });

  // ── table ────────────────────────────────────────────────────────────────
  const visible = (r) => !X.filter || (r.src + ' ' + r.dst).toLowerCase().includes(X.filter);
  function rowHtml(r) {
    return `<tr data-k="${r._k}"${r.on ? '' : ' class="off"'}>
      <td><input class="lx" data-f="src" value="${esc(r.src)}" maxlength="200" placeholder="VD: VieNeu" aria-label="Từ hoặc cách viết"></td>
      <td><input class="lx" data-f="dst" value="${esc(r.dst)}" maxlength="200" placeholder="VD: Vi Neu" aria-label="Đọc là"></td>
      <td class="c"><input type="checkbox" data-f="word" ${r.word ? 'checked' : ''} aria-label="Cả từ"></td>
      <td class="c"><input type="checkbox" data-f="case" ${r.case ? 'checked' : ''} aria-label="Phân biệt hoa thường"></td>
      <td class="c"><input type="checkbox" data-f="on" ${r.on ? 'checked' : ''} aria-label="Bật luật"></td>
      <td class="c"><button class="btn ghost small danger" data-act="del" type="button" title="Xoá luật">✕</button></td></tr>`;
  }
  function render() {
    const rows = X.rules.filter(visible);
    $('#lexRows').innerHTML = rows.map(rowHtml).join('');
    const empty = $('#lexEmpty');
    if (!X.rules.length) {
      empty.hidden = false;
      empty.innerHTML = 'Chưa có luật nào. Bấm “Thêm luật”, ví dụ: <code>VieNeu</code> → <code>Vi Neu</code>, <code>TP.HCM</code> → <code>Thành phố Hồ Chí Minh</code>.';
    } else if (!rows.length) { empty.hidden = false; empty.textContent = 'Không có luật nào khớp.'; }
    else empty.hidden = true;
    renderCount(); markDupes();
  }
  function renderCount() {
    const n = X.rules.filter(r => r.src.trim()).length, on = X.rules.filter(r => r.src.trim() && r.on).length;
    $('#lexCount').textContent = `${n} luật${n !== on ? ` · ${on} đang bật` : ''} · tối đa ${X.max.toLocaleString('vi-VN')}`;
  }
  function markDupes() {   // the same source twice: only the first one ever applies
    const seen = new Map();
    for (const r of X.rules) {
      const k = r.case ? r.src.trim() : r.src.trim().toLowerCase();
      const tr = $(`#lexRows tr[data-k="${r._k}"]`);
      const dup = !!k && seen.has(k);
      if (k && !dup) seen.set(k, r);
      if (tr) { tr.classList.toggle('dup', dup); tr.title = dup ? 'Trùng với một luật phía trên — luật này sẽ không được dùng.' : ''; }
    }
  }
  const ruleOf = (el) => X.rules.find(r => r._k === el.closest('tr')?.dataset.k);
  function addRule(r = {}, focus = true) {
    if (X.rules.length >= X.max) { V.toast(`Tối đa ${X.max} luật.`, true); return; }
    if (X.filter) { X.filter = ''; $('#lexFilter').value = ''; }
    const rule = withKey(r);
    X.rules.unshift(rule); render();
    if (focus) $(`#lexRows tr[data-k="${rule._k}"] input[data-f="src"]`)?.focus();
  }

  // ── import / export ──────────────────────────────────────────────────────
  // One rule per line: "từ = cách đọc" (also tab, "→", "->", ",", ";"); "#" starts a comment line.
  // Our own export is tab-separated with an optional third column of flags.
  const HEADER = /^(từ|tu|word|src|from|source)$/i;
  function parseRules(text) {
    const out = [];
    for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
      const line = raw.trim(); if (!line || line.startsWith('#')) continue;
      let src, dst, flags = '';
      if (raw.includes('\t')) [src, dst = '', flags = ''] = raw.split('\t').map(x => x.trim());
      else { const m = /^(.+?)\s*(?:=|→|->|,|;)\s*(.*)$/.exec(line); if (!m) continue; [, src, dst] = m; }
      const unq = (x) => x.replace(/^"(.*)"$/, '$1').trim();
      src = unq(src); dst = unq(dst);
      if (!src || (!out.length && HEADER.test(src))) continue;
      const f = flags.toLowerCase();
      out.push({ src, dst, word: !f.includes('không-cả-từ'), case: f.includes('hoa-thường'), on: !f.includes('tắt') });
    }
    return out;
  }
  async function importFile(f) {
    let added = 0, updated = 0;
    try {
      const rules = parseRules(await f.text());
      if (!rules.length) { V.toast('Không tìm thấy luật nào (mỗi dòng: từ = cách đọc).', true); return; }
      for (const r of rules) {
        const ex = X.rules.find(x => x.src.trim() === r.src);
        if (ex) { Object.assign(ex, { dst: r.dst, word: r.word, case: r.case, on: r.on }); updated++; }
        else if (X.rules.length < X.max) { X.rules.push(withKey(r)); added++; }
      }
      render(); markDirty();
      V.toast(`Đã nhập ${added} luật mới${updated ? `, cập nhật ${updated} luật` : ''}.`);
    } catch (e) { V.toast(e.message, true); }
  }
  async function exportFile() {
    const rules = payload().rules;
    if (!rules.length) { V.toast('Chưa có luật nào để xuất.', true); return; }
    const flags = (r) => [!r.word && 'không-cả-từ', r.case && 'hoa-thường', !r.on && 'tắt'].filter(Boolean).join(',');
    const text = '# V Studio — từ điển phát âm. Mỗi dòng: từ<TAB>cách đọc[<TAB>tuỳ chọn]\n' +
      rules.map(r => [r.src, r.dst, flags(r)].filter((x, i) => i < 2 || x).join('\t')).join('\n') + '\n';
    try {
      const fd = new FormData(); fd.append('file', new Blob([text], { type: 'text/plain' }), 'tu-dien-phat-am.txt');
      const { id } = await V.apiJson('/api/stash', { method: 'POST', body: fd });
      const r = await V.nativeApi().save_stash(id, 'tu-dien-phat-am.txt');
      if (r?.ok) V.toast('Đã lưu: ' + r.path); else if (!r?.cancelled) V.toast(r?.error || 'Không lưu được', true);
    } catch (e) { V.toast(e.message, true); }
  }

  // ── try it ───────────────────────────────────────────────────────────────
  function schedulePreview(ms = 300) { clearTimeout(X.previewTimer); X.previewTimer = setTimeout(runPreview, ms); }
  async function runPreview() {
    const text = $('#lexTry').value;
    if (!text.trim()) { $('#lexTryOut').textContent = ''; $('#lexTrySpoken').textContent = ''; X.preview = null; return; }
    try {
      const j = await V.apiJson('/api/lexicon/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, rules: payload().rules, enabled: X.enabled }) });
      X.preview = j.text;
      $('#lexTryOut').innerHTML = j.text === text ? `${esc(j.text)} <span class="muted small">(không đổi)</span>` : esc(j.text);
      $('#lexTrySpoken').textContent = j.spoken || '';
    } catch (e) { $('#lexTryOut').textContent = e.message; }
  }
  function speak() {
    const text = (X.preview ?? $('#lexTry').value).trim(); if (!text) return;
    const voice = $('#lexVoice').value;
    // The text already went through the (possibly unsaved) rules, so tell the server not to apply them again.
    V.runJob(null, (j) => V.speak({ text, voice, stream: true, lexicon: false, kind: 'Nghe thử', title: 'Từ điển: ' + text.slice(0, 80), ephemeral: true, j }));
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  function init() {
    if (!$('#tab-lex')) return;
    $('#lexAdd').onclick = () => addRule();
    $('#lexEnabled').onchange = (e) => { X.enabled = e.target.checked; markDirty(); };
    $('#lexFilter').addEventListener('input', (e) => { X.filter = e.target.value.trim().toLowerCase(); render(); });
    $('#lexImport').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
    $('#lexExport').onclick = exportFile;
    const rows = $('#lexRows');
    rows.addEventListener('input', (e) => {
      const r = ruleOf(e.target), f = e.target.dataset.f; if (!r || !f) return;
      if (e.target.type === 'checkbox') { r[f] = e.target.checked; if (f === 'on') e.target.closest('tr').classList.toggle('off', !r.on); }
      else r[f] = e.target.value;
      markDirty();
    });
    rows.addEventListener('keydown', (e) => {   // Enter in the last field adds the next rule
      if (e.key === 'Enter' && e.target.dataset.f === 'dst') { e.preventDefault(); addRule(); }
      else if (e.key === 'Enter' && e.target.dataset.f === 'src') { e.preventDefault(); e.target.closest('tr').querySelector('[data-f="dst"]').focus(); }
    });
    rows.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act="del"]'); if (!b) return;
      const r = ruleOf(b); if (!r) return;
      X.rules = X.rules.filter(x => x !== r); render(); markDirty();
    });
    $('#lexTry').addEventListener('input', () => schedulePreview());
    $('#lexSpeak').onclick = speak;
    $('.tab[data-tab="lex"]')?.addEventListener('click', () => schedulePreview(0));
    load();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
