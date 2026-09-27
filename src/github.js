import { execFile } from 'node:child_process';

const run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/**
 * Accepts the shapes people actually paste and returns one canonical form:
 *   https://github.com/owner/repo(.git)(/)   git@github.com:owner/repo.git
 *   github.com/owner/repo                    owner/repo
 * Returns null for anything that is not a GitHub repository address.
 */
export function normalizeGithubUrl(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const patterns = [
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i,
    /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/
  ];
  for (const pattern of patterns) {
    const m = raw.match(pattern);
    if (!m) continue;
    const owner = m[1];
    const repo = m[2];
    if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo)) return null;
    const ssh = raw.startsWith('git@') || raw.startsWith('ssh://');
    return {
      slug: owner + '/' + repo,
      // SSH input stays SSH: the user chose that transport for a reason (keys, not tokens).
      remote: ssh ? 'git@github.com:' + owner + '/' + repo + '.git' : 'https://github.com/' + owner + '/' + repo + '.git',
      web: 'https://github.com/' + owner + '/' + repo
    };
  }
  return null;
}

export async function ghAuthenticated() {
  // Tests (and anyone who wants git-only behaviour) can keep gh out of the loop.
  if (process.env.SHREY_NO_GH === '1') return false;
  return (await run('gh', ['auth', 'status'])).ok;
}

/**
 * Makes sure the repository exists, creating it private when the GitHub CLI can.
 * Without gh this is a no-op: pushing to a repo that does not exist then fails
 * visibly in the archive status, which is the honest outcome.
 */
export async function ensureRepo(slug, { visibility = 'private' } = {}) {
  if (!(await ghAuthenticated())) return { ok: true, created: false, checked: false };
  const view = await run('gh', ['repo', 'view', slug, '--json', 'url']);
  if (view.ok) return { ok: true, created: false, checked: true };
  const created = await run('gh', [
    'repo', 'create', slug,
    visibility === 'public' ? '--public' : '--private',
    '--description', 'Claude Code request/response trajectories captured by shrey'
  ]);
  if (!created.ok) return { ok: false, created: false, checked: true, error: created.stderr.trim() };
  return { ok: true, created: true, checked: true };
}

/** owner/<name> for the authenticated gh user, used by the auto-create option. */
export async function defaultSlug(repoName) {
  const who = await run('gh', ['api', 'user', '--jq', '.login']);
  const login = who.stdout.trim();
  return who.ok && login ? login + '/' + repoName : null;
}
