/**
 * Command-line routing for `shrey`. Kept free of side effects so it can be tested
 * without starting a proxy or launching Claude Code.
 *
 * The contract: `shrey <anything>` behaves exactly like `claude <anything>`, plus
 * capture. So shrey only claims words and flags Claude Code itself does not use;
 * every collision is resolved in Claude Code's favour.
 */

// Commands shrey owns. None of these is a Claude Code subcommand.
export const COMMANDS = new Set([
  'setup',
  'github',
  'cloud',
  'dashboard',
  'serve',
  'status',
  'push',
  'proxy-install',
  'proxy-uninstall',
  'help',
  '__proxy-daemon'
]);

// Claude Code subcommands that manage Claude rather than run a model session.
// They go straight to `claude` with the arguments untouched: no setup prompt, no
// proxy, no banner - `shrey mcp add ...` is byte-for-byte `claude mcp add ...`.
export const CLAUDE_SUBCOMMANDS = new Set([
  'agents',
  'attach',
  'auth',
  'auto-mode',
  'doctor',
  'gateway',
  'import',
  'install',
  'logs',
  'mcp',
  'plugin',
  'plugins',
  'project',
  'respawn',
  'rm',
  'setup-token',
  'stop',
  'kill',
  'ultrareview',
  'update',
  'upgrade'
]);

// Flags shrey owns, with whether they take a value. None of these is a Claude Code
// flag. (-h/--help and -v/--version are shared: shrey prints its own, then Claude's.)
export const OWN_FLAGS = {
  port: true,
  host: true,
  upstream: true,
  dir: true,
  repo: true,
  'no-github': false,
  'no-push': false,
  raw: false,
  open: false,
  global: false,
  help: false,
  version: false
};

// Launch modes where the Claude Code process returns while the session it started
// keeps running (and keeps calling the API) somewhere else.
export const DETACHING_FLAGS = new Set(['--bg', '--background', '--tmux']);

/**
 * Splits argv into shrey's own flags and Claude Code's arguments. Everything after
 * `--` is Claude's verbatim, so `shrey -- --help` shows only Claude Code's help.
 */
export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  let firstRestIndex = -1;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      if (firstRestIndex === -1 && i + 1 < argv.length) firstRestIndex = i + 1;
      rest.push(...argv.slice(i + 1));
      break;
    }
    if (arg === '-h') {
      flags.help = true;
      continue;
    }
    if (arg === '-v') {
      flags.version = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = arg.slice(2, eq === -1 ? undefined : eq);
      if (key in OWN_FLAGS) {
        if (!OWN_FLAGS[key]) flags[key] = true;
        else if (eq !== -1) flags[key] = arg.slice(eq + 1);
        else if (argv[i + 1] !== undefined) flags[key] = argv[++i];
        continue;
      }
    }
    if (firstRestIndex === -1) firstRestIndex = i;
    rest.push(arg);
  }
  const command = rest.length && COMMANDS.has(rest[0]) ? rest.shift() : null;
  const claudeSubcommand = command === null && rest.length && CLAUDE_SUBCOMMANDS.has(rest[0]) ? rest[0] : null;
  const detaching = command === null && !claudeSubcommand && rest.some((a) => DETACHING_FLAGS.has(a));
  // For a Claude subcommand, everything from the subcommand on is Claude's exactly
  // as typed - including -h/-v, which parsing above would otherwise have claimed.
  const passthrough = claudeSubcommand ? argv.slice(firstRestIndex) : null;
  return { flags, command, rest, claudeSubcommand, passthrough, detaching };
}

/**
 * Pulls `--name <x>` / `--name=<x>` / `-n <x>` out of a shrey command's own
 * arguments. Only used by shrey's `cloud` command: anywhere else `--name` belongs
 * to Claude Code (it names the session) and is passed through untouched.
 */
export function takeNameFlag(args) {
  const out = [];
  let name;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' || a === '-n') {
      name = args[++i];
    } else if (a.startsWith('--name=')) {
      name = a.slice(7);
    } else {
      out.push(a);
    }
  }
  return { name, args: out };
}
