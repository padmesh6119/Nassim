(function () {
  const T = window.TERRAIN, C = window.MAPCOL;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const TOKEN = new URLSearchParams(location.search).get('token') || '';
  const get = (u) => fetch(u, TOKEN ? { headers: { 'x-fogline-token': TOKEN } } : undefined);
  const tok = (u) => (TOKEN ? u + (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(TOKEN) : u);
  document.querySelectorAll('[data-tok]').forEach((a) => { a.href = tok(a.getAttribute('href')); });

  let R = null;      // replay payload
  let A = null;      // the report that goes with it
  let view = 'ALPHA';
  let idx = 0;
  let playing = false;
  let lastFrameTime = 0;

  const truth = new TacMap($('truth'));
  const belief = new TacMap($('belief'));

  // ---- loading ---------------------------------------------------------
  async function loadRuns() {
    const runs = await get('/api/runs').then((r) => r.json()).then((r) => r.runs || []).catch(() => []);
    const opts = ['<option value="">This exercise</option>']
      .concat(runs.map((r) => `<option value="${esc(r.id)}">${esc(r.scenarioName)} · ${new Date(r.generatedAt).toLocaleString()} · fog ${r.fogMin} min</option>`));
    $('runSel').innerHTML = opts.join('');
  }

  async function load(runId) {
    const url = runId ? `/api/replay?run=${encodeURIComponent(runId)}` : '/api/replay';
    const res = await get(url);
    if (!res.ok) {
      $('main').innerHTML = res.status === 401
        ? '<div class="empty">The exercise is running. The replay opens at Endex.</div>'
        : '<div class="empty">No exercise to replay yet. Run one from the instructor console, then come back.</div>';
      $('scrub').style.display = 'none';
      return;
    }
    const data = await res.json();
    R = data.replay; A = data.aar;
    if (!R || !R.frames || !R.frames.length) {
      $('main').innerHTML = '<div class="empty">That exercise has no recorded frames.</div>';
      return;
    }
    const qs = new URLSearchParams(location.search);
    // Open where the gap is, not on an empty battlefield: an explicit moment if
    // asked for, otherwise the moment the debrief singled out.
    const km = A && A.keyMoment;
    view = R.pids.includes(qs.get('pid')) ? qs.get('pid') : km ? km.pid : R.pids[0];
    idx = 0;
    let want = parseFloat(qs.get('t'));
    if (!Number.isFinite(want) && km) want = km.t;
    if (Number.isFinite(want)) {
      let bd = Infinity;
      R.frames.forEach((fr, i) => { const d = Math.abs(fr.t - want); if (d < bd) { bd = d; idx = i; } });
    }
    $('range').max = R.frames.length - 1;
    $('range').value = idx;
    $('tabs').innerHTML = R.pids.map((p) => `<button data-p="${p}">${p}</button>`).join('');
    $('meta').textContent = `${A.scenario.name} · cost of fog ${A.costOfFog.reactionDelayMin} min`;
    renderMarks();
    renderLanes();
    draw();
  }

  $('runSel').onchange = (e) => load(e.target.value);
  $('tabs').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { view = b.dataset.p; draw(); } };

  // ---- transport -------------------------------------------------------
  function setIdx(i) {
    idx = Math.max(0, Math.min(R.frames.length - 1, i));
    $('range').value = idx;
    draw();
  }
  $('range').oninput = (e) => { playing = false; updatePlayBtn(); setIdx(+e.target.value); };
  $('playBtn').onclick = () => {
    if (idx >= R.frames.length - 1) idx = 0;
    playing = !playing;
    lastFrameTime = performance.now();
    updatePlayBtn();
  };
  function updatePlayBtn() {
    $('playBtn').textContent = playing ? 'Pause' : 'Play';
    $('playBtn').className = 'btn ' + (playing ? 'warn' : 'go');
  }
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (!R) return;
    if (e.code === 'Space') { e.preventDefault(); $('playBtn').click(); }
    else if (e.key === 'ArrowRight') { playing = false; updatePlayBtn(); setIdx(idx + (e.shiftKey ? 10 : 1)); }
    else if (e.key === 'ArrowLeft') { playing = false; updatePlayBtn(); setIdx(idx - (e.shiftKey ? 10 : 1)); }
    else if (['1', '2', '3'].includes(e.key) && R.pids[+e.key - 1]) { view = R.pids[+e.key - 1]; draw(); }
  });

  // ---- scrub furniture -------------------------------------------------
  const tOf = (i) => R.frames[i].t;
  const span = () => Math.max(0.001, tOf(R.frames.length - 1) - tOf(0));
  const pctOf = (t) => ((t - tOf(0)) / span()) * 100;
  const idxAt = (t) => {
    let best = 0, bd = Infinity;
    R.frames.forEach((f, i) => { const d = Math.abs(f.t - t); if (d < bd) { bd = d; best = i; } });
    return best;
  };

  function renderMarks() {
    const glyph = { instructor: ['⚑', '#d9a63f'], inject: ['◆', '#b99ae0'], redcell: ['◆', '#b99ae0'], combat: ['✕', '#e8898d'], intent: ['▲', '#d9a63f'], phantom: ['◆', '#b99ae0'] };
    $('marks').innerHTML = R.bookmarks.map((b) => {
      const [ch, col] = glyph[b.kind] || ['•', '#7d9686'];
      return `<span class="mark" style="left:${pctOf(b.t)}%;color:${col}" data-t="${b.t}" title="${esc((b.clock || '') + ' ' + b.label)}">${ch}</span>`;
    }).join('');
    $('marks').onclick = (e) => {
      const m = e.target.closest('[data-t]');
      if (m) { playing = false; updatePlayBtn(); setIdx(idxAt(+m.dataset.t)); }
    };
  }

  // One lane per commander: accuracy line over red shading for degraded comms.
  function renderLanes() {
    $('lanes').innerHTML = R.pids.map((p) => `<span class="nm">${p}</span><canvas data-lane="${p}"></canvas>`).join('');
    $('lanes').onclick = (e) => {
      const cv = e.target.closest('[data-lane]');
      if (!cv) return;
      const r = cv.getBoundingClientRect();
      const k = (e.clientX - r.left) / r.width;
      playing = false; updatePlayBtn();
      setIdx(Math.round(k * (R.frames.length - 1)));
      view = cv.dataset.lane;
      draw();
    };
    requestAnimationFrame(drawLanes);
  }

  function drawLanes() {
    for (const p of R.pids) {
      const cv = $('lanes').querySelector(`[data-lane="${p}"]`);
      if (!cv) continue;
      const r = cv.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      cv.width = Math.max(1, Math.round(r.width * dpr));
      cv.height = Math.round(26 * dpr);
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const W = r.width, H = 26;
      g.fillStyle = '#1f1e19';
      g.fillRect(0, 0, W, H);
      const n = R.frames.length;
      // degraded shading
      for (let i = 0; i < n; i++) {
        const sev = R.frames[i].l[p] ? R.frames[i].l[p].s : 0;
        if (sev > 0) {
          g.fillStyle = `rgba(184,35,43,${0.18 + 0.42 * sev})`;
          g.fillRect((i / (n - 1)) * W, 0, Math.max(1, W / n + 1), H);
        }
      }
      // accuracy line
      g.beginPath();
      for (let i = 0; i < n; i++) {
        const acc = R.frames[i].l[p] ? R.frames[i].l[p].acc : 100;
        const x = (i / (n - 1)) * W, y = H - 2 - ((H - 5) * acc) / 100;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = '#6fbf8f';
      g.lineWidth = 1.4;
      g.stroke();
      // playhead
      const px = (idx / Math.max(1, n - 1)) * W;
      g.fillStyle = '#ded5c0';
      g.fillRect(px - 1, 0, 2, H);
    }
  }

  // ---- drawing ---------------------------------------------------------
  function draw() {
    if (!R) return;
    const f = R.frames[idx];
    $('clock').textContent = f.clock;
    $('pos').textContent = `${idx + 1}/${R.frames.length}`;
    $('bTitle').textContent = `As ${view} believed it`;
    $('tabs').querySelectorAll('[data-p]').forEach((b) => b.classList.toggle('on', b.dataset.p === view));
    const L = f.l[view] || { s: 0, acc: 100 };
    $('truthSub').textContent = `${f.e.filter((e) => e.a).length} enemy live · ${f.u.filter((u) => u.a).length} of 3 effective`;

    const now = performance.now() / 1000;
    FrameDraw.drawTruth(truth, f, { emitters: R.emitters, intent: R.intent, focus: view, now });
    FrameDraw.drawBelief(belief, f, view, { now });

    drawLanes();
  }

  // ---- playback loop ---------------------------------------------------
  (function loop() {
    requestAnimationFrame(loop);
    if (!R) return;
    if (playing) {
      const now = performance.now();
      const dt = (now - lastFrameTime) / 1000;
      const step = R.interval / +$('speedSel').value;
      if (dt >= step) {
        lastFrameTime = now;
        if (idx >= R.frames.length - 1) { playing = false; updatePlayBtn(); }
        else setIdx(idx + 1);
      }
    } else if (R) {
      // keep the maps live for the pulsing emitters even while paused
      draw();
    }
  })();

  window.addEventListener('resize', () => { if (R) { renderMarks(); requestAnimationFrame(drawLanes); } });

  const startRun = new URLSearchParams(location.search).get('run') || '';
  loadRuns().then(() => { if (startRun) $('runSel').value = startRun; return load(startRun); });
})();
