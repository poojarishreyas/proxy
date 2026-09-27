import fs from 'node:fs';
import path from 'node:path';
import { contentId, scrubDeep } from './redact.js';

const SCHEMA_VERSION = 1;

/**
 * The capture store.
 *
 * One append-only JSONL log per session is the truth; everything else on disk
 * (manifest, transcript, index) is a derived view regenerated from that log.
 * Large repeated payloads - system prompts, tool catalogues, individual messages -
 * live once in a content-addressed `objects/` directory and are referenced by id,
 * so a hundred-request session stores each message a single time.
 */
export class CaptureStore {
  constructor(cfg, { onEvent } = {}) {
    this.cfg = cfg;
    this.root = cfg.captureDir;
    this.objectsDir = path.join(this.root, 'objects');
    this.sessionsDir = path.join(this.root, 'sessions');
    this.onEvent = onEvent ?? (() => {});
    this.sessions = new Map();
    this.dirty = new Set();
    this.redactOpts = { redact: cfg.capture.redactSecrets !== false };
    fs.mkdirSync(this.objectsDir, { recursive: true });
    fs.mkdirSync(this.sessionsDir, { recursive: true });
    this.#ensureScaffold();
    this.refreshFromDisk();
  }

  // ---------------------------------------------------------------- objects

  /** Stores a value under its content address and returns the id. */
  putObject(value, kind = 'blob') {
    const scrubbed = scrubDeep(value, this.redactOpts);
    const json = JSON.stringify(scrubbed);
    const id = contentId(json);
    const shard = path.join(this.objectsDir, id.slice(0, 2));
    const file = path.join(shard, id + '.json');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(shard, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ id, kind, value: scrubbed }, null, 2) + '\n');
      this.dirty.add(file);
    }
    return id;
  }

  getObject(id) {
    if (!/^[0-9a-f]{24}$/.test(id ?? '')) return null;
    const file = path.join(this.objectsDir, id.slice(0, 2), id + '.json');
    if (!fs.existsSync(file)) return null;
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8')).value;
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------- sessions

  openSession({ id, title, startedAt, model, credential, source }) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    const day = new Date(startedAt).toISOString().slice(0, 10);
    const dir = path.join(this.sessionsDir, day, id);
    fs.mkdirSync(dir, { recursive: true });

    const session = {
      id,
      dir,
      day,
      title: title ?? '(untitled)',
      startedAt,
      updatedAt: startedAt,
      model,
      credential,
      source: source ?? 'claude-code',
      seq: 0,
      requests: 0,
      errors: 0,
      messageIds: [],
      messageIdSet: new Set(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      logPath: path.join(dir, 'session.jsonl'),
      events: [],
      hydrated: true,
      // Written by this process. Sessions from other terminals are refreshed from disk.
      owned: true
    };
    this.sessions.set(id, session);
    this.append(id, 'session/start', {
      sessionId: id,
      title: session.title,
      model,
      credential,
      schemaVersion: SCHEMA_VERSION
    });
    return session;
  }

  getSession(id) {
    return this.sessions.get(id) ?? null;
  }

  listSessions() {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => this.summarize(s));
  }

  summarize(s) {
    return {
      id: s.id,
      title: s.title,
      day: s.day,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      model: s.model,
      requests: s.requests,
      errors: s.errors,
      events: s.seq,
      usage: s.usage,
      source: s.source
    };
  }

  /**
   * Appends one event. `seq` is the zero-based index in this session's log and is
   * assigned here and nowhere else, so it always equals the log length at write time.
   */
  append(sessionId, type, data) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('append to unknown session ' + sessionId);
    // Appending adopts the session (e.g. a resumed conversation), so a later refresh
    // from disk can never rewind its seq underneath this process.
    session.owned = true;
    this.#hydrate(session);
    const event = { seq: session.seq++, time: Date.now(), type, data };
    fs.appendFileSync(session.logPath, JSON.stringify(event) + '\n');
    session.updatedAt = event.time;
    session.events.push(event);
    this.dirty.add(session.logPath);
    try {
      this.onEvent(session, event);
    } catch (err) {
      console.error('[shrey] event listener threw: ' + err.message);
    }
    return event;
  }

  /** Records the message hashes a session has seen; used for request correlation. */
  noteMessages(sessionId, ids) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const id of ids) {
      if (!session.messageIdSet.has(id)) {
        session.messageIdSet.add(id);
        session.messageIds.push(id);
      }
    }
  }

  addUsage(sessionId, usage) {
    const session = this.sessions.get(sessionId);
    if (!session || !usage) return;
    session.usage.input += usage.input_tokens ?? 0;
    session.usage.output += usage.output_tokens ?? 0;
    session.usage.cacheRead += usage.cache_read_input_tokens ?? 0;
    session.usage.cacheCreation += usage.cache_creation_input_tokens ?? 0;
  }

  readLog(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    if (session.hydrated) return session.events;
    // Not ours and not yet appended to: read without caching, since another
    // process may still be writing it.
    return readEventFile(session.logPath);
  }

  /**
   * Pulls a disk-loaded session's full log into memory before this process appends
   * to it, so readers see one continuous history and seq continues from the true
   * log length (the manifest can lag the log by the events of a crashed run).
   */
  #hydrate(session) {
    if (session.hydrated) return;
    session.events = readEventFile(session.logPath);
    session.seq = session.events.length;
    session.hydrated = true;
  }

  // ----------------------------------------------------------- derived files

  writeManifest(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const manifest = {
      schemaVersion: SCHEMA_VERSION,
      id: s.id,
      title: s.title,
      source: s.source,
      model: s.model,
      credential: s.credential,
      startedAt: new Date(s.startedAt).toISOString(),
      updatedAt: new Date(s.updatedAt).toISOString(),
      durationMs: s.updatedAt - s.startedAt,
      requests: s.requests,
      errors: s.errors,
      events: s.seq,
      usage: s.usage,
      messageIds: s.messageIds
    };
    const file = path.join(s.dir, 'manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
    this.dirty.add(file);
  }

  writeDerived(sessionId, name, text) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const file = path.join(s.dir, name);
    fs.writeFileSync(file, text);
    this.dirty.add(file);
  }

  writeRaw(sessionId, name, value) {
    if (!this.cfg.capture.raw) return;
    const s = this.sessions.get(sessionId);
    if (!s) return;
    const dir = path.join(s.dir, 'raw');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(scrubDeep(value, this.redactOpts), null, 2) + '\n');
    this.dirty.add(file);
  }

  takeDirty() {
    const files = [...this.dirty];
    this.dirty.clear();
    return files;
  }

  // ---------------------------------------------------------------- private

  #ensureScaffold() {
    const readme = path.join(this.root, 'README.md');
    if (!fs.existsSync(readme)) {
      fs.writeFileSync(readme, SCAFFOLD_README);
      this.dirty.add(readme);
    }
    const gitignore = path.join(this.root, '.gitignore');
    if (!fs.existsSync(gitignore)) {
      fs.writeFileSync(gitignore, ['*.tmp', '*.partial', '.DS_Store', 'Thumbs.db', ''].join('\n'));
      this.dirty.add(gitignore);
    }
    const attrs = path.join(this.root, '.gitattributes');
    if (!fs.existsSync(attrs)) {
      fs.writeFileSync(attrs, ['*.jsonl -diff', 'objects/** -diff', ''].join('\n'));
      this.dirty.add(attrs);
    }
  }

  /**
   * Loads sessions from disk: prior runs, and sessions other shrey processes are
   * writing right now into the same capture directory. Sessions this process owns
   * are authoritative in memory and never overwritten from disk.
   */
  refreshFromDisk() {
    if (!fs.existsSync(this.sessionsDir)) return;
    const found = [];
    for (const day of fs.readdirSync(this.sessionsDir)) {
      const dayDir = path.join(this.sessionsDir, day);
      if (!fs.statSync(dayDir).isDirectory()) continue;
      for (const id of fs.readdirSync(dayDir)) {
        const dir = path.join(dayDir, id);
        const manifestPath = path.join(dir, 'manifest.json');
        if (!fs.existsSync(manifestPath)) continue;
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          found.push({ m, dir, day, id });
        } catch {
          /* a truncated manifest just means that session is not resumable */
        }
      }
    }
    found.sort((a, b) => Date.parse(a.m.updatedAt) - Date.parse(b.m.updatedAt));
    for (const entry of found) {
      if (this.sessions.get(entry.id)?.owned) continue;
      const m = entry.m;
      const messageIds = m.messageIds ?? [];
      this.sessions.set(entry.id, {
        id: entry.id,
        dir: entry.dir,
        day: entry.day,
        title: m.title ?? '(untitled)',
        startedAt: Date.parse(m.startedAt) || Date.now(),
        updatedAt: Date.parse(m.updatedAt) || Date.now(),
        model: m.model,
        credential: m.credential,
        source: m.source ?? 'claude-code',
        seq: m.events ?? 0,
        requests: m.requests ?? 0,
        errors: m.errors ?? 0,
        messageIds,
        messageIdSet: new Set(messageIds),
        usage: m.usage ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        logPath: path.join(entry.dir, 'session.jsonl'),
        events: [],
        hydrated: false
      });
    }
  }
}

const SCAFFOLD_README = [
  '# Claude Code trajectories',
  '',
  'Captured by **ccproxy** - a local proxy sitting between the Claude Code CLI and the',
  'Anthropic API. Every request and response is recorded, then committed here.',
  '',
  '## Layout',
  '',
  '```',
  'sessions/<YYYY-MM-DD>/<session-id>/',
  '    session.jsonl    append-only event log - the source of truth',
  '    manifest.json    summary: model, request count, token usage, timings',
  '    transcript.md    human-readable rendering of the same log',
  'objects/<xx>/<id>.json',
  '    content-addressed payloads (messages, system prompts, tool catalogues),',
  '    each stored exactly once and referenced by id from the logs',
  'INDEX.md             table of every captured session, newest first',
  '```',
  '',
  '## Event vocabulary',
  '',
  '| type | meaning |',
  '| --- | --- |',
  '| `session/start` | first request of a conversation observed |',
  '| `request/context` | effective system prompt / tool catalogue changed |',
  '| `request/start` | one model request left the CLI |',
  '| `response/open` | upstream responded; status and headers recorded |',
  '| `response/chunks` | streamed SSE deltas, packed into runs |',
  '| `response/message` | assembled reply, stop reason, usage, timings |',
  '| `response/error` | upstream returned a non-2xx status, or the hop failed |',
  '',
  '## Secrets',
  '',
  'Credentials are fingerprinted, never stored: `x-api-key` and `authorization` become a',
  'stable `redacted` digest, so sessions stay distinguishable by key without exposing it.',
  'Known credential shapes (`sk-ant-`, `ghp_`, `AKIA`, PEM blocks) are scrubbed from bodies.',
  ''
].join('\n');

function readEventFile(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* a torn final line just means that event never committed */
    }
  }
  return out;
}
