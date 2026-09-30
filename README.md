# shrey

Run Claude Code with every request and response captured — viewable live as a
trajectory, pushed to your own GitHub repository, and reported to a built-in admin
dashboard so activity across every machine running `shrey` can be watched in one place.

```bash
npm install -g shrey-cli
shrey
```

That's it. `shrey` opens Claude Code in the current folder, exactly as `claude` would,
with a local proxy in between that records everything it sends to and receives from
the Anthropic API.

```
Claude Code  ──▶  shrey proxy (127.0.0.1)  ──▶  api.anthropic.com
                      │
                      ├──▶  capture on disk  ──▶  git commit  ──▶  your GitHub repo
                      ├──▶  admin dashboard (built in, or self-hosted)
                      └──▶  live local trajectory view
```

Requirements: Node 20+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
and git. The [GitHub CLI](https://cli.github.com) is optional — with it, shrey can create
the repository for you.

---

## First run

The first time you run `shrey` it asks two things, in your terminal:

```
  Where should captures go?
    paste a GitHub repo URL    e.g. https://github.com/you/claude-traces
    press Enter                create a private repo "claude-code-trajectories" for you
    type local                 keep them on this machine only

  What name should show on the dashboard?
    press Enter    use "yourusername"
    type off       do not report anywhere; stays entirely local
```

GitHub archival is opt-in (nothing is pushed until you answer). Reporting to the admin
dashboard is on by default — press Enter to use your OS username, type any other name,
or type `off` to stay fully local. Change either answer any time:

```bash
shrey github https://github.com/you/claude-traces   # push here (created private if missing)
shrey github off                                    # stop pushing to GitHub

shrey cloud "Your Name"                              # report to the built-in dashboard as this name
shrey cloud off                                      # stop reporting anywhere
shrey cloud                                          # show current status
```

> Captures contain your prompts, your code and tool output. API keys are redacted,
> but if you set your own GitHub repo, **use a private one.**

## Everyday use

**`shrey` is `claude` with capture.** Anything you would type after `claude` works
after `shrey` and behaves the same — same flags, same prompts, same subcommands, same
exit codes, and stdout is exactly Claude Code's (shrey's own status lines go to
stderr, so `shrey -p ... --output-format json | jq` works).

| you type | what happens |
| --- | --- |
| `shrey` | Claude Code opens here; everything is captured |
| `shrey --resume`, `shrey -c`, `shrey -r <id>` | resume / continue, captured |
| `shrey -p "explain this repo"` | non-interactive prompts, captured |
| `shrey --model …`, `--name …`, `--add-dir …`, … | every Claude Code flag passes straight through |
| `shrey --bg "fix the tests"` | background session; a detached proxy keeps capturing it after the command returns, and exits by itself once the session is stopped |
| `shrey mcp …`, `shrey update`, `shrey install`, `shrey agents`, `shrey stop <id>`, … | Claude Code's management commands run exactly as `claude …` — no proxy, no banner |
| `shrey --version`, `shrey --help` | shrey's, followed by Claude Code's |
| `shrey dashboard` | open the live local trajectory view of a running shrey |
| `shrey status` | settings, session count, token totals, running instances |
| `shrey push` | commit and push to GitHub now instead of waiting |
| `shrey serve` | proxy and dashboard only, for other tools to point at |
| `shrey setup` | answer the first-run questions again |

shrey's own options, for one run: `--no-push` (capture and commit, don't push to GitHub),
`--no-github` (no git at all), `--open` (open the local dashboard), `--port <n>`,
`--upstream <url>`, `--dir <path>`, `--raw` (also keep verbatim JSON). Anything else is
Claude Code's. Put `--` first to hand everything to Claude Code: `shrey -- --help`.

**Several terminals at once** are fine — each `shrey` gets its own proxy port, and they
share one capture folder and one GitHub repository. **Ctrl+C** behaves exactly as in
Claude Code (interrupts a response); captures are saved, pushed, and reported when
Claude Code exits. If you already route Claude Code through a gateway with
`ANTHROPIC_BASE_URL`, shrey captures in front of it rather than bypassing it.

---

## Two dashboards

**Local** — printed on launch (`http://127.0.0.1:8787/_ccproxy/` unless that port is
taken). Just this machine's own sessions, with the full detail: timeline, per-block
inspector, live streaming rows.

- **Sessions** — every conversation, newest first, from all terminals on this machine.
- **Metrics** — cache hit rate, median/p90 time to first token, requests, output.
- **Timeline** — each model call split into waiting and generating; a second lane
  shows time spent running tools between calls. Drag to focus, right-click to clear.
- **Ledger** — the conversation as a turn-aware event list, each message once, tool
  calls nested under the turn that made them, the live reply streaming in.
- **Inspector** — any row's content, raw JSON, the underlying event, and the request:
  parameters, headers, usage, timings, the system prompt on demand.
- **Settings** — set or change the GitHub repository.

Keys: `j`/`k` move, `/` search, `f` follow, `Esc` close.

**Admin** — a hosted, multi-user view (Next.js on Vercel, Supabase behind it) built into
`shrey-cli` by default: every installation reports there under the name it was given,
so whoever runs the dashboard can watch activity across every machine at once, live.
There is no per-user login — identity is just the name each install chose. See
`shrey-web/README.md` for deploying your own instead of the built-in one.

---

## What's in the GitHub repository

```
INDEX.md                          every session, newest first, with token totals
sessions/<date>/<session-id>/
    transcript.md                 readable conversation
    session.jsonl                 append-only event log — the source of truth
    manifest.json                 model, requests, usage, timings
objects/<xx>/<id>.json            messages, system prompts and tool lists, stored once
```

Every request re-sends the whole conversation, so storing requests verbatim would grow
quadratically. Instead each message is stored once under its content hash and requests
refer to it by id — lossless, and the repository stays small.

Sessions are reconstructed from the traffic (the API carries no session id): a request
joins the session whose messages it continues. Subagents appear as their own sessions;
a `/compact` starts a new one.

| event | meaning |
| --- | --- |
| `session/start` | first request of a conversation |
| `request/context` | system prompt or tool list changed |
| `request/start` | a model request left Claude Code |
| `response/open` | the API answered: status, headers, latency |
| `response/chunks` | the raw stream, packed |
| `response/message` | the assembled reply, stop reason, usage, timings |
| `response/error` | an HTTP error, a dropped connection, or an error in the stream |

## Privacy and security

- `x-api-key` and `authorization` are replaced with a fingerprint before anything is
  written, locally or to the admin dashboard. Known key shapes (`sk-ant-`, `ghp_`, AWS
  keys, private key blocks) are scrubbed from bodies too. This is a safety net, not a
  guarantee.
- Cloud reporting uses a key built into this published package, not a secret only you
  hold — it filters casual/accidental traffic, not a determined installer reading the
  source. Who can *view* the admin dashboard is the real boundary, gated by its own
  separate passphrase (set by whoever deploys it).
- The local proxy listens on `127.0.0.1` only. Its dashboard rejects requests whose Host
  is not local, and every change (settings, push) requires a token only that dashboard
  page holds — another website cannot re-point your captures.
- Both dashboards load fonts from Google Fonts when online; offline they use system
  fonts.

Settings live in `~/.shrey/config.json`, captures in `~/.shrey/captures`, and the
proxy's log in `~/.shrey/shrey.log`.

---

## Development

```bash
npm install
npm test             # proxy, capture, live feed, CLI, archival, cloud sync, dashboard security
npm run build        # dist/shrey.exe — a single executable with no Node dependency
```

`shrey-web/` is the admin dashboard's own source (separate Next.js project, own README).

MIT licensed.
