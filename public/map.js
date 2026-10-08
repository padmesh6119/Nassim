// Tactical map renderer, shared by the commander, instructor and replay screens.
//
// Two materials, deliberately: the SHEET is a printed topographic map — paper,
// contours, woodland, a marginal collar. The OVERLAY is chinagraph pencil on talc
// laid over it — waxy, slightly uneven strokes in blue for friendly and red for
// hostile. Information that is going stale fades and smudges, because that is
// exactly what the product is about.
//
// The sheet is drawn once to an offscreen canvas; only the overlay redraws.
(function () {
  const T = window.TERRAIN;

  const C = {
    paper: '#e8e1d0', paperDeep: '#ded5c0', grain: 'rgba(90,70,40,0.045)',
    ink: '#211e18', inkSoft: '#6b6354', collar: '#d8cfb8',
    contour: '#a88b5e', contourSoft: 'rgba(168,139,94,0.42)', relief: 'rgba(196,169,122,0.20)',
    water: '#6c9cb5', waterDeep: '#4a7e99',
    veg: 'rgba(140,170,104,0.46)', vegEdge: 'rgba(92,124,66,0.72)', vegMark: 'rgba(72,104,52,0.72)',
    road: '#efe7d4', track: 'rgba(120,104,70,0.75)',
    built: 'rgba(150,132,118,0.40)', builtMark: 'rgba(90,74,62,0.55)',
    blue: '#1b4f9c', blueSoft: 'rgba(27,79,156,0.17)',
    red: '#b8232b', redSoft: 'rgba(184,35,43,0.15)',
    ochre: '#b07a14', green: '#2e6b4f', violet: '#6b3fa0',
    white: '#fbf8f0',
  };

  const ABBR = { RECON: 'RCN', ARMOR: 'ARM', 'MECH INF': 'MECH', INFANTRY: 'INF' };
  const NARROW = (px, w = 600) => `${w} ${px}px "Archivo Narrow", "Arial Narrow", sans-serif`;
  const MONO = (px, w = 400) => `${w} ${px}px "IBM Plex Mono", ui-monospace, monospace`;
  const COLLAR = 26;

  const nz = (x, y) => T.noise(x, y) - 0.5;

  class TacMap {
    constructor(canvas, opts = {}) {
      this.c = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts;
      this.sheet = document.createElement('canvas');
      this.hover = null;
      this.s = 0;
      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener('click', (ev) => {
        const w = this.toWorld(ev);
        if (w && opts.onClick) opts.onClick(w, ev);
      });
      canvas.addEventListener('mousemove', (ev) => { this.hover = this.toWorld(ev); });
      canvas.addEventListener('mouseleave', () => { this.hover = null; });
      this.resize();
    }

    resize() {
      const r = this.c.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      if (!r.width || !r.height) return;
      this.c.width = Math.round(r.width * dpr);
      this.c.height = Math.round(r.height * dpr);
      this.dpr = dpr;
      this.w = r.width; this.h = r.height;
      const s = Math.min((r.width - COLLAR * 2) / T.W, (r.height - COLLAR * 2) / T.H);
      this.s = s;
      this.ox = (r.width - T.W * s) / 2;
      this.oy = Math.min((r.height - T.H * s) / 2, COLLAR + 46);
      this.renderSheet();
    }

    toWorld(ev) {
      const r = this.c.getBoundingClientRect();
      const x = (ev.clientX - r.left - this.ox) / this.s;
      const y = (ev.clientY - r.top - this.oy) / this.s;
      if (x < 0 || y < 0 || x > T.W || y > T.H) return null;
      return { x, y };
    }
    X(x) { return this.ox + x * this.s; }
    Y(y) { return this.oy + y * this.s; }
    R(r) { return r * this.s; }

    // =====================================================================
    // The printed sheet
    // =====================================================================
    renderSheet() {
      const cv = this.sheet;
      cv.width = this.c.width; cv.height = this.c.height;
      const g = cv.getContext('2d');
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const s = this.s;
      const X = (v) => this.X(v), Y = (v) => this.Y(v);

      g.fillStyle = C.collar;
      g.fillRect(0, 0, this.w, this.h);
      g.fillStyle = C.paper;
      g.fillRect(X(0), Y(0), T.W * s, T.H * s);

      g.save();
      g.beginPath();
      g.rect(X(0), Y(0), T.W * s, T.H * s);
      g.clip();

      this.paperGrain(g);
      this.relief(g);
      this.woodland(g);
      this.river(g);
      this.roads(g);
      this.builtUp(g);
      this.graticule(g);
      this.sheetLabels(g);

      g.restore();
      this.collar(g);
    }

    paperGrain(g) {
      const s = this.s;
      g.fillStyle = C.grain;
      for (let i = 0; i < 1400; i++) {
        const x = T.noise(i, 1) * T.W, y = T.noise(i, 2) * T.H;
        g.fillRect(this.X(x), this.Y(y), s * 1.2, s * 1.2);
      }
    }

    // Contour rings, drawn with a hand-cut wobble so they read as surveyed
    // ground rather than as concentric ellipses.
    relief(g) {
      const s = this.s;
      for (const h of T.hills) {
        const steps = 4;
        for (let k = steps; k >= 1; k--) {
          const rad = (h.r * k) / steps;
          g.beginPath();
          for (let a = 0; a <= 64; a++) {
            const th = (a / 64) * Math.PI * 2;
            const wob = 1 + nz(h.x + k * 7, h.y + k * 3) * 0.05
              + Math.sin(th * 3 + h.x) * 0.022 + Math.sin(th * 5 + h.y) * 0.014;
            const px = h.x + Math.cos(th) * rad * wob;
            const py = h.y + Math.sin(th) * rad * 0.78 * wob;
            a ? g.lineTo(this.X(px), this.Y(py)) : g.moveTo(this.X(px), this.Y(py));
          }
          g.closePath();
          if (k === steps) { g.fillStyle = C.relief; g.fill(); }
          g.strokeStyle = k === steps || k === 1 ? C.contour : C.contourSoft;
          g.lineWidth = k === steps ? 1.1 : 0.8;
          g.stroke();
        }
        // spot height
        g.fillStyle = C.contour;
        g.beginPath(); g.arc(this.X(h.x), this.Y(h.y), Math.max(1.4, 1.8 * s), 0, 7); g.fill();
        g.font = MONO(Math.max(8, 9 * s), 600);
        g.fillStyle = C.ink;
        g.fillText(String(h.top), this.X(h.x) + 6, this.Y(h.y) - 4);
      }
    }

    // Woodland: a tinted block with a broken edge and scattered tree marks.
    woodland(g) {
      const s = this.s;
      for (let fi = 0; fi < T.forests.length; fi++) {
        const poly = T.forests[fi];
        g.save();
        g.beginPath();
        poly.forEach(([x, y], i) => (i ? g.lineTo(this.X(x), this.Y(y)) : g.moveTo(this.X(x), this.Y(y))));
        g.closePath();
        g.fillStyle = C.veg; g.fill();
        g.strokeStyle = C.vegEdge; g.lineWidth = 0.9; g.stroke();
        g.clip();
        const xs = poly.map((p) => p[0]), ys = poly.map((p) => p[1]);
        const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        g.strokeStyle = C.vegMark;
        g.lineWidth = 0.85;
        const step = 10;
        for (let x = x0; x < x1; x += step) {
          for (let y = y0; y < y1; y += step) {
            const jx = x + nz(x + fi, y) * step * 0.8;
            const jy = y + nz(y, x + fi) * step * 0.8;
            const rr = Math.max(1.0, (1.5 + nz(jx, jy) * 0.6) * s);
            g.beginPath();
            g.arc(this.X(jx), this.Y(jy), rr, Math.PI * 0.08, Math.PI * 0.92, true);
            g.stroke();
            g.beginPath();
            g.moveTo(this.X(jx), this.Y(jy) + rr * 0.1);
            g.lineTo(this.X(jx), this.Y(jy) + rr * 1.0);
            g.stroke();
          }
        }
        g.restore();
      }
    }

    smooth(g, pts, project) {
      const P = pts.map(project);
      g.moveTo(P[0].x, P[0].y);
      for (let i = 1; i < P.length - 1; i++) {
        const mx = (P[i].x + P[i + 1].x) / 2, my = (P[i].y + P[i + 1].y) / 2;
        g.quadraticCurveTo(P[i].x, P[i].y, mx, my);
      }
      g.lineTo(P[P.length - 1].x, P[P.length - 1].y);
    }

    river(g) {
      const s = this.s;
      const proj = ([x, y]) => ({ x: this.X(x), y: this.Y(y) });
      g.lineCap = 'round'; g.lineJoin = 'round';
      g.beginPath(); this.smooth(g, T.river, proj);
      g.strokeStyle = C.waterDeep; g.lineWidth = Math.max(4, 13 * s); g.stroke();
      g.beginPath(); this.smooth(g, T.river, proj);
      g.strokeStyle = C.water; g.lineWidth = Math.max(2.5, 10 * s); g.stroke();
      // bridges
      for (const b of T.bridges) {
        const w = Math.max(5, 11 * s), hh = Math.max(9, 26 * s);
        g.fillStyle = C.paper;
        g.fillRect(this.X(b.x) - w / 2, this.Y(b.y) - hh / 2, w, hh);
        g.strokeStyle = C.ink; g.lineWidth = 1.3;
        g.beginPath();
        g.moveTo(this.X(b.x) - w / 2, this.Y(b.y) - hh / 2); g.lineTo(this.X(b.x) - w / 2, this.Y(b.y) + hh / 2);
        g.moveTo(this.X(b.x) + w / 2, this.Y(b.y) - hh / 2); g.lineTo(this.X(b.x) + w / 2, this.Y(b.y) + hh / 2);
        g.stroke();
      }
    }

    roads(g) {
      const s = this.s;
      const proj = ([x, y]) => ({ x: this.X(x), y: this.Y(y) });
      g.lineCap = 'round'; g.lineJoin = 'round';
      for (const r of T.roads) {
        if (r.cls === 'track') {
          g.beginPath(); this.smooth(g, r.pts, proj);
          g.strokeStyle = C.track; g.lineWidth = Math.max(1, 1.8 * s);
          g.setLineDash([6 * s, 4 * s]); g.stroke(); g.setLineDash([]);
        } else {
          g.beginPath(); this.smooth(g, r.pts, proj);
          g.strokeStyle = 'rgba(33,30,24,0.55)'; g.lineWidth = Math.max(2.2, 4.2 * s); g.stroke();
          g.beginPath(); this.smooth(g, r.pts, proj);
          g.strokeStyle = '#e4d9bd'; g.lineWidth = Math.max(1.0, 2.2 * s); g.stroke();
        }
      }
    }

    builtUp(g) {
      const s = this.s, t = T.town;
      g.save();
      g.beginPath(); g.arc(this.X(t.x), this.Y(t.y), this.R(t.r), 0, 7);
      g.fillStyle = C.built; g.fill();
      g.clip();
      g.fillStyle = C.builtMark;
      for (let i = 0; i < 26; i++) {
        const a = i * 1.37, rr = (i % 5) * 8 + 4;
        const bx = t.x + Math.cos(a) * rr, by = t.y + Math.sin(a) * rr;
        const bw = Math.max(2.4, (4 + nz(bx, by) * 2) * s);
        g.fillRect(this.X(bx), this.Y(by), bw, bw * 0.75);
      }
      g.restore();
      g.beginPath(); g.arc(this.X(t.x), this.Y(t.y), this.R(t.r), 0, 7);
      g.strokeStyle = 'rgba(90,74,62,0.5)'; g.lineWidth = 0.9; g.stroke();
    }

    graticule(g) {
      const s = this.s;
      g.strokeStyle = 'rgba(33,30,24,0.20)';
      g.lineWidth = 0.7;
      for (let i = 0; i <= T.W / T.CELL; i++) {
        g.beginPath(); g.moveTo(this.X(i * T.CELL), this.Y(0)); g.lineTo(this.X(i * T.CELL), this.Y(T.H)); g.stroke();
      }
      for (let j = 0; j <= T.H / T.CELL; j++) {
        g.beginPath(); g.moveTo(this.X(0), this.Y(j * T.CELL)); g.lineTo(this.X(T.W), this.Y(j * T.CELL)); g.stroke();
      }
    }

    sheetLabels(g) {
      const s = this.s;
      g.fillStyle = C.ink;
      g.font = NARROW(Math.max(10, 12 * s));
      g.textAlign = 'center';
      // CHARLIE deploys on the town, so the name goes beside it, not under it
      const t = T.town;
      g.textAlign = 'right';
      g.fillText(t.name.toUpperCase(), this.X(t.x - t.r) - 7, this.Y(t.y) + 4);
      g.textAlign = 'center';
      g.textAlign = 'left';
      g.font = NARROW(Math.max(8.5, 10 * s));
      g.fillStyle = C.inkSoft;
      g.textAlign = 'center';
      for (const h of T.hills) g.fillText(h.name, this.X(h.x), this.Y(h.y - h.r) - 9);
      g.textAlign = 'left';
      g.fillStyle = C.waterDeep;
      g.font = `italic ${Math.max(9, 11 * s)}px "Archivo Narrow", sans-serif`;
      g.fillText('GANGA', this.X(188), this.Y(326) + 15);
      g.fillStyle = C.ink;
      g.font = NARROW(Math.max(8.5, 10 * s));
      for (const b of T.bridges) g.fillText(b.name, this.X(b.x) + 9, this.Y(b.y) - this.R(16));
    }

    // The marginal collar is what makes a sheet read as a sheet: grid letters
    // outside the neat line, a scale bar, and the sheet number.
    collar(g) {
      const s = this.s;
      g.strokeStyle = C.ink;
      g.lineWidth = 1.4;
      g.strokeRect(this.X(0), this.Y(0), T.W * s, T.H * s);
      g.lineWidth = 0.7;
      g.strokeRect(this.X(0) - 5, this.Y(0) - 5, T.W * s + 10, T.H * s + 10);

      g.fillStyle = C.ink;
      g.font = MONO(Math.max(8, 9.5 * s), 600);
      g.textAlign = 'center';
      for (let i = 0; i < T.W / T.CELL; i++) {
        const lab = String.fromCharCode(65 + i);
        const cx = this.X(i * T.CELL + T.CELL / 2);
        g.fillText(lab, cx, this.Y(0) - 10);
        g.fillText(lab, cx, this.Y(T.H) + 17);
      }
      g.textAlign = 'right';
      for (let j = 0; j < T.H / T.CELL; j++) {
        const cy = this.Y(j * T.CELL + T.CELL / 2) + 3;
        g.fillText(String(j + 1), this.X(0) - 9, cy);
        g.textAlign = 'left';
        g.fillText(String(j + 1), this.X(T.W) + 9, cy);
        g.textAlign = 'right';
      }
      g.textAlign = 'left';

      this.marginalInfo(g);
    }

    // Marginal information: what a real sheet carries outside the neat line.
    marginalInfo(g) {
      const s = this.s;
      const top = this.Y(0) - COLLAR, bottom = this.Y(T.H) + COLLAR;
      const left = this.X(0), right = this.X(T.W);

      if (top > 34) {
        g.textAlign = 'left';
        g.fillStyle = C.ink;
        g.font = NARROW(Math.min(19, Math.max(13, 15 * s)));
        g.fillText(`${T.name} — ${T.area}`, left, top - 15);
        g.font = MONO(11);
        g.fillStyle = C.inkSoft;
        g.fillText(`${T.sheet}   1:50,000   GRID NORTH`, left, top - 2);
        g.textAlign = 'right';
        g.font = NARROW(12);
        g.fillText('RESTRICTED — EXERCISE ONLY', right, top - 2);
        g.textAlign = 'left';
      }

      if (this.h - bottom > 36) {
        const by = bottom + 20;
        // scale bar
        const barLen = Math.min(this.R(T.CELL * 2), 150);
        g.fillStyle = C.ink;
        g.fillRect(left, by, barLen / 2, 4);
        g.strokeStyle = C.ink; g.lineWidth = 1;
        g.strokeRect(left, by, barLen, 4);
        g.font = MONO(10);
        g.fillStyle = C.inkSoft;
        g.fillText('0', left - 2, by + 17);
        g.fillText('1 km', left + barLen - 14, by + 17);

        // legend for the overlay, so the two sheets can be read without a caption
        let lx = left + barLen + 36;
        const key = (draw, text) => {
          draw(lx, by + 3);
          g.fillStyle = C.ink;
          g.font = NARROW(12);
          g.fillText(text, lx + 22, by + 7);
          lx += 22 + g.measureText(text).width + 26;
        };
        key((x, y) => {
          g.strokeStyle = C.blue; g.lineWidth = 1.8;
          g.strokeRect(x - 1, y - 6, 16, 11);
          g.beginPath(); g.moveTo(x - 1, y - 6); g.lineTo(x + 15, y + 5);
          g.moveTo(x + 15, y - 6); g.lineTo(x - 1, y + 5); g.stroke();
        }, 'own troops');
        key((x, y) => {
          g.strokeStyle = C.red; g.lineWidth = 1.8;
          g.beginPath();
          g.moveTo(x + 7, y - 7); g.lineTo(x + 15, y); g.lineTo(x + 7, y + 7); g.lineTo(x - 1, y);
          g.closePath(); g.stroke();
        }, 'enemy, seen');
        key((x, y) => {
          g.strokeStyle = C.red; g.lineWidth = 1.8; g.setLineDash([3, 2.5]);
          g.beginPath();
          g.moveTo(x + 7, y - 7); g.lineTo(x + 15, y); g.lineTo(x + 7, y + 7); g.lineTo(x - 1, y);
          g.closePath(); g.stroke(); g.setLineDash([]);
        }, 'enemy, reported only');
        key((x, y) => {
          g.strokeStyle = C.violet; g.lineWidth = 1.8;
          g.beginPath();
          g.moveTo(x + 7, y - 7); g.lineTo(x + 15, y); g.lineTo(x + 7, y + 7); g.lineTo(x - 1, y);
          g.closePath(); g.stroke();
        }, 'does not exist');
      }
    }

    begin() {
      const g = this.ctx;
      g.restore();                 // drop the clip left by the previous frame
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(this.sheet, 0, 0);
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      g.save();
      g.beginPath();
      g.rect(this.X(0), this.Y(0), T.W * this.s, T.H * this.s);
      g.clip();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      g.textAlign = 'left';
      this.taken = [];             // screen boxes already used this frame, so labels can step around them
      return g;
    }

    occupy(x0, y0, x1, y1) { (this.taken || (this.taken = [])).push([x0, y0, x1, y1]); }

    clashes(x0, y0, x1, y1) {
      return (this.taken || []).some(([a, b, c, d]) => x0 < c && x1 > a && y0 < d && y1 > b);
    }

    // =====================================================================
    // The chinagraph overlay
    // =====================================================================

    // A wax pencil never draws a clean line: stroke twice, slightly offset.
    waxy(g, draw, color, width, seed = 0) {
      g.save();
      g.strokeStyle = color;
      g.globalAlpha = (g.globalAlpha || 1) * 0.55;
      g.lineWidth = width * 1.5;
      g.translate(nz(seed, 1) * 0.8, nz(seed, 2) * 0.8);
      draw();
      g.restore();
      g.save();
      g.strokeStyle = color;
      g.lineWidth = width;
      draw();
      g.restore();
    }

    label(text, x, y, color, align = 'center', bg = true) {
      const g = this.ctx;
      const px = Math.max(8.5, Math.min(11.5, 11.5 * (this.s / 0.78)));
      g.font = NARROW(px);
      const w = g.measureText(text).width;
      const x0 = this.X(0), x1 = this.X(T.W), y0 = this.Y(0), y1 = this.Y(T.H);
      let lx = align === 'center' ? this.X(x) - w / 2 : align === 'right' ? this.X(x) - w : this.X(x);
      lx = Math.max(x0 + 3, Math.min(lx, x1 - w - 3));
      const clampY = (v) => Math.max(y0 + 12, Math.min(v, y1 - 3));
      // Where it wants to be, unless something is already printed there: then
      // the nearest free line above or below. A label on a label is unreadable.
      let ly = clampY(this.Y(y));
      const step = px + 4;
      for (const k of [0, -1, 1, -2, 2, -3, 3]) {
        const cy = clampY(this.Y(y) + k * step);
        if (!this.clashes(lx - 3, cy - px + 1.5, lx + w + 3, cy + 3.5)) { ly = cy; break; }
      }
      this.occupy(lx - 3, ly - px + 1.5, lx + w + 3, ly + 3.5);
      if (bg) {
        g.fillStyle = 'rgba(232,225,208,0.82)';
        g.fillRect(lx - 3, ly - px + 1.5, w + 6, px + 2);
      }
      g.fillStyle = color;
      g.fillText(text, lx, ly);
    }

    ring(p, r, color, dash, width = 1.5) {
      const g = this.ctx;
      g.beginPath(); g.arc(this.X(p.x), this.Y(p.y), this.R(r), 0, 7);
      g.strokeStyle = color; g.lineWidth = width;
      g.setLineDash(dash || []); g.stroke(); g.setLineDash([]);
    }

    disc(p, r, fill) {
      const g = this.ctx;
      g.beginPath(); g.arc(this.X(p.x), this.Y(p.y), this.R(r), 0, 7);
      g.fillStyle = fill; g.fill();
    }

    line(a, b, color, dash, width = 1.5) {
      const g = this.ctx;
      g.beginPath(); g.moveTo(this.X(a.x), this.Y(a.y)); g.lineTo(this.X(b.x), this.Y(b.y));
      g.strokeStyle = color; g.lineWidth = width;
      g.setLineDash(dash || []); g.stroke(); g.setLineDash([]);
    }

    // Friendly: the standard rectangle with the infantry cross, in blue wax.
    friendly(u, opts = {}) {
      const g = this.ctx, x = this.X(u.x), y = this.Y(u.y), w = 30, h = 19;
      const dead = u.alive === false;
      const col = dead ? '#8a8378' : opts.color || C.blue;
      g.save();
      g.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
      if (!opts.dashed) { g.fillStyle = C.blueSoft; g.fillRect(x - w / 2, y - h / 2, w, h); }
      const box = () => {
        g.beginPath();
        g.rect(x - w / 2, y - h / 2, w, h);
        g.moveTo(x - w / 2, y - h / 2); g.lineTo(x + w / 2, y + h / 2);
        g.moveTo(x + w / 2, y - h / 2); g.lineTo(x - w / 2, y + h / 2);
        g.stroke();
      };
      if (opts.dashed) g.setLineDash([4, 3]);
      this.waxy(g, box, col, 2, u.x + u.y);
      g.setLineDash([]);
      if (opts.me) {
        g.beginPath(); g.arc(x, y, 25, 0, 7);
        g.strokeStyle = 'rgba(27,79,156,0.45)'; g.lineWidth = 1.2; g.stroke();
      }
      if (opts.spoofed) {
        g.beginPath(); g.arc(x, y, 23, 0, 7);
        g.strokeStyle = C.violet; g.lineWidth = 1.6; g.setLineDash([2, 3]); g.stroke(); g.setLineDash([]);
      }
      if (u.hp != null) {
        const bw = w, bh = 3.5;
        g.fillStyle = 'rgba(33,30,24,0.22)';
        g.fillRect(x - bw / 2, y + h / 2 + 4, bw, bh);
        g.fillStyle = u.hp > 50 ? C.green : u.hp > 25 ? C.ochre : C.red;
        g.fillRect(x - bw / 2, y + h / 2 + 4, (bw * u.hp) / 100, bh);
      }
      g.restore();
      this.occupy(x - w / 2, y - h / 2, x + w / 2, y + h / 2 + (u.hp != null ? 8 : 0));
      const txt = (opts.text || u.pid) + (dead ? ' ✕' : '');
      this.label(txt, u.x, u.y - 17 / this.s, opts.labelColor || col);
    }

    // Hostile: the standard diamond, in red wax.
    enemy(e, opts = {}) {
      const g = this.ctx, x = this.X(e.x), y = this.Y(e.y), r = 13;
      const color = opts.color || C.red;
      g.save();
      g.globalAlpha = opts.alpha == null ? 1 : opts.alpha;
      const diamond = () => {
        g.beginPath();
        g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y);
        g.closePath();
        g.stroke();
      };
      if (!opts.hollow) {
        g.beginPath();
        g.moveTo(x, y - r); g.lineTo(x + r, y); g.lineTo(x, y + r); g.lineTo(x - r, y);
        g.closePath();
        g.fillStyle = color === C.red ? C.redSoft : 'rgba(107,63,160,0.14)';
        g.fill();
      }
      if (opts.dashed) g.setLineDash([4, 3]);
      this.waxy(g, diamond, color, 2, e.x + e.y * 3);
      g.setLineDash([]);
      if (opts.cross) {
        g.beginPath();
        g.moveTo(x - r, y - r); g.lineTo(x + r, y + r);
        g.moveTo(x + r, y - r); g.lineTo(x - r, y + r);
        g.strokeStyle = '#8a8378'; g.lineWidth = 1.6; g.stroke();
      }
      g.fillStyle = color;
      g.font = NARROW(9);
      g.textAlign = 'center';
      g.fillText(ABBR[e.type || e.ty] || '?', x, y + 3.5);
      g.textAlign = 'left';
      g.restore();
      this.occupy(x - r, y - r, x + r, y + r);
      if (opts.text) this.label(opts.text, e.x, e.y + (r + 14) / this.s, opts.labelColor || color);
    }

    blast(f, now) {
      const g = this.ctx, age = now - f.t;
      if (age < 0 || age > 3) return;
      const k = age / 3;
      g.beginPath(); g.arc(this.X(f.x), this.Y(f.y), this.R(20 + 50 * k), 0, 7);
      g.fillStyle = `rgba(184,35,43,${0.3 * (1 - k)})`; g.fill();
      g.strokeStyle = `rgba(176,122,20,${1 - k})`; g.lineWidth = 2; g.stroke();
    }

    sweep(c) {
      this.disc(c, c.r, 'rgba(46,107,79,0.09)');
      this.ring(c, c.r, 'rgba(46,107,79,0.55)', [3, 4]);
    }

    uav(v) {
      const g = this.ctx, x = this.X(v.x), y = this.Y(v.y);
      g.save();
      g.translate(x, y);
      g.strokeStyle = C.green; g.lineWidth = 2;
      g.beginPath();
      g.moveTo(-11, -4); g.lineTo(0, 4); g.lineTo(11, -4);
      g.moveTo(0, 4); g.lineTo(0, -7);
      g.stroke();
      g.restore();
      if (v.state && v.state !== 'IDLE') this.label('UAV ' + v.state, v.x, v.y - 13 / this.s, C.green);
    }

    hqMarker() {
      const g = this.ctx, x = this.X(T.hq.x), y = this.Y(T.hq.y);
      g.fillStyle = C.blue;
      g.fillRect(x - 6, y - 6, 12, 12);
      g.strokeStyle = C.paper; g.lineWidth = 1.2; g.strokeRect(x - 6, y - 6, 12, 12);
      this.label('BN HQ', T.hq.x + 12 / this.s, T.hq.y + 4 / this.s, C.blue, 'left');
    }

    // Emitters are instructor/replay only — a commander never sees one.
    emitter(e, now) {
      const g = this.ctx, x = this.X(e.x), y = this.Y(e.y);
      const spoof = e.type === 'SPOOFER';
      const col = spoof ? C.violet : C.red;
      if (!e.on) {
        this.ring(e, e.r, 'rgba(120,112,98,0.22)', [3, 7], 1);
        this.label(e.name + ' — off air', e.x, e.y - 17 / this.s, '#8a8378');
        return;
      }
      const grad = g.createRadialGradient(x, y, 0, x, y, this.R(e.r));
      grad.addColorStop(0, spoof ? 'rgba(107,63,160,0.17)' : 'rgba(184,35,43,0.15)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.beginPath(); g.arc(x, y, this.R(e.r), 0, 7);
      g.fillStyle = grad; g.fill();
      this.ring(e, e.r, spoof ? 'rgba(107,63,160,0.5)' : 'rgba(184,35,43,0.45)', [6, 5], 1.2);
      const k = (now * 0.3) % 1;
      this.ring(e, e.r * k, spoof ? `rgba(107,63,160,${0.35 * (1 - k)})` : `rgba(184,35,43,${0.35 * (1 - k)})`, [], 1.4);
      g.save();
      g.translate(x, y);
      g.strokeStyle = col; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, 9); g.lineTo(0, -10); g.stroke();
      for (let i = 1; i <= 3; i++) {
        g.globalAlpha = 1 - i * 0.24;
        g.beginPath(); g.arc(0, -10, i * 5, -Math.PI * 0.85, -Math.PI * 0.15);
        g.stroke();
      }
      g.restore();
      this.label(spoof ? 'GPS spoofer' : 'Jammer', e.x, e.y + 24 / this.s, col);
    }

    // A commander gets a bearing cut, never the emitter's position.
    dfArc(from, df) {
      if (!df) return;
      const g = this.ctx, x = this.X(from.x), y = this.Y(from.y);
      const mid = ((df.bearing - 90) * Math.PI) / 180;
      const half = (df.spread * Math.PI) / 180;
      const len = this.R(250);
      g.save();
      g.beginPath();
      g.moveTo(x, y);
      g.arc(x, y, len, mid - half, mid + half);
      g.closePath();
      g.fillStyle = `rgba(184,35,43,${0.05 + 0.09 * df.severity})`;
      g.fill();
      g.strokeStyle = 'rgba(184,35,43,0.4)';
      g.setLineDash([5, 4]); g.lineWidth = 1; g.stroke();
      g.restore();
      const lx = from.x + Math.cos(mid) * 262, ly = from.y + Math.sin(mid) * 262;
      this.label(`interference ${String(df.bearing).padStart(3, '0')}°±${df.spread}`, lx, ly, C.red);
    }

    intentArea(task, opts = {}) {
      const col = opts.covered === false ? C.ochre : 'rgba(33,30,24,0.42)';
      this.ring(task.area, task.area.r, col, [9, 6], 1.4);
      this.label(opts.text || task.id.replace(/_/g, ' '),
        task.area.x, task.area.y - (task.area.r + 7) / this.s,
        opts.covered === false ? C.ochre : '#6b6354');
    }

    // The link to HQ. A degraded one physically breaks up.
    link(u, L, now) {
      const g = this.ctx;
      const a = { x: this.X(u.x), y: this.Y(u.y) }, b = { x: this.X(T.hq.x), y: this.Y(T.hq.y) };
      const sev = L.severity != null ? L.severity : (L.delay || L.drop || L.garble ? 1 : 0);
      g.save();
      if (sev <= 0) {
        g.strokeStyle = 'rgba(27,79,156,0.38)';
        g.lineWidth = 1.2;
        g.setLineDash([7, 7]);
        g.lineDashOffset = -now * 18;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      } else {
        // The signal path still runs commander → HQ; it is the path that is
        // punched full of holes, so draw it on the true bearing and drop
        // segments rather than scribbling.
        const n = 30;
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const nx = -dy / len, ny = dx / len;      // unit normal, for a small waver
        g.strokeStyle = `rgba(184,35,43,${0.5 + 0.4 * sev})`;
        g.lineWidth = 1.3 + sev;
        g.lineCap = 'butt';
        for (let i = 0; i < n; i++) {
          if (Math.random() < 0.42 * sev) continue;   // this stretch does not get through
          const k0 = i / n, k1 = (i + 0.72) / n;
          const w0 = (T.noise(i, now | 0) - 0.5) * 5 * sev;
          const w1 = (T.noise(i + 1, now | 0) - 0.5) * 5 * sev;
          g.beginPath();
          g.moveTo(a.x + dx * k0 + nx * w0, a.y + dy * k0 + ny * w0);
          g.lineTo(a.x + dx * k1 + nx * w1, a.y + dy * k1 + ny * w1);
          g.stroke();
        }
        g.lineCap = 'round';
      }
      g.restore();
    }

    // Ground beyond your own sensors: you are not blind out there, you are
    // relying on somebody else's word. Rendered as tracing paper over the sheet.
    veil(me, range) {
      const g = this.ctx;
      g.save();
      g.beginPath();
      g.rect(0, 0, this.w, this.h);
      // a closed hole of its own: arc() would otherwise join it to the rect's
      // corner, and an anticlockwise 0→7 sweeps short of a full turn
      g.moveTo(this.X(me.x) + this.R(range), this.Y(me.y));
      g.arc(this.X(me.x), this.Y(me.y), this.R(range), 0, Math.PI * 2, true);
      g.closePath();
      g.fillStyle = 'rgba(214,206,186,0.30)';
      g.fill('evenodd');
      g.restore();
    }

    cursor(text) {
      if (!this.hover) return;
      const h = this.hover, g = this.ctx;
      g.strokeStyle = 'rgba(33,30,24,0.55)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(this.X(h.x) - 11, this.Y(h.y)); g.lineTo(this.X(h.x) + 11, this.Y(h.y));
      g.moveTo(this.X(h.x), this.Y(h.y) - 11); g.lineTo(this.X(h.x), this.Y(h.y) + 11);
      g.stroke();
      this.label((text ? text + ' ' : '') + T.gridRef(h.x, h.y), h.x + 15 / this.s, h.y - 9 / this.s, C.ink, 'left');
    }

    // Interference, as a damaged overlay rather than a glowing screen.
    static_(sev, now) {
      if (sev <= 0) return;
      const g = this.ctx;
      // short torn scuffs rather than full-width bands, so the sheet reads as
      // damaged rather than misprinted
      const marks = Math.round(2 + 5 * sev);
      for (let i = 0; i < marks; i++) {
        const w = this.w * (0.06 + Math.random() * 0.17);
        g.fillStyle = `rgba(184,35,43,${0.04 + Math.random() * 0.07 * sev})`;
        g.fillRect(Math.random() * (this.w - w), Math.random() * this.h, w, 1 + Math.random() * 1.8);
      }
    }
  }

  window.TacMap = TacMap;
  window.MAPCOL = C;
})();
