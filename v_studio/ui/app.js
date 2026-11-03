/* V Studio — front-end. Talks to the local API in server.py. */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('vieneu.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('vieneu.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};

// ── state ──────────────────────────────────────────────────────────────────
const S = {
  status: null,           // /api/status
  voices: [],             // /api/voices
  defaultVoice: null,
  params: {},             // per-mode params
  output: null,           // {pcm, sr, title, voice, ...}
  history: [],
  busy: false,
  refBlob: null,          // clone reference (WAV blob)
  refName: '',
  srtCues: [],
  convMap: store.get('convMap', {}),
};

// ── parameter specs ────────────────────────────────────────────────────────
const SPECS = {
  v3turbo: [
    { group: 'Lấy mẫu', items: [
      { k: 'temperature', label: 'Temperature', min: 0, max: 2, step: 0.05, def: 0.8, hint: 'Cao: biểu cảm, đa dạng hơn nhưng dễ lỗi. Thấp: ổn định hơn.' },
      { k: 'top_k', label: 'Top-k', min: 1, max: 1024, step: 1, def: 25, hint: 'Chỉ chọn trong k mã âm thanh có xác suất cao nhất.' },
      { k: 'top_p', label: 'Top-p', min: 0.05, max: 1, step: 0.01, def: 0.95, hint: 'Nucleus sampling — cắt phần đuôi xác suất thấp.' },
      { k: 'repetition_penalty', label: 'Phạt lặp', min: 1, max: 2, step: 0.05, def: 1.2, hint: 'Giảm hiện tượng lặp / kẹt âm.' },
      { k: 'repetition_window', label: 'Cửa sổ phạt lặp (frame)', min: 0, max: 256, step: 1, def: 64, hint: '25 frame ≈ 1 giây. 0 = phạt trên toàn bộ đoạn.' },
    ]},
    { group: 'Chia đoạn', items: [
      { k: 'max_chars', label: 'Số ký tự tối đa mỗi đoạn', min: 64, max: 512, step: 8, def: 256, hint: 'Văn bản dài được tách theo câu thành các đoạn ≤ giá trị này.' },
      { k: 'max_new_frames', label: 'Frame tối đa mỗi đoạn', min: 50, max: 1000, step: 10, def: 300, hint: 'Giới hạn độ dài âm thanh mỗi đoạn (300 frame ≈ 12 giây).' },
      { k: 'batch_size', label: 'Batch size (GPU)', min: 1, max: 64, step: 1, def: 32, hint: 'Số đoạn gộp vào một lượt chạy khi “Tạo trọn vẹn” trên GPU. Không có tác dụng trên CPU.' },
    ]},
    { group: 'Giọng tham chiếu', items: [
      { k: 'use_ref_codes', type: 'check', label: 'Dùng mã tham chiếu (reference codes)', def: true, hint: 'Tắt để chỉ dùng speaker embedding của giọng.' },
    ]},
  ],
  v3nano: [
    { group: 'Flow matching', items: [
      { k: 'steps', label: 'Số bước (Euler)', min: 1, max: 32, step: 1, def: 16, hint: '8 bước nhanh gấp ~2 lần nhưng thô hơn — nên đi kèm sway = −1.' },
      { k: 'cfg', label: 'CFG (guidance)', min: 0, max: 6, step: 0.1, def: 3, hint: '0 giảm một nửa tính toán nhưng giảm độ rõ.' },
      { k: 'sway', label: 'Sway', min: -1, max: 1, step: 0.1, def: 0, hint: 'Lịch thời gian của flow. −1 hợp với số bước ít.' },
      { k: 'speed', label: 'Tốc độ đọc', min: 0.5, max: 2, step: 0.05, def: 1, hint: '>1 nhanh hơn, <1 chậm hơn.' },
      { k: 'seed', type: 'number', label: 'Seed', def: '', hint: 'Để trống = ngẫu nhiên. Chỉ áp dụng khi “Tạo trọn vẹn”.' },
    ]},
    { group: 'Chia đoạn', items: [
      { k: 'max_chars', label: 'Số ký tự tối đa mỗi đoạn', min: 32, max: 300, step: 4, def: 140, hint: 'Nano được huấn luyện với câu ≤ 15 giây — nên giữ đoạn ngắn.' },
    ]},
  ],
  common: [
    { group: 'Âm thanh mẫu (nhân bản)', items: [
      { k: 'denoise', type: 'check', label: 'Khử nhiễu âm thanh mẫu', def: true, hint: 'Áp dụng cho tab Nhân bản giọng.', hidden: true },
    ]},
    { group: 'Đầu ra', items: [
      { k: 'sample_rate', type: 'select', label: 'Tần số lấy mẫu', def: 0, options: () => [[0, 'Gốc của mô hình']].concat((S.status?.out_rates || []).map(r => [r, `${r / 1000} kHz`])) },
      { k: 'format', type: 'select', label: 'Định dạng khi tải xuống', def: 'wav', options: () => (S.status?.formats || ['wav']).map(f => [f, f.toUpperCase()]) },
      { k: 'watermark', type: 'check', label: 'Đóng dấu watermark (Perth)', def: true, hint: '' },
    ]},
  ],
};
const mode = () => S.status?.mode || 'v3turbo';
const specsFor = (m) => SPECS[m].concat(SPECS.common);
function defaults(m) {
  const o = {};
  specsFor(m).forEach(g => g.items.forEach(it => { o[it.k] = it.def; }));
  return o;
}
function loadParams(m) { S.params = Object.assign(defaults(m), store.get('params.' + m, {})); }
function saveParams() { store.set('params.' + mode(), S.params); }

// ── helpers ────────────────────────────────────────────────────────────────
function toast(msg, err = false, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast._t); toast._t = setTimeout(() => { t.className = ''; }, ms);
}
const fmtSec = (s) => {
  if (!isFinite(s)) return '–';
  if (s < 60) return s.toFixed(1) + ' s';
  const m = Math.floor(s / 60); return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); msg = j.error || j.detail || msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res;
}
const apiJson = async (p, o) => (await api(p, o)).json();
/** Methods exposed by the app window (JsApi in __main__.py). */
function nativeApi() {
  const a = window.pywebview?.api;
  if (!a) throw new Error('Chức năng này chỉ có trong cửa sổ V Studio.');
  return a;
}

function encodeWav(f32, sr) {
  const n = f32.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0, o = 44; i < n; i++, o += 2) {
    const x = Math.max(-1, Math.min(1, f32[i]));
    v.setInt16(o, x < 0 ? x * 32768 : x * 32767, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
function concatF32(parts) {
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Float32Array(n);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function int16ToF32(bytes) {
  const n = bytes.byteLength >> 1, dv = new DataView(bytes.buffer, bytes.byteOffset, n * 2), out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = dv.getInt16(i * 2, true) / 32768;
  return out;
}
let _decodeCtx = null;
async function toWavBlob(blob, maxSec = 30) {
  try {
    _decodeCtx = _decodeCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ab = await _decodeCtx.decodeAudioData(await blob.arrayBuffer());
    const n = Math.min(ab.length, Math.floor(maxSec * ab.sampleRate)), mono = new Float32Array(n);
    for (let c = 0; c < ab.numberOfChannels; c++) {
      const d = ab.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / ab.numberOfChannels;
    }
    return { blob: encodeWav(mono, ab.sampleRate), seconds: n / ab.sampleRate };
  } catch (e) {
    return { blob, seconds: NaN };
  }
}

// ── live (streaming) player ────────────────────────────────────────────────
class LivePlayer {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC(); this.ctx.resume?.();
    this.t = 0; this.pending = []; this.pendingLen = 0; this.sources = []; this.started = 0; this.sr = 48000; this.stopped = false;
  }
  push(f32, sr) {
    if (this.stopped) return;
    this.sr = sr; this.pending.push(f32); this.pendingLen += f32.length;
    if (this.pendingLen >= sr * 0.12) this.flush();
  }
  flush() {
    if (!this.pendingLen || this.stopped) return;
    const data = concatF32(this.pending); this.pending = []; this.pendingLen = 0;
    const buf = this.ctx.createBuffer(1, data.length, this.sr);
    buf.copyToChannel ? buf.copyToChannel(data, 0) : buf.getChannelData(0).set(data);
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination);
    const now = this.ctx.currentTime;
    if (!this.started) { this.t = now + 0.25; this.started = this.t; }
    if (this.t < now + 0.02) this.t = now + 0.05;   // underrun: re-buffer a little
    src.start(this.t); this.t += buf.duration; this.sources.push(src);
  }
  get position() { return this.started ? Math.max(0, this.ctx.currentTime - this.started) : 0; }
  finish() {
    this.flush();
    const wait = Math.max(0, this.t - this.ctx.currentTime);
    return new Promise(r => setTimeout(r, wait * 1000 + 80)).then(() => this.close());
  }
  stop() { this.stopped = true; this.sources.forEach(s => { try { s.stop(); } catch { /* */ } }); this.close(); }
  close() { try { this.ctx.close(); } catch { /* */ } }
}

// ── synthesis call ─────────────────────────────────────────────────────────
function synthParams() {
  const p = { ...S.params };
  const out = {}; specsFor(mode()).forEach(g => g.items.forEach(it => { if (!['sample_rate', 'format', 'watermark'].includes(it.k)) out[it.k] = p[it.k]; }));
  return out;
}
/** POST /api/tts; returns {pcm, sr, elapsed, ttfa}. `onChunk(f32, sr, total)` gets audio as it arrives. */
async function synth({ text, voice, ref, stream, signal, onChunk, denoise, lexicon }) {
  const fd = new FormData();
  fd.append('text', text);
  fd.append('voice', voice || '');
  const params = synthParams();
  if (denoise !== undefined) params.denoise = denoise;
  fd.append('params', JSON.stringify(params));
  fd.append('stream', stream ? 'true' : 'false');
  fd.append('sample_rate', String(S.params.sample_rate || 0));
  fd.append('watermark', S.params.watermark ? 'true' : 'false');
  if (lexicon === false) fd.append('lexicon', 'false');   // text already went through the dictionary
  if (ref) fd.append('ref_audio', ref, 'reference.wav');
  const t0 = performance.now();
  const res = await api('/api/tts', { method: 'POST', body: fd, signal });
  const sr = +res.headers.get('X-Sample-Rate') || 48000;
  const reader = res.body.getReader();
  const parts = []; let carry = null, ttfa = null, total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let bytes = value;
    if (carry) { const b = new Uint8Array(carry.length + bytes.length); b.set(carry); b.set(bytes, carry.length); bytes = b; carry = null; }
    if (bytes.length & 1) { carry = bytes.slice(-1); bytes = bytes.subarray(0, bytes.length - 1); }
    if (!bytes.length) continue;
    const f = int16ToF32(bytes);
    if (ttfa === null) ttfa = (performance.now() - t0) / 1000;
    parts.push(f); total += f.length;
    onChunk?.(f, sr, total);
  }
  const elapsed = (performance.now() - t0) / 1000;
  return { pcm: concatF32(parts), sr, elapsed, ttfa: stream ? ttfa : null, serverElapsed: +res.headers.get('X-Elapsed') || null };
}

// ── output panel / waveform ────────────────────────────────────────────────
const wave = { canvas: null, peaks: null, progress: 0, livePcm: [], liveLen: 0, liveSr: 48000, live: null };
function computePeaks(f32, cols) {
  const peaks = new Float32Array(cols), step = Math.max(1, Math.floor(f32.length / cols));
  for (let c = 0; c < cols; c++) {
    let m = 0; const a = Math.floor(c * f32.length / cols), b = Math.min(f32.length, a + step);
    for (let i = a; i < b; i += 4) { const v = Math.abs(f32[i]); if (v > m) m = v; }
    peaks[c] = m;
  }
  return peaks;
}
function drawWave() {
  const cv = wave.canvas, dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
  const peaks = wave.peaks; if (!peaks) return;
  const css = getComputedStyle(document.documentElement);
  const off = css.getPropertyValue('--wave').trim(), on = css.getPropertyValue('--wave-on').trim();
  const bw = 3, gap = 1, cols = Math.floor(W / (bw + gap)), mid = H / 2;
  let max = 0.05; for (const p of peaks) if (p > max) max = p;
  for (let c = 0; c < cols; c++) {
    const p = peaks[Math.floor(c * peaks.length / cols)] || 0, h = Math.max(1.5, (p / max) * (H - 14) / 2);
    g.fillStyle = (c / cols) <= wave.progress ? on : off;
    g.fillRect(c * (bw + gap), mid - h, bw, h * 2);
  }
}
function setOutput(item, { autoplay = false } = {}) {
  S.output = item;
  $('#waveEmpty').hidden = true;
  wave.peaks = computePeaks(item.pcm, 600); wave.progress = 0; drawWave();
  const a = $('#outAudio');
  if (a._url) URL.revokeObjectURL(a._url);
  a._url = URL.createObjectURL(encodeWav(item.pcm, item.sr)); a.src = a._url;
  if (autoplay) a.play().catch(() => {});
  $('#outDownload').disabled = false;
  $('#outMeta').textContent = [item.kind, item.voice].filter(Boolean).join(' · ');
  renderStats(item);
  $$('#history li.item').forEach(li => li.classList.toggle('current', li.dataset.id === item.id));
  document.dispatchEvent(new CustomEvent('vs:output', { detail: item }));
}
function renderStats(it) {
  const dur = it.pcm.length / it.sr;
  const st = [['Thời lượng', fmtSec(dur)], ['Xử lý', it.elapsed ? fmtSec(it.elapsed) : '–'],
    ['RTF', it.elapsed && dur ? (it.elapsed / dur).toFixed(2) : '–'], ['Tần số', `${it.sr / 1000} kHz`]];
  if (it.ttfa) st.splice(2, 0, ['Âm thanh đầu tiên sau', `${Math.round(it.ttfa * 1000)} ms`]);
  $('#outStats').innerHTML = st.map(([k, v]) => `<span class="stat">${k}: <b>${v}</b></span>`).join('');
}
function setStatus(msg, cls = '') { const el = $('#outStatus'); el.textContent = msg || ''; el.className = 'status small ' + cls; }

function liveBegin() {
  wave.livePcm = []; wave.liveLen = 0; $('#waveEmpty').hidden = true; wave.progress = 0;
  const a = $('#outAudio'); a.pause();
}
function liveChunk(f32, sr) {
  wave.livePcm.push(f32); wave.liveLen += f32.length; wave.liveSr = sr;
  if (!liveChunk._raf) liveChunk._raf = requestAnimationFrame(() => {
    liveChunk._raf = null;
    wave.peaks = computePeaks(concatF32(wave.livePcm), 600);
    const pos = wave.live ? wave.live.position * wave.liveSr : 0;
    wave.progress = wave.liveLen ? Math.min(1, pos / wave.liveLen) : 0;
    drawWave();
    setStatus(`Đã tạo ${fmtSec(wave.liveLen / sr)} âm thanh…`);
  });
}

// ── library (history kept across launches; backend: library.py) ─────────────
const LIB = { q: '', kind: '', offset: 0, total: 0, info: null, autosave: store.get('libAutosave', true) };
const MAX_UNSAVED = 30, MAX_LOADED = 12;
let _hid = 0;
function addHistory(item) {
  item.id = 'h' + (++_hid); item.time = item.time || new Date(); item.touched = Date.now();
  S.history.unshift(item);
  const unsaved = S.history.filter(h => !h.libId && !h.saving);
  if (unsaved.length > MAX_UNSAVED) { const drop = new Set(unsaved.slice(MAX_UNSAVED)); S.history = S.history.filter(h => !drop.has(h)); }
  trimPcm();
  renderHistory(); setOutput(item);
  if (LIB.autosave && !item.ephemeral) libSave(item);   // quick previews stay out of the library
}
async function libSave(item) {
  if (item.libId || item.saving || !item.pcm) return;
  item.saving = true; renderHistory();
  try {
    const fd = new FormData();
    fd.append('file', encodeWav(item.pcm, item.sr), 'audio.wav');
    fd.append('meta', JSON.stringify({ title: item.title, kind: item.kind, voice: item.voice, text: item.text || item.title }));
    const r = await apiJson('/api/library', { method: 'POST', body: fd });
    item.libId = r.id;
    S.history = S.history.filter(h => h === item || h.libId !== r.id);   // a list reload may have raced us
    LIB.offset++; LIB.total++;
    libRefreshMeta();
  } catch (e) { toast('Không lưu được vào thư viện: ' + e.message, true); }
  finally { item.saving = false; renderHistory(); }
}
function libItem(r) {
  const ex = S.history.find(h => h.libId === r.id);
  if (ex) { ex.title = r.title; return ex; }
  return { id: 'L' + r.id, libId: r.id, title: r.title, kind: r.kind, voice: r.voice, text: r.text,
    duration: r.duration, sr: r.sr, time: new Date(r.created * 1000), pcm: null };
}
async function libLoad(reset = true) {
  const off = reset ? 0 : LIB.offset;
  const qs = new URLSearchParams({ q: LIB.q, kind: LIB.kind, offset: String(off), limit: '30' });
  const j = await apiJson('/api/library?' + qs);
  const items = j.items.map(libItem);
  if (reset) {
    const keep = (LIB.q || LIB.kind) ? [] : S.history.filter(h => !h.libId);
    S.history = keep.concat(items.filter(i => !keep.includes(i)));
  } else S.history = S.history.concat(items.filter(i => !S.history.includes(i)));
  LIB.offset = off + j.items.length; LIB.total = j.total; LIB.info = j;
  renderLibMeta(); renderHistory();
}
async function libRefreshMeta() {
  try {
    const j = await apiJson('/api/library?' + new URLSearchParams({ q: LIB.q, kind: LIB.kind, limit: '1' }));
    LIB.total = j.total; LIB.info = j; renderLibMeta();
  } catch { /* keep the old numbers */ }
}
const fmtBytes = (b) => b > 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b > 1e6 ? (b / 1e6).toFixed(0) + ' MB' : Math.ceil(b / 1e3) + ' KB';
function renderLibMeta() {
  const j = LIB.info; if (!j) return;
  $('#libStats').textContent = `${j.total.toLocaleString('vi-VN')} bản · ${fmtSec(j.duration)} · ${fmtBytes(j.bytes)}`;
  $('#libDir').textContent = j.dir;
  const sel = $('#libKind'), cur = sel.value;
  sel.innerHTML = '<option value="">Tất cả loại</option>' + j.kinds.map(k => `<option value="${esc(k)}">${esc(k)}</option>`).join('');
  sel.value = j.kinds.includes(cur) ? cur : '';
}
const fmtWhen = (d) => {
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
function renderHistory() {
  const ul = $('#history');
  if (!S.history.length) {
    ul.innerHTML = `<li class="muted small">${LIB.q || LIB.kind ? 'Không tìm thấy bản nào.' : 'Chưa có bản nào. Mọi bản bạn tạo sẽ được lưu ở đây.'}</li>`;
    $('#libMore').hidden = true; return;
  }
  ul.innerHTML = S.history.map(h => {
    const dur = h.pcm ? h.pcm.length / h.sr : h.duration;
    const state = h.libId ? '' : h.saving ? ' · đang lưu…' : ' · <span class="unsaved">chưa lưu</span>';
    return `<li class="item${S.output?.id === h.id ? ' current' : ''}" data-id="${h.id}">
    <button class="btn ghost small" data-act="play" title="Mở và phát">▶</button>
    <div class="grow"><div class="title" title="Nháy đúp để đổi tên">${esc(h.title)}</div>
    <div class="meta">${esc(h.kind || '')}${h.voice ? ' · ' + esc(h.voice) : ''} · ${fmtSec(dur)} · ${fmtWhen(h.time)}${state}</div></div>
    ${h.libId || h.saving ? '' : '<button class="btn ghost small" data-act="save" title="Lưu vào thư viện">Lưu</button>'}
    <button class="btn ghost small" data-act="dl" title="Tải xuống">⤓</button>
    <button class="btn ghost small" data-act="rm" title="Xoá">✕</button></li>`;
  }).join('');
  $('#libMore').hidden = LIB.offset >= LIB.total;
}
/** Library items are listed without their audio; fetch it on first use. */
async function ensurePcm(item) {
  item.touched = Date.now();
  if (item.pcm) return item;
  if (!item.libId) throw new Error('Bản này không còn âm thanh.');
  const res = await api(`/api/library/${item.libId}/audio`);
  item.sr = +res.headers.get('X-Sample-Rate') || item.sr;
  item.pcm = int16ToF32(new Uint8Array(await res.arrayBuffer()));
  trimPcm();
  return item;
}
function trimPcm() {   // keep memory bounded: saved items can always be re-fetched
  S.history.filter(h => h.pcm && h.libId && h !== S.output).sort((a, b) => b.touched - a.touched)
    .slice(MAX_LOADED).forEach(h => { h.duration = h.pcm.length / h.sr; h.pcm = null; });
}
function renameInline(titleEl, item) {
  const input = document.createElement('input');
  input.className = 'rename'; input.value = item.title; input.maxLength = 200;
  titleEl.replaceWith(input); input.focus(); input.select();
  let done = false;
  const finish = async (commit) => {
    if (done) return; done = true;
    const title = input.value.trim();
    if (commit && title && title !== item.title) {
      try {
        if (item.libId) await apiJson('/api/library/' + item.libId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
        item.title = title;
      } catch (e) { toast(e.message, true); }
    }
    renderHistory();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
  input.addEventListener('blur', () => finish(true));
}
function confirmClick(btn, label, fn) {
  if (btn.dataset.confirm === '1') { fn(); return; }
  const old = btn.textContent; btn.dataset.confirm = '1'; btn.textContent = label;
  setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = old; }, 3000);
}
function initLibrary() {
  const auto = $('#libAutosave'); auto.checked = LIB.autosave;
  auto.onchange = () => { LIB.autosave = auto.checked; store.set('libAutosave', auto.checked); if (auto.checked) S.history.filter(h => !h.libId && h.pcm).forEach(libSave); };
  let t; $('#libSearch').addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { LIB.q = e.target.value.trim(); libLoad().catch(err => toast(err.message, true)); }, 250); });
  $('#libKind').onchange = (e) => { LIB.kind = e.target.value; libLoad().catch(err => toast(err.message, true)); };
  $('#libMore').onclick = () => libLoad(false).catch(err => toast(err.message, true));
  $('#histClear').onclick = (e) => confirmClick(e.currentTarget, 'Bấm lần nữa để xoá tất cả', async () => {
    try { await apiJson('/api/library', { method: 'DELETE' }); } catch (err) { toast(err.message, true); return; }
    S.history = []; LIB.offset = 0; renderHistory(); libRefreshMeta(); toast('Đã xoá toàn bộ thư viện');
  });
  $('#history').addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const id = btn.closest('li').dataset.id, it = S.history.find(h => h.id === id); if (!it) return;
    try {
      if (btn.dataset.act === 'play') setOutput(await ensurePcm(it), { autoplay: true });
      if (btn.dataset.act === 'dl') downloadItem(await ensurePcm(it));
      if (btn.dataset.act === 'save') libSave(it);
      if (btn.dataset.act === 'rm') confirmClick(btn, 'Xoá?', async () => {
        if (it.libId) { await apiJson('/api/library/' + it.libId, { method: 'DELETE' }).catch(err => { toast(err.message, true); throw err; }); LIB.offset--; }
        S.history = S.history.filter(h => h !== it); renderHistory(); libRefreshMeta();
      });
    } catch (err) { toast(err.message, true); }
  });
  $('#history').addEventListener('dblclick', (e) => {
    const t = e.target.closest('.title'); if (!t) return;
    const it = S.history.find(h => h.id === t.closest('li').dataset.id); if (it) renameInline(t, it);
  });
  libLoad().catch(err => toast('Không mở được thư viện: ' + err.message, true));
}
async function downloadItem(item) {
  const fmt = S.params.format || 'wav';
  let blob = encodeWav(item.pcm, item.sr);
  try {
    if (fmt !== 'wav') {
      const fd = new FormData(); fd.append('file', blob, 'a.wav'); fd.append('format', fmt);
      blob = await (await api('/api/encode', { method: 'POST', body: fd })).blob();
    }
    const stamp = item.time.toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const safe = (item.voice || 'vieneu').replace(/[^\p{L}\p{N}_-]+/gu, '_');
    const name = `vieneu_${safe}_${stamp}.${fmt}`;
    const fd = new FormData(); fd.append('file', blob, name);
    const { id } = await apiJson('/api/stash', { method: 'POST', body: fd });
    const r = await nativeApi().save_stash(id, name);   // native "Save as" dialog
    if (r?.ok) toast('Đã lưu: ' + r.path); else if (!r?.cancelled) toast(r?.error || 'Không lưu được', true);
  } catch (e) { toast('Lỗi khi xuất file: ' + e.message, true); }
}

// ── voices ─────────────────────────────────────────────────────────────────
function voiceGroups() {
  const g = { featured: [], 'Bắc': [], 'Trung': [], 'Nam': [], other: [], user: [] };
  for (const v of S.voices) {
    if (v.user) g.user.push(v);
    else if (v.featured) g.featured.push(v);
    else if (g[v.region]) g[v.region].push(v);
    else g.other.push(v);
  }
  return [['⭐ Đề xuất', g.featured], ['Miền Bắc', g['Bắc']], ['Miền Trung', g['Trung']], ['Miền Nam', g['Nam']], ['Khác', g.other], ['Giọng của bạn', g.user]];
}
function fillVoiceSelect(sel, value) {
  const cur = value ?? sel.value;
  sel.innerHTML = voiceGroups().filter(([, l]) => l.length).map(([name, list]) =>
    `<optgroup label="${esc(name)}">${list.map(v => `<option value="${esc(v.id)}">${esc(v.id)}${v.description ? ' — ' + esc(v.description) : ''}</option>`).join('')}</optgroup>`).join('');
  const ids = S.voices.map(v => v.id);
  sel.value = ids.includes(cur) ? cur : (ids.includes(S.defaultVoice) ? S.defaultVoice : ids[0] || '');
}
async function refreshVoices() {
  if (!S.status?.loaded) { S.voices = []; return; }
  const j = await apiJson('/api/voices');
  S.voices = j.voices; S.defaultVoice = j.default;
  fillVoiceSelect($('#readVoice'), store.get('voice.' + mode(), null));
  fillVoiceSelect($('#srtVoice'));
  const lv = $('#lexVoice'); if (lv) fillVoiceSelect(lv, lv.value || $('#readVoice').value);
  renderSpeakers();
  renderUserVoices();
}
function renderUserVoices() {
  const ul = $('#userVoices'), list = S.voices.filter(v => v.user);
  if (!list.length) { ul.innerHTML = '<li class="muted small">Chưa có giọng nào.</li>'; return; }
  ul.innerHTML = list.map(v => `<li class="item" data-id="${esc(v.id)}"><div class="grow"><div class="title">${esc(v.id)}</div>
    <div class="meta">${esc(v.description || '')}</div></div>
    <button class="btn ghost small" data-act="use">Dùng để đọc</button>
    <button class="btn ghost small danger" data-act="del">Xoá</button></li>`).join('');
}

// ── settings panel ─────────────────────────────────────────────────────────
function renderParams() {
  const m = mode(), root = $('#paramGroups');
  const groups = specsFor(m);
  root.innerHTML = groups.map(g => {
    const items = g.items.filter(it => !it.hidden);
    if (!items.length) return '';
    return `<div class="group"><h3>${g.group}</h3>${items.map(it => paramHtml(it)).join('')}</div>`;
  }).join('');
  const wm = S.status?.system?.watermark;
  const wmEl = root.querySelector('[data-k="watermark"]');
  if (wmEl && !wm) {
    wmEl.querySelector('input').disabled = true;
    wmEl.querySelector('.hint').textContent = 'Chưa cài resemble-perth (pip install "vieneu[watermark]") nên không đóng dấu được.';
  }
  $('#settingsNote').textContent = m === 'v3nano'
    ? 'Thiết lập cho VieNeu-TTS v3 Nano (24 kHz). Lưu riêng theo từng mô hình.'
    : 'Thiết lập cho VieNeu-TTS v3 Turbo (48 kHz). Lưu riêng theo từng mô hình.';
}
function paramHtml(it) {
  const v = S.params[it.k];
  if (it.type === 'check') return `<div class="param" data-k="${it.k}"><label class="check"><input type="checkbox" ${v ? 'checked' : ''}> ${it.label}</label>${it.hint !== undefined ? `<div class="hint">${it.hint}</div>` : ''}</div>`;
  if (it.type === 'select') return `<div class="param" data-k="${it.k}"><div class="param-head"><label>${it.label}</label></div><select>${it.options().map(([ov, ol]) => `<option value="${ov}" ${String(ov) === String(v) ? 'selected' : ''}>${ol}</option>`).join('')}</select></div>`;
  if (it.type === 'number') return `<div class="param" data-k="${it.k}"><div class="param-head"><label>${it.label}</label><input type="number" min="0" step="1" value="${v ?? ''}" placeholder="ngẫu nhiên"></div>${it.hint ? `<div class="hint">${it.hint}</div>` : ''}</div>`;
  return `<div class="param" data-k="${it.k}"><div class="param-head"><label>${it.label}</label><input type="number" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}"></div>
    <input type="range" min="${it.min}" max="${it.max}" step="${it.step}" value="${v}">${it.hint ? `<div class="hint">${it.hint}</div>` : ''}</div>`;
}
function onParamInput(e) {
  const box = e.target.closest('.param'); if (!box) return;
  const k = box.dataset.k, spec = specsFor(mode()).flatMap(g => g.items).find(i => i.k === k);
  let v;
  if (spec.type === 'check') v = e.target.checked;
  else if (spec.type === 'select') v = isNaN(+e.target.value) ? e.target.value : +e.target.value;
  else if (spec.type === 'number') v = e.target.value === '' ? '' : Math.max(0, Math.floor(+e.target.value));
  else {
    v = +e.target.value; if (!isFinite(v)) return;
    if (e.type === 'change') v = Math.min(spec.max, Math.max(spec.min, v));
    $$('input', box).forEach(i => { if (i !== e.target || e.type === 'change') i.value = v; });
  }
  S.params[k] = v; saveParams();
}

// ── model status / dialog ──────────────────────────────────────────────────
let _pollTimer = null;
async function pollStatus() {
  clearTimeout(_pollTimer);
  let st;
  try { st = await apiJson('/api/status'); } catch (e) {
    $('#modelText').textContent = 'Mất kết nối tới máy chủ cục bộ'; $('#modelDot').className = 'dot err';
    _pollTimer = setTimeout(pollStatus, 2000); return;
  }
  const prev = S.status; S.status = st;
  const changed = !prev || prev.loaded !== st.loaded || prev.mode !== st.mode || prev.loading !== st.loading || prev.load_seconds !== st.load_seconds;
  renderModelPill();
  if (changed) {
    if (!prev || prev.mode !== st.mode || !prev.formats) { loadParams(mode()); renderParams(); }
    $('#voicesHome').textContent = st.voices_home;
    if (st.loaded && !st.loading) { try { await refreshVoices(); } catch (e) { toast(e.message, true); } }
    updateButtons();
    renderDialogStatus();
    if (prev?.loading && !st.loading) {
      if (st.error) toast('Không tải được mô hình: ' + st.error, true, 8000);
      else toast(`Đã tải ${st.mode_label} (${st.load_seconds}s)`);
    }
  }
  if (st.loading) renderDialogStatus();
  _pollTimer = setTimeout(pollStatus, st.loading ? 1000 : 8000);
}
function renderModelPill() {
  const st = S.status, dot = $('#modelDot'), tx = $('#modelText');
  if (st.loading) {
    dot.className = 'dot busy';
    tx.textContent = `Đang tải mô hình… ${st.loading_for ? Math.round(st.loading_for) + 's' : ''}`;
  } else if (st.loaded) {
    dot.className = 'dot ok';
    tx.textContent = `${st.mode === 'v3nano' ? 'v3 Nano' : 'v3 Turbo'} · ${String(st.backend).toUpperCase()} · ${st.sample_rate / 1000} kHz`;
  } else if (st.error) { dot.className = 'dot err'; tx.textContent = 'Lỗi tải mô hình — bấm để xem'; }
  else { dot.className = 'dot'; tx.textContent = 'Chưa tải mô hình'; }
}
function renderDialogStatus() {
  const st = S.status; if (!st) return;
  const sys = st.system || {};
  $('#sysInfo').innerHTML = `SDK vieneu ${esc(st.sdk_version)} · ${sys.cpu_count} nhân CPU · PyTorch: ${sys.torch ? 'có' : 'không'} · CUDA: ${sys.cuda ? 'có' : 'không'} · Watermark: ${sys.watermark ? 'có' : 'không'}`;
  const el = $('#loadStatus');
  if (st.loading) {
    el.className = 'status small';
    el.textContent = `Đang tải… ${Math.round(st.loading_for || 0)}s. Lần đầu cần tải mô hình từ Hugging Face (v3 Turbo ~1 GB), có thể mất vài phút.`;
  } else if (st.error) { el.className = 'status small err'; el.textContent = st.error; }
  else if (st.loaded) { el.className = 'status small ok'; el.textContent = `Đang dùng ${st.mode_label} · backend ${st.backend} · tải trong ${st.load_seconds}s`; }
  else { el.className = 'status small'; el.textContent = ''; }
  $('#loadBtn').disabled = !!st.loading;
}
function openModelDialog() {
  const f = $('#modelDialog form'), cfg = S.status?.config || {}, saved = store.get('modelCfg', {});
  const c = Object.assign({}, saved, cfg);
  f.mode.value = c.mode || 'v3turbo';
  for (const k of ['backend', 'device', 'precision', 'max_batch_size', 'max_streams', 'steps', 'cfg', 'backbone_repo']) if (c[k] != null && f[k]) f[k].value = c[k];
  if (c.threads != null) { f.threads.value = c.threads; f.threads_n.value = c.threads; }
  syncModeFields(); renderDialogStatus();
  if (!UPD.info) checkUpdates({ silent: true });
  $('#modelDialog').showModal();
}
function syncModeFields() {
  const m = $('#modelDialog form').mode.value;
  $$('#modelDialog [data-for]').forEach(el => { el.hidden = el.dataset.for !== m; });
}
async function loadModel() {
  const f = $('#modelDialog form'), m = f.mode.value;
  const cfg = m === 'v3turbo'
    ? { mode: m, backend: f.backend.value, device: f.device.value, precision: f.precision.value, threads: +f.threads.value || 0,
        max_batch_size: +f.max_batch_size.value || 32, max_streams: +f.max_streams.value || 16,
        backbone_repo: f.backbone_repo.value.trim(), onnx_dir: f.onnx_dir_t.value.trim() }
    : { mode: m, threads: +f.threads_n.value || 0, steps: +f.steps.value || 16, cfg: +f.cfg.value, onnx_dir: f.onnx_dir_n.value.trim() };
  store.set('modelCfg', cfg);
  try {
    S.status = await apiJson('/api/load', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cfg) });
    S.voices = []; updateButtons(); renderModelPill(); renderDialogStatus(); pollStatus();
  } catch (e) { toast(e.message, true); }
}

function updateButtons() {
  const ready = !!S.status?.loaded && !S.status?.loading && !S.busy;
  $('#readGo').disabled = !ready; $('#previewVoice').disabled = !ready;
  $('#cloneGo').disabled = !ready || !S.refBlob;
  $('#denoiseBtn').disabled = !ready || !S.refBlob;
  $('#saveVoiceBtn').disabled = !ready || !S.refBlob;
  $('#convGo').disabled = !ready; $('#srtGo').disabled = !ready || !S.srtCues.length;
  const ls = $('#lexSpeak'); if (ls) ls.disabled = !ready;
}

// ── job runner (one generation at a time) ──────────────────────────────────
let job = null;
async function runJob(stopBtn, fn) {
  if (S.busy) return;
  S.busy = true; updateButtons();
  const ctrl = new AbortController(); job = { ctrl, stopped: false };
  if (stopBtn) { stopBtn.hidden = false; stopBtn.onclick = () => { job.stopped = true; ctrl.abort(); job.player?.stop(); }; }
  try { await fn(job); }
  catch (e) {
    if (job.stopped || e.name === 'AbortError') setStatus('Đã dừng.');
    else { setStatus(e.message, 'err'); toast(e.message, true, 6000); }
  } finally {
    if (stopBtn) stopBtn.hidden = true;
    if (wave.live) { wave.live = null; wave.progress = 0; drawWave(); }
    S.busy = false; job = null; updateButtons();
  }
}
async function speak({ text, voice, ref, stream, kind, title, denoise, live = true, lexicon, ephemeral = false, j }) {
  liveBegin();
  let player = null;
  if (stream && live) { player = new LivePlayer(); j.player = player; wave.live = player; }
  setStatus(stream ? 'Đang tạo và phát trực tiếp…' : 'Đang tạo âm thanh…');
  const r = await synth({ text, voice, ref, stream, denoise, lexicon, signal: j.ctrl.signal,
    onChunk: (f, sr) => { player?.push(f, sr); if (stream) liveChunk(f, sr); } });
  if (liveChunk._raf) { cancelAnimationFrame(liveChunk._raf); liveChunk._raf = null; }
  if (!r.pcm.length) throw new Error('Không tạo được âm thanh (văn bản rỗng sau khi chuẩn hoá?)');
  const item = { pcm: r.pcm, sr: r.sr, elapsed: r.serverElapsed || r.elapsed, ttfa: r.ttfa, kind, voice, title, text, ephemeral };
  addHistory(item);
  setStatus(`Xong · ${fmtSec(r.pcm.length / r.sr)} âm thanh trong ${fmtSec(item.elapsed)}.`, 'ok');
  if (player) {
    const tick = () => { if (!j.player) return; wave.progress = Math.min(1, player.position / (r.pcm.length / r.sr)); drawWave(); requestAnimationFrame(tick); };
    tick();
    await player.finish(); j.player = null; wave.live = null; wave.progress = 0; drawWave();
  } else if (live) $('#outAudio').play().catch(() => {});
  return item;
}

// ── tab: read ──────────────────────────────────────────────────────────────
const SAMPLES = [
  ['Giới thiệu', 'Xin chào! Đây là V Studio, ứng dụng chuyển văn bản thành giọng nói tiếng Việt chạy ngay trên máy của bạn. [cười] Bạn có thể chọn giọng đọc, nhân bản giọng nói, làm podcast hay cả một cuốn truyện nhiều giọng.'],
  ['Tin tức', 'Chiều ngày 3/11/2026, Sở Giao thông vận tải TP.HCM cho biết tuyến metro số 1 đã đón trung bình hơn 25.000 lượt khách mỗi ngày, tăng 12% so với tháng trước.'],
  ['Kể chuyện', 'Ngày xửa ngày xưa, ở một ngôi làng nhỏ ven sông, có một cô bé tên là Mai. [thở dài] Sáng nào cô cũng ra bến, ngồi đợi chuyến đò sớm nhất để sang trường.'],
  ['Toán học', 'Xét phương trình ax² + bx + c = 0 với a ≠ 0. Nếu Δ ≥ 0 thì phương trình có nghiệm x ∈ ℝ, và √Δ cho ta khoảng cách giữa hai nghiệm.'],
  ['Hoá học', 'Khi đốt cháy khí hiđro ta có phản ứng 2H2 + O2 → 2H2O. Còn CaCO3 tác dụng với HCl sẽ giải phóng khí CO2.'],
  ['Quảng cáo', 'Ưu đãi cuối tuần! Giảm ngay 30% cho mọi đơn hàng từ 500.000 đồng. [cười] Nhanh tay lên, chương trình chỉ kéo dài đến hết chủ nhật này thôi!'],
  ['Xen tiếng Anh', 'Sáng nay team mình có buổi meeting để review lại roadmap của sản phẩm AI trong quý tới, sau đó sẽ demo bản update mới cho khách hàng.'],
];
/** Plain text of a dropped / picked file (.txt, .md read here; .pdf, .docx by the server). */
async function readTextFile(f) {
  if (/\.(txt|md|srt)$/i.test(f.name) || f.type.startsWith('text/')) return f.text();
  if (!/\.(pdf|docx)$/i.test(f.name)) throw new Error('Chỉ nhận tệp .txt, .md, .docx hoặc .pdf.');
  const fd = new FormData(); fd.append('file', f, f.name);
  return (await apiJson('/api/extract', { method: 'POST', body: fd })).text;
}
function fileDropTarget(box, onFile) {
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  ['dragenter', 'dragover'].forEach(ev => box.addEventListener(ev, (e) => { if (!hasFiles(e)) return; e.preventDefault(); box.classList.add('over'); }));
  box.addEventListener('dragleave', (e) => { if (!box.contains(e.relatedTarget)) box.classList.remove('over'); });
  box.addEventListener('drop', (e) => {
    box.classList.remove('over');
    const f = e.dataTransfer?.files?.[0]; if (!f) return;
    e.preventDefault(); onFile(f);
  });
}
function initRead() {
  const ta = $('#text');
  ta.value = store.get('text', 'Xin chào! Đây là V Studio, ứng dụng chuyển văn bản thành giọng nói tiếng Việt chạy ngay trên máy của bạn. [cười] Bạn có thể chọn giọng đọc, chỉnh các thông số, nhân bản giọng nói hay tạo cả một đoạn hội thoại nhiều người.');
  const count = () => {
    const n = ta.value.length, w = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
    // ~3.4 syllables (Vietnamese words) per second at a normal reading pace
    $('#textCount').textContent = `${n.toLocaleString('vi-VN')} ký tự · ${w.toLocaleString('vi-VN')} từ` + (w ? ` · ≈ ${fmtSec(w / 3.4)} âm thanh` : '');
  };
  ta.addEventListener('input', () => { count(); store.set('text', ta.value); }); count();
  $$('#tab-read [data-insert]').forEach(b => b.addEventListener('click', () => {
    const s = ta.selectionStart, e = ta.selectionEnd, ins = ' ' + b.dataset.insert + ' ';
    ta.setRangeText(ins, s, e, 'end'); ta.focus(); ta.dispatchEvent(new Event('input'));
  }));
  $('#clearText').onclick = () => { ta.value = ''; ta.dispatchEvent(new Event('input')); ta.focus(); };
  const loadFile = async (f) => {
    try { ta.value = await readTextFile(f); ta.dispatchEvent(new Event('input')); toast(`Đã nạp ${f.name}`); }
    catch (err) { toast(err.message, true); }
  };
  $('#textFile').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) loadFile(f); });
  fileDropTarget($('#textDrop'), loadFile);
  const sample = $('#sampleText');
  sample.innerHTML += SAMPLES.map(([k], i) => `<option value="${i}">${esc(k)}</option>`).join('');
  sample.addEventListener('change', () => {
    const it = SAMPLES[+sample.value]; sample.value = ''; if (!it) return;
    ta.focus(); ta.select();
    // execCommand keeps the replacement on the undo stack (⌘/Ctrl+Z brings the old text back)
    if (!document.execCommand?.('insertText', false, it[1])) ta.value = it[1];
    ta.dispatchEvent(new Event('input'));
  });
  let gm = store.get('genMode', 'stream');
  const setGm = (v) => {
    gm = v; store.set('genMode', v);
    $$('#genMode button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
    $('#genModeHint').textContent = v === 'stream' ? 'Phát ngay khi từng đoạn được tạo xong.' : 'Tạo xong toàn bộ rồi mới phát (GPU gộp batch nhiều đoạn — nhanh hơn với văn bản dài).';
  };
  $$('#genMode button').forEach(b => b.addEventListener('click', () => setGm(b.dataset.v))); setGm(gm);
  $('#readVoice').addEventListener('change', (e) => store.set('voice.' + mode(), e.target.value));
  const go = () => {
    const text = ta.value.trim(); if (!text) { toast('Hãy nhập văn bản.', true); return; }
    const voice = $('#readVoice').value;
    runJob($('#readStop'), (j) => speak({ text, voice, stream: gm === 'stream', kind: 'Đọc văn bản', title: text.slice(0, 90), j }));
  };
  $('#readGo').onclick = go;
  ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); if (!$('#readGo').disabled) go(); } });
  $('#previewVoice').onclick = () => {
    const voice = $('#readVoice').value;
    runJob($('#readStop'), (j) => speak({ text: `Xin chào, mình là ${voice}. Rất vui được đọc cho bạn nghe hôm nay.`, voice, stream: true, kind: 'Nghe thử', title: 'Nghe thử giọng ' + voice, ephemeral: true, j }));
  };
}

// ── tab: clone ─────────────────────────────────────────────────────────────
function initClone() {
  const drop = $('#refDrop'), input = $('#refFile');
  const setRef = async (blob, name) => {
    const { blob: wav, seconds } = await toWavBlob(blob);
    S.refBlob = wav; S.refName = name;
    const a = $('#refAudio'); if (a._url) URL.revokeObjectURL(a._url); a._url = URL.createObjectURL(wav); a.src = a._url;
    $('#refName').textContent = `${name}${isFinite(seconds) ? ' · ' + seconds.toFixed(1) + ' giây' : ''}` + (seconds > 8 ? ' — sẽ được cắt còn 8 giây' : '') + (seconds < 3 ? ' — hơi ngắn, nên dùng 3–8 giây' : '');
    $('#refEmpty').hidden = true; $('#refFull').hidden = false; $('#refClear').hidden = false;
    $('#denoisedAudio').hidden = true;
    updateButtons();
  };
  drop.addEventListener('click', (e) => { if (!e.target.closest('audio')) input.click(); });
  drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') input.click(); });
  input.addEventListener('change', () => { const f = input.files[0]; input.value = ''; if (f) setRef(f, f.name); });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) setRef(f, f.name); });
  $('#refClear').onclick = () => { S.refBlob = null; $('#refEmpty').hidden = false; $('#refFull').hidden = true; $('#refClear').hidden = true; $('#denoisedAudio').hidden = true; updateButtons(); };

  // recording — done by the app (recorder.py); the web view's getUserMedia is not reliable
  let recording = false, recTimer = null;
  const stopRec = async () => {
    clearInterval(recTimer); recording = false;
    $('#recBtn').classList.remove('rec'); $('#recBtn').textContent = '● Ghi âm'; $('#recState').textContent = '';
    const r = await nativeApi().rec_stop();
    if (!r?.ok) { toast(r?.error || 'Ghi âm thất bại', true); return; }
    const bin = Uint8Array.from(atob(r.wav), c => c.charCodeAt(0));
    await setRef(new Blob([bin], { type: 'audio/wav' }), 'Bản ghi âm');
  };
  $('#recBtn').onclick = () => toggleRec().catch(e => toast(e.message, true, 7000));
  const toggleRec = async () => {
    if (recording) { await stopRec(); return; }
    const r = await nativeApi().rec_start();
    if (!r?.ok) { toast(r?.error || 'Không mở được micro', true, 7000); return; }
    recording = true;
    $('#recBtn').classList.add('rec'); $('#recBtn').textContent = '■ Dừng ghi';
    recTimer = setInterval(async () => {
      const p = await nativeApi().rec_poll(); if (!recording || !p?.active) return;
      const bars = '▁▂▃▄▅▆▇█', lv = bars[Math.min(7, Math.floor(Math.sqrt(p.level || 0) * 24))];
      $('#recState').textContent = `${lv} Đang ghi… ${p.seconds.toFixed(1)} s (nên 5–8 giây)`;
      if (p.limit) stopRec();
    }, 150);
  };

  $('#denoiseBtn').onclick = () => runJob(null, async () => {
    setStatus('Đang khử nhiễu âm thanh mẫu…');
    const fd = new FormData(); fd.append('file', S.refBlob, 'reference.wav');
    const blob = await (await api('/api/denoise', { method: 'POST', body: fd })).blob();
    const a = $('#denoisedAudio'); if (a._url) URL.revokeObjectURL(a._url); a._url = URL.createObjectURL(blob); a.src = a._url; a.hidden = false; a.play().catch(() => {});
    setStatus('Đã khử nhiễu — đây là bản mô hình sẽ dùng làm tham chiếu.', 'ok');
  });
  $('#cloneGo').onclick = () => {
    const text = $('#cloneText').value.trim(); if (!text) { toast('Hãy nhập văn bản.', true); return; }
    runJob($('#cloneStop'), (j) => speak({ text, ref: S.refBlob, denoise: $('#refDenoise').checked, stream: true,
      kind: 'Nhân bản giọng', voice: 'Giọng nhân bản', title: text.slice(0, 90), j }));
  };
  $('#saveVoiceBtn').onclick = () => {
    const name = $('#saveName').value.trim(); if (!name) { toast('Hãy đặt tên cho giọng.', true); $('#saveName').focus(); return; }
    runJob(null, async () => {
      setStatus('Đang tạo hồ sơ giọng…');
      const fd = new FormData();
      fd.append('name', name); fd.append('description', $('#saveDesc').value.trim()); fd.append('gender', $('#saveGender').value);
      fd.append('denoise', $('#refDenoise').checked ? 'true' : 'false'); fd.append('file', S.refBlob, 'reference.wav');
      const j = await apiJson('/api/voices', { method: 'POST', body: fd });
      S.voices = j.voices; fillVoiceSelect($('#readVoice')); fillVoiceSelect($('#srtVoice')); renderSpeakers(); renderUserVoices();
      setStatus(`Đã lưu giọng “${name}”.`, 'ok'); toast(`Đã lưu giọng “${name}”`);
      $('#saveName').value = ''; $('#saveDesc').value = '';
    });
  };
  $('#userVoices').addEventListener('click', async (e) => {
    const btn = e.target.closest('button'); if (!btn) return;
    const id = btn.closest('li').dataset.id;
    if (btn.dataset.act === 'use') { fillVoiceSelect($('#readVoice'), id); store.set('voice.' + mode(), id); switchTab('read'); return; }
    if (btn.dataset.act === 'del') {
      if (btn.dataset.confirm !== '1') { btn.dataset.confirm = '1'; btn.textContent = 'Bấm lần nữa để xoá'; setTimeout(() => { btn.dataset.confirm = ''; btn.textContent = 'Xoá'; }, 3000); return; }
      try {
        const j = await apiJson('/api/voices/' + encodeURIComponent(id), { method: 'DELETE' });
        S.voices = j.voices; fillVoiceSelect($('#readVoice')); fillVoiceSelect($('#srtVoice')); renderSpeakers(); renderUserVoices();
        toast(`Đã xoá giọng “${id}”`);
      } catch (err) { toast(err.message, true); }
    }
  });
}

// ── tab: conversation ──────────────────────────────────────────────────────
function parseScript(src) {
  const lines = [];
  for (const raw of src.split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const i = line.indexOf(':');
    if (i > 0 && i < 40) lines.push({ speaker: line.slice(0, i).trim(), text: line.slice(i + 1).trim() });
    else if (lines.length) lines[lines.length - 1].text += ' ' + line;
    else lines.push({ speaker: 'Người dẫn', text: line });
  }
  return lines.filter(l => l.text);
}
function speakersOf(lines) { return [...new Set(lines.map(l => l.speaker))]; }
function renderSpeakers() {
  const box = $('#convSpeakers'); if (!box) return;
  const lines = parseScript($('#convScript').value), spk = speakersOf(lines);
  $('#convCount').textContent = `${lines.length} câu · ${spk.length} nhân vật`;
  if (!S.voices.length) { box.innerHTML = '<div class="muted small">Tải mô hình để chọn giọng cho từng nhân vật.</div>'; return; }
  // Auto-assign: keep previous choices, otherwise give each speaker a distinct editors' pick.
  // Alternate female / male so a two-person script gets two clearly different voices.
  const ordered = S.voices.filter(v => v.featured && !v.user).concat(S.voices.filter(v => !v.featured && !v.user));
  const fem = ordered.filter(v => v.gender === 'female'), mal = ordered.filter(v => v.gender !== 'female');
  const pool = [];
  for (let i = 0; i < Math.max(fem.length, mal.length); i++) { if (fem[i]) pool.push(fem[i].id); if (mal[i]) pool.push(mal[i].id); }
  const used = new Set(spk.map(s => S.convMap[s]).filter(v => v && S.voices.some(x => x.id === v)));
  spk.forEach(s => {
    if (!S.convMap[s] || !S.voices.some(x => x.id === S.convMap[s])) {
      const pick = pool.find(v => !used.has(v)) || pool[0]; S.convMap[s] = pick; used.add(pick);
    }
  });
  store.set('convMap', S.convMap);
  box.innerHTML = spk.map((s, i) => `<div class="spk"><b title="${esc(s)}">${esc(s)}</b><select data-spk="${i}" class="voice-select"></select></div>`).join('');
  $$('select', box).forEach((sel) => {
    const s = spk[+sel.dataset.spk]; fillVoiceSelect(sel, S.convMap[s]);
    sel.addEventListener('change', () => { S.convMap[s] = sel.value; store.set('convMap', S.convMap); });
  });
}
function sliderControl(wrap, { label, min, max, step, value, unit, onChange }) {
  wrap.innerHTML = `<div class="param"><div class="param-head"><label>${label}</label><input type="number" min="${min}" max="${max}" step="${step}" value="${value}"></div><input type="range" min="${min}" max="${max}" step="${step}" value="${value}"><div class="hint">${unit || ''}</div></div>`;
  const ins = $$('input', wrap);
  ins.forEach(i => i.addEventListener('input', () => { const v = Math.min(max, Math.max(min, +i.value || 0)); ins.forEach(o => { if (o !== i) o.value = v; }); onChange(v); }));
}
function initConv() {
  const ta = $('#convScript');
  ta.value = store.get('convScript', ta.value);
  let t; ta.addEventListener('input', () => { store.set('convScript', ta.value); clearTimeout(t); t = setTimeout(renderSpeakers, 400); });
  $('#convScan').onclick = renderSpeakers;
  $('#convFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { ta.value = await readTextFile(f); ta.dispatchEvent(new Event('input')); renderSpeakers(); toast(`Đã nạp kịch bản ${f.name}`); }
    catch (err) { toast(err.message, true); }
  });
  $('#convToStory').onclick = async () => {
    const lines = parseScript(ta.value); if (!lines.length) { toast('Kịch bản trống (định dạng: Nhân vật: lời thoại).', true); return; }
    if (!window.VStudio.openStory) { toast('Phòng thu Truyện chưa sẵn sàng.', true); return; }
    renderSpeakers();
    const COLORS = ['#0d8a68', '#3b82f6', '#d97706', '#c2413b', '#8b5cf6', '#db2777', '#0891b2', '#65a30d'];
    const rid = () => Math.random().toString(36).slice(2, 10);
    const chars = speakersOf(lines).map((name, i) => ({ id: rid(), name: name.slice(0, 60), voice: S.convMap[name] || '', color: COLORS[i % COLORS.length] }));
    const byName = new Map(chars.map((c, i) => [speakersOf(lines)[i], c.id]));
    const segments = lines.map(l => ({ id: rid(), char: byName.get(l.speaker), text: l.text }));
    const name = 'Podcast ' + new Date().toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    try {
      const p = await apiJson('/api/stories', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, pause: silence, characters: chars, segments }) });
      await window.VStudio.openStory(p);
      switchTab('story'); toast(`Đã tạo “${name}” trong Phòng thu Truyện: ${segments.length} lượt, ${chars.length} nhân vật.`, false, 5000);
    } catch (err) { toast(err.message, true); }
  };
  let silence = store.get('convSilence', 0.3);
  sliderControl($('#convSilenceWrap'), { label: 'Khoảng lặng giữa các câu (giây)', min: 0, max: 3, step: 0.1, value: silence, onChange: (v) => { silence = v; store.set('convSilence', v); } });
  renderSpeakers();
  $('#convGo').onclick = () => {
    const lines = parseScript(ta.value); if (!lines.length) { toast('Kịch bản trống (định dạng: Nhân vật: lời thoại).', true); return; }
    renderSpeakers();
    runJob($('#convStop'), async (j) => {
      const prog = $('#convProgress'); prog.hidden = false;
      const parts = []; let sr = 0, t0 = performance.now();
      for (let i = 0; i < lines.length; i++) {
        if (j.stopped) throw new DOMException('stop', 'AbortError');
        const l = lines[i];
        prog.querySelector('i').style.width = `${(i / lines.length) * 100}%`;
        prog.querySelector('span').textContent = `${i + 1}/${lines.length} · ${l.speaker}: ${l.text.slice(0, 60)}`;
        setStatus(`Đang tạo câu ${i + 1}/${lines.length}…`);
        const r = await synth({ text: l.text, voice: S.convMap[l.speaker], stream: false, signal: j.ctrl.signal });
        sr = r.sr;
        if (parts.length && silence > 0) parts.push(new Float32Array(Math.round(sr * silence)));
        parts.push(r.pcm);
      }
      prog.querySelector('i').style.width = '100%'; prog.querySelector('span').textContent = 'Hoàn tất';
      const pcm = concatF32(parts);
      addHistory({ pcm, sr, elapsed: (performance.now() - t0) / 1000, kind: 'Podcast', voice: speakersOf(lines).join(', '),
        title: lines.map(l => l.text).join(' ').slice(0, 90), text: lines.map(l => `${l.speaker}: ${l.text}`).join('\n') });
      setStatus(`Xong hội thoại ${lines.length} câu · ${fmtSec(pcm.length / sr)}.`, 'ok');
      $('#outAudio').play().catch(() => {});
      setTimeout(() => { prog.hidden = true; }, 1500);
    });
  };
}

// ── tab: SRT ───────────────────────────────────────────────────────────────
const SAMPLE_SRT = `1
00:00:02,922 --> 00:00:04,442
Sakai, Nhật Bản.

2
00:00:06,602 --> 00:00:10,693
Tại đây, trong thành phố nằm cách
Tokyo 250 dặm về phía tây nam,

3
00:00:10,743 --> 00:00:12,473
có lăng mộ Daisen Kofun,

4
00:00:15,322 --> 00:00:18,212
một trong hơn 40 ngôi mộ
cổ trong bán kính sáu dặm.
`;
function parseSrt(text) {
  const TIME = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;
  const ms = (m) => ((+m[1] * 60 + +m[2]) * 60 + +m[3]) * 1000 + +(m[4] + '000').slice(0, 3);
  const cues = [];
  text = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  for (const block of text.trim().split(/\n\s*\n/)) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    const ti = lines.findIndex(l => l.includes('-->')); if (ti < 0) continue;
    const [a, b] = lines[ti].split('-->'); const ma = TIME.exec(a), mb = TIME.exec(b || ''); if (!ma || !mb) continue;
    const body = lines.slice(ti + 1).join(' ').replace(/<[^>]+>|\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim();
    if (!body) continue;
    const s = ms(ma); cues.push({ start: s, end: Math.max(ms(mb), s + 100), text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}
const fmtTs = (ms) => { const s = ms / 1000, h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return `${h ? h + ':' : ''}${String(m).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
function initSrt() {
  const load = (text, name) => {
    S.srtCues = parseSrt(text);
    $('#srtInfo').textContent = S.srtCues.length ? `${name}: ${S.srtCues.length} câu · dài ${fmtTs(S.srtCues.at(-1).end)}` : `${name}: không tìm thấy câu thoại hợp lệ.`;
    const box = $('#srtCues'); box.hidden = !S.srtCues.length;
    box.innerHTML = `<table><thead><tr><th>#</th><th>Bắt đầu</th><th>Kết thúc</th><th>Lời thoại</th></tr></thead><tbody>${S.srtCues.map((c, i) => `<tr data-i="${i}"><td class="t">${i + 1}</td><td class="t">${fmtTs(c.start)}</td><td class="t">${fmtTs(c.end)}</td><td>${esc(c.text)}</td></tr>`).join('')}</tbody></table>`;
    updateButtons();
  };
  $('#srtFile').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) load(await f.text(), f.name); });
  $('#srtSample').onclick = () => load(SAMPLE_SRT, 'sample_vi.srt');
  let gap = store.get('srtGap', 0.5);
  sliderControl($('#srtGapWrap'), { label: 'Khoảng lặng giữa các câu (giây)', min: 0, max: 2, step: 0.1, value: gap, onChange: (v) => { gap = v; store.set('srtGap', v); } });
  const keep = $('#srtKeep'); keep.addEventListener('change', () => { $('#srtGapWrap').hidden = keep.checked; });
  $('#srtGo').onclick = () => runJob($('#srtStop'), async (j) => {
    const cues = S.srtCues, voice = $('#srtVoice').value, prog = $('#srtProgress'); prog.hidden = false;
    const clips = []; let sr = 0; const t0 = performance.now();
    $$('#srtCues tr').forEach(tr => tr.classList.remove('done', 'doing'));
    for (let i = 0; i < cues.length; i++) {
      if (j.stopped) throw new DOMException('stop', 'AbortError');
      const row = $(`#srtCues tr[data-i="${i}"]`); row?.classList.add('doing'); row?.scrollIntoView({ block: 'nearest' });
      prog.querySelector('i').style.width = `${(i / cues.length) * 100}%`;
      prog.querySelector('span').textContent = `${i + 1}/${cues.length} · ${cues[i].text.slice(0, 60)}`;
      const r = await synth({ text: cues[i].text, voice, stream: false, signal: j.ctrl.signal });
      sr = r.sr; clips.push(r.pcm); row?.classList.replace('doing', 'done');
    }
    let track, note = '';
    if (keep.checked) {
      let cursor = 0, pushed = 0, maxShift = 0; const starts = [];
      cues.forEach((c, i) => {
        const want = Math.round(c.start * sr / 1000), at = Math.max(want, cursor);
        if (at > want) { pushed++; maxShift = Math.max(maxShift, (at - want) / sr); }
        starts.push(at); cursor = at + clips[i].length;
      });
      track = new Float32Array(cursor + Math.round(sr / 2));
      starts.forEach((s, i) => track.set(clips[i], s));
      if (pushed) note = ` · ${pushed} câu bị lùi (tối đa ${maxShift.toFixed(1)} s) vì đọc dài hơn khung phụ đề`;
    } else {
      const parts = []; clips.forEach((c, i) => { if (i) parts.push(new Float32Array(Math.round(gap * sr))); parts.push(c); });
      track = concatF32(parts);
    }
    let peak = 0; for (const x of track) { const a = Math.abs(x); if (a > peak) peak = a; }
    if (peak > 0.98) for (let i = 0; i < track.length; i++) track[i] *= 0.98 / peak;
    prog.querySelector('i').style.width = '100%'; prog.querySelector('span').textContent = 'Hoàn tất' + note;
    addHistory({ pcm: track, sr, elapsed: (performance.now() - t0) / 1000, kind: 'Phụ đề SRT', voice,
      title: `${cues.length} câu phụ đề — ${cues[0].text.slice(0, 60)}`, text: cues.map(c => c.text).join('\n') });
    setStatus(`Xong ${cues.length} câu · ${fmtSec(track.length / sr)}${note}.`, 'ok');
  });
}

// ── updates ────────────────────────────────────────────────────────────────
const UPD = { info: null, job: null, timer: null };
async function checkUpdates({ force = false, silent = false } = {}) {
  if (!silent) $('#updInfo').textContent = 'Đang kiểm tra…';
  try { UPD.info = await apiJson('/api/update/check' + (force ? '?force=true' : '')); }
  catch (e) { if (!silent) { $('#updInfo').textContent = e.message; toast(e.message, true); } return; }
  renderUpdate();
  if (!silent && !UPD.info.update_available) toast(`Đang dùng bản mới nhất (vieneu ${UPD.info.installed})`);
  if (UPD.info.update_available && store.get('autoInstall', false) && !UPD.job?.running && !UPD.job?.done) installUpdate();
}
function renderUpdate() {
  const i = UPD.info, j = UPD.job, bar = $('#updateBar');
  if (i) {
    const date = i.released_at ? new Date(i.released_at).toLocaleDateString('vi-VN') : '';
    $('#updInfo').innerHTML = `Đang dùng <b>vieneu ${esc(i.installed)}</b> · bản mới nhất trên PyPI: <b>${esc(i.latest)}</b>${date ? ' (' + date + ')' : ''}` +
      ` · <a href="${esc(i.pypi_url)}" target="_blank" rel="noopener">PyPI</a> · <a href="${esc(i.changes_url)}" target="_blank" rel="noopener">thay đổi</a>`;
    if (i.frozen) $('#updInfo').innerHTML += '<br><span class="muted">Đây là bản cài đặt sẵn: để cập nhật, hãy tải bản V Studio mới nhất từ <a href="https://github.com/HieuDevs/v-studio/releases/latest" target="_blank" rel="noopener">GitHub Releases</a>.</span>';
    else if (!i.installer) $('#updInfo').innerHTML += '<br><span class="muted">Không tìm thấy uv hoặc pip trong môi trường của app nên không tự cài được.</span>';
  }
  const canInstall = i?.update_available && i.installer && !j?.running && !(j?.done && j.ok);
  $('#updInstall').hidden = !canInstall;
  if (i) $('#updInstall').textContent = `Cập nhật lên ${i.latest}`;
  const needRestart = !!(j?.done && j.ok) || !!i?.restart_needed;
  $('#updRestart').hidden = !needRestart;
  $('#updLog').hidden = !j; if (j) { $('#updLog').textContent = j.log; $('#updLog').scrollTop = 1e9; }

  // banner
  let text = '', show = false;
  if (j?.running) { text = `Đang cập nhật vieneu ${j.from} → ${i?.latest || 'mới nhất'}… Bạn vẫn dùng app bình thường.`; show = true; }
  else if (needRestart) { text = `Đã cài vieneu ${j?.to || i?.latest}. Khởi động lại app để áp dụng.`; show = true; }
  else if (j?.done && !j.ok) { text = 'Cập nhật thất bại — xem chi tiết trong mục Mô hình › Cập nhật.'; show = true; }
  else if (i?.update_available && store.get('dismissed', '') !== i.latest) { text = `Có bản VieNeu-TTS SDK mới: ${i.latest} (bạn đang dùng ${i.installed}).`; show = true; }
  bar.hidden = !show; $('#updateText').textContent = text;
  $('#updateDot').className = 'dot ' + (j?.running ? 'busy' : j?.done && !j.ok ? 'err' : 'ok');
  $('#updateNow').hidden = !(canInstall || needRestart);
  $('#updateNow').textContent = needRestart ? 'Khởi động lại' : 'Cập nhật ngay';
  $('#updateLater').hidden = !!j?.running;
}
async function installUpdate() {
  try { UPD.job = await apiJson('/api/update/install', { method: 'POST' }); }
  catch (e) { toast(e.message, true); return; }
  renderUpdate();
  const poll = async () => {
    try { UPD.job = await apiJson('/api/update/status'); } catch { /* server busy */ }
    renderUpdate();
    if (UPD.job.running) setTimeout(poll, 1000);
    else if (UPD.job.ok) toast(`Đã cập nhật vieneu ${UPD.job.from} → ${UPD.job.to}. Khởi động lại app để áp dụng.`, false, 6000);
    else toast('Cập nhật thất bại, xem log trong mục Cập nhật.', true, 6000);
  };
  setTimeout(poll, 800);
}
async function restartApp() {
  if (S.busy) { toast('Đang tạo âm thanh — hãy đợi xong rồi khởi động lại.', true); return; }
  try {
    const r = await nativeApi().restart();   // opens a fresh window, then closes this one
    if (r && !r.ok) toast(r.error, true);
    else { $('#updateText').textContent = 'Đang khởi động lại…'; $('#updateNow').hidden = true; }
  } catch (e) { toast(e.message, true); }
}
function initUpdates() {
  const autoCheck = store.get('autoCheck', true), autoInstall = store.get('autoInstall', false);
  $('#updAutoCheck').checked = autoCheck; $('#updAutoInstall').checked = autoInstall;
  $('#updAutoCheck').onchange = (e) => store.set('autoCheck', e.target.checked);
  $('#updAutoInstall').onchange = (e) => { store.set('autoInstall', e.target.checked); if (e.target.checked && UPD.info?.update_available) installUpdate(); };
  $('#updCheck').onclick = () => checkUpdates({ force: true });
  $('#updInstall').onclick = installUpdate;
  $('#updRestart').onclick = restartApp;
  $('#updateNow').onclick = () => ((UPD.job?.done && UPD.job.ok) || UPD.info?.restart_needed ? restartApp() : installUpdate());
  $('#updateLater').onclick = () => { if (UPD.info) store.set('dismissed', UPD.info.latest); $('#updateBar').hidden = true; };
  apiJson('/api/update/status').then(j => { if (j.running || j.done) { UPD.job = j; renderUpdate(); } }).catch(() => {});
  if (autoCheck) {
    setTimeout(() => checkUpdates({ silent: true }), 3000);
    setInterval(() => { if (store.get('autoCheck', true)) checkUpdates({ silent: true }); }, 6 * 3600 * 1000);
  }
}

// ── tabs / misc ────────────────────────────────────────────────────────────
function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('main > .panel').forEach(p => { p.hidden = p.id !== 'tab-' + name; });
  store.set('tab', name);
}
function initTheme() {
  const apply = (t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; drawWave(); };
  let theme = store.get('theme', null); apply(theme);
  $('#themeBtn').onclick = () => {
    const dark = theme ? theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    theme = dark ? 'light' : 'dark'; store.set('theme', theme); apply(theme);
  };
}

function init() {
  wave.canvas = $('#wave');
  initTheme();
  $$('.tab').forEach(t => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  switchTab(store.get('tab', 'read'));
  $('#modelPill').onclick = openModelDialog;
  $$('#modelDialog input[name=mode]').forEach(r => r.addEventListener('change', syncModeFields));
  $('#loadBtn').onclick = loadModel;
  $('#paramGroups').addEventListener('input', onParamInput);
  $('#paramGroups').addEventListener('change', onParamInput);
  $('#resetParams').onclick = () => { S.params = defaults(mode()); saveParams(); renderParams(); toast('Đã đưa thiết lập về mặc định'); };
  $('#outDownload').onclick = () => S.output && downloadItem(S.output);
  // Files dropped outside a drop zone must not make the window navigate to them.
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
  const a = $('#outAudio');
  const tick = () => { if (!S.output || wave.live) return; wave.progress = a.duration ? a.currentTime / a.duration : 0; drawWave(); if (!a.paused) requestAnimationFrame(tick); };
  a.addEventListener('play', tick); a.addEventListener('seeked', tick); a.addEventListener('timeupdate', tick);
  wave.canvas.addEventListener('click', (e) => {
    if (!S.output || !a.duration || wave.live) return;
    const r = wave.canvas.getBoundingClientRect(); a.currentTime = ((e.clientX - r.left) / r.width) * a.duration; tick();
  });
  window.addEventListener('resize', drawWave);
  initRead(); initClone(); initConv(); initSrt(); initUpdates(); initLibrary();
  loadParams('v3turbo'); renderParams();
  updateButtons();
  pollStatus();
}
document.addEventListener('DOMContentLoaded', init);

// ── story ── internals used by ui/story.js (Phòng thu Truyện)
window.VStudio = Object.assign(window.VStudio || {}, {
  S, store, api, apiJson, toast, esc, fmtSec, synth, speak, runJob, addHistory, setStatus,
  encodeWav, int16ToF32, fillVoiceSelect, sliderControl, switchTab, readTextFile, fileDropTarget, confirmClick, nativeApi,
});
// ── /story ──
