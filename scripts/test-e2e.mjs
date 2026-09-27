/**
 * End-to-end check: a fake Anthropic upstream, the real proxy, a real client.
 * Verifies that the bytes the client receives are exactly the bytes upstream sent,
 * and that the capture on disk reconstructs the same conversation.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { startServer } from '../src/server.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ccproxy-test-'));
const UPSTREAM_PORT = 9911;
const PROXY_PORT = 9912;

let upstreamSaw = [];

function sse(name, data) {
  return 'event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n';
}

const upstream = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    upstreamSaw.push({ url: req.url, headers: req.headers, body });

    if (req.url.startsWith('/v1/messages') && body.stream) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'request-id': 'req_upstream_1',
        'anthropic-ratelimit-requests-remaining': '99'
      });
      const turn = body.messages.length;
      res.write(sse('message_start', {
        type: 'message_start',
        message: { id: 'msg_' + turn, model: body.model, role: 'assistant', usage: { input_tokens: 120, cache_read_input_tokens: 40 } }
      }));
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      for (const piece of ['Hel', 'lo ', 'fro', 'm t', 'urn ', String(turn)]) {
        res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } }));
        await new Promise((r) => setTimeout(r, 6));
      }
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      if (turn === 1) {
        res.write(sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} } }));
        for (const piece of ['{"comm', 'and":"ls -la"', '}']) {
          res.write(sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: piece } }));
        }
        res.write(sse('content_block_stop', { type: 'content_block_stop', index: 1 }));
      }
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: turn === 1 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 17 } }));
      res.write(sse('message_stop', { type: 'message_stop' }));
      res.end();
      return;
    }

    if (req.url.startsWith('/v1/messages')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_buffered', model: body.model, role: 'assistant', content: [{ type: 'text', text: 'buffered reply' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 3 } }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: 'nope' } }));
  });
});

async function post(pathname, body, extraHeaders = {}) {
  const res = await fetch('http://127.0.0.1:' + PROXY_PORT + pathname, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'sk-ant-api03-SECRETSECRETSECRET1234',
      'anthropic-version': '2023-06-01',
      'user-agent': 'claude-cli/2.1.268 (test)',
      ...extraHeaders
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, text, headers: res.headers };
}

const SYSTEM = [{ type: 'text', text: 'You are Claude Code. Working directory: C:/tmp' }];
const TOOLS = [{ name: 'Bash', description: 'run a command', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }];

async function main() {
  await new Promise((r) => upstream.listen(UPSTREAM_PORT, '127.0.0.1', r));

  const cfg = loadConfig({
    port: PROXY_PORT,
    host: '127.0.0.1',
    upstream: 'http://127.0.0.1:' + UPSTREAM_PORT,
    captureDir: path.join(TMP, 'captures'),
    github: { enabled: false },
    capture: { raw: true }
  });
  const started = await startServer(cfg, { log: () => {} });

  // ---- subscribe to the live feed before any traffic -------------------
  const LF = String.fromCharCode(10);
  const FRAME_SEP = LF + LF;
  const liveFrames = [];
  const liveAbort = new AbortController();
  const liveRes = await fetch('http://127.0.0.1:' + PROXY_PORT + '/_ccproxy/api/live', { signal: liveAbort.signal });
  (async () => {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of liveRes.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf(FRAME_SEP)) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + FRAME_SEP.length);
          const line = frame.split(LF).find((l) => l.startsWith('data: '));
          if (line) {
            try { liveFrames.push(JSON.parse(line.slice(6))); } catch { /* keepalive */ }
          }
        }
      }
    } catch { /* aborted at teardown */ }
  })();

  // ---- turn 1 ---------------------------------------------------------
  const m1 = [{ role: 'user', content: 'ping the repo' }];
  const r1 = await post('/v1/messages', { model: 'claude-opus-5', max_tokens: 1024, stream: true, system: SYSTEM, tools: TOOLS, messages: m1 });
  assert.equal(r1.status, 200, 'turn 1 status');
  // The wire carries the deltas unjoined; that is exactly what must be relayed.
  assert.ok(r1.text.includes('"text":"Hel"') && r1.text.includes('"text":"lo "'), 'stream relayed delta-by-delta');
  assert.ok(r1.text.includes('message_stop'), 'stream complete');
  assert.equal(r1.headers.get('request-id'), 'req_upstream_1', 'upstream headers relayed');

  // ---- turn 2: same conversation, history replayed ---------------------
  const m2 = [
    ...m1,
    { role: 'assistant', content: [{ type: 'text', text: 'Hello from turn 1' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { command: 'ls -la' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'total 0\ndrwxr-xr-x 1 x x 0 .' }] }
  ];
  const r2 = await post('/v1/messages', { model: 'claude-opus-5', max_tokens: 1024, stream: true, system: SYSTEM, tools: TOOLS, messages: m2 });
  assert.equal(r2.status, 200, 'turn 2 status');

  // ---- a different conversation ---------------------------------------
  await post('/v1/messages', { model: 'claude-opus-5', max_tokens: 64, stream: true, system: SYSTEM, tools: TOOLS, messages: [{ role: 'user', content: 'unrelated question' }] });

  // ---- non-streaming + an error ---------------------------------------
  const r4 = await post('/v1/messages', { model: 'claude-opus-5', max_tokens: 64, messages: [{ role: 'user', content: 'buffered please' }] });
  assert.equal(JSON.parse(r4.text).content[0].text, 'buffered reply', 'buffered relay');
  const r5 = await post('/v1/nonexistent', { messages: [] });
  assert.equal(r5.status, 404, 'error status relayed');

  await new Promise((r) => setTimeout(r, 2200)); // let derived views settle

  // ---- assertions on the capture --------------------------------------
  const store = started.store;
  const sessions = store.listSessions();
  const conversations = sessions.filter((s) => !s.id.startsWith('misc-'));
  assert.equal(conversations.length, 3, 'three distinct conversations, got ' + conversations.length);

  const main1 = conversations.find((s) => s.title === 'ping the repo');
  assert.ok(main1, 'session titled from first user message');
  assert.equal(main1.requests, 2, 'two requests correlated into one session, got ' + main1.requests);
  assert.equal(main1.usage.output, 34, 'usage accumulated across requests');

  const events = store.readLog(main1.id);
  const types = events.map((e) => e.type);
  assert.ok(types.includes('session/start'), 'session/start');
  assert.equal(types.filter((t) => t === 'request/context').length, 1, 'context announced once, not per request');
  assert.equal(types.filter((t) => t === 'request/start').length, 2, 'two request/start');
  assert.equal(types.filter((t) => t === 'response/message').length, 2, 'two assembled replies');

  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i), 'seq is contiguous and zero-based');

  const assembled = events.filter((e) => e.type === 'response/message')[0].data;
  assert.equal(assembled.content[0].text, 'Hello from turn 1', 'text reassembled from deltas');
  assert.deepEqual(assembled.content[1].input, { command: 'ls -la' }, 'tool args reassembled from partial json');
  assert.equal(assembled.stopReason, 'tool_use', 'stop reason');
  assert.ok(assembled.timings.ttftMs >= 0, 'ttft recorded');
  assert.ok(assembled.timings.totalMs >= assembled.timings.ttftMs, 'total >= ttft');

  // secrets must never reach disk
  const reqStart = events.find((e) => e.type === 'request/start');
  assert.ok(reqStart.data.headers['x-api-key'].startsWith('«redacted'), 'api key fingerprinted');
  const logText = fs.readFileSync(path.join(store.getSession(main1.id).dir, 'session.jsonl'), 'utf8');
  assert.ok(!logText.includes('SECRETSECRETSECRET'), 'raw key absent from the log');

  // content addressing deduplicates the replayed history
  const refs1 = events.filter((e) => e.type === 'request/start')[0].data.messageRefs;
  const refs2 = events.filter((e) => e.type === 'request/start')[1].data.messageRefs;
  assert.equal(refs2[0], refs1[0], 'the replayed first message resolves to the same object');
  assert.equal(events.filter((e) => e.type === 'request/start')[1].data.newMessageRefs.length, 2, 'only new messages flagged');

  // derived views
  const dir = store.getSession(main1.id).dir;
  for (const f of ['manifest.json', 'transcript.md']) {
    assert.ok(fs.existsSync(path.join(dir, f)), f + ' written');
  }
  const transcript = fs.readFileSync(path.join(dir, 'transcript.md'), 'utf8');
  assert.ok(transcript.includes('ping the repo'), 'transcript contains the prompt');
  assert.ok(transcript.includes('tool_use'), 'transcript contains the tool call');
  assert.ok(!transcript.includes('SECRETSECRET'), 'transcript has no secrets');
  assert.ok(fs.existsSync(path.join(store.root, 'INDEX.md')), 'INDEX.md written');
  assert.ok(fs.existsSync(path.join(dir, 'raw')), 'raw dumps written when --raw');

  // the upstream really received the original credential
  assert.equal(upstreamSaw[0].headers['x-api-key'], 'sk-ant-api03-SECRETSECRETSECRET1234', 'credential passed through untouched');
  assert.equal(upstreamSaw[0].headers['anthropic-version'], '2023-06-01', 'version header preserved');

  // live feed carried both the streaming edge and the committed events
  assert.ok(liveFrames.some((f) => f.kind === 'partial'), 'live feed published streaming partials');
  assert.ok(liveFrames.some((f) => f.kind === 'partial-end'), 'live feed closed the partial');
  assert.ok(liveFrames.some((f) => f.kind === 'event' && f.event.type === 'response/message'), 'live feed published committed events');
  assert.ok(liveFrames.some((f) => f.kind === 'event' && f.summary && f.summary.id), 'live events carry a session summary');
  liveAbort.abort();

  // dashboard API
  const api = async (p) => (await fetch('http://127.0.0.1:' + PROXY_PORT + '/_ccproxy' + p)).json();
  const list = await api('/api/sessions');
  assert.ok(list.length >= 3, 'sessions api');
  const detail = await api('/api/sessions/' + encodeURIComponent(main1.id));
  assert.ok(detail.events.length > 5 && Object.keys(detail.objects).length >= 3, 'session detail resolves objects');
  const status = await api('/api/status');
  assert.equal(status.redactSecrets, true, 'status reports redaction');
  const html = await (await fetch('http://127.0.0.1:' + PROXY_PORT + '/_ccproxy/')).text();
  assert.ok(html.includes('<title>shrey'), 'dashboard html served');

  await started.shutdown();
  await new Promise((r) => upstream.close(r));
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log('\n  All end-to-end checks passed.');
  console.log('  ' + conversations.length + ' conversations reconstructed from ' + upstreamSaw.length + ' proxied calls.\n');
}

main().catch((err) => {
  console.error('\nFAILED: ' + (err?.stack ?? err));
  process.exit(1);
});
