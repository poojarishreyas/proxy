import crypto from 'node:crypto';

/**
 * Streams captures to a hosted shrey dashboard (Vercel + Supabase), independent of
 * and in addition to local GitHub archival. There is no login: a per-install
 * device token (generated once, kept in config.json) identifies which machine an
 * event came from, and a shared cloud key gates the endpoint from strangers. The
 * server maps the device token to a display name the user chose during setup.
 *
 * Sync is debounced per session the same way git commits are - a streaming
 * response produces many events a second and each one triggering an HTTP call
 * would be wasteful. Failures never throw: the local capture (and any GitHub
 * archival) already succeeded, so a network hiccup here just retries later.
 */
export class CloudSync {
  constructor(cfg, store, { log = console.log, fetchImpl = fetch } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.log = log;
    this.fetch = fetchImpl;
    this.ready = Boolean(cfg.cloud?.enabled && cfg.cloud?.url && cfg.cloud?.key && cfg.cloud?.deviceToken);
    this.dirty = new Set();
    this.timer = null;
    this.queue = Promise.resolve();
    // How far each session's log has already been sent, and which content-addressed
    // objects it has already sent - both purely a bandwidth optimisation. Correctness
    // does not depend on this: the server upserts by primary key, so resending
    // anything already stored is a no-op.
    this.sentThrough = new Map();
    this.sentObjects = new Set();
    this.introduced = false;
    this.stats = { syncs: 0, failures: 0 };
    this.lastError = null;
    this.lastSyncAt = null;
  }

  touch(sessionId) {
    if (!this.ready) return;
    this.dirty.add(sessionId);
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.cfg.cloud.syncDebounceMs ?? 4000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  flush() {
    this.queue = this.queue.then(() => this.#syncAll()).catch((err) => {
      this.lastError = String(err?.message ?? err);
      this.stats.failures++;
    });
    return this.queue;
  }

  async #syncAll() {
    if (!this.ready) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      try {
        await this.#syncOne(id);
      } catch (err) {
        // One session's failure (e.g. it was deleted mid-run) should not stop the rest.
        this.lastError = String(err?.message ?? err);
        this.stats.failures++;
        this.log('[shrey] cloud sync failed for ' + id + ': ' + this.lastError);
      }
    }
  }

  async #syncOne(sessionId) {
    const session = this.store.getSession(sessionId);
    if (!session) return;

    const log = this.store.readLog(sessionId);
    const from = this.sentThrough.get(sessionId) ?? 0;
    const fresh = log.filter((e) => e.seq >= from);
    if (!fresh.length && this.sentThrough.has(sessionId)) return; // nothing new

    const objectIds = new Set();
    for (const e of fresh) {
      for (const ref of e.data?.messageRefs ?? []) objectIds.add(ref);
      if (e.data?.systemId) objectIds.add(e.data.systemId);
      if (e.data?.toolsId) objectIds.add(e.data.toolsId);
    }
    const objects = [];
    for (const id of objectIds) {
      if (this.sentObjects.has(id)) continue;
      const value = this.store.getObject(id);
      if (value === null) continue;
      objects.push({ id, kind: 'blob', value });
    }

    const body = {
      deviceToken: this.cfg.cloud.deviceToken,
      name: this.introduced ? undefined : this.cfg.cloud.name,
      session: {
        id: session.id,
        title: session.title,
        model: session.model,
        source: session.source,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        requests: session.requests,
        errors: session.errors,
        usage: session.usage
      },
      events: fresh.map((e) => ({ seq: e.seq, time: e.time, type: e.type, data: e.data })),
      objects
    };

    const res = await this.fetch(this.cfg.cloud.url.replace(/\/+$/, '') + '/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.cfg.cloud.key },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let message = text;
      try {
        message = JSON.parse(text).error ?? text;
      } catch {
        /* not JSON; use the raw body */
      }
      throw new Error('HTTP ' + res.status + (message ? ': ' + message : ''));
    }

    this.introduced = true;
    this.sentThrough.set(sessionId, log.length);
    for (const o of objects) this.sentObjects.add(o.id);
    this.stats.syncs++;
    this.lastSyncAt = Date.now();
    this.lastError = null;
  }

  status() {
    return {
      enabled: this.ready,
      url: this.cfg.cloud?.url ?? null,
      name: this.cfg.cloud?.name ?? null,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      ...this.stats
    };
  }

  async dispose() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.queue;
  }
}

export function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}
