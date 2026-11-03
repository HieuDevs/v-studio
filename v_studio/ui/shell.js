/* V Studio — UI shell: settings drawer, custom player for the result, voice picker,
   filled range sliders and small keyboard niceties. Pure presentation: it drives the
   existing controls of app.js (window.VStudio) and never talks to the API itself. */
'use strict';
(() => {
  const V = window.VStudio;
  if (!V) return;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = V.esc, icon = V.icon;
  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  // ── settings drawer ──────────────────────────────────────────────────────
  function initDrawer() {
    const d = $('#settings'), veil = $('#drawerVeil'), btn = $('#settingsBtn');
    let lastFocus = null;
    const open = () => {
      lastFocus = document.activeElement;
      veil.hidden = false; requestAnimationFrame(() => veil.classList.add('show'));
      d.classList.add('open'); d.setAttribute('aria-hidden', 'false'); btn.setAttribute('aria-expanded', 'true');
      setTimeout(() => $('#settingsClose').focus(), 60);
    };
    const close = () => {
      if (!d.classList.contains('open')) return;
      veil.classList.remove('show'); setTimeout(() => { veil.hidden = true; }, 220);
      d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); btn.setAttribute('aria-expanded', 'false');
      lastFocus?.focus?.();
    };
    btn.onclick = () => (d.classList.contains('open') ? close() : open());
    $('#settingsClose').onclick = close; veil.onclick = close;
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && d.classList.contains('open') && !$('#modelDialog').open) close(); });
  }

  // ── result player (drives the hidden #outAudio) ──────────────────────────
  function initPlayer() {
    const a = $('#outAudio'), btn = $('#playBtn'), time = $('#playTime'), speed = $('#speedBtn');
    const mmss = (t) => { t = isFinite(t) ? Math.max(0, t) : 0; return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
    const render = () => {
      const has = !!a.currentSrc;
      btn.disabled = !has;
      btn.classList.toggle('playing', has && !a.paused && !a.ended);
      btn.setAttribute('aria-label', a.paused ? 'Phát' : 'Tạm dừng');
      time.innerHTML = `${mmss(a.currentTime)} <span class="muted">/ ${mmss(a.duration)}</span>`;
    };
    ['play', 'pause', 'ended', 'timeupdate', 'loadedmetadata', 'durationchange', 'emptied', 'seeked'].forEach(ev => a.addEventListener(ev, render));
    btn.onclick = () => { if (!a.currentSrc) return; if (a.paused || a.ended) a.play().catch(() => {}); else a.pause(); };
    const RATES = [1, 1.25, 1.5, 2, 0.75];
    let rate = V.store.get('playRate', 1); if (!RATES.includes(rate)) rate = 1;
    const applyRate = () => { a.defaultPlaybackRate = rate; a.playbackRate = rate; speed.textContent = `${rate}×`; };
    a.addEventListener('loadedmetadata', applyRate);   // a new src resets the rate
    speed.onclick = () => { rate = RATES[(RATES.indexOf(rate) + 1) % RATES.length]; V.store.set('playRate', rate); applyRate(); };
    applyRate(); render();
    // Space toggles playback when not typing; ⌘/Ctrl+S downloads the current result.
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || typing(e.target) || $('#modelDialog').open) return;
      if (e.key === ' ' && !e.target.closest?.('button, a, summary, label')) { e.preventDefault(); btn.click(); }
    });
  }

  // ── range sliders: paint the filled part ─────────────────────────────────
  function initRanges() {
    const fill = (r) => {
      const min = +r.min || 0, max = r.max === '' ? 100 : +r.max, v = +r.value;
      r.style.setProperty('--p', `${Math.max(0, Math.min(100, ((v - min) / ((max - min) || 1)) * 100))}%`);
    };
    const sync = (root) => { if (root.matches?.('input[type=range]')) fill(root); root.querySelectorAll?.('input[type=range]').forEach(fill); };
    const onEdit = (e) => { const box = e.target.closest?.('.param'); sync(box || e.target); };
    document.addEventListener('input', onEdit); document.addEventListener('change', onEdit);
    new MutationObserver((ms) => ms.forEach(m => m.addedNodes.forEach(n => n.nodeType === 1 && sync(n))))
      .observe(document.body, { childList: true, subtree: true });
    sync(document.body);
  }

  // ── voice picker: a searchable popover in front of a <select data-picker> ─
  const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
  const meta = (id) => V.S.voices.find(v => v.id === id);
  const describe = (id) => {
    const v = meta(id); if (!v) return '';
    return v.description || [v.gender === 'female' ? 'Nữ' : v.gender === 'male' ? 'Nam' : '', v.region].filter(Boolean).join(' · ');
  };
  let openPicker = null;

  function makePicker(sel) {
    const wrap = document.createElement('div'); wrap.className = 'vp';
    sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel);
    sel.classList.add('vp-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
    wrap.insertAdjacentHTML('beforeend', `
      <button type="button" class="vp-btn" aria-haspopup="listbox" aria-expanded="false"></button>
      <div class="vp-pop" role="dialog" aria-label="Chọn giọng">
        <div class="search-box">${icon('search')}<input class="vp-q" type="search" placeholder="Tìm giọng theo tên, ngôn ngữ, giới tính…" aria-label="Tìm giọng"></div>
        <div class="vp-tabs" role="tablist"></div>
        <div class="vp-list" role="listbox"></div>
        <button type="button" class="vp-more">${icon('globe')}<span class="grow">Cần ngôn ngữ khác?</span><b>Đổi mô hình</b></button>
      </div>`);
    $('.vp-more', wrap).onclick = () => { close(); $('#modelPill').click(); };
    const btn = $('.vp-btn', wrap), q = $('.vp-q', wrap), tabs = $('.vp-tabs', wrap), list = $('.vp-list', wrap);
    const label = document.querySelector(`label[for="${sel.id}"]`);
    if (label) label.addEventListener('click', (e) => { e.preventDefault(); btn.focus(); });
    let tab = '', active = -1;

    const groups = () => $$('optgroup', sel).map(g => ({ label: g.label.replace(/^⭐\s*/, ''), ids: $$('option', g).map(o => o.value) }));
    function renderBtn() {
      const id = sel.value;
      if (!sel.options.length) {
        btn.classList.add('empty');
        btn.innerHTML = `<span class="avatar">${icon('mic')}</span><span class="vp-txt"><b>Chưa có giọng</b><span>Tải mô hình để chọn giọng đọc</span></span>${icon('chev')}`;
        return;
      }
      btn.classList.remove('empty');
      btn.innerHTML = `${V.avatar(id)}<span class="vp-txt"><b>${esc(id)}</b><span>${esc(describe(id) || 'Giọng đọc')}</span></span>${icon('chev')}`;
    }
    function renderTabs() {
      const gs = groups(), total = new Set(gs.flatMap(g => g.ids)).size;
      if (tab && !gs.some(g => g.label === tab)) tab = '';
      tabs.innerHTML = [['', 'Tất cả', total], ...gs.map(g => [g.label, g.label, g.ids.length])]
        .map(([k, l, n]) => `<button type="button" role="tab" data-tab="${esc(k)}" class="${k === tab ? 'on' : ''}" aria-selected="${k === tab}">${esc(l)}<small>${n}</small></button>`).join('');
    }
    function renderList() {
      const f = fold(q.value.trim()), seen = new Set(); let html = '', n = 0;
      for (const g of groups()) {
        if (tab && g.label !== tab) continue;
        const ids = g.ids.filter(id => !f || fold(id + ' ' + describe(id) + ' ' + g.label).includes(f)).filter(id => tab || !seen.has(id));
        if (!ids.length) continue;
        ids.forEach(id => seen.add(id));
        html += `<div class="vp-group">${esc(g.label)}</div>` + ids.map(id => `<div class="vp-opt" role="option" data-id="${esc(id)}" data-n="${n++}" aria-selected="${id === sel.value}">
          ${V.avatar(id)}<span class="vp-txt"><b>${esc(id)}</b><span>${esc(describe(id))}</span></span>
          <button type="button" class="vp-play" data-play title="Nghe thử" aria-label="Nghe thử ${esc(id)}">${icon('play')}</button>
          <svg class="ic vp-check"><use href="#i-check"/></svg></div>`).join('');
      }
      list.innerHTML = html || '<div class="vp-none">Không tìm thấy giọng nào.</div>';
      active = -1;
    }
    const opts = () => $$('.vp-opt', list);
    // Scroll inside the list only (scrollIntoView would also scroll the page).
    const reveal = (el, center) => {
      if (!el) return;
      const top = el.offsetTop - list.offsetTop, h = el.offsetHeight, H = list.clientHeight;
      if (center) list.scrollTop = top - (H - h) / 2;
      else if (top < list.scrollTop) list.scrollTop = top - 28;
      else if (top + h > list.scrollTop + H) list.scrollTop = top + h - H + 4;
    };
    function setActive(i) {
      const o = opts(); if (!o.length) return;
      active = (i + o.length) % o.length;
      o.forEach((el, k) => el.classList.toggle('act', k === active));
      reveal(o[active]);
    }
    function choose(id) {
      if (sel.value !== id) { sel.value = id; sel.dispatchEvent(new Event('change', { bubbles: true })); }
      renderBtn(); close(); btn.focus();
    }
    function preview(id) {
      if (V.S.busy) { V.toast('Đang tạo âm thanh — đợi xong rồi nghe thử nhé.', true); return; }
      if (!V.S.status?.loaded) return;
      const stop = sel.closest('.panel')?.querySelector('[id$="Stop"]') || null;
      V.runJob(stop, (j) => V.speak({ text: `Xin chào, mình là ${id}. Rất vui được đọc cho bạn nghe hôm nay.`, voice: id, stream: true,
        kind: 'Nghe thử', title: 'Nghe thử giọng ' + id, ephemeral: true, j }));
    }
    function open() {
      if (!sel.options.length) { $('#modelPill').click(); return; }
      if (openPicker && openPicker !== api) openPicker.close();
      openPicker = api; q.value = ''; renderTabs(); renderList();
      const r = btn.getBoundingClientRect(), below = innerHeight - r.bottom;
      wrap.classList.toggle('up', below < 420 && r.top > below);
      wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
      reveal($('.vp-opt[aria-selected="true"]', list), true);
      setTimeout(() => q.focus({ preventScroll: true }), 0);
    }
    function close() { wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); if (openPicker === api) openPicker = null; }
    const api = { close, wrap };

    btn.addEventListener('click', () => (wrap.classList.contains('open') ? close() : open()));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
    q.addEventListener('input', () => { renderList(); if (q.value.trim()) setActive(0); });
    q.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); const o = opts()[active]; if (o) choose(o.dataset.id); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); btn.focus(); }
    });
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      tab = b.dataset.tab; renderTabs(); renderList(); q.focus();
    });
    list.addEventListener('click', (e) => {
      const o = e.target.closest('.vp-opt'); if (!o) return;
      if (e.target.closest('[data-play]')) { preview(o.dataset.id); return; }
      choose(o.dataset.id);
    });
    list.addEventListener('mousemove', (e) => { const o = e.target.closest('.vp-opt'); if (o && +o.dataset.n !== active) setActive(+o.dataset.n); });
    sel.addEventListener('change', renderBtn);
    // fillVoiceSelect() rewrites the options and sets the value without an event.
    new MutationObserver(() => { renderBtn(); if (wrap.classList.contains('open')) { renderTabs(); renderList(); } })
      .observe(sel, { childList: true, subtree: true });
    renderBtn();
    return api;
  }
  function initPickers() {
    $$('select[data-picker]').forEach(makePicker);
    document.addEventListener('mousedown', (e) => { if (openPicker && !openPicker.wrap.contains(e.target)) openPicker.close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openPicker) openPicker.close(); });
  }

  // ── misc ─────────────────────────────────────────────────────────────────
  function initMisc() {
    const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    $$('.kbd-mod').forEach(k => { k.textContent = mac ? '⌘' : 'Ctrl'; });
    // A tab switch starts at the top of the page.
    $$('.tab').forEach(t => t.addEventListener('click', () => window.scrollTo({ top: 0 })));
    // Keep the window title in sync with the open page (also when app.js switches tabs itself).
    const title = () => { const t = $('.tab.active span')?.textContent; document.title = t ? `${t} · V Studio` : 'V Studio'; };
    new MutationObserver(title).observe($('.nav'), { subtree: true, attributes: true, attributeFilter: ['class'] }); title();
  }

  function init() { initDrawer(); initPlayer(); initRanges(); initPickers(); initMisc(); }
  document.addEventListener('DOMContentLoaded', init);
})();
