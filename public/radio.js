// Radio sound for the commander station, synthesised with WebAudio — no audio
// files, so it works on a closed network. A trainer about radio failure should
// sound like a radio: a squelch when traffic arrives, crackle when it arrives
// broken, a tone when you come under fire, a key-up click when you transmit.
//
// Browsers only allow audio after a user gesture, so the context is created on
// the first click or keypress; cues before that are skipped, not queued.
(function () {
  const KEY = 'fogline.radio.muted';
  let ctx = null, master = null, noiseBuf = null;
  let muted = false;
  try { muted = localStorage.getItem(KEY) === '1'; } catch { /* storage blocked: default to sound on */ }

  function ensure() {
    if (ctx) return true;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.11;
    master.connect(ctx.destination);
    // one second of white noise, reused by every cue
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return true;
  }
  const wake = () => { if (ensure() && ctx.state === 'suspended') ctx.resume(); };
  window.addEventListener('pointerdown', wake, { once: false });
  window.addEventListener('keydown', wake, { once: false });

  const ready = () => !muted && ctx && ctx.state === 'running';

  // band-limited noise burst: the sound of an open squelch
  function burst({ dur, freq = 1800, q = 0.9, gain = 1, gate = 0 }) {
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = freq; bp.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.008);
    if (gate) {
      // a broken signal drops in and out
      for (let k = 0.03; k < dur; k += 0.03 + Math.random() * 0.04) {
        g.gain.setValueAtTime(Math.random() < gate ? 0.02 : gain * (0.5 + Math.random() * 0.6), t + k);
      }
    }
    g.gain.setValueAtTime(gain * 0.9, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp).connect(g).connect(master);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  function tone(freq, start, dur, gain = 0.6, type = 'square') {
    const t = ctx.currentTime + start;
    const o = ctx.createOscillator();
    o.type = type; o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.setValueAtTime(gain, t + dur - 0.02);
    g.gain.linearRampToValueAtTime(0, t + dur);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 2200;
    o.connect(lp).connect(g).connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  const Radio = {
    // traffic arrives cleanly: a short squelch tail
    receive() { if (ready()) burst({ dur: 0.13, freq: 2100, gain: 0.55 }); },
    // traffic arrives corrupted: longer, gated crackle
    garbled() { if (ready()) burst({ dur: 0.42, freq: 1300, q: 0.6, gain: 0.85, gate: 0.45 }); },
    // own eyes on an enemy, or coming under fire
    contact() { if (!ready()) return; tone(660, 0, 0.11, 0.5); tone(440, 0.14, 0.18, 0.5); },
    // you key the handset to send
    transmit() { if (ready()) { burst({ dur: 0.05, freq: 3200, gain: 0.35 }); tone(1200, 0.0, 0.04, 0.15, 'sine'); } },
    // something you sent did not get through
    failed() { if (!ready()) return; tone(300, 0, 0.16, 0.45, 'sawtooth'); tone(220, 0.18, 0.22, 0.45, 'sawtooth'); },

    get muted() { return muted; },
    setMuted(m) {
      muted = !!m;
      try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch { /* fine */ }
    },
  };

  window.Radio = Radio;
})();
