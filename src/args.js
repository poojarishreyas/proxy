/**
 * Command-line routing for `shrey`. Kept free of side effects so it can be tested
 * without starting a proxy or launching Claude Code.
 */

// Commands shrey owns. Anything else is handed to Claude Code untouched.
export const COMMANDS = new Set(['setup', 'github', 'cloud', 'dashboard', 'serve', 'status', 'push', 'install', 'uninstall', 'help']);

// Flags shrey owns, with whether they take a value. Every other flag goes to Claude Code.
export const OWN_FLAGS = {
  port: true,
  host: true,
  upstream: true,
  dir: true,
  repo: true,
  name: true,
  'no-github': false,
  'no-push': false,
  raw: false,
  open: false,
  global: false,
  help: false,
  version: false
};

/**
 * Splits argv into shrey's own flags and Claude Code's arguments. Everything after
 * `--` is Claude's verbatim, so `shrey -- --help` shows Claude Code's help.
 */
export function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
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
    rest.push(arg);
  }
  const command = rest.length && COMMANDS.has(rest[0]) ? rest.shift() : null;
  return { flags, command, rest };
}
