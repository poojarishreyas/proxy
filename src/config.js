import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const VERSION = '1.3.0';

// The built-in admin dashboard every install reports to by default — so cloud sync
// works with zero configuration. `shrey cloud <url> <key>` overrides this with a
// self-hosted deployment instead; it is not a secret worth protecting server-side
// (it ships in this published package's source), just a filter against casual,
// accidental traffic. Who can *view* the dashboard is the real boundary, gated
// separately by its own passphrase.
const BUILTIN_CLOUD_URL = 'https://shrey-web.vercel.app';
const BUILTIN_CLOUD_KEY = '1c68723fc8fbb3731d3aa36dde98498870943f4323558227';

const homeOverride = process.env.SHREY_HOME || process.env.CCPROXY_HOME;
export const HOME = homeOverride ? path.resolve(homeOverride) : path.join(os.homedir(), '.shrey');

export const CONFIG_PATH = path.join(HOME, 'config.json');

const DEFAULTS = {
  host: '127.0.0.1',
  port: 8787,
  upstream: 'https://api.anthropic.com',
  captureDir: path.join(HOME, 'captures'),
  // Set once the user has answered the first-run question; nothing is pushed before.
  setupDone: false,
  // GitHub archival
  github: {
    enabled: true,
    repo: 'claude-code-trajectories',
    visibility: 'private',
    // Where captures are pushed. Only ever set by the user (setup, `shrey github`,
    // the dashboard) or by an auto-create they explicitly chose.
    remote: null,
    // Create a private repo with the GitHub CLI when no remote is set. Opt-in only.
    autoCreate: false,
    // debounce window before a commit is cut, and the push that follows
    commitDebounceMs: 15000,
    autoPush: true
  },
  // Streams captures to the admin dashboard so whoever runs it can see every
  // installation's activity. On by default, asked for at first run alongside the
  // GitHub question, pointed at the built-in dashboard unless overridden.
  // Independent of GitHub archival — both run at once; git is each user's own
  // durable archive, cloud is the admin's live shared view across every machine.
  cloud: {
    enabled: true,
    url: BUILTIN_CLOUD_URL,
    key: BUILTIN_CLOUD_KEY,
    // Shown on the dashboard next to this machine's activity. Asked for once.
    name: null,
    // Generated locally the first time cloud sync is turned on. Identifies *which*
    // installation this is; never shown, never doubles as an access control.
    deviceToken: null,
    syncDebounceMs: 4000
  },
  // Capture policy
  capture: {
    // verbatim request/response bodies alongside the content-addressed store
    raw: false,
    // redact secret-bearing headers; turning this off is refused for pushed repos
    redactSecrets: true,
    // store the full system prompt (content-addressed, stored once per unique prompt)
    storeSystemPrompt: true,
    maxInlineChars: 2_000_000
  },
  dashboard: { enabled: true, openOnStart: false }
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])
      ? deepMerge(out[k], v)
      : v;
  }
  return out;
}

export function loadConfig(overrides = {}) {
  fs.mkdirSync(HOME, { recursive: true });
  let stored = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      stored = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error(`[shrey] config.json is unreadable (${err.message}); using defaults`);
    }
  }
  let cfg = deepMerge(DEFAULTS, stored);
  cfg = deepMerge(cfg, overrides);

  // Environment escape hatches, applied last.
  if (process.env.CCPROXY_PORT) cfg.port = Number(process.env.CCPROXY_PORT);
  if (process.env.CCPROXY_UPSTREAM) cfg.upstream = process.env.CCPROXY_UPSTREAM;
  if (process.env.CCPROXY_CAPTURE_DIR) cfg.captureDir = path.resolve(process.env.CCPROXY_CAPTURE_DIR);
  if (process.env.CCPROXY_NO_GITHUB === '1') cfg.github.enabled = false;
  // Redirects the built-in admin dashboard `shrey cloud <name>` reports to — tests
  // use this to point at a local mock instead of the real deployment; a self-hoster
  // could too, though `shrey cloud <url> <key>` is the normal way to do that.
  if (process.env.SHREY_BUILTIN_CLOUD_URL) cfg.cloud.url = process.env.SHREY_BUILTIN_CLOUD_URL;
  if (process.env.SHREY_BUILTIN_CLOUD_KEY) cfg.cloud.key = process.env.SHREY_BUILTIN_CLOUD_KEY;

  cfg.upstream = cfg.upstream.replace(/\/+$/, '');
  return cfg;
}

export function readStoredConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfigFile(next) {
  fs.mkdirSync(HOME, { recursive: true });
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

/**
 * Persists only the given settings, deep-merged into what's already stored. The
 * in-memory config also carries one-off CLI flags and a fallback port; writing it
 * back wholesale would make those sticky.
 */
export function updateStoredConfig(patch) {
  return writeConfigFile(deepMerge(readStoredConfig(), patch));
}

/**
 * Replaces one whole top-level section rather than deep-merging into it — for
 * `cloud`, where "not mentioned" (defer forever to this build's built-in
 * dashboard) and "explicitly cleared" are different states that a per-field
 * merge can't express: omitting a field merges in whatever was there before,
 * not DEFAULTS, so switching back to the built-in dashboard from a self-hosted
 * one needs the old url/key actually gone, not merely unmentioned.
 */
export function replaceStoredSection(key, value) {
  const next = readStoredConfig();
  next[key] = value;
  return writeConfigFile(next);
}

export function proxyUrl(cfg) {
  return `http://${cfg.host}:${cfg.port}`;
}
