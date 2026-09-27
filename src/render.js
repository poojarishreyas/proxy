import fs from 'node:fs';
import path from 'node:path';
import { extractText } from './correlate.js';

/**
 * Derived, human-readable views of a session log.
 *
 * Nothing here is a source of truth - every file this module writes can be deleted and
 * regenerated from `session.jsonl`. They exist so the GitHub archive is readable in a
 * browser without tooling.
 */

const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');
const ms = (n) => (typeof n === 'number' ? (n >= 1000 ? (n / 1000).toFixed(2) + 's' : n + 'ms') : '-');

function fence(text, lang = '') {
  const body = String(text ?? '');
  // Pick a fence longer than any run of backticks inside, so code samples survive.
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const bar = '`'.repeat(Math.max(3, longest + 1));
  return bar + lang + '\n' + body + '\n' + bar;
}

function clip(text, limit = 4000) {
  const str = String(text ?? '');
  if (str.length <= limit) return str;
  return str.slice(0, limit) + '\n... [' + num(str.length - limit) + ' more characters in session.jsonl]';
}

function renderContentBlocks(blocks, store) {
  const out = [];
  for (const block of blocks ?? []) {
    if (typeof block === 'string') {
      out.push(clip(block));
      continue;
    }
    switch (block?.type) {
      case 'text':
        out.push(clip(block.text));
        break;
      case 'thinking':
        out.push('<details><summary>thinking</summary>\n\n' + fence(clip(block.thinking, 2000)) + '\n\n</details>');
        break;
      case 'tool_use':
        out.push(
          '**-> tool_use** `' + (block.name ?? '?') + '` _(' + (block.id ?? '') + ')_\n\n' +
            fence(clip(JSON.stringify(block.input, null, 2), 2000), 'json')
        );
        break;
      case 'tool_result': {
        const content = typeof block.content === 'string' ? block.content : extractText(block.content);
        out.push(
          '**<- tool_result** _(' + (block.tool_use_id ?? '') + ')_' +
            (block.is_error ? ' **error**' : '') + '\n\n' +
            fence(clip(content, 3000))
        );
        break;
      }
      case 'image':
        out.push('_[image: ' + (block.source?.media_type ?? 'unknown') + ']_');
        break;
      default:
        out.push(fence(clip(JSON.stringify(block, null, 2), 1500), 'json'));
    }
  }
  return out.join('\n\n');
}

function renderMessage(message, store) {
  if (!message) return '_[message unavailable]_';
  const role = String(message.role ?? 'unknown').toUpperCase();
  const body =
    typeof message.content === 'string'
      ? clip(message.content)
      : renderContentBlocks(message.content, store);
  return '#### ' + role + '\n\n' + (body || '_[empty]_');
}

export function renderTranscript(store, sessionId) {
  const session = store.getSession(sessionId);
  if (!session) return '';
  const events = store.readLog(sessionId);
  const lines = [];

  lines.push('# ' + session.title);
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push('| session | `' + session.id + '` |');
  lines.push('| model | `' + (session.model ?? 'unknown') + '` |');
  lines.push('| started | ' + new Date(session.startedAt).toISOString() + ' |');
  lines.push('| requests | ' + session.requests + (session.errors ? ' (' + session.errors + ' errored)' : '') + ' |');
  lines.push(
    '| tokens | in ' + num(session.usage.input) + ' · out ' + num(session.usage.output) +
      ' · cache read ' + num(session.usage.cacheRead) + ' · cache write ' + num(session.usage.cacheCreation) + ' |'
  );
  lines.push('');
  lines.push('> Generated from `session.jsonl`. Delete this file and it regenerates.');
  lines.push('');

  const seen = new Set();
  // A reply is rendered from its response event, then replayed as history by the
  // next request; absorb that replay so each assistant turn is written once.
  let shownReplies = 0;
  for (const event of events) {
    const d = event.data ?? {};
    switch (event.type) {
      case 'request/context': {
        lines.push('---');
        lines.push('');
        lines.push(
          '### Context ' + (d.reason === 'initial' ? 'established' : 'changed') +
            ' — ' + (d.toolNames?.length ?? 0) + ' tools'
        );
        lines.push('');
        if (d.systemId) lines.push('- system prompt: [`' + d.systemId + '`](../../../objects/' + d.systemId.slice(0, 2) + '/' + d.systemId + '.json)');
        if (d.toolsId) lines.push('- tool catalogue: [`' + d.toolsId + '`](../../../objects/' + d.toolsId.slice(0, 2) + '/' + d.toolsId + '.json)');
        if (d.toolNames?.length) lines.push('- tools: ' + d.toolNames.map((n) => '`' + n + '`').join(', '));
        lines.push('');
        break;
      }
      case 'request/start': {
        lines.push('---');
        lines.push('');
        lines.push('## ' + d.requestId + ' — ' + (d.params?.model ?? 'unknown'));
        lines.push('');
        const p = d.params ?? {};
        const bits = [];
        if (p.max_tokens) bits.push('max_tokens ' + num(p.max_tokens));
        if (p.temperature != null) bits.push('temperature ' + p.temperature);
        if (p.thinking?.type === 'enabled') bits.push('thinking ' + num(p.thinking.budget_tokens ?? 0));
        bits.push(p.stream ? 'streaming' : 'buffered');
        bits.push(num(d.messageCount) + ' messages');
        lines.push('_' + bits.join(' · ') + '_');
        lines.push('');
        // Only messages this transcript has not already shown - the API replays the
        // whole history every request, and repeating it would make the file unreadable.
        const refs = d.messageRefs ?? [];
        const fresh = refs.filter((id) => !seen.has(id));
        for (const id of refs) seen.add(id);
        const shown = [];
        for (const id of fresh) {
          const message = store.getObject(id);
          if (message?.role === 'assistant' && shownReplies > 0) {
            shownReplies--;
            continue;
          }
          shown.push(message);
        }
        if (shown.length) {
          for (const message of shown) lines.push(renderMessage(message, store), '');
        } else {
          lines.push('_[no new input since the previous request]_', '');
        }
        break;
      }
      case 'response/message': {
        if ((d.content ?? []).length) shownReplies++;
        const t = d.timings ?? {};
        const u = d.usage ?? {};
        lines.push('#### ASSISTANT');
        lines.push('');
        lines.push(renderContentBlocks(d.content, store) || '_[empty]_');
        lines.push('');
        lines.push(
          '_stop `' + (d.stopReason ?? 'null') + '` · ' + ms(t.totalMs) +
            (t.ttftMs != null ? ' (ttft ' + ms(t.ttftMs) + ')' : '') +
            ' · in ' + num(u.input_tokens) + ' · out ' + num(u.output_tokens) +
            ' · cache r' + num(u.cache_read_input_tokens) + '/w' + num(u.cache_creation_input_tokens) + '_'
        );
        lines.push('');
        break;
      }
      case 'response/error': {
        lines.push('> **Error** (' + d.stage + (d.status ? ' ' + d.status : '') + ') — ' +
          clip(d.message ?? JSON.stringify(d.body ?? d.errors ?? {}), 600));
        lines.push('');
        break;
      }
      default:
        break;
    }
  }
  return lines.join('\n') + '\n';
}

export function writeTranscript(store, sessionId) {
  const text = renderTranscript(store, sessionId);
  if (text) store.writeDerived(sessionId, 'transcript.md', text);
}

export function writeIndex(store) {
  const sessions = store.listSessions();
  const lines = [];
  lines.push('# Session index');
  lines.push('');
  lines.push('_' + sessions.length + ' captured sessions, newest first. Updated ' +
    new Date().toISOString() + '._');
  lines.push('');
  lines.push('| updated | session | model | reqs | in | out | cache read | title |');
  lines.push('| --- | --- | --- | ---: | ---: | ---: | ---: | --- |');
  for (const s of sessions.slice(0, 500)) {
    const dir = 'sessions/' + s.day + '/' + s.id;
    const title = String(s.title ?? '').replace(/\|/g, '\\|').slice(0, 90);
    lines.push(
      '| ' + new Date(s.updatedAt).toISOString().replace('T', ' ').slice(0, 16) +
        ' | [`' + s.id + '`](' + dir + '/transcript.md) | ' + (s.model ?? '-') +
        ' | ' + s.requests + ' | ' + num(s.usage.input) + ' | ' + num(s.usage.output) +
        ' | ' + num(s.usage.cacheRead) + ' | ' + title + ' |'
    );
  }
  lines.push('');
  const totals = sessions.reduce(
    (acc, s) => {
      acc.requests += s.requests;
      acc.input += s.usage.input;
      acc.output += s.usage.output;
      acc.cacheRead += s.usage.cacheRead;
      return acc;
    },
    { requests: 0, input: 0, output: 0, cacheRead: 0 }
  );
  lines.push('**Totals** — ' + num(totals.requests) + ' requests · ' + num(totals.input) +
    ' input · ' + num(totals.output) + ' output · ' + num(totals.cacheRead) + ' cache read');
  lines.push('');
  const file = path.join(store.root, 'INDEX.md');
  fs.writeFileSync(file, lines.join('\n'));
  store.dirty.add(file);
}
