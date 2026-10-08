(function () {
  const T = window.TERRAIN;
  const $ = (id) => document.getElementById(id);
  const root = $('root');
  const tip = $('tip');

  // Validated against the paper surface in light mode. slot1/slot2 are the only
  // identity hues; the rest are reserved status and always carry a label.
  const K = {
    slot1: '#1b4f9c', slot2: '#8f6310',
    good: '#2e6b4f', warn: '#8f6310', crit: '#b8232b', adv: '#6b3fa0',
    grid: 'rgba(33,30,24,0.14)', ink: '#211e18', mute: '#7b7265',
  };

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Tooltip HTML lives inside a quoted attribute and is read back with
  // dataset, which decodes it once before it reaches innerHTML. So it is
  // escaped for the attribute on top of any escaping of the text inside it —
  // otherwise one quote ends the attribute and a trainee's typed reason
  // becomes markup.
  const tipAttr = (html) => String(html).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const n1 = (v, u = '') => (v == null ? '—' : v.toFixed(1) + u);
  const count = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const SANS = 'Archivo, sans-serif';
  const NARROW = '"Archivo Narrow", sans-serif';
  const MONO = '"IBM Plex Mono", monospace';

  let A = null, PIDS = [], mm = (t) => t, sec = 0;
  const num = () => String(++sec);

  // ── tooltip ─────────────────────────────────────────────────────────
  function showTip(ev, html) {
    tip.innerHTML = html;
    tip.style.display = 'block';
    const r = tip.getBoundingClientRect();
    let x = ev.clientX + 15, y = ev.clientY + 15;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 15;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 15;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  const hideTip = () => { tip.style.display = 'none'; };
  document.addEventListener('scroll', hideTip, true);
  function bindTips(scope) {
    scope.querySelectorAll('[data-tip]').forEach((el) => {
      el.addEventListener('mousemove', (ev) => showTip(ev, el.dataset.tip));
      el.addEventListener('mouseleave', hideTip);
    });
  }

  const clockAt = (t) => {
    const s = Math.floor(t * A.timeScale) + 6 * 3600;
    return String(Math.floor(s / 3600) % 24).padStart(2, '0') + ':' + String(Math.floor(s / 60) % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };

  // ── before and after, per commander: a dumbbell ─────────────────────
  function dumbbell() {
    const rows = PIDS.map((p) => ({ p, a: A.players[p].latencyClearMin, b: A.players[p].latencyDegradedMin }));
    if (!rows.some((r) => r.a != null || r.b != null)) return '<p class="quiet">No commander answered a new report during this exercise, so there is nothing to compare.</p>';
    const max = Math.max(0.5, ...rows.flatMap((r) => [r.a || 0, r.b || 0])) * 1.3;
    const L = 78, R = 104, H = 38, top = 10;
    const h = top + rows.length * H + 28;
    const X = (v) => L + ((1000 - L - R) * v) / max;
    let s = `<svg viewBox="0 0 1000 ${h}" role="img" aria-label="Mean time from a new report to the next order, clear net against degraded net">`;
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, x = X(v);
      s += `<line x1="${x}" x2="${x}" y1="${top - 4}" y2="${h - 22}" stroke="${K.grid}"/>`;
      s += `<text x="${x}" y="${h - 7}" fill="${K.mute}" font-size="11" font-family="${MONO}" text-anchor="middle">${v.toFixed(1)}</text>`;
    }
    rows.forEach((r, i) => {
      const y = top + i * H + 13;
      s += `<text x="0" y="${y + 4}" fill="${K.slot1}" font-size="14" font-weight="600" font-family="${NARROW}">${r.p}</text>`;
      s += `<line x1="${L}" x2="${1000 - R}" y1="${y}" y2="${y}" stroke="rgba(33,30,24,.09)"/>`;
      if (r.a == null && r.b == null) {
        s += `<text x="${L + 8}" y="${y + 4}" fill="${K.mute}" font-size="12" font-family="${SANS}">no new report was answered</text>`;
      }
      if (r.a != null && r.b != null) s += `<line x1="${X(r.a)}" x2="${X(r.b)}" y1="${y}" y2="${y}" stroke="rgba(33,30,24,.2)" stroke-width="3"/>`;
      if (r.a != null) {
        s += `<circle cx="${X(r.a)}" cy="${y}" r="6.5" fill="${K.good}" stroke="#e8e1d0" stroke-width="2"
              data-tip="${tipAttr(`<b>${r.p}, clear net</b><br>${r.a.toFixed(1)} min from a new report to the next order`)}"/>`;
        s += `<text x="${X(r.a)}" y="${y - 12}" fill="${K.ink}" font-size="11.5" font-family="${MONO}" text-anchor="middle">${r.a.toFixed(1)}</text>`;
      }
      if (r.b != null) {
        s += `<circle cx="${X(r.b)}" cy="${y}" r="6.5" fill="${K.crit}" stroke="#e8e1d0" stroke-width="2"
              data-tip="${tipAttr(`<b>${r.p}, degraded net</b><br>${r.b.toFixed(1)} min from a new report to the next order`)}"/>`;
        s += `<text x="${X(r.b)}" y="${y + 19}" fill="${K.ink}" font-size="11.5" font-family="${MONO}" text-anchor="middle">${r.b.toFixed(1)}</text>`;
      }
      if (r.a != null && r.b != null) {
        const d = r.b - r.a;
        s += `<text x="${1000 - R + 12}" y="${y + 4}" fill="${d > 0 ? K.crit : K.good}" font-size="12.5" font-family="${MONO}">${d > 0 ? '+' : ''}${d.toFixed(1)} min</text>`;
      }
    });
    s += '</svg>';
    return `<figure>${s}<figcaption>
      <span><i style="background:${K.good};border-radius:50%"></i>clear net</span>
      <span><i style="background:${K.crit};border-radius:50%"></i>degraded net</span>
      <span>minutes, and the penalty on the right</span></figcaption></figure>`;
  }

  // ── small multiples: one lane per commander ─────────────────────────
  function timeline() {
    const W = 1180, L = 68, R = 14, laneH = 92, top = 14;
    const tMax = Math.max(1, A.series.length ? A.series[A.series.length - 1].t : 1);
    const h = top + PIDS.length * laneH + 26;
    const X = (t) => L + ((W - L - R) * t) / tMax;
    const stepMin = mm(tMax) > 40 ? 10 : 5;
    let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="What each commander did, against how accurate their picture was and when their net was degraded">`;

    for (let m = 0; m <= mm(tMax) + 0.001; m += stepMin) {
      const x = X((m * 60) / A.timeScale);
      s += `<line x1="${x}" x2="${x}" y1="${top}" y2="${h - 22}" stroke="${K.grid}"/>`;
      s += `<text x="${x}" y="${h - 6}" fill="${K.mute}" font-size="11" font-family="${MONO}" text-anchor="middle">${m}</text>`;
    }

    PIDS.forEach((p, i) => {
      const y0 = top + i * laneH, y1 = y0 + laneH - 14;
      s += `<rect x="${L}" y="${y0}" width="${W - L - R}" height="${laneH - 14}" fill="rgba(33,30,24,.035)" stroke="rgba(33,30,24,.34)" stroke-width="1"/>`;
      s += `<text x="0" y="${y0 + 16}" fill="${K.slot1}" font-weight="600" font-size="14" font-family="${NARROW}">${p}</text>`;
      s += `<text x="0" y="${y0 + 31}" fill="${K.mute}" font-size="10.5" font-family="${SANS}">picture</text>`;
      s += `<text x="0" y="${y0 + 45}" fill="${K.mute}" font-size="10.5" font-family="${SANS}">orders</text>`;

      let st = null;
      A.series.forEach((pt, k) => {
        const d = pt.deg[p];
        if (d && st == null) st = pt.t;
        if ((!d || k === A.series.length - 1) && st != null) {
          const x = X(st), w = Math.max(2, X(pt.t) - X(st));
          s += `<rect x="${x}" y="${y0}" width="${w}" height="${laneH - 14}" fill="${K.crit}" opacity="0.13"
                data-tip="${tipAttr(`<b>${p}, net degraded</b><br>${clockAt(st)} to ${clockAt(pt.t)}, ${n1(mm(pt.t - st))} min`)}"/>`;
          st = null;
        }
      });

      const pts = A.series.map((pt) => `${X(pt.t).toFixed(1)},${(y1 - ((laneH - 30) * pt.acc[p]) / 100).toFixed(1)}`).join(' ');
      s += `<polyline points="${pts}" fill="none" stroke="${K.good}" stroke-width="2" stroke-linejoin="round"/>`;

      A.interventions.filter((v) => v.pid === p).forEach((v) => {
        const x = X(v.t);
        const what = v.kind === 'fake' ? `phantom contact ${v.track}`
          : v.kind === 'forgedOrder' ? 'forged order from HQ'
          : v.kind === 'falseBda' ? `false kill report, ${v.track}`
          : v.kind === 'spoof' ? 'position spoofed'
          : `net set to ${v.flags && v.flags.length ? v.flags.join(' and ') : 'clear'}`;
        s += `<path d="M${x} ${y0 + 3} l6 6 l-6 6 l-6 -6z" fill="${K.adv}"
              data-tip="${tipAttr(`<b>${v.clock || ''} — ${v.by === 'REDCELL' ? 'red cell' : 'instructor'}</b><br>${esc(what)}, against ${p}`)}"/>`;
      });

      A.events.filter((e) => e.pid === p && e.kind === 'combat').forEach((e) => {
        s += `<text x="${X(e.t)}" y="${y1 - 3}" fill="${K.crit}" font-size="13" text-anchor="middle" font-family="${MONO}"
              data-tip="${tipAttr(`<b>${e.clock}</b><br>${esc(e.text)}`)}">✕</text>`;
      });
      A.events.filter((e) => e.pid === p && e.kind === 'intent').forEach((e) => {
        s += `<text x="${X(e.t)}" y="${y0 + laneH - 18}" fill="${K.warn}" font-size="11" text-anchor="middle" font-family="${MONO}"
              data-tip="${tipAttr(`<b>${e.clock}, mission command</b><br>${esc(e.text)}`)}">▲</text>`;
      });

      A.decisions.filter((d) => d.pid === p).forEach((d) => {
        const x = X(d.t), y = y0 + 50;
        const col = d.onPhantom ? K.adv : K.slot1;
        const why = d.rationale ? `<br>“${esc(d.rationale)}”` : '<br>no reason given';
        const extra = (d.onPhantom ? `<br><b style="color:#c9a6f0">aimed at a contact that did not exist</b>` : '')
          + (d.lost ? `<br><b style="color:#f0a0a4">the request never got through</b>` : '')
          + (d.latency != null ? `<br>reacted ${n1(mm(d.latency))} min after the report` : '');
        s += `<circle cx="${x}" cy="${y}" r="5.5" fill="${col}" stroke="#e8e1d0" stroke-width="1.8"
              data-tip="${tipAttr(`<b>${d.clock} ${p} — ${esc(d.desc)}</b>${why}<br>picture ${d.accuracy}%, net ${d.degraded ? 'degraded' : 'clear'}${extra}`)}"/>`;
      });
    });
    s += '</svg>';
    return `<figure>${s}<figcaption>
      <span><i style="background:${K.crit};opacity:.4"></i>net degraded</span>
      <span><i class="ln" style="background:${K.good}"></i>picture accuracy</span>
      <span><i style="background:${K.slot1};border-radius:50%"></i>order given</span>
      <span class="adv">◆ inject, or an order aimed at a phantom</span>
      <span class="bad">✕ contact</span>
      <span class="warn">▲ mission command</span>
      <span>minutes from the start · hover any mark · every order is listed in full below</span>
    </figcaption></figure>`;
  }

  // ── one series over time ────────────────────────────────────────────
  function copChart() {
    const d = A.team.copSeries;
    if (!d || d.length < 2) return '';
    const W = 1180, L = 44, R = 14, H = 146, top = 10;
    const tMax = d[d.length - 1].t || 1;
    const X = (t) => L + ((W - L - R) * t) / tMax;
    const Y = (v) => top + (H - top - 24) * (1 - v / 100);
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="How far the three commanders' pictures disagreed, over time">`;
    for (let v = 0; v <= 100; v += 25) {
      s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${K.grid}"/>`;
      s += `<text x="${L - 7}" y="${Y(v) + 4}" fill="${K.mute}" font-size="10.5" font-family="${MONO}" text-anchor="end">${v}%</text>`;
    }
    const stepMin = mm(tMax) > 40 ? 10 : 5;
    for (let m = 0; m <= mm(tMax) + 0.001; m += stepMin) {
      s += `<text x="${X((m * 60) / A.timeScale)}" y="${H - 4}" fill="${K.mute}" font-size="10.5" font-family="${MONO}" text-anchor="middle">${m}</text>`;
    }
    s += `<polyline points="${d.map((p) => `${X(p.t).toFixed(1)},${Y(p.div).toFixed(1)}`).join(' ')}" fill="none" stroke="${K.warn}" stroke-width="2" stroke-linejoin="round"/>`;
    const worst = d.reduce((a, b) => (b.div > a.div ? b : a), d[0]);
    s += `<circle cx="${X(worst.t)}" cy="${Y(worst.div)}" r="5" fill="${K.warn}" stroke="#e8e1d0" stroke-width="2"/>`;
    s += `<text x="${X(worst.t)}" y="${Y(worst.div) - 11}" fill="${K.ink}" font-size="11.5" font-family="${SANS}" text-anchor="middle">worst ${worst.div}% at ${clockAt(worst.t)}</text>`;
    s += '</svg>';
    return `<figure id="copFig">${s}<figcaption>
      <span><i class="ln" style="background:${K.warn}"></i>disagreement between the three pictures, where 0% is one shared picture</span>
      <span>average ${A.team.copMeanPct}%, worst ${A.team.copWorstPct}%</span></figcaption></figure>`;
  }
  function bindCop() {
    const fig = $('copFig');
    if (!fig) return;
    const svg = fig.querySelector('svg');
    const d = A.team.copSeries;
    const tMax = d[d.length - 1].t || 1;
    svg.addEventListener('mousemove', (ev) => {
      const r = svg.getBoundingClientRect();
      const t = (((ev.clientX - r.left) / r.width * 1180) - 44) / (1180 - 58) * tMax;
      const pt = d.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a), d[0]);
      showTip(ev, `<b>${clockAt(pt.t)}</b><br>the three pictures disagreed by <b>${pt.div}%</b>`);
    });
    svg.addEventListener('mouseleave', hideTip);
  }

  // ── pieces ──────────────────────────────────────────────────────────
  const meter = (v, col) => `<span class="meter"><i style="width:${Math.max(0, Math.min(100, v))}%;background:${col}"></i></span>`;
  const accCol = (v) => (v > 75 ? K.good : v > 45 ? K.warn : K.crit);
  const verdictCol = (o) => (/OBEYED|DECEIVED|FELL/.test(o) ? K.crit
    : /REJECTED|AUTHENTICATED|RE-ACQUIRED|SUSPICION/.test(o) ? K.good
    : /NOT RECEIVED|NEVER/.test(o) ? K.mute : K.warn);
  const verdict = (o) => `<span class="verdict" style="color:${verdictCol(o)}">${esc(o.toLowerCase())}</span>`;

  function commander(p) {
    const P = A.players[p], M = P.missionCommand;
    const threats = P.threats.length ? `<table>
      <tr><th>Threat</th><th>Could have known</th><th>Did know</th><th class="n">Late by</th></tr>
      ${P.threats.map((t) => `<tr>
        <td>${t.track || t.enemy} <span class="quiet">${esc(t.type)}</span></td>
        <td class="n">${t.idealClock}</td>
        <td class="n ${t.never ? 'bad' : ''}">${t.actualClock}</td>
        <td class="n ${t.lagMin > 0.4 ? 'bad' : 'good'}">${t.never ? 'never' : t.lagMin + ' min'}</td></tr>`).join('')}
    </table>` : '<p class="quiet" style="font-size:12.5px">No enemy came within 2.5 km of this commander.</p>';

    const traces = [
      ...P.fakes.map((f) => `<div class="trace"><b>Phantom ${f.track}</b> — ${esc(f.type)} at ${f.grid},
        reported ${f.injectedClock} as if from ${esc(f.source)}. ${verdict(f.outcome)}
        <div class="steps">${f.steps.map(esc).join(' → ')}</div></div>`),
      ...P.forged.map((f) => `<div class="trace"><b>Forged order from HQ</b> — ${f.injectedClock},
        “reposition to ${f.grid}”. ${verdict(f.outcome)}</div>`),
      ...P.falseBda.map((f) => `<div class="trace"><b>False kill report, ${f.track}</b> — ${f.injectedClock},
        told a live ${esc(f.type)} was destroyed. ${verdict(f.outcome)}</div>`),
    ].join('');

    const conflicts = P.conflicts.total ? `<div class="trace" style="border-left-color:var(--c-warn);background:rgba(143,99,16,.07)">
      <b>Contradictory reports</b> — ${P.conflicts.total} times, worst gap ${P.conflicts.worstGapM} m.
      Resolved ${P.conflicts.resolved} of ${P.conflicts.total}${P.conflicts.meanResolveMin != null ? `, taking ${P.conflicts.meanResolveMin} min` : ''}.
      ${P.conflicts.total > P.conflicts.resolved ? `<span class="bad">${P.conflicts.total - P.conflicts.resolved} left unresolved.</span>` : ''}
    </div>` : '';

    return `<div class="cdr">
      <h4>${p} <small>${esc(P.name)} · ${P.alive ? 'strength ' + P.hp : '<span class="bad">combat ineffective</span>'}</small></h4>
      <dl>
        <dt>Cost of fog</dt><dd class="${P.fogMin > 0 ? 'bad' : 'good'}"><b>${P.fogMin} min</b> late${P.threats.filter((t) => t.never).length ? `, ${P.threats.filter((t) => t.never).length} never seen` : ''}</dd>
        <dt>Orders</dt><dd>${P.decisions}, ${P.withRationale} with a reason · ${count(P.unanswered, 'report')} never acted on</dd>
        <dt>Reaction</dt><dd>${n1(P.meanLatencyMin, ' min')}${P.latencyClearMin != null && P.latencyDegradedMin != null ? ` · ${P.latencyClearMin} clear, ${P.latencyDegradedMin} degraded` : ''}</dd>
        <dt>Picture</dt><dd>${meter(P.meanAccuracy, accCol(P.meanAccuracy))} ${P.meanAccuracy}% average, ${P.minAccuracy}% at worst</dd>
        <dt>Losses</dt><dd>${P.hpLost}, of which <span class="${P.blindHpLost ? 'bad' : ''}">${P.blindHpLost} taken blind (${P.blindPct}%)</span></dd>
        <dt>Wasted</dt><dd>${count(P.wastedRounds, 'round')}, ${count(P.phantomActions, 'order')} on phantoms</dd>
        <dt>Radio</dt><dd>${P.comms.sent} messages · ${P.comms.dropped} lost (${P.comms.lostPct}%) · ${P.comms.garbled} corrupted · ${P.comms.meanDelayMin} min average lag</dd>
        <dt>Under jamming</dt><dd>${P.ew.jammedMin} min (${P.ew.jammedPct}%), ${P.ew.isolatedMin} min cut off${P.ew.manoeuvredOut ? ` · <span class="good">moved clear ${P.ew.manoeuvredOut}×</span>` : ''}</dd>
        <dt>Mission command</dt><dd>${meter(M.score, M.score > 70 ? K.good : M.score > 45 ? K.warn : K.crit)} <b>${M.score}</b> of 100</dd>
      </dl>
      <h5>Threat awareness</h5>${threats}${traces}${conflicts}
    </div>`;
  }

  // ── comparison ──────────────────────────────────────────────────────
  async function compare(idA, idB) {
    const box = $('cmpOut');
    if (!box) return;
    if (!idA || !idB) { box.innerHTML = '<p class="quiet">Choose two exercises to compare.</p>'; return; }
    const r = await fetch(`/api/compare?a=${encodeURIComponent(idA)}&b=${encodeURIComponent(idB)}`).then((x) => x.json()).catch(() => null);
    if (!r || r.error) { box.innerHTML = '<p class="quiet">Those two could not be loaded.</p>'; return; }
    const M = [
      ['Cost of fog, minutes', (x) => x.costOfFog.reactionDelayMin, false],
      ['Casualties taken blind', (x) => x.costOfFog.blindHp, false],
      ['Share of losses taken blind, %', (x) => x.costOfFog.blindPct, false],
      ['Threats never seen', (x) => x.costOfFog.threatsNeverSeen, false],
      ['Rounds wasted', (x) => x.costOfFog.wastedRounds, false],
      ['Orders aimed at phantoms', (x) => x.costOfFog.phantomActions, false],
      ['Average disagreement between pictures, %', (x) => x.team.copMeanPct, false],
      ['Mission command score', (x) => x.mcScore, true],
      ['Enemy destroyed', (x) => x.outcome.enemiesKilled, true],
      ['Sub-units still effective', (x) => x.outcome.friendlyAlive, true],
    ];
    const rows = M.map(([label, f, higher]) => {
      const a = f(r.a) || 0, b = f(r.b) || 0;
      const max = Math.max(a, b, 1);
      const better = a === b ? null : (higher ? (a > b ? 'a' : 'b') : (a < b ? 'a' : 'b'));
      const bar = (v, col) => `<div style="display:flex;align-items:center;gap:9px">
        <span class="meter" style="flex:1;width:auto"><i style="width:${(v / max) * 100}%;background:${col}"></i></span>
        <b style="font-family:${MONO};min-width:38px;text-align:right">${v}</b></div>`;
      return `<tr><td>${label}</td><td style="width:32%">${bar(a, K.slot1)}</td><td style="width:32%">${bar(b, K.slot2)}</td>
        <td class="n ${better === 'a' ? 'good' : better === 'b' ? 'bad' : 'quiet'}">${better === null ? 'same' : better === 'a' ? 'A' : 'B'}</td></tr>`;
    }).join('');
    box.innerHTML = `<table>
      <tr><th>Measure</th>
        <th><span style="color:${K.slot1}">■</span> A — ${esc(r.a.label)}</th>
        <th><span style="color:${K.slot2}">■</span> B — ${esc(r.b.label)}</th>
        <th class="n">Better</th></tr>${rows}</table>
      <figcaption>Running the same mission under different information conditions is the cleanest way to show what degradation costs.</figcaption>`;
  }

  // ── who they believed ───────────────────────────────────────────────
  const SRC = [['UAV', 'drone feed', 'DRONE'], ['SCOUT', 'ground report', 'GROUND'], ['SIGINT', 'signals intercept', 'SIGINT']];
  const pct0 = (v) => (v == null ? '—' : Math.round(v * 100) + '%');

  function believeCard(p) {
    const J = A.players[p].judgement;
    if (!J) return '';
    const c = J.calibration;
    const rows = SRC.map(([k, label, tag]) => {
      const t = J.trust[k] || {};
      return `<tr><td><span class="srctag">${tag}</span>${label}</td>
        <td class="n">${t.judged ? `${t.trusted} of ${t.judged}` : '—'}</td>
        <td class="n ${t.fooled ? 'bad' : ''}">${t.fooled || 0}</td>
        <td class="n ${t.saved ? 'good' : ''}">${t.saved || 0}</td></tr>`;
    }).join('');
    const list = J.disputes.map((d) => `<tr>
        <td class="n">${esc(d.clock)}</td><td>${esc(d.grid)}</td>
        <td>${esc(d.name)}${d.targeted ? ` <span class="adv">${d.probe ? 'testing their trust' : 'aimed at their bias'}</span>` : ''}</td>
        <td>${d.froze ? '<span class="warn">left unresolved</span>' : d.answer ? (d.answer === 'present' ? 'enemy there' : 'clear') : '—'}</td>
        <td class="n">${d.confidence != null ? Math.round(d.confidence * 100) + '%' : ''}</td>
        <td class="${d.correct ? 'good' : d.answer ? 'bad' : ''}">${d.correct ? 'right' : d.answer ? 'wrong' : ''}</td></tr>`).join('');
    return `<div class="cdr">
      <h4>${esc(J.who)} <small>${p}</small></h4>
      <p class="callout ${c.enough ? '' : 'quiet'}">${esc(J.summary)}</p>
      ${c.n ? `<div class="kv2"><span>Brier score</span><b>${c.brier}</b><span class="quiet">lower is better · 0.25 is what always saying 50% scores</span></div>` : ''}
      ${J.weakSpot && !J.weakSpot.probe ? `<p class="lean2">${['UAV', 'SCOUT', 'SIGINT'].includes(J.weakSpot.source) ? 'Misled by the' : 'Weakness:'} <b>${esc(J.weakSpot.label)}</b>. <span class="quiet">${esc(J.weakSpot.reason)}</span></p>`
        : J.weakSpot ? `<p class="lean2">No weakness shown. Untested trust in the <b>${esc(J.weakSpot.label)}</b>. <span class="quiet">${esc(J.weakSpot.reason)}</span></p>`
        : `<p class="lean2 quiet">No consistent weakness in their recent rounds.</p>`}
      <table class="tight"><tr><th>Source</th><th class="n">Sided with</th><th class="n">Misled by it</th><th class="n">Saved by doubting</th></tr>${rows}</table>
      ${J.disputes.length ? `<h5>Each disagreement, with the truth now shown</h5>
        <table class="tight"><tr><th>Time</th><th>Grid</th><th>What was really going on</th><th>They said</th><th class="n">Sure</th><th></th></tr>${list}</table>` : ''}
    </div>`;
  }

  function judgementSection() {
    const any = PIDS.some((p) => { const J = A.players[p].judgement; return J && (J.calibration.n || J.disputes.length); });
    if (!any) return '';
    return `<section style="padding:0">
      <h2 style="margin:0 48px"><span class="n">${num()}.</span> Who did they believe?
        <span class="note">when the ground, the drone and the intercept disagreed</span></h2>
      <div class="who">${PIDS.map(believeCard).join('')}</div>
    </section>`;
  }

  // ── improvement across rounds ───────────────────────────────────────
  // One small chart per person (identity comes from the title, so one hue);
  // the dashed line marks 0.25, what someone who always says "50%" scores.
  const aimedIn = (r) => (r.disputes && r.disputes.aimed) || 0;
  function progressChart(name, rounds) {
    const W = 420, H = 170, L = 40, R = 18, top = 16, bot = 30;
    const ymax = Math.max(0.5, ...rounds.map((r) => r.brier || 0)) * 1.1;
    const X = (i) => L + 8 + (rounds.length === 1 ? (W - L - R - 16) / 2 : ((W - L - R - 16) * i) / (rounds.length - 1));
    const Y = (v) => top + (H - top - bot) * (v / ymax);            // 0 at the top: lower score sits higher
    let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(name)}: Brier score by round, lower is better">`;
    for (const v of [0, 0.25, 0.5].filter((v) => v <= ymax)) {
      s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="${v === 0.25 ? K.mute : K.grid}" ${v === 0.25 ? 'stroke-dasharray="4 4"' : ''}/>`;
      s += `<text x="${L - 6}" y="${Y(v) + 4}" fill="${K.mute}" font-size="10" font-family="${MONO}" text-anchor="end">${v.toFixed(2)}</text>`;
    }
    s += `<text x="${W - R}" y="${Y(0.25) - 5}" fill="${K.mute}" font-size="10" font-family="${SANS}" text-anchor="end">a coin flip</text>`;
    s += `<polyline points="${rounds.map((r, i) => `${X(i)},${Y(r.brier)}`).join(' ')}" fill="none" stroke="${K.slot1}" stroke-width="2"/>`;
    rounds.forEach((r, i) => {
      s += `<circle cx="${X(i)}" cy="${Y(r.brier)}" r="5" fill="${r.enough ? K.slot1 : '#e8e1d0'}" stroke="${K.slot1}" stroke-width="2"
        data-tip="${tipAttr(`<b>Round ${i + 1}</b><br>Brier ${r.brier} from ${r.n} judgement${r.n === 1 ? '' : 's'}<br>said ${pct0(r.meanConfidence)} sure, right ${pct0(r.accuracy)}${aimedIn(r) ? `<br>${aimedIn(r)} of ${r.disputes.issued} aimed at their habit` : ''}${r.enough ? '' : '<br><i>too few judgements to rely on</i>'}`)}"/>`;
      const above = Y(r.brier) - top > 16;
      const anchor = rounds.length > 1 && i === 0 ? 'start' : rounds.length > 1 && i === rounds.length - 1 ? 'end' : 'middle';
      const nudge = anchor === 'start' ? -4 : anchor === 'end' ? 4 : 0;
      s += `<text x="${X(i) + nudge}" y="${above ? Y(r.brier) - 10 : Y(r.brier) + 19}" fill="${K.ink}" font-size="11" font-family="${MONO}" text-anchor="${anchor}">${r.brier}</text>`;
      s += `<text x="${X(i) + nudge}" y="${H - 12}" fill="${K.mute}" font-size="10.5" font-family="${SANS}" text-anchor="${anchor}">round ${i + 1} · n ${r.n}</text>`;
    });
    return s + '</svg>';
  }

  function progressSection() {
    // Like against like: a drill round and a full exercise ask different
    // questions, so only rounds of this scenario go on one line.
    const same = (r) => r.n && (!r.scenario || !A.scenario || r.scenario === A.scenario.id);
    const people = Object.entries(A.progress || {}).map(([name, rs]) => [name, rs.filter(same)]).filter(([, rs]) => rs.length);
    const anyJudged = PIDS.some((p) => A.players[p].judgement && A.players[p].judgement.calibration.n);
    if (!people.length && !anyJudged) return '';
    const multi = people.filter(([, rs]) => rs.length >= 2);
    if (!multi.length) {
      return `<section><h2><span class="n">${num()}.</span> Getting better across rounds</h2>
        <p>This is the first round on record for ${people.length ? people.map(([n]) => esc(n)).join(', ') : 'these commanders'}.
        Run the source drill again with the same names and this section will show whether their judgement improved — measured, not asserted.</p></section>`;
    }
    const cards = multi.map(([name, rs]) => {
      const a = rs[0], b = rs[rs.length - 1];
      const better = b.brier < a.brier - 0.04, worse = b.brier > a.brier + 0.04;
      const thin = rs.some((r) => !r.enough);
      const verdict = better ? (thin ? 'Improving — on small samples' : 'Improved') : worse ? (aimedIn(b) ? 'Worse, under targeting' : 'Worse') : 'No clear change';
      // A round full of attacks on a known habit is a harder test. Say so,
      // so a rising score is read as what the habit cost, not as decline.
      const hunted = rs.map((r, i) => [i + 1, r]).filter(([, r]) => aimedIn(r));
      const worked = (r) => (r.disputes.aimedWorked != null ? `, ${r.disputes.aimedWorked} worked` : '');
      const huntNote = !hunted.length ? ''
        : `The red cell aimed ${hunted.map(([i, r]) => `${aimedIn(r)} of ${r.disputes.issued} in round ${i}${worked(r)}`).join('; ')} at a habit it had learned.`
          + (!aimedIn(b) ? ` By round ${rs.length} it had no habit left to aim at.` : '')
          + (worse && aimedIn(b) ? ' A rising score here is what the habit costs once an opponent knows it.' : '');
      return `<div class="prog">
        <h4>${esc(name)} <span class="verdict" style="color:${better ? K.good : worse ? K.crit : K.mute}">${verdict}</span></h4>
        ${progressChart(name, rs)}
        <p class="quiet" style="font-size:12.5px;margin:6px 0 0">Round 1: said ${pct0(a.meanConfidence)} sure, right ${pct0(a.accuracy)} (n ${a.n}).
          Round ${rs.length}: said ${pct0(b.meanConfidence)} sure, right ${pct0(b.accuracy)} (n ${b.n}).
          ${huntNote}
          ${thin ? 'Hollow points are rounds with fewer than five judgements — read them as a direction, not a result.' : ''}</p>
      </div>`;
    }).join('');
    return `<section><h2><span class="n">${num()}.</span> Getting better across rounds
        <span class="note">Brier score per round of ${esc(A.scenario.name)}, from real play — lower is better</span></h2>
      <div class="progs">${cards}</div></section>`;
  }

  // ── the key moment, drawn exactly as the replay draws it ─────────────
  function drawKeyMoment() {
    const km = A.keyMoment;
    if (!km || !window.TacMap || !window.FrameDraw) return;      // no canvas (print stub, tests): the words stand alone
    const tc = $('kmTruth'), bc = $('kmBelief');
    if (!tc || !bc) return;
    const truthMap = new TacMap(tc);
    const beliefMap = new TacMap(bc);
    const ctx = { emitters: A.emitters || [], intent: A.intent, focus: km.pid, now: 0, live: false };
    const redraw = () => {
      if (!truthMap.s || !beliefMap.s) return;
      FrameDraw.drawTruth(truthMap, km.frame, ctx);
      FrameDraw.drawBelief(beliefMap, km.frame, km.pid, { now: 0 });
    };
    // TacMap clears the canvas when it resizes, so draw after every resize
    new ResizeObserver(() => requestAnimationFrame(redraw)).observe(tc);
    (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => requestAnimationFrame(redraw));
  }

  // ── build ───────────────────────────────────────────────────────────
  async function main() {
    const runs = await fetch('/api/runs').then((r) => r.json()).then((r) => r.runs).catch(() => []);
    const runId = new URLSearchParams(location.search).get('run') || '';
    const res = await fetch(runId ? `/api/run/${encodeURIComponent(runId)}` : '/api/aar');
    if (!res.ok) {
      // nothing to export, so do not offer exports that would download an error
      ['dlJson', 'dlCsv'].forEach((id) => { $(id).removeAttribute('href'); $(id).setAttribute('disabled', ''); });
      $('runPick').style.display = runs.length ? '' : 'none';
      $('runPick').innerHTML = runs.map((r) => `<option value="${esc(r.id)}">${esc(r.scenarioName)} · ${new Date(r.generatedAt).toLocaleString()}</option>`).join('');
      $('runPick').onchange = (e) => { location.search = '?run=' + encodeURIComponent(e.target.value); };
      root.innerHTML = `<div class="pagehead">
          <div class="cls">RESTRICTED — EXERCISE ONLY</div>
          <h1>After action review</h1>
          <div class="sub">No exercise has finished yet</div>
        </div>
        <section>
          <p>This page is written at <b>Endex</b>. Run an exercise from the instructor console and it will
          fill in: what each commander decided, how good their picture was at the time, and what the
          degradation cost them.</p>
          <p>${runs.length
            ? 'Earlier exercises are in the list at the top of this page.'
            : 'The cleanest first run is <b>TRG-1 BASELINE</b> followed by <b>TRG-2 CONTESTED EW</b> — the same enemy, so the difference between the two scorecards is purely the jamming.'}</p>
          <p><a class="btn go" href="/instructor">Open the instructor console</a></p>
        </section>`;
      return;
    }
    A = await res.json();
    PIDS = Object.keys(A.players);
    mm = (t) => (t * A.timeScale) / 60;

    $('runPick').innerHTML = '<option value="">This exercise</option>'
      + runs.map((r) => `<option value="${esc(r.id)}" ${r.id === runId ? 'selected' : ''}>${esc(r.scenarioName)} · ${new Date(r.generatedAt).toLocaleString()}</option>`).join('');
    $('runPick').onchange = (e) => { location.search = e.target.value ? '?run=' + encodeURIComponent(e.target.value) : ''; };
    if (runId) { $('dlJson').href = `/api/run/${encodeURIComponent(runId)}`; $('dlCsv').href = `/api/run/${encodeURIComponent(runId)}?csv=1`; }
    $('meta').textContent = `${A.scenario.name} · ${A.startClock} to ${A.endClock}`;

    const F = A.costOfFog, O = A.outcome, M = A.missionCommand, TM = A.team;
    const JT = A.judgement || { disputes: 0, answered: 0, correct: 0, froze: 0, calibration: { n: 0 } };
    // a round run to train judgement, with the radio working, is judged on judgement
    const judgementLed = JT.disputes > 0 && F.reactionDelayMin === 0;
    const runOpts = '<option value="">—</option><option value="current">This exercise</option>'
      + runs.map((r) => `<option value="${esc(r.id)}">${esc(r.scenarioName)} · ${new Date(r.generatedAt).toLocaleTimeString()}</option>`).join('');

    root.innerHTML = `
      <div class="pagehead">
        <div class="cls">RESTRICTED — EXERCISE ONLY</div>
        <h1>After action review</h1>
        <div class="sub">${esc(A.scenario.name)} · ${esc(A.scenario.area)} · ${A.startClock} to ${A.endClock}, ${A.durationMin} minutes of mission time · ${esc(A.endReason)}</div>
      </div>

      <section>
        ${judgementLed
          ? `<h2><span class="n">${num()}.</span> Judgement under contradiction</h2>
        <div class="finding">
          <div class="bignum" style="color:${JT.correct >= JT.answered / 2 ? K.slot1 : K.crit}">${JT.correct} of ${JT.answered}
            <small>disagreements between sources called right${JT.froze ? `. ${count(JT.froze, 'more')} left unresolved.` : '.'}
            ${JT.calibration.n ? esc(JT.summary) : ''}</small>
          </div>`
          : `<h2><span class="n">${num()}.</span> The cost of fog</h2>
        <div class="finding">
          <div class="bignum">${F.reactionDelayMin} min
            <small>later than on a working net, across the three commanders${F.threatsNeverSeen ? `. ${count(F.threatsNeverSeen, 'threat')} never seen at all.` : ''}</small>
          </div>`}
          <ul>${F.summary.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>
        <div class="figs">
          <div class="fig"><div class="v ${F.blindHp ? 'bad' : 'good'}">${F.blindHp}</div>
            <div class="k">strength lost to enemies that were not on the commander's map, ${F.blindPct}% of ${F.totalHp} lost in all</div></div>
          ${judgementLed ? (() => {
            const aimed = Object.values(A.players).flatMap((P) => P.judgement.disputes).filter((d) => d.targeted && !d.probe && d.answer);
            const hit = aimed.filter((d) => !d.correct).length;
            return aimed.length
              ? `<div class="fig"><div class="v ${hit ? 'adv' : 'good'}">${hit} of ${aimed.length}</div>
                  <div class="k">attacks on a weakness the red cell had learned that caught them out</div></div>`
              : `<div class="fig"><div class="v quiet">None</div>
                  <div class="k">the red cell had not yet learned anyone's weakness — play another round</div></div>`;
          })() : (() => {
            const worked = F.deceptionsSucceeded + F.forgedOrdersObeyed + F.falseBdaAmbushes;
            const tried = worked + F.deceptionsRejected
              + Object.values(A.players).reduce((a, P) => a + P.forged.filter((f) => !f.complied).length + P.falseBda.filter((f) => !/FELL/.test(f.outcome)).length, 0);
            return tried
              ? `<div class="fig"><div class="v ${worked ? 'adv' : 'good'}">${worked} of ${tried}</div>
                  <div class="k">deceptions that worked — phantoms believed, forged orders obeyed, false kills trusted</div></div>`
              : `<div class="fig"><div class="v quiet">None</div>
                  <div class="k">no deception was attempted in this exercise</div></div>`;
          })()}
          <div class="fig"><div class="v">${M.teamScore}</div>
            <div class="k">mission command, out of 100 — did they keep acting on intent when cut off</div></div>
          <div class="fig"><div class="v ${O.objectiveHeld ? 'good' : 'bad'}">${O.objectiveHeld ? 'Held' : 'Lost'}</div>
            <div class="k">RAMPUR · ${O.enemiesKilled} of ${O.enemiesTotal} enemy destroyed · ${O.friendlyAlive} of ${O.friendlyTotal} sub-units effective</div></div>
        </div>
      </section>

      ${judgementSection()}
      ${progressSection()}

      ${A.keyMoment ? `<section>
        <h2><span class="n">${num()}.</span> The moment it went wrong
          <span class="note">${esc(A.keyMoment.clock)}, the furthest a commander's picture drifted from the ground</span></h2>
        <p class="momentnote">At <b>${esc(A.keyMoment.clock)}</b>, ${A.keyMoment.pid}'s picture was <b>${A.keyMoment.accuracy}% accurate</b>${A.keyMoment.degraded ? ' with their net degraded' : ''}.
          ${A.keyMoment.unseen ? `${A.keyMoment.unseen} live ${A.keyMoment.unseen === 1 ? 'enemy was' : 'enemies were'} not on their map. ` : ''}${A.keyMoment.worstErrorM > 300 ? `The worst track they held was ${A.keyMoment.worstErrorM.toLocaleString()} m from where it really was. ` : ''}${A.keyMoment.phantoms ? `They were tracking ${A.keyMoment.phantoms} contact${A.keyMoment.phantoms === 1 ? '' : 's'} that did not exist.` : ''}</p>
        <div class="moment">
          <div><div class="cap">Ground truth<span>what was there</span></div><canvas id="kmTruth"></canvas></div>
          <div><div class="cap">As ${A.keyMoment.pid} believed it<span>what their map showed</span></div><canvas id="kmBelief"></canvas></div>
        </div>
        <figcaption>Red lines run from where they thought an enemy was to where it was. A red ring marks an enemy that was not on their map.
          <a href="/replay?${runId ? 'run=' + encodeURIComponent(runId) + '&' : ''}t=${A.keyMoment.t}&pid=${A.keyMoment.pid}">Open the replay at this moment</a> to watch how it got there.</figcaption>
      </section>` : ''}

      <section>
        <h2><span class="n">${num()}.</span> How long an order took to follow new information
          <span class="note">the same commanders, clear net against degraded</span></h2>
        ${dumbbell()}
      </section>

      <section>
        <h2><span class="n">${num()}.</span> Decision timeline
          <span class="note">what each commander did, and how good their picture was at that moment</span></h2>
        ${timeline()}
      </section>

      <section>
        <h2><span class="n">${num()}.</span> Did the team share one picture?</h2>
        ${copChart()}
        <table>
          <tr><th>Measure</th><th class="n">Count</th><th>What it means</th></tr>
          <tr><td>Moves to support a flank in contact</td><td class="n ${TM.mutualSupport ? 'good' : ''}">${TM.mutualSupport}</td><td class="quiet">a commander going to help without being told</td></tr>
          <tr><td>Fratricide</td><td class="n ${TM.fratricide ? 'bad' : 'good'}">${TM.fratricide}</td><td class="quiet">${TM.fratricideSpoofed ? `${TM.fratricideSpoofed} after a position report was falsified · ` : ''}${count(TM.dangerClose, 'further danger-close round')}</td></tr>
          <tr><td>Contradictory reports resolved</td><td class="n">${TM.conflictsResolved} of ${TM.conflicts}</td><td class="quiet">${TM.conflictsResolvedPct}% · ${count(TM.teamMessages, 'message')} on the team net</td></tr>
        </table>
      </section>

      <section>
        <h2><span class="n">${num()}.</span> Mission command
          <span class="note">did commanders keep acting on intent when they lost HQ?</span></h2>
        <p><b>${esc(M.intent.commander)}'s intent.</b> ${esc(M.intent.text)}</p>
        <table>
          <tr><th>Task</th><th>Commander</th><th>Held its area</th><th class="n">Breaches</th><th>Cut off</th><th class="n">Acted anyway</th><th>Forged orders</th><th class="n">Score</th></tr>
          ${M.tasks.map((k) => {
            const P = A.players[k.pid], mc = P.missionCommand;
            return `<tr><td>${esc(k.text)}</td><td style="color:${K.slot1}">${k.pid}</td>
              <td>${meter(mc.coveragePct, mc.coveragePct > 65 ? K.good : mc.coveragePct > 35 ? K.warn : K.crit)} ${mc.coveragePct}%</td>
              <td class="n ${mc.breaches ? 'bad' : 'good'}">${mc.breaches}</td>
              <td class="quiet">${mc.isolationSpans.length ? mc.isolationSpans.map((s) => `${s.startClock}–${s.endClock}${s.brokeOut ? ', moved clear' : ''}`).join('<br>') : 'never'}</td>
              <td class="n ${mc.initiativePct >= 100 ? 'good' : mc.initiativePct === 0 && mc.isolationSpans.length ? 'bad' : ''}">${mc.isolationSpans.length ? mc.spansActed + ' of ' + mc.isolationSpans.length : '—'}</td>
              <td class="${mc.compliedWithForgedOrder ? 'bad' : ''}">${P.forged.length ? P.forged.map((f) => verdict(f.outcome)).join(' ') : '<span class="quiet">none sent</span>'}</td>
              <td class="n"><b>${mc.score}</b></td></tr>`;
          }).join('')}
        </table>
        <figcaption>${esc(M.method)}</figcaption>
      </section>

      <section style="padding:0">
        <h2 style="margin:0 48px"><span class="n">${num()}.</span> Commanders</h2>
        <div class="who">${PIDS.map(commander).join('')}</div>
      </section>

      ${A.redcell.log.length ? `<section>
        <h2><span class="n">${num()}.</span> AI red cell
          <span class="note">mode: ${esc(A.redcell.mode.toLowerCase())}</span></h2>
        <p>The adversary chose each of these moments itself, and recorded why.</p>
        <table>
          <tr><th>Time</th><th>Decision</th><th>Action</th><th>Against</th><th>Its reasoning</th></tr>
          ${A.redcell.log.map((l) => `<tr><td class="n">${l.clock}</td>
            <td>${verdict(l.mode)}</td><td>${esc(l.label)}</td><td style="color:${K.slot1}">${l.pid || ''}</td>
            <td>${esc(l.reason)}</td></tr>`).join('')}
        </table>
      </section>` : ''}

      <section>
        <h2><span class="n">${num()}.</span> Decision log
          <span class="note">every order, with the reason the commander gave</span></h2>
        <div class="scrollbox"><table>
          <tr><th>Time</th><th>Commander</th><th>Order</th><th>Reason given</th><th>Basis</th><th class="n">Picture</th><th>Net</th><th class="n">Reaction</th></tr>
          ${A.decisions.length ? A.decisions.map((d) => `<tr>
            <td class="n">${d.clock}</td><td style="color:${K.slot1}">${d.pid}</td>
            <td>${esc(d.desc)}${d.onPhantom ? ' <span class="adv">phantom</span>' : ''}${d.lost ? ' <span class="bad">lost</span>' : ''}</td>
            <td>${esc(d.rationale) || '<span class="quiet">—</span>'}</td>
            <td>${d.ref || ''}</td>
            <td class="n" style="color:${accCol(d.accuracy)}">${d.accuracy}%</td>
            <td class="${d.degraded ? 'bad' : 'good'}">${d.degraded ? 'degraded' : 'clear'}</td>
            <td class="n">${d.latency != null ? n1(mm(d.latency)) : ''}</td></tr>`).join('')
          : '<tr><td colspan="8" class="quiet">No orders were given.</td></tr>'}
        </table></div>
      </section>

      <section>
        <h2><span class="n">${num()}.</span> Exercise log</h2>
        <div class="scrollbox"><table>
          ${A.events.filter((e) => e.kind !== 'truth').map((e) => `<tr>
            <td class="n" style="width:86px">${e.clock}</td>
            <td style="width:92px" class="${e.kind === 'inject' || e.kind === 'redcell' ? 'adv' : e.kind === 'combat' ? 'bad' : e.kind === 'intent' ? 'warn' : 'quiet'}">${e.kind}</td>
            <td style="width:72px;color:${K.slot1}">${e.pid || ''}</td>
            <td>${esc(e.text)}</td></tr>`).join('')}
        </table></div>
      </section>

      <section>
        <h2><span class="n">${num()}.</span> Compare two exercises
          <span class="note">the same mission, different information conditions</span></h2>
        <div style="display:flex;gap:9px;align-items:center;flex-wrap:wrap;margin:12px 0" class="onpaper">
          <span class="quiet">A</span><select id="cmpA">${runOpts}</select>
          <span class="quiet">against B</span><select id="cmpB">${runOpts}</select>
          <button class="btn go" id="cmpGo">Compare</button>
        </div>
        <div id="cmpOut"></div>
      </section>`;

    bindTips(root);
    bindCop();
    drawKeyMoment();
    $('cmpGo').onclick = () => compare($('cmpA').value, $('cmpB').value);
    if (runs.length >= 2) { $('cmpA').value = runs[1].id; $('cmpB').value = runs[0].id; }
    else if (runs.length === 1) { $('cmpA').value = runs[0].id; $('cmpB').value = 'current'; }
    compare($('cmpA').value, $('cmpB').value);
  }

  main().catch((e) => { root.innerHTML = `<div class="empty">The report could not be built: ${esc(e.message)}</div>`; });
})();
