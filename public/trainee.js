(function () {
  const T = window.TERRAIN, C = window.MAPCOL;
  const PIDS = ['ALPHA', 'BRAVO', 'CHARLIE'];
  const qs = new URLSearchParams(location.search);
  const pid = qs.get('pid');
  const seat = qs.get('seat') || '';
  const $ = (id) => document.getElementById(id);
  const curtain = $('curtain');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  if (!PIDS.includes(pid)) {
    curtain.style.display = 'flex';
    curtain.innerHTML = '<h1>Which callsign?</h1><div style="display:flex;gap:10px">'
      + PIDS.map((p) => `<a class="btn lg" href="/trainee?pid=${p}">${p}</a>`).join('') + '</div>';
    return;
  }
  // A seat is opened with the four-digit code the instructor gives each commander,
  // so a stray laptop or phone on the WiFi cannot give orders as somebody else.
  function askSeat(note) {
    curtain.style.display = 'flex';
    curtain.innerHTML = `<h1>${pid}</h1>
      <form class="whoami" id="seatForm">
        <label for="seatCode">Seat code</label>
        <input type="text" id="seatCode" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="4 digits">
        <button class="btn go" type="submit">Open</button>
        <span class="why2">${note || 'The instructor has a four-digit code for each seat.'}</span>
      </form>`;
    $('seatCode').focus();
    $('seatForm').onsubmit = (ev) => {
      ev.preventDefault();
      const code = $('seatCode').value.trim();
      if (!/^\d{4}$/.test(code)) return;
      location.search = `?pid=${encodeURIComponent(pid)}&seat=${encodeURIComponent(code)}`;
    };
  }
  if (!/^\d{4}$/.test(seat)) { askSeat(); return; }
  document.title = `${pid} — FOGLINE`;
  $('callsign').textContent = pid;

  let S = null, mode = 'move', ref = null, why = null, intentOpen = false;
  let lastHp = null, wasUnderFire = false, lastDisputes = 0;
  const seenTracks = new Set();     // so a new contact can be announced once
  const freshUntil = {};            // track -> time its arrival highlight ends
  const trail = {};                 // track -> recent believed positions, never ground truth

  const REASONS = ['Eyes on', 'Spot report', 'UAV confirmed', 'Teammate asked', 'Acting on intent', 'I doubt the report'];
  $('why').innerHTML = REASONS.map((r) => `<button data-r="${r}">${r}</button>`).join('');
  $('why').onclick = (e) => {
    const r = e.target.dataset.r;
    if (!r) return;
    why = why === r ? null : r;
    [...$('why').children].forEach((b) => b.classList.toggle('on', b.dataset.r === why));
  };

  function toast(text, bad) {
    const d = document.createElement('div');
    d.className = 'toast' + (bad ? ' bad' : '');
    d.textContent = text;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2400);
  }

  const MODE_TEXT = { move: 'move — click the sheet', fire: 'fire mission — click the target', uav: 'UAV sweep — click the area' };
  function setMode(m) {
    mode = m;
    document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
    $('modeBadge').textContent = MODE_TEXT[m];
  }
  document.querySelectorAll('[data-mode]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.mode === 'fire' && S && S.rounds === 0) return toast('No fire missions left', true);
      setMode(b.dataset.mode);
    };
  });
  setMode('move');

  function reason() {
    const parts = [why, $('rationale').value.trim()].filter(Boolean);
    if (!parts.length && ref) parts.push(`Acting on ${ref}`);
    return parts.join(' — ');
  }
  function clearReason() {
    $('rationale').value = '';
    why = null;
    [...$('why').children].forEach((b) => b.classList.remove('on'));
  }

  async function act(body) {
    try {
      const res = await fetch('/api/action', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pid, seat, ...body }),
      });
      if (res.status === 401) { askSeat('That seat code was not accepted. Check it with the instructor.'); return { error: 'seat' }; }
      const r = await res.json();
      if (r.error) toast(r.error, true);
      return r;
    } catch { toast('No connection to exercise control', true); return { error: 'network' }; }
  }

  async function order(type, p) {
    const r = await act({ type, rationale: reason(), ref, ...(p || {}) });
    if (!r.ok) return;
    const d = r.decision;
    if (d && d.lost) Radio.failed(); else if (['fire', 'uav', 'auth'].includes(type)) Radio.transmit();
    if (d) addEntry({
      id: 0, kind: 'OUT', from: `${pid}, out`, rcvdClock: d.clock, lag: 0,
      text: d.desc + (d.rationale ? ` — ${d.rationale}` : '') + (d.lost ? ' (did not get through)' : ''),
    });
    if (d && d.lost) toast(d.desc + ' — the request never got through', true);
    else toast(d ? d.desc : type);
    clearReason();
    if (type !== 'move') setMode('move');
  }

  const soundLabel = () => { $('soundBtn').textContent = Radio.muted ? 'sound off' : 'sound on'; };
  $('soundBtn').onclick = () => { Radio.setMuted(!Radio.muted); soundLabel(); };
  soundLabel();

  $('holdBtn').onclick = () => order('hold');
  $('authBtn').onclick = () => order('auth');
  $('chat').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      act({ type: 'chat', text: e.target.value.trim() }).then((r) => { if (r.ok) { Radio.transmit(); toast('Sent on the team net'); } });
      e.target.value = '';
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (judging) {
      const map = { 5: 50, 6: 60, 7: 70, 8: 80, 9: 90, 0: 100 };
      if (k in map) { e.preventDefault(); submitJudgement(map[k]); return; }
      if (k === 'escape') { judging = null; trackSig = ''; drawTracks(); return; }
    }
    if (k === 'm') setMode('move');
    else if (k === 'f') { if (S && S.rounds === 0) toast('No fire missions left', true); else setMode('fire'); }
    else if (k === 'u') setMode('uav');
    else if (k === 'h') order('hold');
    else if (k === 'a') order('auth');
    else if (k === 'escape') { setMode('move'); ref = null; drawTracks(); }
  });

  const map = new TacMap($('map'), {
    onClick: (w) => {
      if (S && mode === 'move') {
        const hit = S.tracks.find((t) => Math.hypot(t.x - w.x, t.y - w.y) < 17 / map.s);
        if (hit && ref !== hit.track) { ref = hit.track; drawTracks(); return; }
      }
      order(mode, { x: Math.round(w.x), y: Math.round(w.y) });
    },
  });

  $('task').onclick = (e) => { if (e.target.closest('#intentBtn')) intentOpen = !intentOpen; };

  // ── contacts, disagreements, and how sure you are ───────────────────
  // Committing to a report — confirming it, rejecting it, or deciding a
  // disagreement — asks one more thing: how sure. That number is what the
  // debrief scores calibration on, so it is two clicks, never typing.
  let judging = null;           // { kind: 'mark'|'resolve', track?, mark?, dispute?, answer? }
  const SURE = [50, 60, 70, 80, 90, 100];

  function picker() {
    return `<div class="sure">
      <span class="q">How sure?</span>
      ${SURE.map((v) => `<button data-sure="${v}" title="${v === 50 ? 'a coin flip' : v === 100 ? 'certain' : v + '% sure'}">${v}</button>`).join('')}
      <button class="cancel" data-sure="cancel">Cancel</button>
    </div>`;
  }

  function submitJudgement(conf) {
    const j = judging;
    judging = null;
    if (!j) return;
    const body = j.kind === 'mark'
      ? { type: 'mark', track: j.track, mark: j.mark, confidence: conf, rationale: reason() }
      : { type: 'resolve', dispute: j.dispute, answer: j.answer, confidence: conf, rationale: reason() };
    act(body).then((r) => {
      if (!r.ok) return;
      clearReason();
      if (r.feedback) toast(r.feedback, /^Wrong/.test(r.feedback));
      else if (r.decision) toast(r.decision.desc);
      trackSig = ''; drawTracks();
    });
  }

  $('tracks').onclick = (e) => {
    const sure = e.target.closest('[data-sure]');
    if (sure) {
      if (sure.dataset.sure === 'cancel') { judging = null; trackSig = ''; drawTracks(); return; }
      return submitJudgement(+sure.dataset.sure);
    }
    const ans = e.target.closest('[data-answer]');
    if (ans) { judging = { kind: 'resolve', dispute: ans.dataset.dispute, answer: ans.dataset.answer }; trackSig = ''; drawTracks(); return; }
    const b = e.target.closest('button[data-mark]');
    if (b) {
      if (b.dataset.mark === 'SUSPECT') {
        // doubt is not a commitment, so it does not ask how sure
        act({ type: 'mark', track: b.dataset.t, mark: 'SUSPECT', rationale: reason() }).then((r) => { if (r.ok) clearReason(); });
        return;
      }
      judging = { kind: 'mark', track: b.dataset.t, mark: b.dataset.mark };
      trackSig = ''; drawTracks();
      return;
    }
    const row = e.target.closest('.track');
    if (row) { ref = ref === row.dataset.t ? null : row.dataset.t; drawTracks(); }
  };

  const tag = (t) => (t ? `<span class="srctag">${esc(t)}</span>` : '');

  function drawDisputes() {
    return (S.disputes || []).map((d) => {
      const open = judging && judging.kind === 'resolve' && judging.dispute === d.id;
      const claims = d.claims.map((c) => `<div class="claim">${tag(c.tag)}<span>${esc(c.text)}</span></div>`).join('');
      const waiting = d.waiting ? `<div class="claim quiet">${d.waiting} more report${d.waiting === 1 ? '' : 's'} on the way…</div>` : '';
      return `<div class="dispute">
        <div class="dhead"><b>Sources disagree about ${esc(d.grid)}</b>
          <span class="left" data-countdown="${d.id}">${d.secondsLeft}s to decide</span></div>
        ${claims}${waiting}
        <div class="dq">What do you believe?</div>
        ${open
          ? `<div class="chosen">${judging.answer === 'present' ? 'The enemy is there' : 'The area is clear'}</div>${picker()}`
          : `<div class="dbtns">
              <button class="btn alarm" data-dispute="${d.id}" data-answer="present">The enemy is there</button>
              <button class="btn go" data-dispute="${d.id}" data-answer="absent">The area is clear</button>
            </div>`}
      </div>`;
    }).join('');
  }

  function drawTracks() {
    if (!S) return;
    const warn = (S.conflicts || []).map((k) => `<div class="warnbox">
      Two reports of <b>${k.track}</b> disagree by <b>${k.gapM} m</b>.
      ${k.a.src === k.b.src
        ? `${esc(k.a.src)} put it at ${T.gridRef(k.a.x, k.a.y)}, then at ${T.gridRef(k.b.x, k.b.y)}.`
        : `${esc(k.a.src)} puts it at ${T.gridRef(k.a.x, k.a.y)}, ${esc(k.b.src)} at ${T.gridRef(k.b.x, k.b.y)}.`}
      Send the UAV, or decide which source you trust.</div>`).join('');

    const rows = [...S.tracks].sort((a, b) => a.track.localeCompare(b.track)).map((t) => {
      const age = t.visual
        ? '<b style="color:var(--red)">eyes on</b>'
        : `${esc(t.src)}, ${t.age.toFixed(1)} min old`;
      const flags = (t.notObserved ? ' · <span style="color:var(--ochre)">not where it was reported</span>' : '')
        + (t.garbled ? ' · <span style="color:var(--ochre)">corrupted</span>' : '');
      const fresh = freshUntil[t.track] && performance.now() < freshUntil[t.track];
      const asking = judging && judging.kind === 'mark' && judging.track === t.track;
      return `<div class="track ${t.mark} ${ref === t.track ? 'sel' : ''} ${fresh ? 'fresh' : ''}" data-t="${t.track}">
        <span class="id">${t.track}</span>
        <span>${tag(t.visual ? 'EYES' : t.sourceTag)}<span class="what">${esc(t.type)}</span> <span class="mono" style="font-size:12.5px">${T.gridRef(t.x, t.y)}</span>
          <br><span class="meta">${age}${flags}</span></span>
        <span class="acts">${[['CONFIRMED', 'Confirm'], ['SUSPECT', 'Doubt'], ['DISMISSED', 'Reject']]
          .map(([m, lab]) => `<button data-t="${t.track}" data-mark="${m}" class="${t.mark === m || (asking && judging.mark === m) ? 'sel' : ''}">${lab}</button>`).join('')}</span>
        ${asking ? `<div class="askrow">${picker()}</div>` : ''}
      </div>`;
    }).join('');

    $('tracks').innerHTML = drawDisputes() + warn + (rows || `<div class="nothing">Nothing on your picture yet.
      <b>That is not the same as nothing being out there</b> — you see enemy forces yourself only inside your sensor ring.</div>`);
    $('refHint').innerHTML = ref
      ? `order tied to <b class="mono">${ref}</b> — Esc clears`
      : 'click a contact to tie your order to it';
  }

  // the countdown ticks without rebuilding the panel under the commander's cursor
  function tickCountdowns() {
    for (const d of (S && S.disputes) || []) {
      const el = document.querySelector(`[data-countdown="${d.id}"]`);
      if (el) { el.textContent = `${d.secondsLeft}s to decide`; el.classList.toggle('urgent', d.secondsLeft <= 10); }
    }
  }

  // ── signals log ─────────────────────────────────────────────────────
  const LANE = {
    CONTACT: 'own', SPOTREP: 'hostile', ISR: 'hostile', UAVREP: 'hostile',
    CHAT: 'friend', BDA: 'friend', HQ: 'control', INTENT: 'control', OUT: 'out',
    PATROL: 'hostile', DRONE: 'hostile', SIGINT: 'control', TRUTH: 'truth',
    FIRES: 'control', AUTH: 'control', ORDER: 'suspect',
  };
  let serial = 0;
  function addEntry(m, prepend = true) {
    const ser = ++serial;
    const d = document.createElement('div');
    d.className = `entry ${LANE[m.kind] || ''}${m.garbled ? ' garbled' : ''}`;
    const late = m.lag >= 0.5 ? `<span class="late">${m.lag.toFixed(1)} min late</span>` : '';
    const unauth = m.kind === 'ORDER' ? '<span class="unauth">not authenticated</span>' : '';
    const corrupt = m.garbled ? '<span class="corrupt">corrupted</span>' : '';
    const srcTag = { UAV: 'DRONE', SCOUT: 'GROUND', SIGINT: 'SIGINT' }[m.source];
    d.innerHTML = `<span class="ser">${String(ser).padStart(3, '0')}</span>
      <span class="dtg">${m.rcvdClock}</span>
      <span>${srcTag ? `<span class="srctag">${srcTag}</span>` : ''}<span class="from">${esc(m.from)}</span> ${late} ${unauth} ${corrupt}
        <br><span class="txt">${esc(m.text)}</span></span>`;
    const log = $('log');
    if (prepend) log.prepend(d); else log.appendChild(d);
    while (log.children.length > 90) log.lastChild.remove();
  }

  // ── stream ──────────────────────────────────────────────────────────
  let trackSig = '';
  const es = new EventSource(`/events?role=trainee&pid=${encodeURIComponent(pid)}&seat=${encodeURIComponent(seat)}`);
  es.addEventListener('history', (e) => { $('log').innerHTML = ''; serial = 0; JSON.parse(e.data).forEach((m) => addEntry(m)); });
  es.addEventListener('msg', (e) => {
    const m = JSON.parse(e.data);
    addEntry(m);
    if (m.kind === 'CONTACT') Radio.contact();
    else if (m.garbled) Radio.garbled();
    else Radio.receive();
  });
  es.addEventListener('reset', () => {
    $('log').innerHTML = ''; ref = null; trackSig = ''; lastHp = null; serial = 0;
    seenTracks.clear();
    for (const k of Object.keys(trail)) delete trail[k];
    for (const k of Object.keys(freshUntil)) delete freshUntil[k];
  });
  es.onerror = () => {
    $('status').textContent = 'LINK LOST'; $('status').className = 'state ENDED';
    // never connected at all: most likely the seat code, so ask rather than retry forever
    if (!S) act({ type: 'identify', name: '', auto: true }).then((r) => { if (r.error === 'seat') es.close(); });
  };
  es.addEventListener('reload', () => location.reload());

  es.addEventListener('state', (e) => {
    S = JSON.parse(e.data);
    $('clock').textContent = S.clock;
    $('status').textContent = S.status;
    $('status').className = 'state ' + S.status;
    $('unitname').textContent = S.who && S.who !== pid ? `${S.who} · ${S.me.name}` : S.me.name;
    $('hp').textContent = S.me.hp;
    $('hp').style.color = S.me.hp > 50 ? '#ded5c0' : S.me.hp > 25 ? '#e0b659' : '#e8898d';
    $('rounds').textContent = S.rounds;
    $('roundsBtn').textContent = S.rounds ? `(${S.rounds})` : '(none left)';
    document.querySelector('[data-mode="fire"]').disabled = S.rounds === 0;
    $('scenName').textContent = S.scenario.area;

    const bars = Math.round(S.signal * 5);
    $('signal').className = 'bars' + (S.severity > 0 ? ' bad' : '');
    $('signal').innerHTML = [1, 2, 3, 4, 5].map((i) => `<i class="${i > bars ? 'off' : ''}" style="height:${i * 2.6 + 4}px"></i>`).join('');
    $('netState').innerHTML = S.severity > 0
      ? `<span style="color:var(--red)">interference ${Math.round(S.severity * 100)}%${S.df ? `, bearing ${String(S.df.bearing).padStart(3, '0')}°` : ''}</span>`
      : '';
    $('gps').className = 'gps' + (S.gpsDegraded ? ' bad' : '');
    $('gps').textContent = S.gpsDegraded ? 'GPS spoofed, your reported position is wrong' : 'GPS good';

    const task = S.intent.task;
    const fighting = S.status === 'RUNNING' && !intentOpen;
    $('task').innerHTML = (task
      ? `<div class="mytask"><b>Your task.</b> ${esc(task.text)}, centred ${T.gridRef(task.area.x, task.area.y)}.</div>` : '')
      + (fighting
        ? `<button class="intentbtn" id="intentBtn">Commander's intent</button>`
        : `<div class="intent"><b>${esc(S.intent.commander)}'s intent.</b> ${esc(S.intent.text)}
           ${S.status === 'RUNNING' ? '<button class="intentbtn" id="intentBtn">Hide</button>' : ''}</div>`);

    const now = performance.now();
    for (const t of S.tracks) {
      if (!seenTracks.has(t.track)) {
        if (seenTracks.size || S.t > 2) freshUntil[t.track] = now + 2400;   // not on first paint
        seenTracks.add(t.track);
      }
      const h = trail[t.track] || (trail[t.track] = []);
      const last = h[h.length - 1];
      if (!last || Math.hypot(last.x - t.x, last.y - t.y) > 6) {
        h.push({ x: t.x, y: t.y });
        if (h.length > 7) h.shift();
      }
    }

    // strength falling is felt, not read
    if (lastHp != null && S.me.hp < lastHp) {
      $('hp').classList.remove('hit'); void $('hp').offsetWidth; $('hp').classList.add('hit');
    }
    lastHp = S.me.hp;

    const visualNear = S.tracks.filter((t) => t.visual).map((t) => t.track);
    if (S.underFire && !wasUnderFire && S.status === 'RUNNING') Radio.contact();
    wasUnderFire = !!S.underFire;
    const down = !S.me.alive && S.status === 'RUNNING';
    $('downbar').className = 'downbar' + (down ? ' on' : '');
    $('downbar').innerHTML = down ? `<b>${pid} is combat ineffective</b>
      <span>Your sub-unit was destroyed${S.me.diedClock ? ' at ' + S.me.diedClock : ''}. Keep watching —
      this is the last picture you had, and the debrief will show what was really out there.</span>` : '';
    document.querySelector('.orderform').classList.toggle('dead', !S.me.alive);
    $('contactbar').className = 'contactbar' + (S.underFire && S.status === 'RUNNING' ? ' on' : '');
    $('contactbar').innerHTML = `Contact — you are under fire <small>${visualNear.length ? visualNear.join(', ') + ' in sight' : 'enemy not identified'} · strength ${S.me.hp}</small>`;

    $('left').textContent = S.status === 'RUNNING' || S.status === 'PAUSED'
      ? `${Math.floor(S.remaining / 60)}:${String(S.remaining % 60).padStart(2, '0')} left` : '';

    const pend = S.pending || [];
    $('pendingRow').style.display = pend.length ? 'flex' : 'none';
    $('pending').innerHTML = pend.map((p) => `<span class="inair">${esc(p.kind)}${p.x != null ? ' ' + T.gridRef(p.x, p.y) : ''}
      <span class="w">sent ${p.waiting.toFixed(1)} min ago, not acknowledged</span></span>`).join('');

    const sig = JSON.stringify([S.tracks.map((t) => [t.track, t.mark, t.visual, t.notObserved, Math.round(t.age * 2), t.garbled, t.sourceTag]),
      (S.conflicts || []).length, ref, judging, (S.disputes || []).map((d) => [d.id, d.claims.length, d.waiting])]);
    // a disagreement that closed while the commander was choosing takes its picker with it
    if (judging && judging.kind === 'resolve' && !(S.disputes || []).some((d) => d.id === judging.dispute)) judging = null;
    if (sig !== trackSig) { trackSig = sig; drawTracks(); }
    tickCountdowns();
    if ((S.disputes || []).length > lastDisputes && S.status === 'RUNNING') Radio.contact();
    lastDisputes = (S.disputes || []).length;

    drawCurtain(task);
  });

  // ── the curtain: built once per state, so a name being typed is never wiped ──
  const NAME_KEY = 'fogline.name';
  let myName = '';
  try { myName = localStorage.getItem(NAME_KEY) || ''; } catch { /* storage blocked: ask again next time */ }
  const identify = (auto) => act({ type: 'identify', name: myName, auto: auto === true });
  es.addEventListener('open', () => identify(true));
  es.addEventListener('reset', () => identify(true));

  let curtainMode = null;
  function drawCurtain(task) {
    const mode = S.status === 'LOBBY' ? 'lobby' : S.status === 'ENDED' ? 'ended' : S.status === 'PAUSED' ? 'paused' : 'none';
    if (mode !== curtainMode) {
      curtainMode = mode;
      curtain.style.display = mode === 'none' ? 'none' : 'flex';
      if (mode === 'lobby') {
        curtain.innerHTML = `<h1>${pid}</h1>
          <form class="whoami" id="whoForm">
            <label for="whoName">Your name</label>
            <input type="text" id="whoName" maxlength="40" autocomplete="off" placeholder="e.g. Capt Rao" value="${esc(myName)}">
            <button class="btn go" type="submit">Save</button>
            <span class="why2">Your record follows your name between rounds, so the debrief can show whether your judgement improved.</span>
          </form>
          <div class="oporder">
            <h2>Situation</h2>
            <p>${esc(S.scenario.brief)}</p>
            <h2>Mission</h2>
            <p class="mission">${task ? esc(task.text) + ', centred ' + T.gridRef(task.area.x, task.area.y) + '.' : ''}</p>
            <h2>Execution — commander's intent</h2>
            <p>${esc(S.intent.text)}</p>
            <h2>Command and signal</h2>
            <p>You see enemy forces yourself only inside your own sensor ring. Everything beyond it comes from
            other sources — a ground patrol, the drone feed, signals intercept, the other two commanders — and
            any of them can be late, wrong, or deliberately false. When they disagree you will be asked who you
            believe, and how sure you are. Saying 90% and being right half the time is scored as a failure.</p>
            <dl>
              <dt>M</dt><dd>move</dd>
              <dt>F</dt><dd>fire mission, from a small allocation the whole company shares</dd>
              <dt>U</dt><dd>UAV sweep — check a report before you act on it</dd>
              <dt>H</dt><dd>hold and defend</dd>
              <dt>A</dt><dd>challenge an order from HQ that looks wrong</dd>
              <dt>5–0</dt><dd>how sure you are, 50% to 100%, when asked</dd>
            </dl>
          </div>
          <div class="seats" id="seatsLine"></div>
          <div class="quiet">Waiting for the instructor to begin.</div>`;
        $('whoForm').onsubmit = (ev) => {
          ev.preventDefault();
          myName = $('whoName').value.trim();
          try { localStorage.setItem(NAME_KEY, myName); } catch { /* fine */ }
          identify(false).then((r) => { if (r.ok) toast(r.who === pid ? 'Playing as ' + pid : 'Saved — playing as ' + r.who); });
        };
      } else if (mode === 'ended') {
        curtain.innerHTML = '<h1>Endex</h1><div class="quiet">Exercise complete. The debrief is on the main screen.</div>';
      } else if (mode === 'paused') {
        curtain.innerHTML = '<h1>Paused</h1><div class="quiet">Held by the instructor.</div>';
      }
    }
    if (mode === 'lobby' && $('seatsLine')) {
      $('seatsLine').innerHTML = PIDS.map((p) => {
        const n = (S.seats || {})[p] || 0;
        const cls = n > 1 ? 'dup' : n === 1 ? 'here' : '';
        const note = n > 1 ? `${n} laptops on this callsign` : n === 1 ? 'at their station' : 'not connected';
        return `<span class="${cls}"><span class="dot ${n ? 'on' : ''}"></span>${p} — ${note}</span>`;
      }).join('');
    }
  }

  // ── render ──────────────────────────────────────────────────────────
  function draw() {
    requestAnimationFrame(draw);
    if (!S || !map.s) return;
    const now = performance.now() / 1000;
    map.begin();
    const me = S.me;

    map.veil(me, S.sensorRange);
    if (S.intent.task) map.intentArea({ id: 'task', area: S.intent.task.area }, { text: 'your task area' });
    for (const c of S.cleared) map.sweep(c);
    // where the open disagreement is — the place the sources named, not the truth
    for (const d of S.disputes || []) {
      map.ring(d, (24 + 3 * Math.sin(now * 3)) / map.s, C.ochre, [4, 3], 2);
      map.label(`${d.grid} — sources disagree`, d.x, d.y - 32 / map.s, C.ochre);
    }
    if (S.df) map.dfArc(me, S.df);

    map.ring(me, S.sensorRange, 'rgba(27,79,156,0.34)', [5, 4]);
    if (me.tx != null) map.line(me, { x: me.tx, y: me.ty }, 'rgba(27,79,156,0.65)', [7, 5], 2);

    for (const f of S.friends) {
      map.friendly({ ...f, hp: null, alive: true }, {
        dashed: true,
        alpha: Math.max(0.3, 1 - f.age / 6),
        text: `${f.pid}${f.age >= 0.5 ? ' ' + f.age.toFixed(1) + 'm' : ''}`,
      });
    }

    const nowMs = performance.now();
    for (const t of S.tracks) {
      const h = trail[t.track];
      if (h && h.length > 1 && t.mark !== 'DISMISSED') {
        const g = map.ctx;
        g.save();
        g.setLineDash([2, 4]);
        g.strokeStyle = 'rgba(184,35,43,0.4)';
        g.lineWidth = 1.4;
        g.beginPath();
        h.forEach((p, i) => (i ? g.lineTo(map.X(p.x), map.Y(p.y)) : g.moveTo(map.X(p.x), map.Y(p.y))));
        g.stroke();
        g.restore();
      }
      if (freshUntil[t.track] && nowMs < freshUntil[t.track]) {
        const k = 1 - (freshUntil[t.track] - nowMs) / 2400;
        map.ring(t, (18 + 36 * k) / map.s, `rgba(184,35,43,${0.8 * (1 - k)})`, [], 2.4);
      }
    }
    for (const t of S.tracks) {
      const colour = t.mark === 'DISMISSED' ? '#8a8378' : (t.mark === 'SUSPECT' || t.garbled) ? C.ochre : C.red;
      const alpha = t.visual ? 1 : Math.max(0.3, 1 - t.age / 8);
      const note = `${t.track}${t.visual ? '' : ' ' + t.age.toFixed(1) + 'm'}${t.notObserved ? ' not here' : ''}`;
      map.enemy(t, { color: colour, alpha, dashed: !t.visual, hollow: !!t.notObserved, cross: t.mark === 'DISMISSED', text: note });
      if (ref === t.track) map.ring(t, 24 / map.s, C.ink, [3, 3], 1.6);
    }

    for (const p of (S.pending || [])) {
      if (p.x == null) continue;
      map.ring(p, 20 / map.s, C.ochre, [3, 4], 1.6);
      map.label(`${p.kind}, not acknowledged`, p.x, p.y + 32 / map.s, C.ochre);
    }
    for (const f of S.effects) map.blast(f, S.t);
    map.friendly(me, { me: true, text: pid, spoofed: S.gpsDegraded });
    map.hqMarker();
    map.cursor(mode === 'fire' ? 'fire' : mode === 'uav' ? 'UAV' : '');
    if (S.status === 'RUNNING') map.static_(S.severity, now);
    if (S.underFire && S.status === 'RUNNING') {
      const g = map.ctx, a = 0.14 + 0.08 * Math.sin(now * 5);
      const grad = g.createRadialGradient(map.w / 2, map.h / 2, Math.min(map.w, map.h) * 0.35, map.w / 2, map.h / 2, Math.max(map.w, map.h) * 0.7);
      grad.addColorStop(0, 'rgba(184,35,43,0)');
      grad.addColorStop(1, `rgba(184,35,43,${a})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, map.w, map.h);
    }
  }
  draw();
})();
