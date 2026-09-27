# shrey

Run Claude Code with every request and response captured — viewable live as a
trajectory, and pushed to your own GitHub repository.

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
                      └──▶  live trajectory dashboard
```

Requirements: Node 20+, [Claude Code](https://docs.anthropic.com/en/docs/claude-code),
and git. The [GitHub CLI](https://cli.github.com) is optional — with it, shrey can create
the repository for you.

---

## First run

The first time you run `shrey` it asks where captures should go:

```
  Where should captures go?
    paste a GitHub repo URL    e.g. https://github.com/you/claude-traces
    press Enter                create a private repo "claude-code-trajectories" for you
    type local                 keep them on this machine only
```

Nothing is pushed anywhere until you answer. Change it any time:

```bash
shrey github https://github.com/you/claude-traces   # push here (created private if missing)
shrey github you/claude-traces                      # short form works too
shrey github off                                    # stop pushing, keep capturing locally
shrey github                                        # show the current setting
```

…or from **Settings** in the dashboard.

> Captures contain your prompts, your code and tool output. API keys are redacted,
> but **use a private repository.** Point shrey at an empty repo.

## Everyday use

| you type | what happens |
| --- | --- |
| `shrey` | Claude Code opens here; everything is captured |
| `shrey --resume` | any Claude Code argument passes straight through |
| `shrey -p "explain this repo"` | including non-interactive prompts |
| `shrey dashboard` | open the live trajectory view of a running shrey |
| `shrey status` | settings, session count, token totals, running instances |
| `shrey push` | commit and push now instead of waiting |
| `shrey serve` | proxy and dashboard only, for other tools to point at |
| `shrey setup` | answer the first-run question again |

shrey's own options, for one run: `--no-push` (capture and commit, don't push),
`--no-github` (no git at all), `--open` (open the dashboard), `--port <n>`,
`--upstream <url>`, `--dir <path>`, `--raw` (also keep verbatim JSON). Anything else is
Claude Code's. Put `--` first to hand everything to Claude Code: `shrey -- --help`.

**Several terminals at once** are fine — each `shrey` gets its own proxy port, and they
share one capture folder and one repository. **Ctrl+C** behaves exactly as in Claude
Code (interrupts a response); captures are saved and pushed when Claude Code exits.
If you already route Claude Code through a gateway with `ANTHROPIC_BASE_URL`, shrey
captures in front of it rather than bypassing it.

---

## The dashboard

Printed on launch (`http://127.0.0.1:8787/_ccproxy/` unless that port is taken).

- **Sessions** — every conversation, newest first, from all terminals.
- **Metrics** — cache hit rate, median/p90 time to first token, requests, output.
- **Timeline** — each model call split into waiting and generating; a second lane
  shows time spent running tools between calls. Drag to focus, right-click to clear.
- **Ledger** — the conversation as a turn-aware event list, each message once, tool
  calls nested under the turn that made them, the live reply streaming in.
- **Inspector** — any row's content, raw JSON, the underlying event, and the request:
  parameters, headers, usage, timings, the system prompt on demand.
- **Settings** — set or change the GitHub repository.

Keys: `j`/`k` move, `/` search, `f` follow, `Esc` close.

---

## What's in the repository

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
  written. Known key shapes (`sk-ant-`, `ghp_`, AWS keys, private key blocks) are
  scrubbed from bodies too. This is a safety net, not a guarantee.
- The proxy listens on `127.0.0.1` only. The dashboard rejects requests whose Host is
  not local, and every change (settings, push) requires a token only the dashboard page
  holds — another website cannot re-point your captures.
- The dashboard loads its fonts from Google Fonts when online; offline it uses system
  fonts.

Settings live in `~/.shrey/config.json`, captures in `~/.shrey/captures`, and the
proxy's log in `~/.shrey/shrey.log`.

---

## Development

```bash
npm install
npm test             # proxy, capture, live feed, CLI, archival, dashboard security
npm run build        # dist/shrey.exe — a single executable with no Node dependency
```

MIT licensed.
