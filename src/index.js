#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';
import readline from 'node:readline/promises';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadConfig, updateStoredConfig, replaceStoredSection, readStoredConfig, proxyUrl, VERSION, HOME, CONFIG_PATH } from './config.js';
import { startServer } from './server.js';
import { DASH_PREFIX } from './dashboard.js';
import { normalizeGithubUrl, ghAuthenticated } from './github.js';
import { generateDeviceToken } from './cloud.js';
import { parseArgs, takeNameFlag } from './args.js';

const CLAUDE_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const RUN_DIR = path.join(HOME, 'run');
const LOG_PATH = path.join(HOME, 'shrey.log');

// ------------------------------------------------------------------ arg parsing

function overridesFrom(flags) {
  const o = {};
  if (flags.port) o.port = Number(flags.port);
  if (flags.host) o.host = String(flags.host);
  if (flags.upstream) o.upstream = String(flags.upstream);
  if (flags.dir) o.captureDir = path.resolve(String(flags.dir));
  const github = {};
  if (flags['no-github']) github.enabled = false;
  if (flags['no-push']) github.autoPush = false;
  if (flags.repo) github.repo = String(flags.repo);
  if (Object.keys(github).length) o.github = github;
  if (flags.raw) o.capture = { raw: true };
  return o;
}

/**
 * If the user already routes Claude Code through a gateway, capture in front of it
 * rather than silently bypassing it. A loopback URL is another proxy (possibly
 * another shrey) and is never chained to.
 */
function inheritedUpstream() {
  const inherited = process.env.ANTHROPIC_BASE_URL;
  if (!inherited) return null;
  try {
    const u = new URL(inherited);
    if (['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname)) return null;
    return inherited;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ help text

const HELP = [
  'shrey ' + VERSION + ' — capture everything Claude Code sends and receives',
  '',
  'shrey is claude with capture: anything you would type after `claude` works after',
  '`shrey` and behaves the same - shrey --resume, shrey -c, shrey -p "...", shrey --bg,',
  'shrey --model ..., shrey mcp list, shrey update, and so on.',
  '',
  'USAGE',
  '  shrey                      open Claude Code in this folder, capturing every request',
  '  shrey [claude args]        same, passing arguments to Claude Code (shrey --resume)',
  '  shrey setup                choose where captures are pushed',
  '  shrey github [url|off]     show or set the GitHub repository captures push to',
  '  shrey cloud [name|off]     show status, set your name, or stop reporting to the admin dashboard',
  '  shrey dashboard            open the trajectory dashboard of a running shrey',
  '  shrey serve                run only the proxy and dashboard',
  '  shrey status               settings, session count, token totals',
  '  shrey push                 commit and push captures now',
  '',
  'OPTIONS (anything else is passed to Claude Code)',
  '  --no-push          capture and commit locally, but do not push this run',
  '  --no-github        no git at all for this run',
  '  --open             open the dashboard in a browser on start',
  '  --port <n>         preferred port (default 8787; a free one is used if taken)',
  '  --upstream <url>   API to forward to (default https://api.anthropic.com)',
  '  --dir <path>       capture directory',
  '  --raw              also keep verbatim request/response JSON',
  '  --                 everything after goes to Claude Code as-is',
  '',
  'Captures: ' + path.join(HOME, 'captures'),
  'Settings: ' + CONFIG_PATH,
  ''
].join('\n');

// -------------------------------------------------------------- first-run setup

async function setupWizard({ force = false } = {}) {
  const stored = readStoredConfig();
  if (stored.setupDone && !force) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // Can't ask (piped or scripted). Nothing is pushed or reported without an
    // answer, and nothing is recorded as answered: the next run in a real
    // terminal still asks.
    process.stderr.write('[shrey] not set up yet - capturing locally only. Run `shrey setup` in a terminal to choose.\n');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const out = process.stdout;
  try {
    await setupGithub(rl, out);
    await setupCloudName(rl, out);
    updateStoredConfig({ setupDone: true });
  } finally {
    rl.close();
  }
}

async function setupGithub(rl, out) {
  const gh = await ghAuthenticated();
  out.write('\n  shrey · setup\n\n');
  out.write('  shrey records every request Claude Code makes and can push the recordings\n');
  out.write('  to a GitHub repository you own. Recordings include your prompts, code and\n');
  out.write('  tool output. API keys are redacted. Use a private repository.\n\n');
  out.write('  Where should captures go?\n');
  out.write('    paste a GitHub repo URL    e.g. https://github.com/you/claude-traces\n');
  if (gh) out.write('    press Enter                create a private repo "claude-code-trajectories" for you\n');
  out.write('    type local                 keep them on this machine only' + (gh ? '' : '  (default)') + '\n');
  if (!gh) out.write('\n    (sign in with "gh auth login" to let shrey create the repo for you)\n');
  out.write('\n');

  for (let attempt = 0; attempt < 3; attempt++) {
    const answer = (await rl.question('  > ')).trim();
    if (!answer) {
      updateStoredConfig({ github: { autoCreate: gh, remote: null } });
      out.write(gh
        ? '\n  A private repo will be created on first run. Change it any time: shrey github <url>\n\n'
        : '\n  Keeping captures local. Push later with: shrey github <url>\n\n');
      return;
    }
    if (/^(local|no|n|off)$/i.test(answer)) {
      updateStoredConfig({ github: { autoCreate: false, remote: null } });
      out.write('\n  Keeping captures local. Push later with: shrey github <url>\n\n');
      return;
    }
    const target = normalizeGithubUrl(answer);
    if (target) {
      updateStoredConfig({ github: { remote: target.web, autoCreate: false } });
      out.write('\n  Captures will push to ' + target.web + '\n');
      out.write('  (created as private if it does not exist and gh is signed in)\n\n');
      return;
    }
    out.write('  That is not a GitHub repository URL. Try https://github.com/you/repo\n');
  }
  updateStoredConfig({ github: { autoCreate: false, remote: null } });
  out.write('\n  Keeping captures local for now. Set a repo later: shrey github <url>\n\n');
}

/**
 * The admin dashboard: on by default, pointed at the built-in deployment. This
 * only needs a name — there is no login, no email, nothing else to configure.
 * `shrey cloud off` (or `shrey cloud <own-url> <own-key>`) is the escape hatch
 * for anyone who wants out, or their own deployment instead of the built-in one.
 */
async function setupCloudName(rl, out) {
  out.write('  shrey also reports live to an admin dashboard, so activity across every\n');
  out.write('  machine running shrey can be watched in one place, under a name you choose.\n\n');
  out.write('  What name should show on the dashboard?\n');
  out.write('    press Enter    use "' + defaultDisplayName() + '"\n');
  out.write('    type off       do not report anywhere; stays entirely local (+ GitHub, if set above)\n\n');

  const answer = (await rl.question('  > ')).trim();
  if (/^(off|no|n|none)$/i.test(answer)) {
    replaceStoredSection('cloud', { enabled: false });
    out.write('\n  Not reporting anywhere. Turn it on any time: shrey cloud <name>\n\n');
    return;
  }
  const name = answer || defaultDisplayName();
  // Reuse this machine's existing device identity if it has one, so re-running
  // setup renames it rather than minting a new identity that fragments its
  // history on the dashboard. No url/key here: the built-in dashboard is
  // whatever this installed version's DEFAULTS say, followed automatically
  // forever (including across upgrades).
  const deviceToken = readStoredConfig().cloud?.deviceToken || generateDeviceToken();
  replaceStoredSection('cloud', { enabled: true, name, deviceToken });
  out.write('\n  Reporting as "' + name + '". Change your name or turn this off: shrey cloud <name|off>\n\n');
}

function defaultDisplayName() {
  try {
    return os.userInfo().username || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

// ------------------------------------------------------------ run registry

function registerRun(info) {
  try {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    fs.writeFileSync(path.join(RUN_DIR, process.pid + '.json'), JSON.stringify(info));
  } catch {
    /* only used to find dashboards; never worth failing a launch */
  }
}

function unregisterRun() {
  try {
    fs.rmSync(path.join(RUN_DIR, process.pid + '.json'), { force: true });
  } catch {
    /* ignore */
  }
}

function liveRuns() {
  if (!fs.existsSync(RUN_DIR)) return [];
  const runs = [];
  for (const name of fs.readdirSync(RUN_DIR)) {
    const file = path.join(RUN_DIR, name);
    try {
      const info = JSON.parse(fs.readFileSync(file, 'utf8'));
      process.kill(info.pid, 0); // throws if the process is gone
      runs.push(info);
    } catch {
      fs.rmSync(file, { force: true }); // stale entry from a crashed run
    }
  }
  return runs.sort((a, b) => b.startedAt - a.startedAt);
}

// ------------------------------------------------------------------- launching

/** Sends proxy chatter to a log file so it can never draw over Claude Code's UI. */
function logToFile() {
  fs.mkdirSync(HOME, { recursive: true });
  const write = (...args) => {
    try {
      fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + args.map(String).join(' ') + '\n');
    } catch {
      /* logging must never take the session down */
    }
  };
  console.log = write;
  console.error = write;
  console.warn = write;
  return write;
}

/**
 * shrey's own one-line status messages. Always stderr, never stdout: stdout is
 * Claude Code's, so `shrey -p --output-format json "..." | jq` gets exactly the
 * bytes `claude` would have produced. Bound to the real stream up front, so
 * logToFile() redirecting console.* later can't swallow it.
 */
function makeNotice() {
  const write = process.stderr.write.bind(process.stderr);
  const tty = Boolean(process.stderr.isTTY);
  return (text) => write((tty ? '\x1b[2m' + text + '\x1b[0m' : text) + '\n');
}

function destinationLabel(cfg) {
  const git = cfg.github.enabled === false
    ? 'local (no git)'
    : cfg.github.remote
      ? cfg.github.remote.replace(/^https:\/\//, '')
      : cfg.github.autoCreate ? 'github (creating private repo)' : 'local only';
  const cloud = cfg.cloud?.enabled && cfg.cloud?.name ? ' · cloud: ' + cfg.cloud.name : '';
  return git + cloud;
}

function claudeMissing() {
  process.stderr.write('shrey: Claude Code is not installed or not on PATH.\n');
  process.stderr.write('Install it: npm install -g @anthropic-ai/claude-code\n');
  process.exitCode = 1;
}

/**
 * Runs Claude Code in the foreground with this terminal, returning its exit code.
 * Ctrl+C belongs to Claude Code (it interrupts a response), so shrey ignores it and
 * lets the child decide; a closed terminal or a kill is forwarded instead.
 */
function runClaude(bin, args, env) {
  process.on('SIGINT', () => {});
  let child;
  for (const sig of ['SIGTERM', 'SIGHUP']) {
    process.on(sig, () => child?.kill(sig));
  }
  return new Promise((resolve) => {
    child = spawnClaude(bin, args, { cwd: process.cwd(), env, stdio: 'inherit' });
    child.on('error', (err) => {
      process.stderr.write('shrey: failed to launch Claude Code: ' + err.message + '\n');
      resolve(1);
    });
    // A signal-terminated child has no exit code; report failure, not success.
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function cmdLaunch(cfg, flags, claudeArgs) {
  await setupWizard();
  Object.assign(cfg, loadConfig(overridesFrom(flags)));
  if (!flags.upstream && inheritedUpstream()) cfg.upstream = inheritedUpstream().replace(/\/+$/, '');

  const bin = resolveClaude();
  if (!bin) return claudeMissing();

  const notice = makeNotice();
  const launchedAt = Date.now();
  const log = logToFile();
  const started = await startServer(cfg, { log, portFallback: true, awaitArchive: false });
  const dash = started.url + DASH_PREFIX + '/';
  registerRun({ pid: process.pid, port: cfg.port, url: dash, cwd: process.cwd(), startedAt: Date.now() });

  notice('shrey · capturing → ' + destinationLabel(cfg) + ' · dashboard ' + dash);
  if (flags.open) openBrowser(dash);

  const code = await runClaude(bin, claudeArgs, { ...process.env, ANTHROPIC_BASE_URL: started.url, SHREY_ACTIVE: '1' });

  notice('shrey · saving captures…');
  await started.shutdown();
  unregisterRun();
  const a = started.archiver?.status();
  const c = started.cloudSync?.status();
  const sessions = started.store.listSessions().filter((s) => s.updatedAt >= launchedAt).length;
  let summary = 'shrey · ' + sessions + ' session(s) captured';
  if (a?.remote) summary += a.lastError ? ' · push failed: ' + a.lastError : ' · pushed to ' + (a.web ?? a.remote);
  if (c?.enabled) summary += c.lastError ? ' · cloud sync failed: ' + c.lastError : ' · synced to cloud';
  notice(summary);
  process.exit(code);
}

/**
 * `shrey --bg ...` (and --background, --tmux): Claude Code starts the session
 * somewhere else and returns immediately, while that session keeps calling the
 * API through whatever ANTHROPIC_BASE_URL it inherited. A proxy living in this
 * process would die with it and strand the session, so the proxy runs as its own
 * detached process instead, and shuts itself down once no session it could be
 * serving is still running.
 */
async function cmdLaunchDetached(cfg, flags, claudeArgs) {
  await setupWizard();
  Object.assign(cfg, loadConfig(overridesFrom(flags)));
  const upstream = !flags.upstream && inheritedUpstream() ? inheritedUpstream().replace(/\/+$/, '') : null;

  const bin = resolveClaude();
  if (!bin) return claudeMissing();
  const notice = makeNotice();

  fs.mkdirSync(RUN_DIR, { recursive: true });
  const handoff = path.join(RUN_DIR, 'handoff-' + process.pid + '-' + Date.now() + '.json');
  const [file, args] = selfInvocation(['__proxy-daemon', handoff]);
  const daemon = spawn(file, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: process.cwd(),
    env: {
      ...process.env,
      SHREY_DAEMON_OVERRIDES: JSON.stringify(overridesFrom(flags)),
      SHREY_DAEMON_UPSTREAM: upstream ?? ''
    }
  });
  daemon.unref();

  const port = await waitForHandoff(handoff, 15000);
  if (!port) {
    // Never block the user's command on shrey: run it exactly as `claude` would.
    notice('shrey · could not start the background proxy; running without capture (see ' + LOG_PATH + ')');
    process.exit(await runClaude(bin, claudeArgs, process.env));
  }

  const base = 'http://' + cfg.host + ':' + port;
  notice('shrey · capturing in the background → ' + destinationLabel(cfg) + ' · dashboard ' + base + DASH_PREFIX + '/');
  process.exit(await runClaude(bin, claudeArgs, { ...process.env, ANTHROPIC_BASE_URL: base, SHREY_ACTIVE: '1' }));
}

async function waitForHandoff(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { port } = JSON.parse(fs.readFileSync(file, 'utf8'));
      fs.rmSync(file, { force: true });
      if (port) return port;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

/**
 * The detached proxy behind `shrey --bg`. Lives until Claude Code reports no
 * session started since this proxy came up, checked via `claude agents --json`,
 * which lists running sessions whether interactive or background.
 */
async function cmdProxyDaemon(cfg, rest) {
  const handoff = rest[0];
  const log = logToFile();
  try {
    Object.assign(cfg, loadConfig(JSON.parse(process.env.SHREY_DAEMON_OVERRIDES || '{}')));
  } catch {
    /* fall back to stored settings */
  }
  if (process.env.SHREY_DAEMON_UPSTREAM) cfg.upstream = process.env.SHREY_DAEMON_UPSTREAM;
  // Leave the well-known port to foreground sessions; any free port will do here.
  cfg.port = 0;

  const bin = resolveClaude();
  const startedAt = Date.now();
  const started = await startServer(cfg, { log, portFallback: true, awaitArchive: false });
  registerRun({ pid: process.pid, port: cfg.port, url: started.url + DASH_PREFIX + '/', cwd: process.cwd(), startedAt, kind: 'background' });
  fs.writeFileSync(handoff, JSON.stringify({ port: cfg.port }));
  log('[shrey] background proxy on ' + started.url);

  const pollMs = Number(process.env.SHREY_DAEMON_POLL_MS) || 30000;
  const graceMs = Number(process.env.SHREY_DAEMON_GRACE_MS) || 90000;
  let emptyChecks = 0;
  let failedChecks = 0;

  const stop = async (why) => {
    log('[shrey] background proxy stopping: ' + why);
    await started.shutdown();
    unregisterRun();
    process.exit(0);
  };

  const check = async () => {
    if (Date.now() - startedAt < graceMs) return;
    const sessions = bin ? await listClaudeSessions(bin) : null;
    if (!sessions) {
      // Can't tell; don't guess it's safe to stop. Give up only if it stays unknowable.
      if (++failedChecks >= 20) await stop('`claude agents --json` keeps failing');
      return;
    }
    failedChecks = 0;
    const ours = sessions.filter((s) => (s.startedAt ?? 0) >= startedAt - 15000);
    emptyChecks = ours.length ? 0 : emptyChecks + 1;
    // Two in a row, so a session between turns or mid-restart isn't cut off.
    if (emptyChecks >= 2) await stop('no sessions left');
  };
  setInterval(() => check().catch((err) => log('[shrey] session check failed: ' + err.message)), pollMs);
}

function listClaudeSessions(bin) {
  return new Promise((resolve) => {
    const child = spawnClaude(bin, ['agents', '--json'], { stdio: ['ignore', 'pipe', 'ignore'], env: process.env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve(null));
    child.on('exit', (code) => {
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(out);
        resolve(Array.isArray(parsed) ? parsed : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** How to re-run this same shrey: a packaged shrey.exe is its own entry point. */
function selfInvocation(args) {
  let sea = false;
  try {
    sea = createRequire(import.meta.url)('node:sea').isSea();
  } catch {
    /* node:sea unavailable: definitely not a packaged executable */
  }
  return sea ? [process.execPath, args] : [process.execPath, [process.argv[1], ...args]];
}

/**
 * Claude Code's management subcommands (`mcp`, `update`, `install`, `agents`, ...)
 * run exactly as `claude` would: same arguments, same terminal, same exit code, no
 * proxy and no setup prompt, since none of them runs a model session.
 */
async function cmdPassthrough(args) {
  const bin = resolveClaude();
  if (!bin) return claudeMissing();
  process.exit(await runClaude(bin, args, process.env));
}

/** shrey's own help, then Claude Code's - every Claude Code option works here too. */
async function cmdHelp() {
  process.stdout.write(HELP + '\n');
  const bin = resolveClaude();
  if (!bin) return;
  process.stdout.write('CLAUDE CODE OPTIONS (all of these work with shrey too)\n\n');
  await new Promise((resolve) => {
    const child = spawnClaude(bin, ['--help'], { stdio: 'inherit', env: process.env });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

async function cmdVersion() {
  process.stdout.write(VERSION + ' (shrey)\n');
  const bin = resolveClaude();
  if (!bin) return;
  await new Promise((resolve) => {
    const child = spawnClaude(bin, ['--version'], { stdio: 'inherit', env: process.env });
    child.on('exit', resolve);
    child.on('error', resolve);
  });
}

/**
 * Starts Claude Code. A native claude.exe is spawned directly. An npm .cmd shim
 * must go through cmd.exe, so arguments are quoted by hand: Node refuses to quote
 * for a shell, and an unquoted prompt with spaces would be split into words.
 */
function spawnClaude(bin, args, opts) {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const quote = (a) => '"' + String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
    const line = [bin, ...args].map(quote).join(' ');
    return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], {
      ...opts,
      windowsHide: true,
      windowsVerbatimArguments: true
    });
  }
  return spawn(bin, args, { ...opts, windowsHide: true });
}

function resolveClaude() {
  const fromEnv = process.env.CLAUDE_CODE_EXECPATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const which = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(which, ['claude'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Prefer something directly executable over an extension-less shell script.
    const pick = candidates.find((c) => /\.(exe|cmd)$/i.test(c)) ?? candidates[0];
    if (pick && fs.existsSync(pick)) return pick;
  } catch {
    /* not on PATH */
  }
  return null;
}

async function cmdServe(cfg, flags) {
  await setupWizard();
  Object.assign(cfg, loadConfig(overridesFrom(flags)));
  if (!flags.upstream && inheritedUpstream()) cfg.upstream = inheritedUpstream().replace(/\/+$/, '');
  const started = await startServer(cfg, { portFallback: true });
  const dash = started.url + DASH_PREFIX + '/';
  registerRun({ pid: process.pid, port: cfg.port, url: dash, cwd: process.cwd(), startedAt: Date.now() });
  const a = started.archiver?.status();
  console.log('');
  console.log('  shrey ' + VERSION);
  console.log('  proxy      ' + started.url + '  →  ' + cfg.upstream);
  console.log('  dashboard  ' + dash);
  console.log('  captures   ' + cfg.captureDir);
  console.log('  pushing to ' + (a?.web ?? a?.remote ?? 'nowhere (local only) — set one with: shrey github <url>'));
  if (cfg.cloud?.enabled && cfg.cloud?.name) console.log('  reporting  ' + cfg.cloud.url + '  as "' + cfg.cloud.name + '"');
  console.log('');
  console.log('  Point any Claude Code at it:  ANTHROPIC_BASE_URL=' + started.url);
  console.log('  Ctrl+C to stop.');
  if (flags.open) openBrowser(dash);

  let closing = false;
  const stop = async () => {
    if (closing) return;
    closing = true;
    console.log('\n  saving captures…');
    await started.shutdown();
    unregisterRun();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// ------------------------------------------------------------------- settings

async function cmdGithub(cfg, rest) {
  const value = rest[0];
  if (value === undefined) {
    const stored = readStoredConfig();
    const remote = stored.github?.remote;
    console.log(remote ? 'Captures push to ' + remote : stored.github?.autoCreate
      ? 'A private repo "' + cfg.github.repo + '" is created on the next run.'
      : 'Captures stay local. Set a repo with: shrey github https://github.com/you/repo');
    return;
  }
  const off = ['off', 'local', 'none'].includes(value);
  if (!off && !normalizeGithubUrl(value)) {
    console.error('Not a GitHub repository URL: ' + value);
    console.error('Examples: https://github.com/you/claude-traces   you/claude-traces   git@github.com:you/claude-traces.git');
    process.exitCode = 1;
    return;
  }
  const { CaptureStore } = await import('./store.js');
  const { Archiver } = await import('./git.js');
  const { writeIndex } = await import('./render.js');
  const store = new CaptureStore(cfg);
  writeIndex(store);
  const archiver = new Archiver(cfg, store, { log: () => {} });
  const result = await archiver.setRemote(off ? null : value);
  if (!result.ok) {
    console.error('Could not use that repository: ' + result.error);
    process.exitCode = 1;
    return;
  }
  if (off) {
    console.log('Captures now stay local.');
    return;
  }
  console.log('Captures push to ' + result.remote);
  const s = archiver.status();
  console.log(s.lastError ? '  first push failed: ' + s.lastError : '  existing captures pushed (' + s.commits + ' commit(s)).');
  if (liveRuns().length) console.log('  Running shrey sessions pick this up when they next start.');
}

/**
 * Turns on (or off, or reports) streaming to the admin dashboard. Distinct from
 * `shrey github`: git archival is a durable per-user backup, this is the admin's
 * live shared view across every machine running shrey. The two don't interact and
 * either can be on without the other.
 *
 *   shrey cloud                    show current status
 *   shrey cloud <name>             report to the built-in dashboard as <name>
 *   shrey cloud off                stop reporting
 *   shrey cloud <url> <key>        report to a self-hosted dashboard instead
 */
async function cmdCloud(cfg, rawRest, flags) {
  const taken = takeNameFlag(rawRest);
  const rest = taken.args;
  flags = { ...flags, name: taken.name };
  const [first, second] = rest;
  const stored = readStoredConfig();

  if (first === undefined) {
    if (!stored.cloud || stored.cloud.enabled === false) {
      console.log('Cloud sync is off. Turn it on with: shrey cloud <your name>');
    } else {
      console.log('Reporting to ' + (stored.cloud.url || cfg.cloud.url) + ' as "' + stored.cloud.name + '"');
    }
    return;
  }
  if (['off', 'none', 'local'].includes(first)) {
    replaceStoredSection('cloud', { enabled: false });
    console.log('Cloud sync turned off. Local capture (and GitHub, if set) are unaffected.');
    return;
  }

  // `shrey cloud <url> <key>` — a self-hosted dashboard instead of the built-in one.
  const looksLikeUrl = /^https?:\/\//i.test(first);
  let url = cfg.cloud.url;
  let key = cfg.cloud.key;
  let name = flags.name || (looksLikeUrl ? stored.cloud?.name : first);

  if (looksLikeUrl) {
    if (!second) {
      console.error('Also pass that deployment’s cloud key (its SHREY_CLOUD_KEY): shrey cloud <url> <key>');
      process.exitCode = 1;
      return;
    }
    try {
      url = new URL(first).toString();
    } catch {
      console.error('Not a URL: ' + first);
      process.exitCode = 1;
      return;
    }
    key = second;
    if (!name) {
      if (!process.stdin.isTTY) {
        console.error('First time on this machine: also pass --name "Your Name".');
        process.exitCode = 1;
        return;
      }
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      name = (await rl.question('\n  What name should show on the dashboard?  > ')).trim();
      rl.close();
      if (!name) {
        console.error('A name is required.');
        process.exitCode = 1;
        return;
      }
    }
  }

  const deviceToken = stored.cloud?.deviceToken || generateDeviceToken();
  // Only an explicit `<url> <key>` is persisted. The built-in form deliberately
  // leaves url/key out of config.json (replaceStoredSection, not a merge — so a
  // previously self-hosted url/key is actually dropped, not left stale), meaning
  // it keeps following whatever this installed shrey-cli's built-in dashboard is,
  // including across upgrades, with no need to ever re-run this.
  updateStoredConfig({ setupDone: true });
  replaceStoredSection('cloud', looksLikeUrl ? { enabled: true, url, key, name, deviceToken } : { enabled: true, name, deviceToken });

  // Verify it actually works right away, rather than making the user wait for
  // their next real Claude Code session to find out something was wrong.
  try {
    const res = await fetch(url.replace(/\/+$/, '') + '/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({
        deviceToken,
        name,
        session: { id: 'setup-check-' + Date.now(), title: 'shrey cloud setup check', startedAt: Date.now(), updatedAt: Date.now(), requests: 0, errors: 0, usage: {} },
        events: [],
        objects: []
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      console.error('Saved, but could not verify the connection: ' + (data.error || 'HTTP ' + res.status));
      process.exitCode = 1;
      return;
    }
    console.log('Connected. Activity from this machine will show as "' + name + '" at ' + url);
  } catch (err) {
    console.error('Saved, but could not reach ' + url + ': ' + err.message);
    console.error('shrey will keep retrying automatically once it can reach it.');
  }
}

async function cmdStatus(cfg) {
  const { CaptureStore } = await import('./store.js');
  const store = new CaptureStore(cfg);
  const sessions = store.listSessions();
  const totals = sessions.reduce(
    (a, s) => {
      a.req += s.requests;
      a.in += s.usage.input;
      a.out += s.usage.output;
      return a;
    },
    { req: 0, in: 0, out: 0 }
  );
  const stored = readStoredConfig();
  const runs = liveRuns();
  console.log('shrey ' + VERSION);
  console.log('  settings   ' + CONFIG_PATH);
  console.log('  captures   ' + cfg.captureDir);
  console.log('  github     ' + (stored.github?.remote ?? (stored.github?.autoCreate ? 'auto-create on next run' : 'local only')));
  console.log('  cloud      ' + (stored.cloud?.enabled && stored.cloud?.name ? (stored.cloud.url || cfg.cloud.url) + ' as "' + stored.cloud.name + '"' : 'off'));
  console.log('  sessions   ' + sessions.length + ', ' + totals.req + ' requests, ' +
    totals.in.toLocaleString('en-US') + ' in / ' + totals.out.toLocaleString('en-US') + ' out tokens');
  console.log('  running    ' + (runs.length ? runs.map((r) => r.url + '  (' + r.cwd + ')').join('\n             ') : 'none'));
}

async function cmdPush(cfg) {
  const { CaptureStore } = await import('./store.js');
  const { Archiver } = await import('./git.js');
  const { writeIndex } = await import('./render.js');
  const store = new CaptureStore(cfg);
  writeIndex(store);
  const archiver = new Archiver(cfg, store, { log: () => {} });
  await archiver.init();
  await archiver.flush();
  const s = archiver.status();
  if (!s.remote) {
    console.log('Committed locally (' + s.commits + '). No GitHub repo set: shrey github <url>');
    return;
  }
  console.log(s.lastError ? 'Push failed: ' + s.lastError : 'Pushed to ' + (s.web ?? s.remote) + ' (' + s.commits + ' new commit(s)).');
}

function cmdDashboard(cfg) {
  const runs = liveRuns();
  if (!runs.length) {
    console.log('No shrey is running. Start one with: shrey   (or: shrey serve)');
    return;
  }
  for (const r of runs) console.log(r.url + '   ' + r.cwd);
  openBrowser(runs[0].url);
}

// ------------------------------------------------ fixed-port install (advanced)

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
  fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + '\n');
}

function cmdInstall(cfg, flags) {
  const target = proxyUrl(cfg);
  const settings = readSettings();
  settings.env = { ...(settings.env ?? {}), ANTHROPIC_BASE_URL: target };
  writeSettings(settings);
  console.log('Claude Code will now always use ' + target + ' (written to ' + CLAUDE_SETTINGS + ').');
  console.log('It then needs "shrey serve --port ' + cfg.port + '" running. Undo with: shrey proxy-uninstall');
  if (flags.global && process.platform === 'win32') {
    execFile('setx', ['ANTHROPIC_BASE_URL', target], { windowsHide: true }, () => {});
  }
}

function cmdUninstall(flags) {
  const settings = readSettings();
  if (settings.env?.ANTHROPIC_BASE_URL) {
    delete settings.env.ANTHROPIC_BASE_URL;
    if (!Object.keys(settings.env).length) delete settings.env;
    writeSettings(settings);
    console.log('Removed ANTHROPIC_BASE_URL from ' + CLAUDE_SETTINGS);
  } else {
    console.log('Nothing to remove.');
  }
  if (flags.global && process.platform === 'win32') {
    execFile('reg', ['delete', 'HKCU\\Environment', '/F', '/V', 'ANTHROPIC_BASE_URL'], { windowsHide: true }, () => {});
  }
}

function openBrowser(target) {
  const cmd = process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    /* opening a browser is a convenience, never a failure condition */
  }
}

// ----------------------------------------------------------------------- main

async function main() {
  const { flags, command, rest, passthrough, detaching } = parseArgs(process.argv.slice(2));
  // Checked before -h/-v: in `shrey mcp --help` the --help is Claude's.
  if (passthrough) return cmdPassthrough(passthrough);
  if (flags.help || command === 'help') return cmdHelp();
  if (flags.version) return cmdVersion();

  const cfg = loadConfig(overridesFrom(flags));

  switch (command) {
    case null:
      return detaching ? cmdLaunchDetached(cfg, flags, rest) : cmdLaunch(cfg, flags, rest);
    case '__proxy-daemon':
      return cmdProxyDaemon(cfg, rest);
    case 'setup':
      await setupWizard({ force: true });
      return console.log('Saved to ' + CONFIG_PATH);
    case 'github':
      return cmdGithub(cfg, rest);
    case 'cloud':
      return cmdCloud(cfg, rest, flags);
    case 'dashboard':
      return cmdDashboard(cfg);
    case 'serve':
      return cmdServe(cfg, flags);
    case 'status':
      return cmdStatus(cfg);
    case 'push':
      return cmdPush(cfg);
    case 'proxy-install':
      return cmdInstall(cfg, flags);
    case 'proxy-uninstall':
      return cmdUninstall(flags);
    default:
      return undefined;
  }
}

// Exported so scripts/test-cli.mjs can exercise the interactive prompts directly
// (readline works fine over a plain pipe; only the top-level TTY gate in
// setupWizard() needs a real terminal, and tests bypass that gate on purpose).
export { setupGithub, setupCloudName, defaultDisplayName, cmdCloud };

const isEntryPoint = process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  main().catch((err) => {
    process.stderr.write('shrey: ' + (err?.stack ?? err) + '\n');
    process.exit(1);
  });
}
