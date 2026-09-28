/**
 * The `shrey` command end to end, without touching the network or GitHub:
 *   - argument routing between shrey and Claude Code
 *   - GitHub URL normalisation
 *   - archival to a local bare repository standing in for GitHub (via insteadOf),
 *     including a rejected push that must rebase and retry
 *   - dashboard write protection (token, Host header) and the settings API
 *   - the real launch path, with a fake `claude` that records what it was given
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'shrey-cli-'));
const HOME = path.join(TMP, 'home');
process.env.SHREY_HOME = HOME; // before config.js is imported: HOME is read once
process.env.SHREY_NO_GH = '1'; // never let a test reach real GitHub

const { parseArgs } = await import('../src/args.js');
const { normalizeGithubUrl } = await import('../src/github.js');
const { loadConfig } = await import('../src/config.js');
const { startServer } = await import('../src/server.js');
const { CaptureStore } = await import('../src/store.js');
const { Archiver } = await import('../src/git.js');

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const fwd = (p) => p.replace(/\\/g, '/');
let passed = 0;
const ok = (name) => {
  passed++;
  console.log('  ✓ ' + name);
};

// ------------------------------------------------------------ 1. arg routing
{
  let r = parseArgs([]);
  assert.deepEqual([r.command, r.rest], [null, []]);
  r = parseArgs(['-p', 'hello world', '--model', 'opus']);
  assert.equal(r.command, null);
  assert.deepEqual(r.rest, ['-p', 'hello world', '--model', 'opus'], 'unknown flags go to Claude Code');
  r = parseArgs(['--resume', '--no-push', '--port', '9000']);
  assert.deepEqual(r.rest, ['--resume']);
  assert.equal(r.flags['no-push'], true);
  assert.equal(r.flags.port, '9000');
  r = parseArgs(['github', 'https://github.com/a/b']);
  assert.deepEqual([r.command, r.rest], ['github', ['https://github.com/a/b']]);
  r = parseArgs(['--', '--help', '--port', '1']);
  assert.equal(r.flags.help, undefined, 'after -- nothing is ours');
  assert.deepEqual(r.rest, ['--help', '--port', '1']);
  r = parseArgs(['config', 'list']);
  assert.equal(r.command, null, 'claude subcommands are not swallowed');
  assert.deepEqual(r.rest, ['config', 'list']);
  ok('arguments route to shrey or to Claude Code');
}

// ----------------------------------------------------- 2. GitHub URL shapes
{
  const want = 'https://github.com/you/traces';
  for (const input of [
    'https://github.com/you/traces',
    'https://github.com/you/traces.git',
    'https://github.com/you/traces/',
    'github.com/you/traces',
    'you/traces',
    '  https://www.github.com/you/traces  '
  ]) {
    assert.equal(normalizeGithubUrl(input)?.web, want, input);
  }
  assert.equal(normalizeGithubUrl('git@github.com:you/traces.git').remote, 'git@github.com:you/traces.git', 'ssh stays ssh');
  for (const bad of ['', 'https://gitlab.com/you/traces', 'https://github.com/you', 'not a url', 'a/b/c', 'https://github.com/you/traces/tree/main']) {
    assert.equal(normalizeGithubUrl(bad), null, 'rejects ' + bad);
  }
  ok('GitHub URLs normalise, everything else is rejected');
}

// --------------------------------------------- 3. archival to a stand-in remote
{
  const bare = path.join(TMP, 'remote.git');
  execFileSync('git', ['init', '--bare', '-b', 'main', bare], { windowsHide: true, stdio: 'ignore' });
  const cfg = loadConfig({ captureDir: path.join(TMP, 'arch-captures'), github: { commitDebounceMs: 50 } });
  const store = new CaptureStore(cfg);
  const archiver = new Archiver(cfg, store, { log: () => {} });
  await archiver.init();
  assert.equal(archiver.status().remote, null, 'nothing is pushed before a destination is chosen');
  // Route the GitHub URL to the local bare repo for this repository only.
  git(store.root, 'config', 'url.' + fwd(bare) + '.insteadOf', 'https://github.com/shrey-test/traces.git');

  const bad = await archiver.setRemote('https://gitlab.com/x/y');
  assert.equal(bad.ok, false, 'non-GitHub URL refused');

  const res = await archiver.setRemote('shrey-test/traces');
  assert.equal(res.ok, true, 'setRemote ok: ' + res.error);
  assert.equal(res.remote, 'https://github.com/shrey-test/traces');
  assert.ok(git(bare, 'log', '--oneline', 'main').length > 0, 'initial captures pushed');
  const stored = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  assert.equal(stored.github.remote, 'https://github.com/shrey-test/traces', 'remote persisted');
  assert.equal(stored.setupDone, true);
  ok('setting a repository pushes existing captures and persists the choice');

  // Someone else pushes to the same repo; our next push must rebase, not fail.
  const other = path.join(TMP, 'other');
  execFileSync('git', ['clone', '-q', bare, other], { windowsHide: true, stdio: 'ignore' });
  git(other, 'config', 'user.email', 'o@x');
  git(other, 'config', 'user.name', 'o');
  fs.mkdirSync(path.join(other, 'sessions', 'elsewhere'), { recursive: true });
  fs.writeFileSync(path.join(other, 'sessions', 'elsewhere', 'note.txt'), 'from another machine\n');
  git(other, 'add', '-A');
  git(other, 'commit', '-qm', 'other machine');
  git(other, 'push', '-q', 'origin', 'main');

  store.openSession({ id: 's-test-rebase', title: 't', startedAt: Date.now(), model: 'm' });
  store.writeManifest('s-test-rebase');
  await archiver.flush();
  assert.equal(archiver.status().lastError, null, 'push after rebase: ' + archiver.status().lastError);
  const files = git(bare, 'ls-tree', '-r', '--name-only', 'main');
  assert.ok(files.includes('sessions/elsewhere/note.txt') && files.includes('s-test-rebase'), 'both histories kept');
  ok('a push rejected by newer remote history rebases and retries');

  const off = await archiver.setRemote('off');
  assert.equal(off.ok, true);
  assert.equal(archiver.status().remote, null);
  assert.throws(() => git(store.root, 'remote', 'get-url', 'origin'), 'origin removed');
  ok('switching to local-only stops pushing');
}

// ---------------------------------------------- 4. dashboard write protection
{
  const cfg = loadConfig({ port: 0, captureDir: path.join(TMP, 'dash-captures'), github: { enabled: true, remote: null, autoCreate: false } });
  cfg.port = 9951;
  const started = await startServer(cfg, { log: () => {}, portFallback: true });
  const base = 'http://127.0.0.1:' + cfg.port + '/_ccproxy';
  const html = await (await fetch(base + '/')).text();
  const token = html.match(/name="shrey-token" content="([0-9a-f]+)"/)?.[1];
  assert.ok(token, 'token embedded in the page');

  const post = (p, body, headers = {}) =>
    fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  assert.equal((await post('/api/settings', { githubRemote: 'evil/repo' })).status, 403, 'no token → refused');
  assert.equal((await post('/api/settings', { githubRemote: 'evil/repo' }, { 'x-shrey-token': 'nope' })).status, 403, 'wrong token → refused');

  const rebound = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: cfg.port, path: '/_ccproxy/api/sessions', headers: { host: 'attacker.example:' + cfg.port } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.end();
  });
  assert.equal(rebound, 403, 'foreign Host header (DNS rebinding) refused');

  const bad = await post('/api/settings', { githubRemote: 'https://example.com/x' }, { 'x-shrey-token': token });
  assert.equal(bad.status, 400, 'invalid URL rejected by the API');
  const cleared = await (await post('/api/settings', { githubRemote: null }, { 'x-shrey-token': token })).json();
  assert.equal(cleared.ok, true, 'local-only accepted with a valid token');
  const settings = await (await fetch(base + '/api/settings')).json();
  assert.equal(settings.github.remote, null);
  await started.shutdown();
  ok('dashboard writes need the page token; foreign hosts are refused');
}

// ------------------------------------------------ 5. the real `shrey` launch
{
  const sse = (n, d) => 'event: ' + n + '\ndata: ' + JSON.stringify(d) + '\n\n';
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sse('message_start', { type: 'message_start', message: { id: 'm', model: 'fake', role: 'assistant', usage: { input_tokens: 3 } } }));
      res.write(sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
      res.write(sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }));
      res.write(sse('content_block_stop', { type: 'content_block_stop', index: 0 }));
      res.write(sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }));
      res.write(sse('message_stop', { type: 'message_stop' }));
      res.end();
    });
  });
  await new Promise((r) => upstream.listen(9953, '127.0.0.1', r));

  // Fake Claude Code: calls the API through whatever base URL it was given and
  // reports its argv, cwd and base URL, then exits with a distinctive code.
  const fakeDir = path.join(TMP, 'fake-claude');
  fs.mkdirSync(fakeDir, { recursive: true });
  const report = path.join(TMP, 'fake-report.json');
  fs.writeFileSync(path.join(fakeDir, 'fake.mjs'), [
    "import fs from 'node:fs';",
    'const args = process.argv.slice(2);',
    'const base = process.env.ANTHROPIC_BASE_URL;',
    "const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-ant-fake-key-000000' }, body: JSON.stringify({ model: 'fake', max_tokens: 5, stream: true, messages: [{ role: 'user', content: args.join(' ') }] }) });",
    'await r.text();',
    'fs.writeFileSync(process.env.FAKE_REPORT, JSON.stringify({ args, cwd: process.cwd(), base, status: r.status }));',
    'process.exit(7);',
    ''
  ].join('\n'));
  let fakeBin;
  if (process.platform === 'win32') {
    fakeBin = path.join(fakeDir, 'claude.cmd');
    fs.writeFileSync(fakeBin, '@echo off\r\n"' + process.execPath + '" "%~dp0fake.mjs" %*\r\n');
  } else {
    fakeBin = path.join(fakeDir, 'claude');
    fs.writeFileSync(fakeBin, '#!/bin/sh\nexec "' + process.execPath + '" "$(dirname "$0")/fake.mjs" "$@"\n');
    fs.chmodSync(fakeBin, 0o755);
  }

  // Occupy the preferred port: a second terminal must still get its own proxy.
  const squatter = http.createServer((q, s) => s.end('busy'));
  await new Promise((r) => squatter.listen(9954, '127.0.0.1', r));

  const work = path.join(TMP, 'my project');
  fs.mkdirSync(work, { recursive: true });
  const env = { ...process.env, SHREY_HOME: HOME, SHREY_NO_GH: '1', CCPROXY_UPSTREAM: 'http://127.0.0.1:9953', CLAUDE_CODE_EXECPATH: fakeBin, FAKE_REPORT: report };
  delete env.ANTHROPIC_BASE_URL;

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(root, 'src', 'index.js'), '-p', 'hello "quoted" world', '--model', 'opus', '--port', '9954', '--no-push'], {
      cwd: work,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('exit', (code) => resolve({ code, out }));
  });

  assert.ok(fs.existsSync(report), 'fake claude ran. output:\n' + result.out);
  const rep = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.deepEqual(rep.args, ['-p', 'hello "quoted" world', '--model', 'opus'], 'args reach Claude Code intact (spaces and quotes)');
  assert.equal(fs.realpathSync(rep.cwd), fs.realpathSync(work), 'Claude Code opens in the current directory');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+$/.test(rep.base), 'base URL points at the local proxy');
  assert.notEqual(new URL(rep.base).port, '9954', 'busy port → a free one was used');
  assert.equal(rep.status, 200, 'the call went through the proxy to the upstream');
  assert.equal(result.code, 7, 'exit code of Claude Code is propagated');
  assert.ok(result.out.includes('shrey · capturing'), 'banner printed');
  assert.ok(result.out.includes('session(s) captured'), 'summary printed');

  const sessionsDir = path.join(HOME, 'captures', 'sessions');
  const days = fs.readdirSync(sessionsDir);
  const all = days.flatMap((d) => fs.readdirSync(path.join(sessionsDir, d)).map((id) => path.join(sessionsDir, d, id)));
  const captured = all.find((dir) => {
    const m = path.join(dir, 'manifest.json');
    return fs.existsSync(m) && JSON.parse(fs.readFileSync(m, 'utf8')).title === '-p hello "quoted" world --model opus';
  });
  assert.ok(captured, 'the session was captured under SHREY_HOME');
  assert.ok(!fs.readFileSync(path.join(captured, 'session.jsonl'), 'utf8').includes('sk-ant-fake-key-000000'), 'key redacted');
  assert.equal(fs.readdirSync(path.join(HOME, 'run')).length, 0, 'run registry cleaned up on exit');
  ok('`shrey` launches Claude Code in the cwd with args intact, captures, and exits with its code');

  squatter.close();
  upstream.close();
}

// --------------------------------------------------- 6. built-in admin dashboard
{
  const { PassThrough } = await import('node:stream');
  const readline = (await import('node:readline/promises')).default;
  const { setupGithub, setupCloudName, defaultDisplayName } = await import('../src/index.js');
  const { readStoredConfig } = await import('../src/config.js');

  // Never let this test touch the real production dashboard.
  const mock = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      mock.lastAuth = req.headers.authorization;
      mock.lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, identityId: 'id-1' }));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  const mockUrl = 'http://127.0.0.1:' + mock.address().port;
  process.env.SHREY_BUILTIN_CLOUD_URL = mockUrl;
  process.env.SHREY_BUILTIN_CLOUD_KEY = 'mock-builtin-key';

  // readline only starts reading once something actually calls question() -
  // writing to the input stream before that point is not buffered and is lost.
  // Since the caller (setupGithub/setupCloudName) is what calls question(), the
  // write is deferred to let that call happen first; the intervening async work
  // in those functions (at least one await before their question()) comfortably
  // covers a setImmediate's one-macrotask delay.
  const scripted = (...answers) => {
    const input = new PassThrough();
    const rl = readline.createInterface({ input, terminal: false });
    let i = 0;
    const feedNext = () => {
      if (i >= answers.length) return;
      setImmediate(() => {
        input.write(answers[i++] + '\n');
        feedNext();
      });
    };
    feedNext();
    return rl;
  };
  const devNull = { write: () => true };

  // setup asks for GitHub, then a name - together, in that order, exactly as
  // `shrey` first run does (this is what was previously wrong: cloud used to be
  // a separate manual `shrey cloud <url> <key>` step, not part of first-run setup).
  await setupGithub(scripted('local'), devNull);
  await setupCloudName(scripted(''), devNull); // blank -> default (OS username)

  let stored = readStoredConfig();
  assert.equal(stored.github.remote, null, 'setup: github question answered');
  assert.equal(stored.cloud.enabled, true, 'setup: cloud enabled by default');
  assert.equal(stored.cloud.name, defaultDisplayName(), 'setup: blank name falls back to the OS username');
  assert.match(stored.cloud.deviceToken, /^[0-9a-f]{64}$/, 'setup: a device token was generated');
  assert.ok(!('url' in stored.cloud) && !('key' in stored.cloud), 'setup: built-in form persists no url/key - it keeps following this build\'s default forever');
  ok('first-run setup asks for GitHub repo and dashboard name together, deferring to the built-in dashboard');

  const firstToken = stored.cloud.deviceToken;
  await setupCloudName(scripted('Ada'), devNull);
  stored = readStoredConfig();
  assert.equal(stored.cloud.name, 'Ada', 'name updated');
  assert.equal(stored.cloud.deviceToken, firstToken, 're-running setup renames the same identity, not a new one');
  ok('re-running setup reuses this machine\'s existing identity instead of fragmenting it');

  // `shrey cloud <name>` — the real CLI, non-interactively, using the mock as the
  // "built-in" dashboard via the test-only env override.
  const runCloud = (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [path.join(root, 'src', 'index.js'), 'cloud', ...args], {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { out += d; });
      child.on('exit', (code) => resolve({ code, out }));
    });

  const r1 = await runCloud(['Grace']);
  assert.equal(r1.code, 0, '`shrey cloud <name>` exit 0: ' + r1.out);
  assert.ok(r1.out.includes('Connected'), 'reports connected');
  assert.equal(mock.lastBody.name, 'Grace', 'the name reached the dashboard');
  assert.equal(mock.lastAuth, 'Bearer mock-builtin-key', 'authenticated with the built-in key, not one the user had to supply');
  stored = readStoredConfig();
  assert.ok(!('url' in stored.cloud) && !('key' in stored.cloud), '`shrey cloud <name>` also persists no url/key');
  ok('`shrey cloud <name>` needs no URL or key - just a name, using the built-in dashboard');

  // Point at a self-hosted dashboard instead, then switch back to the built-in
  // one by name - the old self-hosted url/key must actually be gone afterward,
  // not merely unmentioned (this was the second bug: a naive merge would leave
  // the stale self-hosted destination in place).
  const bogus = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  });
  await new Promise((r) => bogus.listen(0, '127.0.0.1', r));
  const bogusUrl = 'http://127.0.0.1:' + bogus.address().port;
  const r2 = await runCloud([bogusUrl, 'bogus-key', '--name', 'Grace']);
  assert.equal(r2.code, 0, 'self-hosted form saved: ' + r2.out);
  stored = readStoredConfig();
  assert.equal(stored.cloud.url, bogusUrl + '/', 'self-hosted url persisted this time');

  const r3 = await runCloud(['Grace']);
  assert.equal(r3.code, 0, 'switch back to built-in: ' + r3.out);
  stored = readStoredConfig();
  assert.ok(!('url' in stored.cloud) && !('key' in stored.cloud), 'switching back to the built-in form actually clears the old self-hosted url/key');
  ok('switching from a self-hosted dashboard back to the built-in one clears the old override, not just leaves it unmentioned');

  mock.close();
  bogus.close();
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n  ' + passed + ' CLI checks passed.\n');
process.exit(0);
