'use strict';
// Screenshot tool. These pages hold an SSE connection open, so the page never
// reaches "load complete" and Chrome's --screenshot flag never fires. This drives
// Chrome over the DevTools Protocol instead and captures after a fixed settle
// delay, which works on a live, streaming page.
//
//   node tools/shoot.js <outDir> <port> <name=path[@WxH][!!js]> ...
//
// Anything after "!!" is run in the page before the capture, to put it into a
// state that only a click would reach (an open menu, a picker, a dialog).
//
// Needs no dependencies: Node 22 ships a global WebSocket client.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const CHROME = process.env.CHROME_BIN
  || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : (require('child_process').execSync('which google-chrome || which google-chrome-stable || which chromium-browser || which chromium 2>/dev/null || true', { encoding: 'utf8' }).trim() || 'google-chrome'));
const CDP_PORT = 9333;

const argv = process.argv.slice(2);
const outDir = argv[0] || '/tmp/shots';
const appPort = argv[1] || '3123';
const shots = argv.slice(2).map((a) => {
  const i = a.indexOf('=');
  const name = a.slice(0, i);
  const [rest, script] = a.slice(i + 1).split('!!');
  const [p, size] = rest.split('@');
  const [w, h] = (size || '1600x1000').split('x').map(Number);
  return { name, path: p, w, h, script: script || null };
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); this.onEvent = () => {}; }
  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && cdp.waiting.has(msg.id)) {
        const { resolve, reject } = cdp.waiting.get(msg.id);
        cdp.waiting.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        cdp.onEvent(msg.method, msg.params);
      }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP socket failed')), { once: true });
    });
    return cdp;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.waiting.has(id)) { this.waiting.delete(id); reject(new Error(method + ' timed out')); }
      }, 30000);
    });
  }
  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const profile = fs.mkdtempSync('/tmp/shoot-profile-');
  const chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu',
    '--hide-scrollbars', '--force-device-scale-factor=2',
    '--force-color-profile=srgb', '--font-render-hinting=none',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
      target = list.find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  if (!target) { console.error('Chrome did not come up'); chrome.kill(); process.exit(1); }

  const cdp = await Cdp.open(target.webSocketDebuggerUrl);
  const failures = [];
  let pageErrors = [];
  cdp.onEvent = (method, p) => {
    if (method === 'Runtime.exceptionThrown') {
      const d = p.exceptionDetails || {};
      pageErrors.push((d.exception && d.exception.description) || d.text || 'uncaught exception');
    } else if (method === 'Runtime.consoleAPICalled' && p.type === 'error') {
      pageErrors.push('console.error: ' + (p.args || []).map((a) => a.value || a.description || '').join(' '));
    }
  };
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  for (const s of shots) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: s.w, height: s.h, deviceScaleFactor: 2, mobile: false,
    });
    pageErrors = [];
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${appPort}${s.path}` });
    await sleep(2400);
    if (s.script) {
      try { await cdp.send('Runtime.evaluate', { expression: s.script, awaitPromise: true }); }
      catch (e) { console.error(`  script failed for ${s.name}: ${e.message}`); }
      await sleep(600);
    }
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const out = path.join(outDir, `${s.name}.png`);
    fs.writeFileSync(out, Buffer.from(data, 'base64'));
    const errs = pageErrors.length ? ` (${pageErrors.length} page error${pageErrors.length > 1 ? 's' : ''})` : '';
    console.log(`  ${s.name} → ${out}${errs}`);
    if (pageErrors.length) pageErrors.forEach((e) => console.error(`    ${e}`));
    if (pageErrors.length) failures.push(s.name);
  }

  cdp.close();
  chrome.kill();
  try { fs.rmSync(profile, { recursive: true }); } catch { /* best effort */ }

  if (failures.length) {
    console.error(`\n${failures.length} shot(s) had page errors: ${failures.join(', ')}`);
    process.exit(1);
  }
})().catch((e) => { console.error(e); process.exit(1); });
