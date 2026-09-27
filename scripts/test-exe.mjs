/** Runs the built executable as a real process and proxies a real call through it. */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const exe = path.join(here, '..', 'dist', 'shrey' + (process.platform === 'win32' ? '.exe' : ''));
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccproxy-exe-'));
const UP = 9913;
const PROXY = 9914;

const sse = (n, d) => 'event: ' + n + '\ndata: ' + JSON.stringify(d) + '\n\n';

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse('message_start', { type: 'message_start', message: { id: 'm1', model: 'claude-opus-5', role: 'assistant', usage: { input_tokens: 5 } } }));
    res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'exe path works' } }));
    res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
    res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } }));
    res.write(sse('message_stop', { type: 'message_stop' }));
    res.end();
  });
});

const waitFor = async (probe, ms = 20000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await probe();
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

async function main() {
  assert.ok(fs.existsSync(exe), 'build the executable first: npm run build');
  await new Promise((r) => upstream.listen(UP, '127.0.0.1', r));

  const child = spawn(exe, [
    'serve',
    '--port', String(PROXY),
    '--upstream', 'http://127.0.0.1:' + UP,
    '--dir', path.join(TMP, 'captures'),
    '--no-github'
  ], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHREY_HOME: path.join(TMP, 'home'), SHREY_NO_GH: '1' } });

  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  try {
    await waitFor(async () => {
      const r = await fetch('http://127.0.0.1:' + PROXY + '/_ccproxy/api/status');
      if (!r.ok) throw new Error('not ready');
      return r.json();
    });

    const res = await fetch('http://127.0.0.1:' + PROXY + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-TESTKEY000111222333', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 32, stream: true, messages: [{ role: 'user', content: 'does the exe work?' }] })
    });
    const text = await res.text();
    assert.equal(res.status, 200, 'proxied status');
    assert.ok(text.includes('exe path works'), 'stream relayed through the exe');

    const sessions = await waitFor(async () => {
      const list = await (await fetch('http://127.0.0.1:' + PROXY + '/_ccproxy/api/sessions')).json();
      if (!list.length) throw new Error('no sessions yet');
      return list;
    });
    assert.equal(sessions[0].title, 'does the exe work?', 'session captured by the exe');
    assert.equal(sessions[0].usage.output, 4, 'usage captured');

    const html = await (await fetch('http://127.0.0.1:' + PROXY + '/_ccproxy/')).text();
    assert.ok(html.includes('shrey · trajectory'), 'embedded dashboard served from the exe');
    const appjs = await (await fetch('http://127.0.0.1:' + PROXY + '/_ccproxy/app.js')).text();
    assert.ok(appjs.includes('trajectory dashboard'), 'embedded app.js served');

    const redirect = await fetch('http://127.0.0.1:' + PROXY + '/', { redirect: 'manual' });
    assert.equal(redirect.status, 302, 'root redirects to the dashboard');

    const logFile = path.join(TMP, 'captures', 'sessions', new Date().toISOString().slice(0, 10), sessions[0].id, 'session.jsonl');
    assert.ok(fs.existsSync(logFile), 'log written to disk at ' + logFile);
    assert.ok(!fs.readFileSync(logFile, 'utf8').includes('TESTKEY000111222333'), 'no credential on disk');

    console.log('\n  Executable verified: proxying, capture, dashboard and redaction all work from dist/.\n');
  } finally {
    child.kill();
    await new Promise((r) => upstream.close(r));
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(TMP, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('\nFAILED: ' + (err?.stack ?? err));
  process.exit(1);
});
