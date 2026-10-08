'use strict';
// Seeded randomness. Every random draw that can change the exercise goes
// through one of these, so the same seed and the same inputs give the same run.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a: a string (a test name, a typed seed) to a 32-bit seed.
function seedFrom(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < String(str).length; i++) { h ^= String(str).charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Stateless [0,1) from any values. For noise on a screen (a jittering signal
// bar, a bearing cut), so drawing a view never moves the simulation's stream.
function noise(...parts) { return mulberry32(seedFrom(parts.join('|')))(); }

const seedHex = (s) => (s >>> 0).toString(16).toUpperCase().padStart(8, '0');

// Accepts 42, "42", "0x2A", or the eight hex digits the screens print
// ("7F3A21C0" — always hex, even when every digit is 0–9); anything else is hashed.
function parseSeed(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v >>> 0;
  const s = String(v).trim();
  if (/^[0-9a-f]{8}$/i.test(s) || /^0x[0-9a-f]{1,8}$/i.test(s)) return parseInt(s.replace(/^0x/i, ''), 16) >>> 0;
  if (/^\d{1,10}$/.test(s) && +s <= 0xffffffff) return +s >>> 0;
  return seedFrom(s);
}

module.exports = { mulberry32, seedFrom, noise, seedHex, parseSeed };
