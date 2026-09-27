import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { updateStoredConfig } from './config.js';
import { normalizeGithubUrl, ensureRepo, ghAuthenticated, defaultSlug } from './github.js';

const run = (file, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err?.code ?? 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/**
 * Archives the capture directory to GitHub.
 *
 * Nothing is pushed until the user has named a destination: an explicit repository
 * URL, or an opt-in auto-create through the GitHub CLI. Until then commits stay local.
 *
 * Commits are debounced rather than written per event: a streaming session produces
 * hundreds of appends a minute and one commit each would be noise. Push failures are
 * never fatal - the local commit has already landed, so an offline run simply catches
 * up on the next cycle.
 */
export class Archiver {
  constructor(cfg, store, { log = console.log } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.dir = store.root;
    this.log = log;
    this.timer = null;
    this.queue = Promise.resolve();
    this.ready = false;
    this.remote = null;
    this.web = null;
    this.pendingPush = false;
    this.lastError = null;
    this.lastPushAt = null;
    this.stats = { commits: 0, pushes: 0, failures: 0 };
  }

  git(args) {
    return run('git', ['-C', this.dir, ...args]);
  }

  async init() {
    const gitAvailable = (await run('git', ['--version'])).ok;
    if (!gitAvailable) {
      this.lastError = 'git is not installed - captures stay local';
      this.log('[shrey] git not found on PATH - archival disabled, captures stay local');
      return false;
    }

    if (!fs.existsSync(path.join(this.dir, '.git'))) {
      await this.git(['init', '-b', 'main']);
      this.log('[shrey] initialised capture repository at ' + this.dir);
    }

    // Fall back to an identity only if the machine has none; never override the user's.
    if (!(await this.git(['config', 'user.name'])).stdout.trim()) {
      await this.git(['config', 'user.name', 'shrey']);
    }
    if (!(await this.git(['config', 'user.email'])).stdout.trim()) {
      await this.git(['config', 'user.email', 'shrey@localhost']);
    }

    this.ready = true;
    if (this.cfg.github.enabled !== false) await this.#resolveRemote();
    return true;
  }

  async #resolveRemote() {
    const configured = this.cfg.github.remote ? normalizeGithubUrl(this.cfg.github.remote) : null;
    if (configured) {
      await this.#applyRemote(configured);
      return;
    }
    if (this.cfg.github.autoCreate) {
      if (!(await ghAuthenticated())) {
        this.lastError = 'auto-create needs the GitHub CLI: run gh auth login';
        return;
      }
      const slug = await defaultSlug(this.cfg.github.repo);
      if (!slug) {
        this.lastError = 'could not read the GitHub user from gh';
        return;
      }
      const target = normalizeGithubUrl(slug);
      await this.#applyRemote(target);
      if (this.remote) updateStoredConfig({ github: { remote: target.web } });
      return;
    }
    // A leftover origin from an earlier configuration is not consent for this one.
    const origin = (await this.git(['remote', 'get-url', 'origin'])).stdout.trim();
    if (origin) await this.git(['remote', 'remove', 'origin']);
  }

  async #applyRemote(target) {
    const repo = await ensureRepo(target.slug, { visibility: this.cfg.github.visibility });
    if (!repo.ok) {
      this.lastError = 'could not create ' + target.slug + ': ' + repo.error;
      return false;
    }
    if (repo.created) this.log('[shrey] created private GitHub repository ' + target.web);

    const existing = (await this.git(['remote', 'get-url', 'origin'])).stdout.trim();
    const result = existing
      ? await this.git(['remote', 'set-url', 'origin', target.remote])
      : await this.git(['remote', 'add', 'origin', target.remote]);
    if (!result.ok) {
      this.lastError = result.stderr.trim();
      return false;
    }
    this.remote = target.remote;
    this.web = target.web;
    this.cfg.github.remote = target.web;
    this.lastError = null;
    // A new destination has none of the history yet.
    this.pendingPush = true;
    return true;
  }

  /**
   * Points archival at a new destination, persists it, and pushes everything so far.
   * `input` may be any GitHub repository address, or null to stop pushing.
   */
  async setRemote(input) {
    if (input === null || input === '' || input === 'off' || input === 'local') {
      updateStoredConfig({ setupDone: true, github: { remote: null, autoCreate: false } });
      this.cfg.github.remote = null;
      this.cfg.github.autoCreate = false;
      if (this.ready) {
        const origin = (await this.git(['remote', 'get-url', 'origin'])).stdout.trim();
        if (origin) await this.git(['remote', 'remove', 'origin']);
      }
      this.remote = null;
      this.web = null;
      this.pendingPush = false;
      this.lastError = null;
      return { ok: true, remote: null };
    }

    const target = normalizeGithubUrl(input);
    if (!target) return { ok: false, error: 'Not a GitHub repository URL. Try https://github.com/you/repo' };

    if (!this.ready && !(await this.init())) return { ok: false, error: this.lastError ?? 'git unavailable' };
    const applied = await this.#applyRemote(target);
    if (!applied) return { ok: false, error: this.lastError };

    updateStoredConfig({ setupDone: true, github: { remote: target.web, autoCreate: false } });
    this.cfg.github.autoCreate = false;
    await this.flush();
    return { ok: !this.lastError, remote: target.web, error: this.lastError ?? undefined, pushes: this.stats.pushes };
  }

  /** Marks the working tree changed; a commit follows within the debounce window. */
  touch() {
    if (!this.ready || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.cfg.github.commitDebounceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Commits and pushes now. Serialised: two flushes never overlap. */
  flush() {
    this.queue = this.queue.then(() => this.#commitAndPush()).catch((err) => {
      this.lastError = String(err?.message ?? err);
      this.stats.failures++;
    });
    return this.queue;
  }

  async #commitAndPush() {
    if (!this.ready) return;
    this.store.takeDirty();

    const add = await this.git(['add', '-A']);
    if (!add.ok) {
      // Another shrey in another terminal may hold the index lock; the next cycle retries.
      this.lastError = add.stderr.trim();
      return;
    }

    const staged = await this.git(['diff', '--cached', '--quiet']);
    const hasChanges = !staged.ok; // --quiet exits 1 when there is a diff
    if (hasChanges) {
      const commit = await this.git(['commit', '-m', this.#message()]);
      if (!commit.ok) {
        this.lastError = commit.stderr.trim() || commit.stdout.trim();
        this.stats.failures++;
        return;
      }
      this.stats.commits++;
      this.pendingPush = true;
    }

    if (!this.pendingPush || !this.cfg.github.autoPush || !this.remote) return;

    let push = await this.git(['push', '-u', 'origin', 'HEAD']);
    if (!push.ok && /fetch first|non-fast-forward|rejected/i.test(push.stderr)) {
      // Another machine (or terminal) pushed to the same repo. Captures never touch
      // the same files twice, so a rebase onto theirs is conflict-free.
      const branch = (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim() || 'main';
      const pulled = await this.git(['pull', '--rebase', '--autostash', 'origin', branch]);
      if (!pulled.ok) {
        // Typically a pre-existing repo whose README collides with ours. Leave the
        // local history untouched and say what to do rather than retrying forever.
        await this.git(['rebase', '--abort']);
        this.lastError = 'the remote repository has conflicting files - point shrey at an empty repository';
        this.stats.failures++;
        return;
      }
      push = await this.git(['push', '-u', 'origin', 'HEAD']);
    }
    if (push.ok) {
      this.pendingPush = false;
      this.stats.pushes++;
      this.lastPushAt = Date.now();
      this.lastError = null;
    } else {
      // Local history is safe; the next cycle retries. Offline runs simply queue up.
      this.lastError = push.stderr.trim().split('\n').slice(-2).join(' ');
      this.stats.failures++;
    }
  }

  #message() {
    const sessions = this.store.listSessions();
    const recent = sessions.filter((s) => Date.now() - s.updatedAt < 10 * 60 * 1000);
    const requests = recent.reduce((n, s) => n + s.requests, 0);
    const head = recent.length === 1
      ? 'capture: ' + recent[0].id + ' (' + recent[0].requests + ' requests)'
      : 'capture: ' + recent.length + ' sessions, ' + requests + ' requests';
    const body = recent
      .slice(0, 10)
      .map((s) => '- ' + s.id + ' · ' + (s.model ?? '?') + ' · ' + s.requests + ' req · ' +
        s.usage.input + ' in / ' + s.usage.output + ' out · ' + String(s.title).slice(0, 70))
      .join('\n');
    return head + '\n\n' + body + '\n';
  }

  status() {
    return {
      ready: this.ready,
      remote: this.remote,
      web: this.web,
      autoPush: this.cfg.github.autoPush !== false,
      pendingPush: this.pendingPush,
      lastError: this.lastError,
      lastPushAt: this.lastPushAt,
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
