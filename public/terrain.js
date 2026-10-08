// Shared scenario geography — loaded by the server (require) and the browser (<script>).
// Pure terrain only: force packages, intent and EW layout live in engine/scenarios.js.
(function (root) {
  const W = 1000, H = 640, CELL = 50; // 1 unit = 10 m → 10 km x 6.4 km area, 500 m grid squares

  const T = {
    W, H, CELL, UNIT_M: 10,
    name: 'OP FOG LINE',
    sheet: 'SHEET 54B/11',
    area: 'GANGA LINE — RAMPUR SECTOR',
    river: [[0, 300], [150, 322], [300, 310], [450, 336], [600, 322], [750, 300], [880, 318], [1000, 306]],
    bridges: [{ x: 300, y: 310, name: 'BR WEST' }, { x: 750, y: 300, name: 'BR EAST' }],

    // Woodland blocks. Irregular outlines — a forest edge follows the ground,
    // it is never a quadrilateral.
    forests: [
      [[74, 126], [128, 104], [182, 110], [214, 138], [222, 174], [198, 202], [150, 212], [108, 198], [80, 168]],
      [[560, 74], [608, 62], [652, 76], [668, 108], [658, 146], [622, 166], [580, 158], [558, 126]],
      [[836, 420], [888, 408], [932, 424], [946, 462], [934, 506], [896, 530], [854, 520], [834, 482]],
      [[110, 444], [156, 428], [200, 438], [214, 470], [200, 504], [158, 516], [122, 500], [106, 472]],
      [[392, 372], [428, 364], [456, 380], [456, 406], [432, 422], [400, 418], [386, 396]],
    ],

    // Relief. `top` is the spot height in metres; contours are drawn from it.
    hills: [
      { x: 420, y: 175, r: 55, name: 'HILL 412', top: 412 },
      { x: 860, y: 150, r: 45, name: 'HILL 389', top: 389 },
      { x: 180, y: 600, r: 40, name: 'HILL 204', top: 204 },
    ],

    roads: [
      { pts: [[300, 0], [300, 310], [420, 430], [520, 500]], cls: 'metalled' },
      { pts: [[750, 0], [750, 300], [640, 430], [520, 500]], cls: 'metalled' },
      { pts: [[520, 500], [520, 640]], cls: 'metalled' },
      { pts: [[0, 575], [300, 560], [520, 500], [760, 555], [1000, 545]], cls: 'track' },
    ],

    town: { x: 520, y: 500, r: 42, name: 'RAMPUR' },
    hq: { x: 520, y: 625, name: 'BN HQ' },
    friendly: [
      { pid: 'ALPHA', name: '1 PL / A COY', callsign: 'ALPHA', x: 300, y: 405 },
      { pid: 'BRAVO', name: '2 PL / A COY', callsign: 'BRAVO', x: 735, y: 400 },
      { pid: 'CHARLIE', name: '3 PL / A COY', callsign: 'CHARLIE', x: 520, y: 545 },
    ],
  };

  T.dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // Grid reference, NATO-ish: column letter, row number, 2-digit sub-square.
  T.gridRef = function (x, y) {
    const c = Math.max(0, Math.min(19, Math.floor(x / CELL)));
    const r = Math.max(0, Math.min(12, Math.floor(y / CELL)));
    const sub = Math.floor(((x % CELL) / CELL) * 10) + '' + Math.floor(((y % CELL) / CELL) * 10);
    return String.fromCharCode(65 + c) + (r + 1) + '-' + sub;
  };

  T.inPoly = function (x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  T.inForest = function (x, y) { return T.forests.some((p) => T.inPoly(x, y, p)); };

  // Shortest distance from point c to segment a→b. Used for terrain masking of EW.
  T.segDist = function (a, b, c) {
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
    if (!L2) return Math.hypot(c.x - a.x, c.y - a.y);
    let t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
  };

  // True when high ground sits between the two points — radio shadow.
  T.masked = function (a, b) {
    return T.hills.some((h) => T.segDist(a, b, h) < h.r * 0.85 && T.dist(a, h) > h.r * 0.5 && T.dist(b, h) > h.r * 0.5);
  };

  T.bearing = function (from, to) {
    const d = (Math.atan2(to.x - from.x, -(to.y - from.y)) * 180) / Math.PI;
    return (d + 360) % 360;
  };
  const CARD = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  T.bearingName = function (deg) { return CARD[Math.round((deg % 360) / 22.5) % 16]; };

  // Deterministic value noise. Keeps every hand-drawn wobble identical between
  // redraws, so the map never shimmers.
  T.noise = function (x, y) {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = T;
  else root.TERRAIN = T;
})(this);
