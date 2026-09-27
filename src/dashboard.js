import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import crypto from 'node:crypto';
import { ASSETS } from './assets.generated.js';
import { ghAuthenticated, defaultSlug } from './github.js';

export const DASH_PREFIX = '/_ccproxy';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8'
};

/** In a source checkout the files on disk win, so the UI can be edited without rebuilding. */
function loadAsset(name) {
  try {
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const disk = path.join(here, '..', 'web', name);
    if (fs.existsSync(disk)) return fs.readFileSync(disk, 'utf8');
  } catch {
    /* packaged build: fall through to the embedded copy */
  }
  return ASSETS[name] ?? null;
}

/** Fan-out for live updates. One Set of open SSE responses, no per-client state. */
export class LiveBus {
  constructor() {
    this.clients = new Set();
  }

  add(res) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  publish(payload) {
    if (!this.clients.size) return;
    const frame = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }
}

/**
 * The dashboard is unauthenticated and bound to loopback, which is not the same as
 * private: any web page the user visits can send requests to 127.0.0.1. Two guards:
 *   - Host must be a loopback name for this port, so DNS rebinding cannot read it.
 *   - Every state-changing request carries a per-process token that only the page
 *     this server rendered knows, so a cross-site form cannot re-point the archive.
 */
export function createDashboard({ cfg, store, archiver, cloudSync, bus }) {
  const token = crypto.randomBytes(24).toString('hex');
  let lastRefresh = 0;

  const hostAllowed = (host) => {
    const port = String(cfg.port);
    return ['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port].includes(String(host ?? '').toLowerCase());
  };

  // Other shrey terminals write into the same capture directory; pick their
  // sessions up, but not on every poll.
  const refreshSessions = () => {
    if (Date.now() - lastRefresh < 3000) return;
    lastRefresh = Date.now();
    try {
      store.refreshFromDisk();
    } catch {
      /* a half-written manifest from another process; the next poll catches up */
    }
  };

  const dashboard = async function dashboard(req, res) {
    if (!hostAllowed(req.headers.host)) return send(res, 403, 'text/plain', 'forbidden host');

    const parsed = new URL(req.url, 'http://placeholder');
    let route = parsed.pathname.slice(DASH_PREFIX.length) || '/';
    if (route === '/') route = '/index.html';

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['x-shrey-token'] !== token) return json(res, 403, { error: 'missing or invalid token' });
    }

    // ---- static ---------------------------------------------------------
    if (route === '/index.html' || route === '/app.js' || route === '/styles.css') {
      let body = loadAsset(route.slice(1));
      if (body == null) return send(res, 404, 'text/plain', 'asset missing');
      if (route === '/index.html') {
        body = body.replace('</head>', '  <meta name="shrey-token" content="' + token + '" />\n</head>');
      }
      return send(res, 200, MIME[path.extname(route)] ?? 'text/plain', body, {
        'cache-control': 'no-store',
        'x-frame-options': 'DENY',
        'referrer-policy': 'no-referrer'
      });
    }

    // ---- api ------------------------------------------------------------
    if (route === '/api/status') {
      return json(res, 200, {
        version: cfg.version ?? null,
        host: cfg.host,
        port: cfg.port,
        upstream: cfg.upstream,
        upstreamHost: new URL(cfg.upstream).host,
        captureDir: store.root,
        redactSecrets: cfg.capture.redactSecrets !== false,
        raw: !!cfg.capture.raw,
        archive: archiver ? archiver.status() : { ready: false, disabled: true },
        cloud: cloudSync ? cloudSync.status() : { enabled: false },
        sessions: store.sessions.size
      });
    }

    if (route === '/api/sessions') {
      refreshSessions();
      return json(res, 200, store.listSessions());
    }

    if (route.startsWith('/api/sessions/')) {
      const id = decodeURIComponent(route.slice('/api/sessions/'.length));
      const session = store.getSession(id);
      if (!session) return json(res, 404, { error: 'unknown session' });
      const events = store.readLog(id);
      const objects = {};
      for (const event of events) {
        for (const ref of event.data?.messageRefs ?? []) {
          if (!(ref in objects)) objects[ref] = store.getObject(ref);
        }
      }
      return json(res, 200, { session: store.summarize(session), events, objects });
    }

    if (route === '/api/objects') {
      const ids = (parsed.searchParams.get('ids') ?? '').split(',').filter(Boolean).slice(0, 500);
      const out = {};
      for (const id of ids) out[id] = store.getObject(id);
      return json(res, 200, out);
    }

    if (route === '/api/settings' && req.method === 'GET') {
      return json(res, 200, {
        github: {
          remote: archiver?.status().web ?? cfg.github.remote ?? null,
          repo: cfg.github.repo,
          autoPush: cfg.github.autoPush !== false,
          disabled: !archiver
        },
        ghAuthenticated: await ghAuthenticated(),
        captureDir: store.root
      });
    }

    if (route === '/api/settings' && req.method === 'POST') {
      if (!archiver) return json(res, 409, { ok: false, error: 'archival is disabled for this run (--no-github)' });
      const body = await readJson(req);
      if (!body || !('githubRemote' in body)) return json(res, 400, { ok: false, error: 'githubRemote is required' });
      const result = await archiver.setRemote(body.githubRemote);
      return json(res, result.ok ? 200 : 400, { ...result, archive: archiver.status() });
    }

    if (route === '/api/settings/auto-create' && req.method === 'POST') {
      if (!archiver) return json(res, 409, { ok: false, error: 'archival is disabled for this run (--no-github)' });
      if (!(await ghAuthenticated())) {
        return json(res, 400, { ok: false, error: 'The GitHub CLI is not signed in. Run: gh auth login' });
      }
      const slug = await defaultSlug(cfg.github.repo);
      if (!slug) return json(res, 400, { ok: false, error: 'Could not read your GitHub username from gh' });
      const result = await archiver.setRemote(slug);
      return json(res, result.ok ? 200 : 400, { ...result, archive: archiver.status() });
    }

    if (route === '/api/flush' && req.method === 'POST') {
      if (!archiver) return json(res, 200, { ok: false, reason: 'archival disabled' });
      await archiver.flush();
      return json(res, 200, { ok: true, ...archiver.status() });
    }

    if (route === '/api/live') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      res.write('retry: 2000\n\n');
      bus.add(res);
      const keepalive = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {
          clearInterval(keepalive);
        }
      }, 20000);
      res.on('close', () => clearInterval(keepalive));
      return undefined;
    }

    return send(res, 404, 'text/plain', 'not found');
  };

  dashboard.token = token;
  return dashboard;
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 16 * 1024) {
        req.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });
}

function send(res, status, type, body, extra = {}) {
  res.writeHead(status, { 'content-type': type, ...extra });
  res.end(body);
}

function json(res, status, value) {
  send(res, status, 'application/json; charset=utf-8', JSON.stringify(value), { 'cache-control': 'no-store' });
}
