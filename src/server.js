import http from 'node:http';
import { CaptureStore } from './store.js';
import { Archiver } from './git.js';
import { CloudSync } from './cloud.js';
import { createForwarder } from './proxy.js';
import { createDashboard, LiveBus, DASH_PREFIX } from './dashboard.js';
import { writeTranscript, writeIndex } from './render.js';
import { proxyUrl, VERSION } from './config.js';

/**
 * Wires the three halves together: the forwarding hop, the capture store, and the
 * dashboard. One HTTP server serves both - every Anthropic path lives under /v1, so
 * the dashboard can own /_ccproxy without any chance of collision.
 */
export async function startServer(cfg, { log = console.log, portFallback = false, awaitArchive = true } = {}) {
  const bus = new LiveBus();

  const store = new CaptureStore(cfg, {
    onEvent: (session, event) => {
      bus.publish({
        kind: 'event',
        sessionId: session.id,
        event,
        summary: store.summarize(session)
      });
      // Bursty (streaming chunks) but debounced inside CloudSync itself, so this
      // is cheap to call on every event rather than only on the ones below.
      if (cloudSync) cloudSync.touch(session.id);
      // Regenerate the readable views once a request has settled, not per delta.
      // `response/open` is included so requests that never produce a message
      // (probes, errors, aborted calls) still get a transcript INDEX.md can link to.
      if (
        event.type === 'response/message' ||
        event.type === 'response/error' ||
        event.type === 'response/open'
      ) {
        scheduleDerived(session.id);
      }
    }
  });

  const archiver = cfg.github.enabled !== false ? new Archiver(cfg, store, { log }) : null;
  const cloudSync = cfg.cloud?.enabled ? new CloudSync(cfg, store, { log }) : null;

  let derivedTimer = null;
  const derivedPending = new Set();

  function flushDerived() {
    if (derivedTimer) {
      clearTimeout(derivedTimer);
      derivedTimer = null;
    }
    const ids = [...derivedPending];
    derivedPending.clear();
    for (const id of ids) {
      try {
        writeTranscript(store, id);
      } catch (err) {
        log('[shrey] transcript failed for ' + id + ': ' + err.message);
      }
    }
    try {
      // The index covers every terminal writing into this capture directory,
      // not only the sessions this process has seen.
      store.refreshFromDisk();
      writeIndex(store);
    } catch (err) {
      log('[shrey] index failed: ' + err.message);
    }
    if (archiver) archiver.touch();
  }

  function scheduleDerived(sessionId) {
    derivedPending.add(sessionId);
    if (derivedTimer) return;
    derivedTimer = setTimeout(flushDerived, 1500);
    if (typeof derivedTimer.unref === 'function') derivedTimer.unref();
  }

  const forward = createForwarder({
    cfg,
    store,
    onActivity: (activity) => {
      if (activity.kind === 'settled') {
        // The assembled message has landed as an event, so the provisional row goes.
        bus.publish({ kind: 'partial-end', sessionId: activity.sessionId, requestId: activity.requestId });
        if (archiver) archiver.touch();
        return;
      }
      if (activity.kind === 'partial') {
        bus.publish({
          kind: 'partial',
          sessionId: activity.sessionId,
          requestId: activity.requestId,
          partial: activity.capture.partial()
        });
      }
    }
  });

  // The live cfg, not a copy: the port can change below and the dashboard's host
  // check must follow it.
  cfg.version = VERSION;
  const dashboard = createDashboard({ cfg, store, archiver, cloudSync, bus });

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/' || pathname === '/favicon.ico') {
      res.writeHead(302, { location: DASH_PREFIX + '/' });
      return res.end();
    }
    if (pathname.startsWith(DASH_PREFIX)) {
      return dashboard(req, res).catch((err) => {
        if (res.headersSent) return res.end();
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      });
    }
    return forward(req, res);
  });

  // Streaming responses must not be cut by an idle timer.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
  server.keepAliveTimeout = 75_000;

  const listen = (port) =>
    new Promise((resolve, reject) => {
      const onError = (err) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, cfg.host);
    });

  try {
    await listen(cfg.port);
  } catch (err) {
    // Another shrey already holds the port (a second terminal). Each Claude Code
    // session gets its own proxy, so take any free port rather than sharing one
    // whose lifetime belongs to a different terminal.
    if (err?.code !== 'EADDRINUSE' || !portFallback) throw err;
    await listen(0);
  }
  cfg.port = server.address().port;

  if (archiver) {
    const bootArchive = async () => {
      await archiver.init();
      store.refreshFromDisk();
      writeIndex(store);
      archiver.touch();
    };
    // Launching Claude Code should not wait on a network round-trip to GitHub.
    if (awaitArchive) await bootArchive();
    else bootArchive().catch((err) => log('[shrey] archive init failed: ' + err.message));
  }

  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    // Derived views are debounced, so the last request's transcript and the index
    // are usually still pending here. Write them before the final commit, or the
    // archive would permanently lag the log by one request.
    flushDerived();
    if (archiver) await archiver.dispose();
    if (cloudSync) await cloudSync.dispose();
  };

  return { server, store, archiver, cloudSync, bus, url: proxyUrl(cfg), shutdown };
}
