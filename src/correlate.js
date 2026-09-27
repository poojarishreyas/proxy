import { contentId } from './redact.js';

/**
 * Request -> session correlation.
 *
 * The wire carries no session identifier, so the conversation has to be recovered from
 * the traffic itself. Every Messages request replays the whole history, so successive
 * requests of one session share a growing prefix: content-address each message and a
 * request belongs to the session that already holds those messages.
 *
 * Deliberately: a request whose history overlaps nothing known starts a new session.
 * That means a compaction (which replaces the history wholesale) reads as a new
 * session rather than being force-joined to the old one - the honest reading, since
 * from the API's point of view it is a different conversation.
 */

const SESSION_HEADERS = [
  'x-session-id',
  'x-claude-session-id',
  'x-conversation-id',
  'anthropic-session-id'
];

/** Content addresses for each message in a request, in order. */
export function messageIds(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => contentId(JSON.stringify(m)));
}

export function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (typeof block === 'string') parts.push(block);
    else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n');
}

/** A short, human-meaningful session title taken from the opening user message. */
export function deriveTitle(messages) {
  for (const m of messages ?? []) {
    if (m?.role !== 'user') continue;
    let text = extractText(m.content)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) continue;
    if (text.length > 120) text = text.slice(0, 117) + '...';
    return text;
  }
  return '(no user message)';
}

/**
 * Picks the session a request belongs to.
 * Returns { sessionId, isNew, ids, newIds, title, matchScore }.
 */
export function correlate({ headers, body, store, now = Date.now() }) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const ids = messageIds(messages);
  const title = deriveTitle(messages);

  // An explicit identifier, if a future client ever sends one, always wins.
  for (const header of SESSION_HEADERS) {
    const value = headers[header];
    if (value) {
      const sessionId = 'h-' + contentId(String(value)).slice(0, 12);
      return finish(store, sessionId, ids, title, now, Infinity);
    }
  }

  if (!ids.length) {
    // No history to correlate on: park it in a per-day bucket rather than inventing
    // a session that can never accumulate anything.
    const day = new Date(now).toISOString().slice(0, 10);
    return finish(store, 'misc-' + day, ids, 'Ancillary requests', now, 0);
  }

  const firstId = ids[0];
  let best = null;
  // Only recent sessions are candidates. An archive of thousands would otherwise make
  // every request scan the lot, and a conversation older than this is not being
  // continued in a live CLI anyway.
  const candidates = [...store.sessions.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 200);
  for (const session of candidates) {
    if (session.id.startsWith('misc-')) continue;
    let score = 0;
    for (const id of ids) if (session.messageIdSet.has(id)) score++;
    if (!score) continue;
    const firstMatches = session.messageIdSet.has(firstId);
    // One shared message is only convincing when it is the conversation's opener;
    // otherwise require two, so an identical one-line message in two different
    // sessions cannot merge them.
    if (!firstMatches && score < 2) continue;
    const rank = (firstMatches ? 1e9 : 0) + score * 1000 + session.updatedAt / 1e9;
    if (!best || rank > best.rank) best = { session, score, rank };
  }

  if (best) return finish(store, best.session.id, ids, title, now, best.score);

  const sessionId = 's-' + firstId.slice(0, 16);
  return finish(store, sessionId, ids, title, now, 0);
}

function finish(store, sessionId, ids, title, now, matchScore) {
  const existing = store.getSession(sessionId);
  const known = existing?.messageIdSet ?? new Set();
  const newIds = ids.filter((id) => !known.has(id));
  return { sessionId, isNew: !existing, ids, newIds, title, matchScore, now };
}
