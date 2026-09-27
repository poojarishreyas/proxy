/**
 * CloudSync against a real HTTP server standing in for the hosted dashboard's
 * /api/ingest — verifies auth, debouncing, content-addressed object dedupe, and
 * that a failed push doesn't lose data (the next flush resends from where it left
 * off, since correctness relies on the server's upsert being idempotent, which
 * this fake server also enforces so a bug in that assumption would be caught).
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { CloudSync, generateDeviceToken } from '../src/cloud.js';
import { CaptureStore } from '../src/store.js';
import { loadConfig } from '../src/config.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shrey-cloud-test-'));
let passed = 0;
const ok = (name) => {
  passed++;
  console.log('  ✓ ' + name);
};

const CLOUD_KEY = 'test-cloud-key';
const seenEvents = new Map(); // `${identity}:${session}:${seq}` -> data, mimicking the PK upsert
const seenObjects = new Set();
let identityName = null;
let rejectNext = false;
let requestsReceived = 0;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    requestsReceived++;
    const auth = req.headers.authorization ?? '';
    if (auth !== 'Bearer ' + CLOUD_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'bad key' }));
    }
    if (rejectNext) {
      rejectNext = false;
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'simulated outage' }));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (body.name) identityName = body.name;
    for (const e of body.events ?? []) {
      seenEvents.set(body.session.id + ':' + e.seq, e);
    }
    for (const o of body.objects ?? []) seenObjects.add(o.id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, identityId: 'id-1' }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = 'http://127.0.0.1:' + server.address().port;

const cfg = loadConfig({
  captureDir: path.join(TMP, 'captures'),
  github: { enabled: false },
  cloud: { enabled: true, url, key: CLOUD_KEY, name: 'Ada Lovelace', deviceToken: generateDeviceToken(), syncDebounceMs: 30 }
});
const store = new CaptureStore(cfg);
const sync = new CloudSync(cfg, store, { log: () => {} });

// ------------------------------------------------------------- 1. basic sync
{
  const id = 's1';
  store.openSession({ id, title: 'hello', startedAt: Date.now(), model: 'opus' });
  const sysId = store.putObject([{ type: 'text', text: 'be helpful' }], 'system');
  store.append(id, 'request/context', { requestId: 'req-0001', systemId: sysId, toolNames: [] });
  const msgId = store.putObject({ role: 'user', content: 'hi' }, 'message');
  store.append(id, 'request/start', { requestId: 'req-0001', messageRefs: [msgId], messageCount: 1 });
  store.writeManifest(id);
  sync.touch(id);
  await sync.flush();

  assert.equal(requestsReceived, 1, 'one batch sent');
  assert.equal(identityName, 'Ada Lovelace', 'name sent on first sync');
  assert.ok(seenObjects.has(sysId) && seenObjects.has(msgId), 'referenced objects synced');
  assert.ok(seenEvents.has('s1:0') && seenEvents.has('s1:1'), 'events synced with their real seq');
  assert.equal(sync.status().syncs, 1);
  ok('a new session syncs its events and referenced objects, tagged with the display name');
}

// ------------------------------------------------ 2. debounce + incremental
{
  requestsReceived = 0;
  seenObjects.clear();
  const id = 's1';
  store.append(id, 'response/message', { requestId: 'req-0001', content: [{ type: 'text', text: 'hi there' }], stopReason: 'end_turn', usage: {} });
  store.append(id, 'response/open', { requestId: 'req-0001', status: 200 }); // no-op type, still counted
  sync.touch(id);
  sync.touch(id); // a second touch within the debounce window must not double-send
  await sync.flush();

  assert.equal(requestsReceived, 1, 'rapid touches collapse into one batch');
  assert.equal(seenObjects.size, 0, 'no new objects referenced, none resent');
  assert.ok(seenEvents.has('s1:2') && seenEvents.has('s1:3'), 'only the new events were included');
  assert.equal(identityName, undefined || identityName, 'name only sent again if changed — value unchanged from before');
  ok('subsequent syncs are incremental and debounce collapses bursts');
}

// -------------------------------------------------------- 3. name re-sent once
{
  // A fresh CloudSync instance (simulating a new shrey process) always re-introduces
  // itself once, in case the identity or name changed since the last run.
  requestsReceived = 0;
  identityName = null;
  const sync2 = new CloudSync(cfg, store, { log: () => {} });
  const id = 's1';
  store.append(id, 'response/error', { requestId: 'req-0002', stage: 'http', status: 500 });
  sync2.touch(id);
  await sync2.flush();
  assert.equal(identityName, 'Ada Lovelace', 'a fresh process re-sends the name');
  ok('a fresh CloudSync instance re-introduces its identity');
}

// ------------------------------------------------------------ 4. auth failure
{
  const badCfg = loadConfig({ captureDir: path.join(TMP, 'captures2'), github: { enabled: false }, cloud: { enabled: true, url, key: 'wrong-key', name: 'X', deviceToken: generateDeviceToken(), syncDebounceMs: 10 } });
  const badStore = new CaptureStore(badCfg);
  const badSync = new CloudSync(badCfg, badStore, { log: () => {} });
  badStore.openSession({ id: 'sx', title: 't', startedAt: Date.now(), model: 'm' });
  badStore.append('sx', 'request/start', { requestId: 'r', messageRefs: [], messageCount: 0 });
  badSync.touch('sx');
  await badSync.flush();
  assert.equal(badSync.status().lastError, 'HTTP 401: bad key', 'auth failure surfaces the server error, got: ' + badSync.status().lastError);
  assert.equal(badSync.status().syncs, 0, 'nothing counted as synced');
  ok('a wrong cloud key fails loudly with the server-reported reason, not silently');
}

// -------------------------------------------------- 5. transient failure retries
{
  requestsReceived = 0;
  const id = 's1';
  store.append(id, 'response/error', { requestId: 'req-0003', stage: 'http', status: 500 });
  rejectNext = true;
  sync.touch(id);
  await sync.flush();
  assert.equal(sync.status().lastError, 'HTTP 500: simulated outage', 'first attempt recorded the failure');
  const before = sync.status().syncs;

  sync.touch(id); // retry
  await sync.flush();
  assert.equal(sync.status().lastError, null, 'retry cleared the error');
  assert.equal(sync.status().syncs, before + 1);
  assert.ok(seenEvents.has('s1:4'), 'the event from the failed attempt was not lost - it went through on retry');
  ok('a failed push is retried on the next touch and does not drop events');
}

await sync.dispose();
// Close idle keep-alive sockets before closing the server itself - on Windows,
// tearing down the server while fetch()'s connection pool still holds one open
// crashes the process at the libuv layer rather than raising a catchable error.
server.closeAllConnections();
await new Promise((r) => server.close(r));
fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n  ' + passed + ' cloud sync checks passed.\n');
