import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const VERSION = '1.2.0';

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
  // Hosted multi-user dashboard (Vercel + Supabase). Independent of GitHub archival —
  // both can run at once, since they serve different purposes: git is a durable
  // per-user archive, cloud is a live shared view across everyone's machines.
  cloud: {
    enabled: false,
    // e.g. https://your-deploy.vercel.app — the dashboard's own origin.
    url: null,
    // The deployment's shared secret (SHREY_CLOUD_KEY on the server). Not a login;
    // it just keeps strangers off your ingest endpoint.
    key: null,
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

/**
 * Persists only the given settings. The in-memory config also carries one-off CLI
 * flags and a fallback port; writing it back wholesale would make those sticky.
 */
export function updateStoredConfig(patch) {
  fs.mkdirSync(HOME, { recursive: true });
  const next = deepMerge(readStoredConfig(), patch);
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);
  return next;
}

export function proxyUrl(cfg) {
  return `http://${cfg.host}:${cfg.port}`;
}
