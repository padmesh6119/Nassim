(function () {
  const T = window.TERRAIN, C = window.MAPCOL;
  const PIDS = ['ALPHA', 'BRAVO', 'CHARLIE'];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  let S = null, view = 'ALPHA', aiming = null, settingsBuilt = false, scenBuilt = false;

  const admin = (body) => fetch('/api/admin', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => ({ error: 'no connection' }));

  function toast(text, bad) {
    const d = document.createElement('div');
    d.className = 'toast' + (bad ? ' bad' : '');
    d.textContent = text;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 2400);
  }
  const send = (body, note) => admin(body).then((r) => { if (r.error) toast(r.error, true); else if (note) toast(note); return r; });

  // ── rail ────────────────────────────────────────────────────────────
  $('startBtn').onclick = () => send({ type: 'start' });
  $('pauseBtn').onclick = () => send({ type: 'pause' });
  $('endBtn').onclick = () => send({ type: 'end' }, 'Endex — the debrief is ready');
  $('resetBtn').onclick = () => { if (confirm('Reset the exercise? Everything from this run is cleared.')) send({ type: 'reset' }); };
  $('cfgBtn').onclick = () => { const c = $('settings'); c.style.display = c.style.display === 'flex' ? 'none' : 'flex'; };
  $('markBtn').onclick = () => {
    // one click, no modal — an instructor marking a moment is watching the screen,
    // not typing. The replay shows the clock, which is what you navigate by.
    const label = S ? `Teaching point, ${view} at ${S.clock}` : 'Teaching point';
    send({ type: 'bookmark', label, pid: view }, 'Moment marked for the replay');
  };
  $('scenSel').onchange = (e) => send({ type: 'scenario', id: e.target.value });
  $('msgText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      send({ type: 'message', pid: $('msgTo').value, text: e.target.value.trim() }, 'Sent');
      e.target.value = '';
    }
  });

  const SETTINGS = [
    ['intensity', 'Enemy groups'], ['enemySpeed', 'Enemy speed'], ['sensorRange', 'Sensor range'],
    ['duration', 'Length (sec)'], ['timeScale', 'Time scale'], ['isrInterval', 'HQ picture every'],
    ['artilleryRounds', 'Rounds'], ['delayMin', 'Delay from'], ['delayMax', 'Delay to'],
    ['dropRate', 'Loss chance'], ['garbleRate', 'Garble chance'], ['redcellBudget', 'Red cell budget'],
    ['disputeEvery', 'Disagreement every (s)'], ['disputeTTL', 'Time to decide (s)'],
  ];
  function buildSettings(cfg) {
    $('settings').innerHTML = SETTINGS.map(([k, l]) => `<label>${l}<input type="number" step="any" id="cfg_${k}" value="${cfg[k]}"></label>`).join('')
      + '<button class="btn go" id="applyCfg">Apply</button>'
      + '<span style="font-size:11.5px;color:#9a9281">Applying restarts the exercise.</span>'
      + '<span class="spacer"></span>'
      + '<span id="recordsNote" style="font-size:11.5px;color:#9a9281"></span>'
      + '<button class="btn alarm" id="clearRecords" title="Forget every trainee\'s history — use before a fresh demo">Clear trainee records</button>';
    fetch('/api/profiles').then((r) => r.json()).then((d) => {
      const n = (d.profiles || []).length;
      if ($('recordsNote')) $('recordsNote').textContent = n ? `${n} trainee record${n === 1 ? '' : 's'} on file` : 'no trainee records yet';
    }).catch(() => {});
    $('clearRecords').onclick = () => {
      if (!confirm('Forget every trainee\'s record? The red cell will have to learn them again.')) return;
      send({ type: 'profiles', op: 'clear' }, 'Trainee records cleared').then(() => { if ($('recordsNote')) $('recordsNote').textContent = 'no trainee records yet'; });
    };
    $('applyCfg').onclick = () => {
      const config = {};
      SETTINGS.forEach(([k]) => { config[k] = +$('cfg_' + k).value; });
      send({ type: 'config', config }, 'Settings applied');
    };
  }

  // ── commander desks ─────────────────────────────────────────────────
  $('desks').innerHTML = PIDS.map((p) => `
    <div class="desk" id="desk_${p}">
      <div class="who">
        <span class="dot" id="dot_${p}"></span>
        <span class="cs" data-view="${p}">${p}</span>
        <span class="whoname" id="who_${p}"></span>
        <span class="unit">${T.friendly.find((f) => f.pid === p).name}</span>
        <span class="unit" id="seat_${p}"></span>
        <span class="net" id="net_${p}"></span>
      </div>
      <div class="gauge"><i id="sev_${p}"></i></div>
      <div class="lead" id="lead_${p}"></div>
      <div class="nums" id="num_${p}"></div>
      <div class="judge" id="judge_${p}"></div>
      <div class="acts">
        <button class="btn alarm" data-act="jam" data-p="${p}">Jam</button>
        <button class="btn deceive" data-act="fake" data-p="${p}">Phantom contact</button>
        <button class="btn deceive" data-act="dispute" data-p="${p}" title="Have the ground, drone and intercept reports disagree — aimed at whatever this commander leans on">Disagreement</button>
        <button class="btn go" data-act="clear" data-p="${p}">Clear net</button>
        <button class="btn" data-act="delay" data-p="${p}">Delay</button>
        <button class="btn" data-act="drop" data-p="${p}">Dropout</button>
        <button class="btn" data-act="garble" data-p="${p}">Garble</button>
        <button class="btn deceive" data-act="falseBda" data-p="${p}" title="Report a live enemy as destroyed">False kill</button>
        <button class="btn deceive" data-act="forged" data-p="${p}" title="Send an order that did not come from HQ">Forge order</button>
        <button class="btn deceive" data-act="spoof" data-p="${p}" title="Falsify their position to the others">Spoof GPS</button>
      </div>
    </div>`).join('');

  $('viewtabs').onclick = (e) => { const b = e.target.closest('[data-v]'); if (b) view = b.dataset.v; };

  $('desks').onclick = (e) => {
    const v = e.target.closest('[data-view]');
    if (v) { view = v.dataset.view; return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const p = b.dataset.p, a = b.dataset.act;
    if (a === 'fake') return aim('fake', p);
    if (a === 'forged') return aim('forged', p);
    if (a === 'falseBda') return falseKill(p);
    if (a === 'spoof') return send({ type: 'spoof', pid: p, seconds: 30 }, `Spoofing ${p}'s position for 30 seconds`);
    if (a === 'dispute') {
      return admin({ type: 'contradiction', pid: p }).then((r) => {
        if (r.error) return toast(r.error, true);
        toast(r.note || `Disagreement staged for ${p}${S && S.judgement[p].weakSpot ? ', aimed at ' + S.judgement[p].weakSpot.label : ''}`);
      });
    }
    send({ type: 'link', pid: p, mode: a });
  };

  // Pick the live enemy closest to that commander — the one a false report hurts most.
  function falseKill(pid) {
    if (!S) return;
    const u = S.units.find((x) => x.pid === pid);
    const live = S.beliefs[pid].tracks
      .filter((t) => !t.fake && t.enemyId && S.enemies.some((e) => e.id === t.enemyId && e.alive))
      .map((t) => ({ t, d: Math.hypot(t.x - u.x, t.y - u.y) }))
      .sort((a, b) => a.d - b.d);
    if (!live.length) return toast(`${pid} is not tracking a live enemy to falsify`, true);
    send({ type: 'falseBda', pid, track: live[0].t.track }, `${pid} told ${live[0].t.track} is destroyed`);
  }

  function aim(kind, pid) {
    aiming = { kind, pid };
    const what = { fake: 'phantom contact', forged: 'forged order', jammer: 'jammer', spoofer: 'GPS spoofer' }[kind];
    $('aim').style.display = 'block';
    $('aim').textContent = `Click the truth sheet to place the ${what}${pid ? ' for ' + pid : ''} — Esc cancels`;
    if (pid) view = pid;
  }
  function unaim() { aiming = null; $('aim').style.display = 'none'; }

  function place(w) {
    if (!aiming) return;
    const x = Math.round(w.x), y = Math.round(w.y);
    const { kind, pid } = aiming;
    if (kind === 'fake') send({ type: 'fake', pid, x, y, etype: 'ARMOR' }, `Phantom armour reported to ${pid}`);
    else if (kind === 'forged') send({ type: 'forgedOrder', pid, x, y }, `Forged order sent to ${pid}`);
    else if (kind === 'jammer') send({ type: 'emitter', op: 'add', etype: 'JAMMER', x, y, r: 330 }, 'Jammer emplaced');
    else if (kind === 'spoofer') send({ type: 'emitter', op: 'add', etype: 'SPOOFER', x, y, r: 400 }, 'Spoofer emplaced');
    unaim();
  }

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') return unaim();
    if (['1', '2', '3'].includes(e.key)) { view = PIDS[+e.key - 1]; return; }
    const k = e.key.toLowerCase();
    if (k === 'j') send({ type: 'link', pid: view, mode: 'jam' });
    else if (k === 'f') aim('fake', view);
    else if (k === 'o') aim('forged', view);
    else if (k === 'b') falseKill(view);
    else if (k === 's') send({ type: 'spoof', pid: view, seconds: 30 }, `Spoofing ${view}'s position`);
    else if (k === 'm') $('markBtn').click();
    else if (e.code === 'Space') { e.preventDefault(); send({ type: S && S.status === 'RUNNING' ? 'pause' : 'start' }); }
  });

  // ── EW strip ────────────────────────────────────────────────────────
  $('ewstrip').onclick = (e) => {
    const chip = e.target.closest('[data-em]');
    if (chip) return send({ type: 'emitter', op: 'toggle', id: chip.dataset.em });
    const rm = e.target.closest('[data-rm]');
    if (rm) return send({ type: 'emitter', op: 'remove', id: rm.dataset.rm });
    const b = e.target.closest('[data-ew]');
    if (!b) return;
    if (b.dataset.ew === 'jammer') aim('jammer', null);
    else if (b.dataset.ew === 'spoofer') aim('spoofer', null);
    else send({ type: 'emitter', op: 'enable' });
  };

  // ── red cell ────────────────────────────────────────────────────────
  document.querySelectorAll('[data-rc]').forEach((b) => {
    b.onclick = () => send({ type: 'redcell', op: 'mode', mode: b.dataset.rc });
  });
  $('rcBody').onclick = (e) => {
    const b = e.target.closest('[data-rec]');
    if (b) send({ type: 'redcell', op: b.dataset.op, id: b.dataset.rec });
  };

  function drawRedcell(rc) {
    const every = S && S.cfg.disputeEvery;
    $('rcBudget').textContent = rc.mode === 'OFF' ? 'you are injecting by hand'
      : every > 0 && !rc.budget ? `a disagreement every ${every} s`
      : every > 0 ? `${rc.budget} actions left, a disagreement every ${every} s`
      : `${rc.budget} actions left`;
    document.querySelectorAll('[data-rc]').forEach((b) => b.classList.toggle('on', b.dataset.rc === rc.mode));
    const props = rc.recs.map((r) => `<div class="prop">
        <div class="hdr">${esc(r.label)} <span>${r.clock}, ${r.expiresIn}s to decide</span></div>
        <div class="arg">${esc(r.reason)}</div>
        <div class="onpaper" style="display:flex;gap:5px">
          <button class="btn deceive on" data-rec="${r.id}" data-op="approve">Approve</button>
          <button class="btn" data-rec="${r.id}" data-op="dismiss">Dismiss</button>
        </div>
      </div>`).join('');
    const past = rc.log.slice().reverse().map((l) => `<div class="rcrow">
        <span class="md ${l.mode}">${l.mode.toLowerCase()}</span>
        <span>${esc(l.label)} <span class="quiet mono" style="font-size:11px">${l.clock}</span></span>
      </div>`).join('');
    const idle = rc.mode === 'OFF'
      ? '<div class="quiet" style="padding:11px 12px;font-size:13px">Off. You are injecting by hand.</div>'
      : '<div class="quiet" style="padding:11px 12px;font-size:13px">Watching for an opening.</div>';
    $('rcBody').innerHTML = (props || idle) + past;
  }

  // ── decision feed, as a log ─────────────────────────────────────────
  const LANE = {
    decision: 'friend', inject: 'suspect', redcell: 'suspect', combat: 'own',
    fires: 'control', isr: 'hostile', coord: 'friend', intent: 'control', control: 'control', chat: 'friend',
  };
  let ser = 0;
  function entry(dtg, body, lane) {
    const d = document.createElement('div');
    d.className = 'entry ' + (lane || '');
    d.innerHTML = `<span class="ser">${String(++ser).padStart(3, '0')}</span><span class="dtg">${dtg}</span><span>${body}</span>`;
    const f = $('feed');
    f.prepend(d);
    while (f.children.length > 150) f.lastChild.remove();
  }
  function addDecision(d) {
    const ts = S ? S.cfg.timeScale : 10;
    const flags = [
      d.degraded ? '<span class="late">net degraded</span>' : '',
      d.onPhantom ? '<span class="unauth">aimed at a phantom</span>' : '',
      d.lost ? '<span class="late">request lost</span>' : '',
      d.latency != null ? `<span class="quiet">reacted in ${((d.latency * ts) / 60).toFixed(1)} min</span>` : '',
    ].filter(Boolean).join(' ');
    const outcome = d.outcome ? ` <span class="call ${d.outcome === 'right' ? 'right' : 'wrong'}">— ${esc(d.outcome)}</span>` : '';
    entry(d.clock, `<span class="from" style="color:var(--blue)">${d.pid}</span> ${flags}
      <br><span class="txt"><b>${esc(d.desc)}</b>${outcome}${d.rationale ? ` — “${esc(d.rationale)}”` : d.outcome ? '' : ' <span class="quiet">(no reason given)</span>'}
      <span class="quiet"> · picture ${d.accuracy}%</span></span>`, 'friend');
  }
  function addEvent(ev) {
    if (ev.kind === 'truth' || ev.onDecision) return;
    entry(ev.clock, `<span class="from">${ev.pid ? ev.pid : ev.kind}</span>
      <br><span class="txt">${esc(ev.text)}</span>`, LANE[ev.kind] || '');
  }

  const es = new EventSource('/events?role=instructor');
  es.addEventListener('history', (e) => {
    const h = JSON.parse(e.data);
    $('feed').innerHTML = ''; ser = 0;
    [...h.events.map((x) => ['e', x]), ...h.decisions.map((x) => ['d', x])]
      .sort((a, b) => a[1].t - b[1].t)
      .forEach(([k, x]) => (k === 'e' ? addEvent(x) : addDecision(x)));
  });
  es.addEventListener('feed', (e) => addEvent(JSON.parse(e.data)));
  es.addEventListener('decision', (e) => addDecision(JSON.parse(e.data)));
  es.addEventListener('reset', () => { $('feed').innerHTML = ''; ser = 0; settingsBuilt = false; unaim(); });
  es.addEventListener('ended', () => entry('', '<b>Endex — open the debrief</b>', 'control'));
  es.onerror = () => { $('status').textContent = 'LINK LOST'; $('status').className = 'state ENDED'; };

  es.addEventListener('state', (e) => {
    S = JSON.parse(e.data);
    $('clock').textContent = S.clock;
    $('status').textContent = S.status;
    $('status').className = 'state ' + S.status;
    $('remaining').textContent = S.status === 'ENDED' ? '' : `${Math.floor(S.remaining / 60)}:${String(S.remaining % 60).padStart(2, '0')} left`;
    $('truthSub').textContent = `${S.enemies.filter((x) => x.alive).length} enemy live · ${S.rounds} fire missions left`;

    if (!scenBuilt && S.scenario.list) {
      scenBuilt = true;
      $('scenSel').innerHTML = S.scenario.list.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    }
    $('scenSel').value = S.scenario.id;
    $('scenSel').disabled = S.status === 'RUNNING' || S.status === 'PAUSED';
    if (!settingsBuilt) {
      buildSettings(S.cfg);
      settingsBuilt = true;
      if (S.status === 'LOBBY') $('settings').style.display = 'flex';
    }

    $('ewstrip').innerHTML = `<span class="lbl">Electronic warfare</span>
      <button class="btn ${S.ewEnabled ? 'go on' : ''}" data-ew="enable">${S.ewEnabled ? 'Active' : 'Disabled'}</button>
      <button class="btn alarm" data-ew="jammer">Place jammer</button>
      <button class="btn deceive" data-ew="spoofer">Place spoofer</button>
      ${S.emitters.map((m) => `<span class="em ${m.on ? 'live' : ''} ${m.type === 'SPOOFER' ? 'spf' : ''}" data-em="${m.id}" title="Switch on or off">${m.id}</span><span class="em" data-rm="${m.id}" title="Remove">remove</span>`).join('')}`;

    for (const p of PIDS) {
      const L = S.links[p], a = S.accuracy[p], st = S.stats[p], u = S.units.find((x) => x.pid === p);
      $('desk_' + p).className = 'desk' + (view === p ? ' sel' : '') + (L.severity > 0.35 ? ' cut' : '');
      const seats = (S.seats || {})[p] || 0;
      $('dot_' + p).className = 'dot' + (seats ? ' on' : '');
      $('dot_' + p).title = seats === 0 ? `${p} is not connected`
        : seats === 1 ? `${p} is at their station` : `${seats} laptops are on ${p}`;
      $('seat_' + p).innerHTML = seats > 1
        ? `<span style="color:#e0b659">${seats} laptops on this callsign</span>`
        : seats === 0 ? '<span style="color:#7b7265">not connected</span>' : '';
      $('sev_' + p).style.width = Math.round(L.severity * 100) + '%';
      $('net_' + p).innerHTML = !u.alive
        ? `<span style="color:#e8898d">combat ineffective${u.diedClock ? ' at ' + u.diedClock : ''}</span>`
        : L.severity > 0
          ? `<span style="color:#e8898d">net ${Math.round(L.severity * 100)}% down${L.masked ? ', masked by ground' : ''}</span>`
          : '<span style="color:#7fd0a0">net clear</span>';
      $('desk_' + p).classList.toggle('down', !u.alive);
      $('num_' + p).innerHTML = [
        ['picture', Math.round(a.acc * 100) + '%'],
        ['strength', u.hp],
        ['orders', st.decisions],
        ['in flight', S.inflight[p]],
        ['lost', st.dropped],
        ['hit blind', st.blindHpLost],
      ].map(([l, v]) => `<span>${l}<b>${v}</b></span>`).join('')
        + (st.unresolved ? `<span style="color:#e0b659">contradictions<b style="color:#e0b659">${st.unresolved}</b></span>` : '')
        + (L.spoofed ? '<span style="color:#b99ae0">GPS spoofed</span>' : '');
      document.querySelectorAll(`[data-p="${p}"]`).forEach((b) => {
        const k = b.dataset.act;
        if (k === 'jam') b.classList.toggle('on', L.delay && L.drop && L.garble);
        else if (['delay', 'drop', 'garble'].includes(k)) b.classList.toggle('on', !!L[k]);
        else if (k === 'fake') b.classList.toggle('on', !!aiming && aiming.kind === 'fake' && aiming.pid === p);
        else if (k === 'forged') b.classList.toggle('on', !!aiming && aiming.kind === 'forged' && aiming.pid === p);
        else if (k === 'spoof') b.classList.toggle('on', !!L.spoofed);
      });
    }

    // the headline figure, climbing while the net is broken
    const f = S.fog || { teamMin: 0, per: {} };
    const fogEl = $('fogTeam');
    const prev = +fogEl.dataset.v || 0;
    fogEl.textContent = f.teamMin.toFixed(1);
    fogEl.dataset.v = f.teamMin;
    fogEl.classList.toggle('rising', f.teamMin > prev + 0.04);
    for (const p of PIDS) {
      const pf = f.per[p] || { min: 0, unseen: 0 };
      const col = pf.min > 1.5 ? '#f08a8e' : pf.min > 0.4 ? '#e8c983' : '#9fd3b4';
      $('lead_' + p).innerHTML = `<b style="color:${col}">${pf.min.toFixed(1)}</b>
        <span>min behind the ground${pf.unseen ? `, ${pf.unseen} threat${pf.unseen === 1 ? '' : 's'} never seen` : ''}</span>`;
    }
    $('gapnotes').innerHTML = (S.gaps[view] || []).map((n) => `<span class="${n.kind}">${esc(n.text)}</span>`).join('');

    for (const p of PIDS) {
      const J = S.judgement && S.judgement[p];
      if (!J) continue;
      $('who_' + p).textContent = J.who !== p ? J.who : '';
      const rates = ['UAV', 'SCOUT', 'SIGINT']
        .map((s) => { const t = J.trust[s]; return `${{ UAV: 'drone', SCOUT: 'ground', SIGINT: 'sigint' }[s]} ${t.rate == null ? '—' : t.rate + '%'}`; })
        .join(' · ');
      const c = J.calibration;
      const cal = c.n
        ? `said ${Math.round(c.meanConfidence * 100)}% sure, right ${Math.round(c.accuracy * 100)}% <span class="n">(${c.n})</span>`
        : 'no confidence stated yet';
      const rc = S.cfg.redcell !== 'OFF';
      const W = J.weakSpot;
      const learnt = W
        ? `<span class="lean ${rc ? 'hunted' : ''} ${W.probe ? 'probe' : ''}" title="${esc(J.reason)}">${W.probe
            ? `trusts the ${esc(W.label)}, never seen it wrong${rc ? ' — red cell will test it' : ''}`
            : ['UAV', 'SCOUT', 'SIGINT'].includes(W.source)
              ? `misled by the ${esc(W.label)}${rc ? ' — red cell will make it lie again' : ''}`
              : `weakness: ${esc(W.label)}${rc ? ' — red cell will exploit it' : ''}`}</span>`
        : `<span class="lean none">${J.rounds ? `${J.rounds} round${J.rounds === 1 ? '' : 's'} on record, no bias yet` : 'no pattern yet'}</span>`;
      $('judge_' + p).innerHTML = `<span>trusts ${rates}</span><span class="cal">this round: ${cal}</span>${learnt}`;
    }

    const calls = PIDS.reduce((acc, p) => {
      const d = S.judgement && S.judgement[p] ? S.judgement[p].disputes : { issued: 0, answered: 0, correct: 0 };
      return { issued: acc.issued + d.issued, answered: acc.answered + d.answered, correct: acc.correct + d.correct };
    }, { issued: 0, answered: 0, correct: 0 });
    $('callsRead').style.display = calls.issued ? '' : 'none';
    $('callsVal').textContent = calls.correct;
    $('callsOf').textContent = `of ${calls.answered}`;

    const a = S.accuracy[view];
    $('beliefTitle').textContent = `As ${view} believes it`;
    document.querySelectorAll('#viewtabs [data-v]').forEach((b) => b.classList.toggle('on', b.dataset.v === view));
    const pc = Math.round(a.acc * 100);
    $('acc').innerHTML = `<span style="color:${pc > 75 ? '#7fd0a0' : pc > 45 ? '#e0b659' : '#e8898d'}">picture ${pc}%</span>`;
    $('gapline').innerHTML = `average position error <b>${a.err} m</b> · the three pictures disagree by <b>${S.cop}%</b>`;

    $('startBtn').textContent = S.status === 'PAUSED' ? 'Resume' : 'Start';
    $('startBtn').disabled = !['LOBBY', 'PAUSED'].includes(S.status);
    $('pauseBtn').disabled = S.status !== 'RUNNING';
    $('endBtn').disabled = S.status === 'ENDED' || S.status === 'LOBBY';
    $('reportBtn').classList.toggle('on', S.status === 'ENDED');
    drawRedcell(S.redcell);
  });

  // ── sheets ──────────────────────────────────────────────────────────
  const truth = new TacMap($('truth'), { onClick: place });
  const belief = new TacMap($('belief'), { onClick: place });

  function drawTruth(now) {
    if (!truth.s || !S) return;
    truth.begin();
    for (const m of S.emitters) truth.emitter(m, now);
    for (const task of S.intent.tasks) {
      const u = S.units.find((x) => x.pid === task.pid);
      const covered = u && u.alive && Math.hypot(u.x - task.area.x, u.y - task.area.y) < task.area.r * 1.5;
      truth.intentArea(task, { covered, text: `${task.pid} — ${task.type}` });
    }
    for (const u of S.units) if (u.alive) truth.link(u, S.links[u.pid], now);
    truth.hqMarker();
    for (const u of S.units) if (u.alive) truth.ring(u, S.cfg.sensorRange, 'rgba(27,79,156,0.16)', [4, 5], 1);
    for (const f of S.fakes) truth.enemy(f, { color: C.violet, dashed: true, hollow: true, text: `${f.track} → ${f.to}` });
    for (const e of S.enemies) {
      truth.enemy(e, { alpha: e.alive ? 1 : 0.25, cross: !e.alive, text: `${e.track || 'untracked'}${e.alive ? ' ' + e.hp + '%' : ' destroyed'}` });
    }
    for (const u of S.units) {
      if (u.alive && u.tx != null) truth.line(u, { x: u.tx, y: u.ty }, 'rgba(27,79,156,0.5)', [6, 4], 2);
      truth.friendly(u, { text: u.pid, labelColor: view === u.pid ? C.ink : C.blue, spoofed: S.links[u.pid].spoofed });
    }
    if (S.uav.state !== 'IDLE') truth.uav(S.uav);
    for (const f of S.effects) truth.blast(f, S.t);
    truth.cursor(aiming ? aiming.kind : '');
  }

  function drawBelief(now) {
    if (!belief.s || !S) return;
    const b = S.beliefs[view];
    const me = S.units.find((u) => u.pid === view);
    belief.begin();

    // the truth, faint, so the gap is visible without explanation
    for (const e of S.enemies) if (e.alive) belief.enemy(e, { alpha: 0.13, hollow: true });

    const seen = new Set();
    for (const t of b.tracks) {
      if (t.mark === 'DISMISSED') { belief.enemy(t, { color: '#8a8378', cross: true, alpha: 0.5, text: `${t.track} rejected` }); continue; }
      if (t.fake) {
        belief.enemy(t, { color: C.violet, text: `phantom ${t.track}` });
        if (Math.sin(now * 4) > 0) belief.ring(t, 27 / belief.s, C.violet, [3, 3], 1.6);
        continue;
      }
      const e = S.enemies.find((x) => x.id === t.enemyId);
      if (e && !e.alive) { belief.enemy(t, { color: C.violet, alpha: 0.65, dashed: true, text: `${t.track} already destroyed` }); continue; }
      const off = e ? Math.hypot(e.x - t.x, e.y - t.y) : 0;
      if (e) seen.add(e.id);
      if (off > 25) belief.line(t, e, 'rgba(184,35,43,0.8)', [6, 4], 2);
      belief.enemy(t, { color: t.garbled ? C.ochre : C.red, dashed: t.age > 0.3, text: `${t.track} ${t.age.toFixed(1)}m old` });
      if (off > 25) belief.label(`${Math.round(off * T.UNIT_M)} m out`, (t.x + e.x) / 2, (t.y + e.y) / 2, C.red);
    }
    for (const e of S.enemies) {
      if (!e.alive || seen.has(e.id)) continue;
      belief.ring(e, (21 + 5 * Math.sin(now * 5)) / belief.s, C.red, [], 2.2);
      belief.label('not on their map', e.x, e.y - 25 / belief.s, C.red);
    }
    for (const f of b.friends) {
      const real = S.units.find((u) => u.pid === f.pid);
      if (real && Math.hypot(real.x - f.x, real.y - f.y) > 25) {
        belief.line(f, real, f.spoofed ? 'rgba(107,63,160,0.8)' : 'rgba(27,79,156,0.55)', [4, 3], f.spoofed ? 2 : 1.5);
        if (f.spoofed) belief.label('spoofed position', (f.x + real.x) / 2, (f.y + real.y) / 2, C.violet);
      }
      belief.friendly({ ...f, hp: null, alive: true }, { dashed: true, alpha: 0.7, text: `${f.pid} ${f.age.toFixed(1)}m`, spoofed: f.spoofed });
    }
    if (me.alive) {
      belief.ring(me, S.cfg.sensorRange, 'rgba(27,79,156,0.3)', [4, 5], 1);
      belief.friendly(me, { me: true, text: view });
    }
    belief.hqMarker();
    belief.cursor(aiming ? aiming.kind : '');
    belief.static_(S.links[view].severity * 0.5, now);
  }

  (function loop() {
    requestAnimationFrame(loop);
    if (!S) return;
    const now = performance.now() / 1000;
    drawTruth(now);
    drawBelief(now);
  })();
})();
