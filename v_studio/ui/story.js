/* V Studio — "Phòng thu Truyện" (story studio): build a multi-voice story
   segment by segment, regenerate only what changed, export one seamless file.
   Backend: v_studio/stories.py (/api/stories…). Uses app.js internals
   exported as window.VStudio (synth, runJob, addHistory, …). */
'use strict';
(() => {
  const V = window.VStudio;
  if (!V) return;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = V.esc, fmtSec = V.fmtSec;

  const COLORS = ['#0d8a68', '#3b82f6', '#d97706', '#c2413b', '#8b5cf6', '#db2777', '#0891b2', '#65a30d'];
  const NARRATOR = 'Người kể';
  const NARRATOR_RE = /^(người kể|người dẫn|người dẫn truyện|dẫn truyện|lời kể|narrator)$/i;
  const LABEL = { none: 'Chưa tạo', doing: 'Đang tạo…', done: 'Đã tạo', error: 'Lỗi', stale: 'Đã sửa – cần tạo lại', empty: 'Trống' };
  const AUDIO_KEYS = ['audio', 'duration', 'sr', 'gen'];

  const ST = {
    list: [], proj: null, dirty: false, saveTimer: null, saving: null,
    genId: null, job: false, playing: null, audio: new Audio(),
    drag: null, drop: null, importMode: 'append',
  };
  const uid = () => Math.random().toString(36).slice(2, 10);
  const ready = () => !!V.S.status?.loaded && !V.S.status?.loading && !V.S.busy;
  const base = (p = ST.proj) => `/api/stories/${encodeURIComponent(p.id)}`;

  // ── model helpers ────────────────────────────────────────────────────────
  const charById = (id, p = ST.proj) => p?.characters.find(c => c.id === id);
  const charOf = (seg) => charById(seg.char) || ST.proj.characters[0];
  function segStatus(s) {
    if (ST.genId === s.id) return 'doing';
    const c = charOf(s), g = s.gen;
    if (s.audio && g && g.text === s.text && g.char === s.char && (g.voice || '') === (c?.voice || '')) return 'done';
    if (!s.text.trim()) return 'empty';
    if (s.error) return 'error';
    return s.audio ? 'stale' : 'none';
  }
  const pendingSegs = () => ST.proj.segments.filter(s => s.text.trim() && segStatus(s) !== 'done');
  function voicePool() {
    const vs = V.S.voices || [];
    const ordered = vs.filter(v => v.featured && !v.user).concat(vs.filter(v => !v.featured && !v.user), vs.filter(v => v.user));
    const fem = ordered.filter(v => v.gender === 'female'), mal = ordered.filter(v => v.gender !== 'female');
    const pool = [];
    for (let i = 0; i < Math.max(fem.length, mal.length); i++) { if (fem[i]) pool.push(fem[i].id); if (mal[i]) pool.push(mal[i].id); }
    return pool;
  }
  function pickVoice(exclude = []) {
    const used = new Set((ST.proj?.characters || []).map(c => c.voice).concat(exclude));
    const pool = voicePool();
    return pool.find(v => !used.has(v)) || pool[(ST.proj?.characters.length || 0) % (pool.length || 1)] || '';
  }
  function pickColor() {
    const used = new Set((ST.proj?.characters || []).map(c => c.color));
    return COLORS.find(c => !used.has(c)) || COLORS[(ST.proj?.characters.length || 0) % COLORS.length];
  }
  const hasVoice = (id) => (V.S.voices || []).some(v => v.id === id);

  // ── persistence ──────────────────────────────────────────────────────────
  function payload(p) {
    return { name: p.name, pause: p.pause, characters: p.characters,
      segments: p.segments.map(s => ({ id: s.id, char: s.char, text: s.text, error: s.error || '' })) };
  }
  function markDirty() {
    if (!ST.proj) return;
    ST.dirty = true; $('#storySaved').textContent = 'Đang lưu…';
    clearTimeout(ST.saveTimer); ST.saveTimer = setTimeout(() => save().catch(() => {}), 500);
  }
  function mergeAudio(p, server) {
    // Audio metadata is owned by the server; never let an older response undo a newer upload.
    const byId = new Map(server.segments.map(s => [s.id, s]));
    for (const s of p.segments) {
      const r = byId.get(s.id);
      if (!r?.audio || (s.gen?.at || 0) > (r.gen?.at || 0)) continue;
      AUDIO_KEYS.forEach(k => { if (k in r) s[k] = r[k]; });
    }
  }
  async function save() {
    clearTimeout(ST.saveTimer);
    const p = ST.proj; if (!p) return;
    while (ST.saving) await ST.saving.catch(() => {});
    if (!ST.dirty || ST.proj !== p) return;
    ST.dirty = false;
    ST.saving = V.apiJson(base(p), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(p)) })
      .then((res) => { mergeAudio(p, res); if (ST.proj === p) { $('#storySaved').textContent = 'Đã lưu'; } })
      .catch((e) => { ST.dirty = true; if (ST.proj === p) $('#storySaved').textContent = 'Chưa lưu được'; V.toast('Không lưu được truyện: ' + e.message, true); throw e; })
      .finally(() => { ST.saving = null; });
    return ST.saving;
  }
  window.addEventListener('pagehide', () => {
    if (ST.proj && ST.dirty) {
      try { fetch(base(), { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload(ST.proj)) }); } catch { /* */ }
    }
  });

  // ── project list ─────────────────────────────────────────────────────────
  async function loadList() {
    try {
      const j = await V.apiJson('/api/stories');
      ST.list = j.stories; $('#storyDir').textContent = j.dir ? '· ' + j.dir : '';
    } catch (e) { ST.list = []; V.toast(e.message, true); }
    renderList();
  }
  function renderList() {
    const ul = $('#storyProjects');
    if (!ST.list.length) { ul.innerHTML = '<li class="muted small">Chưa có truyện nào — bấm “＋ Truyện mới” để bắt đầu.</li>'; return; }
    ul.innerHTML = ST.list.map(s => {
      const t = s.updated ? new Date(s.updated * 1000) : null;
      const when = t ? `${t.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })} ${t.toLocaleDateString('vi-VN')}` : '';
      return `<li class="item" data-id="${esc(s.id)}">
        <div class="grow"><div class="title">${esc(s.name || 'Không tên')}</div>
        <div class="meta">${s.segments} đoạn · ${s.done}/${s.spoken ?? s.segments} đã tạo · ${s.characters} nhân vật · ${fmtSec(s.duration || 0)}${when ? ' · sửa lúc ' + when : ''}</div></div>
        <button class="btn ghost small" data-act="open" type="button">Mở</button>
        <button class="btn ghost small danger" data-act="del" type="button">Xoá</button></li>`;
    }).join('');
  }
  async function newProject() {
    const names = new Set(ST.list.map(s => s.name));
    let name = 'Truyện mới', n = 2; while (names.has(name)) name = `Truyện mới ${n++}`;
    const narrator = { id: uid(), name: NARRATOR, voice: V.S.defaultVoice || voicePool()[0] || '', color: COLORS[0] };
    try {
      const p = await V.apiJson('/api/stories', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, pause: 0.4, characters: [narrator], segments: [{ id: uid(), char: narrator.id, text: '' }] }) });
      openProject(p);
      setTimeout(() => { $('#storyName').focus(); $('#storyName').select(); }, 0);
    } catch (e) { V.toast(e.message, true); }
  }
  async function openProject(pOrId) {
    try {
      const p = typeof pOrId === 'string' ? await V.apiJson('/api/stories/' + encodeURIComponent(pOrId)) : pOrId;
      p.segments.forEach(s => { s.text = s.text || ''; s.error = s.error || ''; });
      ST.proj = p; ST.dirty = false; V.store.set('story.open', p.id);
      $('#storyListView').hidden = true; $('#storyEditor').hidden = false;
      $('#storyName').value = p.name; $('#storySaved').textContent = '';
      V.sliderControl($('#storyPauseWrap'), { label: 'Khoảng lặng giữa các đoạn (giây)', min: 0, max: 3, step: 0.1, value: p.pause ?? 0.4,
        unit: 'Chèn giữa các đoạn khi xuất file. Lưu riêng cho từng truyện.', onChange: (v) => { p.pause = v; markDirty(); renderSummary(); } });
      ensureVoices();
      renderChars(); renderSegs();
    } catch (e) {
      V.store.set('story.open', null); V.toast(e.message, true); showList();
    }
  }
  async function showList() {
    if (ST.job) { V.toast('Đang tạo giọng — hãy dừng trước.', true); return; }
    if (ST.proj && ST.dirty) await save().catch(() => {});
    stopPlayback();
    ST.proj = null; V.store.set('story.open', null);
    $('#storyEditor').hidden = true; $('#storyListView').hidden = false;
    loadList();
  }
  function confirmClick(btn, label, fn) {
    if (btn.dataset.confirm !== '1') {
      const old = btn.textContent; btn.dataset.confirm = '1'; btn.textContent = label;
      setTimeout(() => { if (btn.isConnected) { btn.dataset.confirm = ''; btn.textContent = old; } }, 3000);
      return;
    }
    fn();
  }
  async function deleteProject(id) {
    try {
      await V.apiJson('/api/stories/' + encodeURIComponent(id), { method: 'DELETE' });
      V.toast('Đã xoá truyện');
      if (ST.proj?.id === id) { ST.dirty = false; ST.proj = null; V.store.set('story.open', null); $('#storyEditor').hidden = true; $('#storyListView').hidden = false; }
      loadList();
    } catch (e) { V.toast(e.message, true); }
  }

  // ── characters ───────────────────────────────────────────────────────────
  function ensureVoices() {
    // Characters created before a model was loaded get a voice once voices exist.
    const p = ST.proj; if (!p || !(V.S.voices || []).length) return;
    let changed = false;
    p.characters.forEach((c, i) => {
      if (!c.voice) { c.voice = i === 0 && V.S.defaultVoice && !p.characters.some(o => o.voice === V.S.defaultVoice) ? V.S.defaultVoice : pickVoice(); changed = true; }
    });
    if (changed) markDirty();
  }
  function fillCharVoice(sel, c) {
    if (!(V.S.voices || []).length) {
      sel.innerHTML = `<option value="${esc(c.voice)}">${c.voice ? esc(c.voice) : 'Tải mô hình để chọn giọng'}</option>`;
      return;
    }
    V.fillVoiceSelect(sel, c.voice);
    if (c.voice && !hasVoice(c.voice)) {
      sel.insertAdjacentHTML('afterbegin', `<option value="${esc(c.voice)}">⚠ ${esc(c.voice)} (không có trong mô hình này)</option>`);
      sel.value = c.voice;
    }
  }
  function renderChars() {
    const p = ST.proj, ul = $('#storyChars');
    const counts = {}; p.segments.forEach(s => { counts[s.char] = (counts[s.char] || 0) + 1; });
    ul.innerHTML = p.characters.map(c => `<li class="item story-char" data-id="${esc(c.id)}" style="--c:${esc(c.color)}">
      <button class="char-color" type="button" data-act="color" title="Đổi màu" aria-label="Đổi màu nhân vật ${esc(c.name)}"></button>
      <input class="char-name" maxlength="60" value="${esc(c.name)}" aria-label="Tên nhân vật">
      <select class="char-voice voice-select" aria-label="Giọng của ${esc(c.name)}"></select>
      <span class="muted small char-count">${counts[c.id] || 0} đoạn</span>
      <button class="btn ghost small" type="button" data-act="preview" title="Nghe thử giọng" aria-label="Nghe thử giọng của ${esc(c.name)}">▶</button>
      <button class="btn ghost small danger" type="button" data-act="del" title="Xoá nhân vật" aria-label="Xoá nhân vật ${esc(c.name)}">✕</button></li>`).join('');
    $$('li', ul).forEach(li => fillCharVoice($('select', li), charById(li.dataset.id)));
    updateControls();
  }
  function addChar() {
    const p = ST.proj, n = p.characters.length + 1;
    const c = { id: uid(), name: `Nhân vật ${n}`, voice: pickVoice(), color: pickColor() };
    p.characters.push(c); markDirty(); renderChars(); renderSegs();
    const inp = $(`#storyChars li[data-id="${c.id}"] .char-name`); inp?.focus(); inp?.select();
  }
  function removeChar(id, btn) {
    const p = ST.proj;
    if (p.characters.length <= 1) { V.toast('Truyện cần ít nhất một nhân vật.', true); return; }
    const used = p.segments.filter(s => s.char === id);
    const go = () => {
      p.characters = p.characters.filter(c => c.id !== id);
      const fallback = p.characters.find(c => NARRATOR_RE.test(c.name)) || p.characters[0];
      used.forEach(s => { s.char = fallback.id; });
      markDirty(); renderChars(); renderSegs();
      if (used.length) V.toast(`${used.length} đoạn chuyển sang “${fallback.name}” (cần tạo lại).`);
    };
    if (used.length) confirmClick(btn, `Xoá? (${used.length} đoạn)`, go); else go();
  }
  async function previewChar(c) {
    if (!ready()) { V.toast(V.S.busy ? 'Đang bận tạo âm thanh khác.' : 'Hãy tải mô hình trước.', true); return; }
    V.runJob($('#storyStop'), async (j) => {
      V.setStatus(`Đang tạo câu nghe thử giọng ${c.voice}…`);
      const r = await V.synth({ text: `Xin chào, mình là ${c.name}. Đây là giọng của mình trong truyện.`, voice: c.voice, stream: false, signal: j.ctrl.signal });
      stopPlayback();
      const url = URL.createObjectURL(V.encodeWav(r.pcm, r.sr));
      ST.audio.src = url; ST.audio.play().catch(() => {});
      V.setStatus(`Nghe thử: ${c.name} · ${c.voice}`, 'ok');
    });
  }

  // ── segments ─────────────────────────────────────────────────────────────
  function charOptions(sel) {
    return ST.proj.characters.map(c => `<option value="${esc(c.id)}"${c.id === sel ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  function segHtml(s, i) {
    const c = charOf(s), st = segStatus(s), n = i + 1;
    return `<li class="story-seg" data-id="${esc(s.id)}" data-status="${st}" style="--c:${esc(c.color)}">
      <div class="seg-top">
        <button class="seg-handle" type="button" title="Kéo để sắp xếp (hoặc Alt + ↑/↓)" aria-label="Sắp xếp đoạn ${n} (Alt + mũi tên lên/xuống)">⠿</button>
        <span class="seg-no">${n}</span>
        <select class="seg-char" aria-label="Nhân vật của đoạn ${n}">${charOptions(s.char)}</select>
        <span class="seg-status">${LABEL[st]}</span>
        <span class="seg-dur muted small">${s.audio && s.duration ? fmtSec(s.duration) : ''}</span>
        <span class="spacer"></span>
        <button class="btn ghost small" type="button" data-act="up" title="Chuyển lên" aria-label="Chuyển đoạn ${n} lên"${i === 0 ? ' disabled' : ''}>▲</button>
        <button class="btn ghost small" type="button" data-act="down" title="Chuyển xuống" aria-label="Chuyển đoạn ${n} xuống"${i === ST.proj.segments.length - 1 ? ' disabled' : ''}>▼</button>
        <button class="btn ghost small" type="button" data-act="play" title="Nghe đoạn này" aria-label="Nghe đoạn ${n}"${s.audio ? '' : ' disabled'}>${ST.playing === s.id ? '■' : '▶'}</button>
        <button class="btn small seg-gen" type="button" data-act="gen">${s.audio ? 'Tạo lại' : 'Tạo giọng'}</button>
        <button class="btn ghost small" type="button" data-act="insert" title="Chèn đoạn mới bên dưới" aria-label="Chèn đoạn mới dưới đoạn ${n}">＋</button>
        <button class="btn ghost small danger" type="button" data-act="del" title="Xoá đoạn" aria-label="Xoá đoạn ${n}">✕</button>
      </div>
      <textarea class="seg-text" rows="2" aria-label="Lời đoạn ${n}" placeholder="Nhập lời cho đoạn này…">${esc(s.text)}</textarea>
      <div class="seg-err small"${st === 'error' ? '' : ' hidden'}>${esc(s.error || '')}</div>
    </li>`;
  }
  function autosize(ta) { if (!ta.offsetParent) return; ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 320) + 'px'; }
  function renderSegs() {
    const p = ST.proj, ol = $('#storySegs');
    ol.innerHTML = p.segments.length ? p.segments.map(segHtml).join('') : '<li class="muted small story-empty">Chưa có đoạn nào — thêm đoạn hoặc nhập kịch bản.</li>';
    $$('.seg-text', ol).forEach(autosize);
    renderSummary(); updateControls();
  }
  function updateRow(s) {
    const li = $(`#storySegs li[data-id="${s.id}"]`); if (!li) return;
    const st = segStatus(s), c = charOf(s);
    li.dataset.status = st; li.style.setProperty('--c', c.color);
    $('.seg-status', li).textContent = LABEL[st];
    $('.seg-dur', li).textContent = s.audio && s.duration ? fmtSec(s.duration) : '';
    const play = $('[data-act=play]', li); play.disabled = !s.audio; play.textContent = ST.playing === s.id ? '■' : '▶';
    $('.seg-gen', li).textContent = s.audio ? 'Tạo lại' : 'Tạo giọng';
    const err = $('.seg-err', li); err.hidden = st !== 'error'; err.textContent = s.error || '';
    if ($('.seg-char', li).value !== s.char) $('.seg-char', li).value = s.char;
  }
  function renderSummary() {
    const p = ST.proj; if (!p) return;
    const segs = p.segments, done = segs.filter(s => segStatus(s) === 'done'), pend = pendingSegs();
    const withAudio = segs.filter(s => s.audio && s.text.trim());
    const total = withAudio.reduce((a, s) => a + (s.duration || 0), 0) + Math.max(0, withAudio.length - 1) * (p.pause || 0);
    $('#storySummary').textContent = `${segs.length} đoạn · ${done.length} đã tạo${pend.length ? ` · ${pend.length} cần tạo` : ''} · tổng ≈ ${fmtSec(total)}`;
    $('#storyGenAll').textContent = pend.length ? `Tạo các đoạn chưa có (${pend.length})` : 'Đã tạo đủ các đoạn';
    $('#storyExportHint').textContent = pend.length && segs.some(s => s.text.trim())
      ? `Còn ${pend.length} đoạn chưa tạo hoặc cần tạo lại — “Xuất file truyện” sẽ tạo chúng trước rồi ghép.`
      : (segs.some(s => s.text.trim()) ? 'Ghép các đoạn theo thứ tự (kèm khoảng lặng) vào khung “Kết quả” để nghe và tải xuống.' : '');
    const counts = {}; segs.forEach(s => { counts[s.char] = (counts[s.char] || 0) + 1; });
    $$('#storyChars li').forEach(li => { const el = $('.char-count', li); if (el) el.textContent = `${counts[li.dataset.id] || 0} đoạn`; });
  }
  function updateControls() {
    if (!ST.proj) return;
    const r = ready(), pend = pendingSegs().length, any = ST.proj.segments.some(s => s.text.trim());
    $('#storyGenAll').disabled = !r || !pend;
    $('#storyExport').disabled = V.S.busy || !any || (pend > 0 && !r);
    $$('#storySegs .seg-gen').forEach(b => {
      const s = ST.proj.segments.find(x => x.id === b.closest('li').dataset.id);
      b.disabled = !r || !s?.text.trim();
    });
    $$('#storyChars [data-act=preview]').forEach(b => { b.disabled = !r; });
    $('#storyBack').disabled = ST.job; $('#storyDelete').disabled = ST.job;
  }
  function newSeg(char) { return { id: uid(), char, text: '', error: '' }; }
  function insertSeg(at, char) {
    const p = ST.proj, s = newSeg(char || p.segments[at - 1]?.char || p.characters[0].id);
    p.segments.splice(at, 0, s); markDirty(); renderSegs();
    $(`#storySegs li[data-id="${s.id}"] .seg-text`)?.focus();
  }
  function moveSeg(id, to) {
    const p = ST.proj, from = p.segments.findIndex(s => s.id === id);
    if (from < 0 || to < 0 || to >= p.segments.length || from === to) return false;
    const [s] = p.segments.splice(from, 1); p.segments.splice(to, 0, s);
    markDirty(); renderSegs(); return true;
  }
  function deleteSeg(s, btn) {
    const go = () => {
      const p = ST.proj; if (ST.playing === s.id) stopPlayback();
      p.segments = p.segments.filter(x => x !== s); markDirty(); renderSegs(); renderChars();
    };
    if (s.audio || s.text.trim()) confirmClick(btn, 'Xoá?', go); else go();
  }

  // ── playback ─────────────────────────────────────────────────────────────
  function stopPlayback() {
    const was = ST.playing; ST.playing = null;
    try { ST.audio.pause(); } catch { /* */ }
    const s = was && ST.proj?.segments.find(x => x.id === was); if (s) updateRow(s);
  }
  function playSeg(s) {
    if (ST.playing === s.id) { stopPlayback(); return; }
    stopPlayback();
    ST.audio.src = `${base()}/segments/${encodeURIComponent(s.id)}/audio?v=${encodeURIComponent(s.gen?.at || 0)}`;
    ST.playing = s.id; updateRow(s);
    ST.audio.play().catch((e) => {
      if (e.name === 'AbortError' || ST.playing !== s.id) return;   // replaced by another play / pause
      V.toast('Không phát được: ' + e.message, true); stopPlayback();
    });
  }
  ST.audio.addEventListener('ended', stopPlayback);

  // ── generation ───────────────────────────────────────────────────────────
  async function genOne(p, s, j) {
    const c = charById(s.char, p) || p.characters[0];
    const sig = { text: s.text, char: s.char, voice: c.voice || '' };
    ST.genId = s.id; updateRow(s);
    $(`#storySegs li[data-id="${s.id}"]`)?.scrollIntoView({ block: 'nearest' });
    try {
      if (ST.dirty || ST.saving) { ST.dirty = true; await save(); }   // the server must know the segment
      const r = await V.synth({ text: sig.text.trim(), voice: sig.voice, stream: false, signal: j.ctrl.signal });
      if (!r.pcm.length) throw new Error('Không tạo được âm thanh (văn bản rỗng sau khi chuẩn hoá?)');
      const fd = new FormData();
      fd.append('file', V.encodeWav(r.pcm, r.sr), 'segment.wav');
      fd.append('gen', JSON.stringify(sig));
      const res = await V.apiJson(`${base(p)}/segments/${encodeURIComponent(s.id)}/audio`, { method: 'PUT', body: fd });
      AUDIO_KEYS.forEach(k => { if (k in res) s[k] = res[k]; });
      s.error = '';
      return r;
    } catch (e) {
      if (!(j.stopped || e.name === 'AbortError')) { s.error = e.message; markDirty(); }
      throw e;
    } finally {
      ST.genId = null;
      if (ST.proj === p) { updateRow(s); renderSummary(); updateControls(); }
    }
  }
  function prog(frac, text) {
    const el = $('#storyProgress'); el.hidden = false;
    $('i', el).style.width = `${Math.round(frac * 100)}%`; $('span', el).textContent = text;
  }
  async function genPending(p, j) {
    const todo = p.segments.filter(s => s.text.trim() && segStatus(s) !== 'done');
    let ok = 0, fail = 0;
    for (let i = 0; i < todo.length; i++) {
      if (j.stopped) throw new DOMException('stop', 'AbortError');
      const s = todo[i];
      if (!p.segments.includes(s) || !s.text.trim() || segStatus(s) === 'done') continue;
      const idx = p.segments.indexOf(s) + 1, c = charById(s.char, p);
      prog(i / todo.length, `${i + 1}/${todo.length} · đoạn ${idx} · ${c?.name || ''}: ${s.text.trim().slice(0, 60)}`);
      V.setStatus(`Đang tạo đoạn ${idx} (${i + 1}/${todo.length})…`);
      try { await genOne(p, s, j); ok++; } catch (e) { if (j.stopped || e.name === 'AbortError') throw e; fail++; }
    }
    return { ok, fail, total: todo.length };
  }
  function runStory(fn) {
    if (V.S.busy) { V.toast('Đang bận tạo âm thanh khác.', true); return; }
    ST.job = true; updateControls();
    V.runJob($('#storyStop'), async (j) => {
      try { await fn(j); } finally {
        ST.job = false; ST.genId = null;
        setTimeout(() => { $('#storyProgress').hidden = true; }, 1500);
      }
    }).finally(() => { ST.job = false; if (ST.proj) { renderSummary(); updateControls(); } });
  }
  function genSegment(s) {
    if (!ready()) { V.toast(V.S.busy ? 'Đang bận tạo âm thanh khác.' : 'Hãy tải mô hình trước.', true); return; }
    if (!s.text.trim()) { V.toast('Đoạn này chưa có lời.', true); return; }
    const p = ST.proj;
    runStory(async (j) => {
      const idx = p.segments.indexOf(s) + 1;
      V.setStatus(`Đang tạo đoạn ${idx}…`);
      await genOne(p, s, j);
      V.setStatus(`Đã tạo đoạn ${idx} · ${fmtSec(s.duration || 0)}.`, 'ok');
      if (ST.proj === p && $('#tab-story') && !$('#tab-story').hidden) playSeg(s);
    });
  }
  function genAll() {
    if (!ready()) { V.toast(V.S.busy ? 'Đang bận tạo âm thanh khác.' : 'Hãy tải mô hình trước.', true); return; }
    const p = ST.proj;
    runStory(async (j) => {
      const r = await genPending(p, j);
      prog(1, r.fail ? `Xong · ${r.fail} đoạn lỗi` : 'Hoàn tất');
      if (r.fail) V.setStatus(`Đã tạo ${r.ok} đoạn, ${r.fail} đoạn lỗi — xem dòng báo lỗi ở từng đoạn.`, 'err');
      else V.setStatus(`Đã tạo ${r.ok} đoạn.`, 'ok');
    });
  }
  function exportStory() {
    const p = ST.proj;
    if (!p.segments.some(s => s.text.trim())) { V.toast('Truyện chưa có đoạn nào.', true); return; }
    if (pendingSegs().length && !ready()) { V.toast('Còn đoạn chưa tạo — hãy tải mô hình trước.', true); return; }
    runStory(async (j) => {
      if (pendingSegs().length) {
        const r = await genPending(p, j);
        if (r.fail) throw new Error(`${r.fail} đoạn tạo lỗi — sửa rồi thử lại.`);
      }
      if (ST.dirty || ST.saving) { ST.dirty = true; await save(); }
      prog(1, 'Đang ghép các đoạn…'); V.setStatus('Đang ghép các đoạn thành một file…');
      const fd = new FormData(); fd.append('sample_rate', String(V.S.params.sample_rate || 0));
      const res = await V.api(`${base(p)}/export`, { method: 'POST', body: fd, signal: j.ctrl.signal });
      const sr = +res.headers.get('X-Sample-Rate') || 48000, nSeg = +res.headers.get('X-Segments') || 0;
      const pcm = V.int16ToF32(new Uint8Array(await res.arrayBuffer()));
      const names = [...new Set(p.segments.filter(s => s.text.trim()).map(s => charById(s.char, p)?.name).filter(Boolean))];
      V.addHistory({ pcm, sr, elapsed: null, kind: 'Truyện', voice: p.name,
        title: `${p.name} — ${nSeg} đoạn · ${names.join(', ')}`.slice(0, 120) });
      prog(1, 'Hoàn tất');
      V.setStatus(`Đã xuất “${p.name}” · ${nSeg} đoạn · ${fmtSec(pcm.length / sr)}. Dùng “Tải xuống” để lưu file.`, 'ok');
      $('#output')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  }

  // ── import ───────────────────────────────────────────────────────────────
  function parseStory(src) {
    const out = [];
    for (const raw of src.replace(/\r\n?/g, '\n').split('\n')) {
      const line = raw.trim(); if (!line) continue;
      const m = /^([^:：]{1,40})[:：]\s*(.*)$/.exec(line);
      if (m && !/[.!?…"“”]/.test(m[1])) out.push({ speaker: m[1].trim(), text: m[2].trim() });
      else out.push({ speaker: null, text: line });
    }
    return out.filter(l => l.text);
  }
  function importScript() {
    const p = ST.proj, lines = parseStory($('#storyImportText').value);
    if (!lines.length) { V.toast('Kịch bản trống (định dạng: Nhân vật: lời thoại).', true); return; }
    const narrator = () => {
      let c = p.characters.find(x => NARRATOR_RE.test(x.name));
      if (!c) { c = { id: uid(), name: NARRATOR, voice: pickVoice(), color: pickColor() }; p.characters.unshift(c); added++; }
      return c;
    };
    let added = 0;
    const find = (name) => {
      if (!name || NARRATOR_RE.test(name)) return narrator();
      let c = p.characters.find(x => x.name.trim().toLowerCase() === name.toLowerCase());
      if (!c) { c = { id: uid(), name, voice: pickVoice(), color: pickColor() }; p.characters.push(c); added++; }
      return c;
    };
    const segs = lines.map(l => ({ id: uid(), char: find(l.speaker).id, text: l.text, error: '' }));
    const replaceAll = ST.importMode === 'replace' || (p.segments.length === 1 && !p.segments[0].text.trim() && !p.segments[0].audio);
    if (replaceAll) { stopPlayback(); p.segments = segs; } else p.segments.push(...segs);
    markDirty(); renderChars(); renderSegs();
    $('#storyImportText').value = ''; toggleImport(false);
    V.toast(`Đã nhập ${segs.length} đoạn${added ? ` · ${added} nhân vật mới` : ''}.`);
  }
  function toggleImport(show) {
    const box = $('#storyImport'); box.hidden = !show;
    $('#storyImportToggle').setAttribute('aria-expanded', String(show));
    if (show) $('#storyImportText').focus();
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  function init() {
    if (!$('#tab-story')) return;
    $('#storyNew').onclick = newProject;
    $('#storyProjects').addEventListener('click', (e) => {
      const li = e.target.closest('li.item'); if (!li) return;
      const btn = e.target.closest('button');
      if (btn?.dataset.act === 'del') { confirmClick(btn, 'Bấm lần nữa để xoá', () => deleteProject(li.dataset.id)); return; }
      if (!btn || btn.dataset.act === 'open') openProject(li.dataset.id);
    });
    $('#storyBack').onclick = showList;
    $('#storyDelete').onclick = (e) => { if (!ST.job && ST.proj) confirmClick(e.currentTarget, 'Bấm lần nữa để xoá', () => deleteProject(ST.proj.id)); };
    $('#storyName').addEventListener('input', (e) => { if (ST.proj) { ST.proj.name = e.target.value; markDirty(); } });
    $('#storyName').addEventListener('change', (e) => { if (ST.proj && !e.target.value.trim()) { e.target.value = ST.proj.name = 'Truyện mới'; markDirty(); } });

    // characters
    $('#storyAddChar').onclick = addChar;
    const chars = $('#storyChars');
    chars.addEventListener('click', (e) => {
      const btn = e.target.closest('button'); if (!btn) return;
      const c = charById(btn.closest('li').dataset.id); if (!c) return;
      if (btn.dataset.act === 'color') {
        c.color = COLORS[(COLORS.indexOf(c.color) + 1) % COLORS.length];
        btn.closest('li').style.setProperty('--c', c.color);
        ST.proj.segments.filter(s => s.char === c.id).forEach(updateRow); markDirty();
      }
      if (btn.dataset.act === 'del') removeChar(c.id, btn);
      if (btn.dataset.act === 'preview') previewChar(c);
    });
    chars.addEventListener('input', (e) => {
      if (!e.target.classList.contains('char-name')) return;
      const c = charById(e.target.closest('li').dataset.id); if (!c) return;
      c.name = e.target.value;
      $$(`#storySegs .seg-char option[value="${c.id}"]`).forEach(o => { o.textContent = c.name || '…'; });
      markDirty();
    });
    chars.addEventListener('change', (e) => {
      const c = charById(e.target.closest('li')?.dataset.id); if (!c) return;
      if (e.target.classList.contains('char-name') && !e.target.value.trim()) { e.target.value = c.name = 'Nhân vật'; markDirty(); }
      if (e.target.classList.contains('char-voice')) {
        c.voice = e.target.value; markDirty();
        ST.proj.segments.filter(s => s.char === c.id).forEach(updateRow); renderSummary(); updateControls();
      }
    });

    // segments
    const ol = $('#storySegs');
    ol.addEventListener('input', (e) => {
      if (!e.target.classList.contains('seg-text')) return;
      const s = ST.proj.segments.find(x => x.id === e.target.closest('li').dataset.id); if (!s) return;
      s.text = e.target.value; s.error = ''; autosize(e.target);
      updateRow(s); renderSummary(); updateControls(); markDirty();
    });
    ol.addEventListener('change', (e) => {
      if (!e.target.classList.contains('seg-char')) return;
      const s = ST.proj.segments.find(x => x.id === e.target.closest('li').dataset.id); if (!s) return;
      s.char = e.target.value; s.error = '';
      updateRow(s); renderSummary(); updateControls(); markDirty();
    });
    ol.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]'); if (!btn) return;
      const li = btn.closest('li'), p = ST.proj, i = p.segments.findIndex(x => x.id === li.dataset.id), s = p.segments[i];
      if (!s) return;
      const act = btn.dataset.act;
      if (act === 'up' || act === 'down') {
        if (moveSeg(s.id, i + (act === 'up' ? -1 : 1))) {
          const nb = $(`#storySegs li[data-id="${s.id}"] [data-act="${act}"]`);
          (nb && !nb.disabled ? nb : $(`#storySegs li[data-id="${s.id}"] .seg-handle`))?.focus();
        }
      }
      if (act === 'play') playSeg(s);
      if (act === 'gen') genSegment(s);
      if (act === 'insert') insertSeg(i + 1, s.char);
      if (act === 'del') deleteSeg(s, btn);
    });
    ol.addEventListener('keydown', (e) => {
      if (!e.target.classList.contains('seg-handle') || !e.altKey || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
      e.preventDefault();
      const id = e.target.closest('li').dataset.id, i = ST.proj.segments.findIndex(x => x.id === id);
      if (moveSeg(id, i + (e.key === 'ArrowUp' ? -1 : 1))) $(`#storySegs li[data-id="${id}"] .seg-handle`)?.focus();
    });
    // drag & drop by the ⠿ handle
    const clearDrop = () => $$('#storySegs .drop-before, #storySegs .drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after'));
    ol.addEventListener('pointerdown', (e) => { const h = e.target.closest('.seg-handle'); if (h) h.closest('li').draggable = true; });
    ol.addEventListener('pointerup', () => { $$('#storySegs li[draggable="true"]').forEach(li => { if (!ST.drag) li.draggable = false; }); });
    ol.addEventListener('dragstart', (e) => {
      const li = e.target.closest?.('li.story-seg');
      if (!li || !li.draggable) { e.preventDefault(); return; }
      ST.drag = li.dataset.id; ST.drop = null;
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', li.dataset.id); } catch { /* */ }
      li.classList.add('dragging');
    });
    ol.addEventListener('dragover', (e) => {
      if (!ST.drag) return;
      e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const li = e.target.closest('li.story-seg'); if (!li) return;
      clearDrop();
      if (li.dataset.id === ST.drag) { ST.drop = null; return; }
      const r = li.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
      li.classList.add(after ? 'drop-after' : 'drop-before'); ST.drop = { id: li.dataset.id, after };
    });
    ol.addEventListener('drop', (e) => {
      if (!ST.drag) return;
      e.preventDefault();
      const p = ST.proj, d = ST.drop, id = ST.drag;
      if (d) {
        const from = p.segments.findIndex(s => s.id === id);
        let to = p.segments.findIndex(s => s.id === d.id) + (d.after ? 1 : 0);
        if (from < to) to--;
        moveSeg(id, to);
      }
    });
    ol.addEventListener('dragend', () => {
      clearDrop(); ST.drag = null; ST.drop = null;
      $$('#storySegs li').forEach(li => { li.draggable = false; li.classList.remove('dragging'); });
    });

    $('#storyAddSeg').onclick = () => insertSeg(ST.proj.segments.length, ST.proj.segments.at(-1)?.char);
    $('#storyImportToggle').onclick = () => toggleImport($('#storyImport').hidden);
    $('#storyImportCancel').onclick = () => toggleImport(false);
    $('#storyImportGo').onclick = importScript;
    $$('#storyImportMode button').forEach(b => b.addEventListener('click', () => {
      ST.importMode = b.dataset.v; $$('#storyImportMode button').forEach(x => x.classList.toggle('on', x === b));
    }));
    $('#storyGenAll').onclick = genAll;
    $('#storyExport').onclick = exportStory;

    // follow app state without touching app.js: voices list changes re-fill #readVoice;
    // busy / model state toggles #readGo.disabled (updateButtons).
    const rv = $('#readVoice');
    if (rv) new MutationObserver(() => { if (ST.proj) { ensureVoices(); renderChars(); ST.proj.segments.forEach(updateRow); renderSummary(); } }).observe(rv, { childList: true });
    const rg = $('#readGo');
    if (rg) new MutationObserver(() => updateControls()).observe(rg, { attributes: true, attributeFilter: ['disabled'] });
    $('.tab[data-tab="story"]')?.addEventListener('click', () => {
      if (!ST.proj) loadList(); else requestAnimationFrame(() => $$('#storySegs .seg-text').forEach(autosize));
    });

    // Used by the Podcast tab ("Sửa từng lượt trong Phòng thu Truyện"): save the open story first.
    V.openStory = async (p) => {
      if (ST.job) throw new Error('Phòng thu Truyện đang tạo giọng — hãy dừng trước.');
      if (ST.proj && ST.dirty) await save().catch(() => {});
      stopPlayback();
      await openProject(p);
    };

    const last = V.store.get('story.open', null);
    if (last) openProject(last); else loadList();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
