/* V Studio — "Nhạc nền": lay background music under the clip in the output
   panel (built-in synthesised tracks or the user's own), with ducking.
   Backend: v_studio/music.py (/api/music…, /api/mix). Uses app.js internals
   exported as window.VStudio. */
'use strict';
(() => {
  const V = window.VStudio;
  if (!V) return;
  const $ = (s, el = document) => el.querySelector(s);
  const esc = V.esc;

  const M = { tracks: [], busy: false };
  const cfg = {
    track: V.store.get('music.track', 'b-piano'), vol: V.store.get('music.vol', 30),
    intro: V.store.get('music.intro', 1.5), outro: V.store.get('music.outro', 2.5), duck: V.store.get('music.duck', true),
  };
  const set = (k, v) => { cfg[k] = v; V.store.set('music.' + k, v); };
  const current = () => M.tracks.find(t => t.id === $('#musicTrack').value);

  async function load(select) {
    try {
      M.tracks = (await V.apiJson('/api/music')).tracks;
      if (select) set('track', select);
      renderSelect();
    } catch (e) { $('#musicDesc').textContent = 'Không tải được danh sách nhạc: ' + e.message; }
  }
  function renderSelect() {
    const sel = $('#musicTrack');
    const groups = [['Có sẵn (tạo trên máy, không bản quyền)', M.tracks.filter(t => t.builtin)], ['Nhạc của bạn', M.tracks.filter(t => !t.builtin)]];
    sel.innerHTML = groups.filter(([, l]) => l.length).map(([g, l]) => `<optgroup label="${esc(g)}">${
      l.map(t => `<option value="${esc(t.id)}">${esc(t.name)}${t.builtin ? ' · ' + esc(t.mood) : ''}</option>`).join('')}</optgroup>`).join('');
    sel.value = M.tracks.some(t => t.id === cfg.track) ? cfg.track : (M.tracks[0]?.id || '');
    renderTrack(); updateBtn();
  }
  function renderTrack() {
    const t = current();
    $('#musicDesc').textContent = !t ? '' : t.builtin ? t.desc : `Nhạc của bạn${t.duration ? ' · ' + V.fmtSec(t.duration) : ''} · được lặp lại cho đủ độ dài`;
    $('#musicDel').hidden = !t || t.builtin;
  }

  // ── preview player ───────────────────────────────────────────────────────
  const audio = () => $('#musicAudio');
  function stopPreview() { const a = audio(); a.pause(); $('#musicPlay').textContent = '▶ Nghe nhạc'; }
  function togglePreview() {
    const a = audio(), t = current(); if (!t) return;
    if (!a.paused && a.dataset.id === t.id) { stopPreview(); return; }
    if (a.dataset.id !== t.id) { a.src = `/api/music/${encodeURIComponent(t.id)}/preview`; a.dataset.id = t.id; }
    a.volume = 0.8;
    $('#musicPlay').textContent = '■ Dừng nhạc';
    a.play().catch((e) => { stopPreview(); V.toast('Không phát được: ' + e.message, true); });
  }

  // ── mixing ───────────────────────────────────────────────────────────────
  function updateBtn() {
    const out = V.S.output;
    $('#musicMix').disabled = !out?.pcm || !current() || M.busy;
    $('#musicMix').textContent = M.busy ? 'Đang trộn…' : 'Trộn nhạc nền';
  }
  async function mixNow() {
    const t = current(), out = V.S.output;
    if (!t || !out?.pcm || M.busy) return;
    // Re-mixing a clip we mixed in this session starts again from its voice-only version.
    const dry = out.dry?.pcm ? out.dry : out;
    if (dry === out && (out.music || /· 🎵 /.test(out.title || ''))) V.toast('Bản này đã có nhạc nền — nhạc mới sẽ chồng lên nhạc cũ.', false, 5000);
    M.busy = true; updateBtn(); stopPreview();
    V.setStatus(`Đang trộn “${t.name}” vào bản đang mở…`);
    try {
      const fd = new FormData();
      fd.append('file', V.encodeWav(dry.pcm, dry.sr), 'voice.wav');
      fd.append('track', t.id); fd.append('volume', String(cfg.vol / 100)); fd.append('duck', cfg.duck ? 'true' : 'false');
      fd.append('intro', String(cfg.intro)); fd.append('outro', String(cfg.outro));
      const res = await V.api('/api/mix', { method: 'POST', body: fd });
      const sr = +res.headers.get('X-Sample-Rate') || dry.sr;
      const pcm = V.int16ToF32(new Uint8Array(await res.arrayBuffer()));
      const base = (dry.title || '').replace(/\s*· 🎵 .*$/, '');
      V.addHistory({ pcm, sr, elapsed: null, kind: dry.kind, voice: dry.voice,
        title: `${base} · 🎵 ${t.name}`, text: dry.text, music: t.name, dry: dry.pcm ? dry : null });
      $('#outAudio').play().catch(() => {});
      V.setStatus(`Đã trộn nhạc nền “${t.name}”.`, 'ok');
    } catch (e) { V.setStatus(e.message, 'err'); V.toast(e.message, true); }
    finally { M.busy = false; updateBtn(); }
  }

  // ── user tracks ──────────────────────────────────────────────────────────
  async function upload(f) {
    const fd = new FormData(); fd.append('file', f, f.name); fd.append('name', f.name.replace(/\.[^.]+$/, ''));
    $('#musicDesc').textContent = `Đang thêm ${f.name}…`;
    try { const t = await V.apiJson('/api/music', { method: 'POST', body: fd }); await load(t.id); V.toast(`Đã thêm “${t.name}”`); }
    catch (e) { V.toast(e.message, true); renderTrack(); }
  }
  function remove(btn) {
    const t = current(); if (!t || t.builtin) return;
    V.confirmClick(btn, 'Bấm lần nữa để xoá', async () => {
      try { await V.apiJson('/api/music/' + encodeURIComponent(t.id), { method: 'DELETE' }); stopPreview(); await load('b-piano'); V.toast(`Đã xoá “${t.name}”`); }
      catch (e) { V.toast(e.message, true); }
    });
  }

  function init() {
    const box = $('#musicBox'); if (!box) return;
    box.open = V.store.get('music.open', false);
    box.addEventListener('toggle', () => V.store.set('music.open', box.open));
    $('#musicTrack').addEventListener('change', (e) => { set('track', e.target.value); stopPreview(); renderTrack(); updateBtn(); });
    $('#musicPlay').onclick = togglePreview;
    audio().addEventListener('ended', stopPreview);
    $('#musicFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) upload(f); });
    $('#musicDel').onclick = (e) => remove(e.currentTarget);
    $('#musicDuck').checked = cfg.duck;
    $('#musicDuck').onchange = (e) => set('duck', e.target.checked);
    V.sliderControl($('#musicVolWrap'), { label: 'Âm lượng nhạc (%)', min: 0, max: 100, step: 1, value: cfg.vol,
      unit: 'So với giọng đọc. 20–40% thường vừa nghe.', onChange: (v) => set('vol', v) });
    V.sliderControl($('#musicIntroWrap'), { label: 'Dạo nhạc trước (giây)', min: 0, max: 10, step: 0.5, value: cfg.intro,
      unit: 'Nhạc chạy một mình trước khi giọng bắt đầu.', onChange: (v) => set('intro', v) });
    V.sliderControl($('#musicOutroWrap'), { label: 'Nhạc sau cùng (giây)', min: 0, max: 15, step: 0.5, value: cfg.outro,
      unit: 'Nhạc còn lại sau câu cuối rồi nhỏ dần.', onChange: (v) => set('outro', v) });
    $('#musicMix').onclick = mixNow;
    document.addEventListener('vs:output', updateBtn);
    load();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
