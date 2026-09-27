import { once } from 'node:events';
import { redactHeaders, credentialId, contentId } from './redact.js';
import { correlate } from './correlate.js';
import { SseCapture } from './sse.js';

const MESSAGES_PATH = /^\/v1\/messages\/?$/;

/**
 * The forwarding hop.
 *
 * Everything the CLI sends is relayed byte-for-byte upstream and everything upstream
 * returns is relayed back unchanged; capture is a tee, never a transform. If the
 * capture side throws, the proxied call still completes - observation must not be able
 * to break the thing being observed.
 */
export function createForwarder({ cfg, store, onActivity = () => {} }) {
  return async function forward(req, res) {
    const startedAt = Date.now();
    const url = new URL(req.url, 'http://placeholder');
    const target = cfg.upstream + url.pathname + url.search;

    let bodyBuf;
    try {
      bodyBuf = await readBody(req);
    } catch (err) {
      return fail(res, 400, 'request_body_error', err.message);
    }

    const upstreamHeaders = buildUpstreamHeaders(req.headers);
    const controller = new AbortController();
    // A client that hangs up should not leave an orphaned upstream stream billing away.
    const abort = () => controller.abort();
    res.on('close', () => {
      if (!res.writableEnded) abort();
    });

    // ---- capture: request side -------------------------------------------
    let ctx = null;
    try {
      ctx = openCapture({ cfg, store, req, url, bodyBuf, startedAt });
    } catch (err) {
      console.error('[shrey] request capture failed: ' + err.message);
    }

    // ---- forward ----------------------------------------------------------
    let upstream;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers: upstreamHeaders,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuf,
        signal: controller.signal,
        redirect: 'manual'
      });
    } catch (err) {
      if (ctx) {
        safely(() => {
          store.append(ctx.sessionId, 'response/error', {
            requestId: ctx.requestId,
            stage: 'connect',
            message: String(err?.message ?? err),
            durationMs: Date.now() - startedAt
          });
          const s = store.getSession(ctx.sessionId);
          if (s) s.errors++;
          finishCapture({ store, ctx, onActivity });
        });
      }
      if (controller.signal.aborted) return;
      return fail(res, 502, 'upstream_unreachable', String(err?.message ?? err));
    }

    const responseHeaders = copyDownstreamHeaders(upstream.headers);
    const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');

    if (ctx) {
      safely(() =>
        store.append(ctx.sessionId, 'response/open', {
          requestId: ctx.requestId,
          status: upstream.status,
          statusText: upstream.statusText,
          stream: isStream,
          headers: pickResponseHeaders(upstream.headers),
          latencyMs: Date.now() - startedAt
        })
      );
    }

    res.writeHead(upstream.status, responseHeaders);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    if (!upstream.body) {
      res.end();
      if (ctx) safely(() => finishCapture({ store, ctx, onActivity }));
      return;
    }

    if (isStream) {
      await pipeStream({ upstream, res, ctx, store, startedAt, onActivity, controller });
    } else {
      await pipeBuffered({ upstream, res, ctx, store, startedAt, onActivity });
    }
  };
}

// --------------------------------------------------------------------- streaming

async function pipeStream({ upstream, res, ctx, store, startedAt, onActivity, controller }) {
  const capture = new SseCapture({ startedAt });
  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  let flushTimer = null;

  // The dashboard follows live, but a frame per token would be pointless work.
  // Leading edge fires at once so a short reply still shows up streaming; the rest
  // is throttled.
  const CADENCE_MS = 120;
  let lastPublish = 0;
  const emit = () => {
    lastPublish = Date.now();
    onActivity({ kind: 'partial', sessionId: ctx.sessionId, requestId: ctx.requestId, capture });
  };
  const publish = () => {
    if (!ctx) return;
    const elapsed = Date.now() - lastPublish;
    if (elapsed >= CADENCE_MS) return emit();
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      emit();
    }, CADENCE_MS - elapsed);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // Relay first: the CLI must never wait on capture work.
      if (!res.write(Buffer.from(value))) await once(res, 'drain');
      safely(() => {
        capture.feed(decoder.decode(value, { stream: true }));
        publish();
      });
    }
    res.end();
  } catch (err) {
    if (!controller.signal.aborted) {
      safely(() => {
        if (ctx) {
          store.append(ctx.sessionId, 'response/error', {
            requestId: ctx.requestId,
            stage: 'stream',
            message: String(err?.message ?? err),
            durationMs: Date.now() - startedAt
          });
        }
      });
    }
    if (!res.writableEnded) res.end();
  } finally {
    if (flushTimer) clearTimeout(flushTimer);
    safely(() => {
      capture.end();
      if (ctx) recordAssembled({ store, ctx, capture, startedAt });
      if (ctx) finishCapture({ store, ctx, onActivity });
    });
  }
}

async function pipeBuffered({ upstream, res, ctx, store, startedAt, onActivity }) {
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
  if (!ctx) return;
  safely(() => {
    const text = buf.toString('utf8');
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (upstream.ok && payload) {
      store.append(ctx.sessionId, 'response/message', {
        requestId: ctx.requestId,
        stream: false,
        messageId: payload.id ?? null,
        model: payload.model ?? null,
        content: payload.content ?? null,
        stopReason: payload.stop_reason ?? null,
        usage: payload.usage ?? {},
        timings: { totalMs: Date.now() - startedAt, ttftMs: null, decodeMs: null }
      });
      store.addUsage(ctx.sessionId, payload.usage);
      store.writeRaw(ctx.sessionId, ctx.requestId + '.response.json', payload);
    } else if (!upstream.ok) {
      store.append(ctx.sessionId, 'response/error', {
        requestId: ctx.requestId,
        stage: 'http',
        status: upstream.status,
        body: payload ?? text.slice(0, 20000),
        durationMs: Date.now() - startedAt
      });
      const s = store.getSession(ctx.sessionId);
      if (s) s.errors++;
    }
    finishCapture({ store, ctx, onActivity });
  });
}

function recordAssembled({ store, ctx, capture, startedAt }) {
  if (capture.packed.length) {
    store.append(ctx.sessionId, 'response/chunks', {
      requestId: ctx.requestId,
      count: capture.eventCount,
      rows: capture.packed
    });
  }
  const result = capture.result();
  if (result.errors.length) {
    store.append(ctx.sessionId, 'response/error', {
      requestId: ctx.requestId,
      stage: 'sse',
      errors: result.errors,
      durationMs: Date.now() - startedAt
    });
    const s = store.getSession(ctx.sessionId);
    if (s) s.errors++;
  }
  store.append(ctx.sessionId, 'response/message', {
    requestId: ctx.requestId,
    stream: true,
    messageId: result.id,
    model: result.model,
    content: result.content,
    stopReason: result.stop_reason,
    usage: result.usage,
    timings: result.timings,
    sseEvents: result.sseEvents
  });
  store.addUsage(ctx.sessionId, result.usage);
  store.writeRaw(ctx.sessionId, ctx.requestId + '.response.json', result);
}

// ---------------------------------------------------------------- request capture

function openCapture({ cfg, store, req, url, bodyBuf, startedAt }) {
  const isJson = (req.headers['content-type'] ?? '').includes('json');
  let body = null;
  if (isJson && bodyBuf.length) {
    try {
      body = JSON.parse(bodyBuf.toString('utf8'));
    } catch {
      body = null;
    }
  }

  const match = correlate({ headers: req.headers, body, store, now: startedAt });
  let session = store.getSession(match.sessionId);
  if (!session) {
    session = store.openSession({
      id: match.sessionId,
      title: match.title,
      startedAt,
      model: body?.model ?? null,
      credential: credentialId(req.headers),
      source: req.headers['user-agent'] ?? 'unknown'
    });
  }
  if (body?.model) session.model = body.model;

  const requestId = 'req-' + String(session.requests + 1).padStart(4, '0');
  session.requests++;

  // The system prompt and tool catalogue are large and near-constant. They are stored
  // content-addressed and only announced when the effective value actually changes,
  // so a hundred-request session records them once.
  const redactOpts = { redact: cfg.capture.redactSecrets !== false };
  let systemId = null;
  let toolsId = null;
  if (body) {
    if (cfg.capture.storeSystemPrompt && body.system !== undefined) {
      systemId = store.putObject(body.system, 'system');
    }
    if (Array.isArray(body.tools)) {
      toolsId = store.putObject(body.tools, 'tools');
    }
    if (systemId !== session.lastSystemId || toolsId !== session.lastToolsId) {
      store.append(session.id, 'request/context', {
        requestId,
        systemId,
        toolsId,
        toolNames: Array.isArray(body.tools) ? body.tools.map((t) => t?.name ?? '?') : [],
        previousSystemId: session.lastSystemId ?? null,
        previousToolsId: session.lastToolsId ?? null,
        reason: session.lastSystemId === undefined ? 'initial' : 'change'
      });
      session.lastSystemId = systemId;
      session.lastToolsId = toolsId;
    }
  }

  // Only messages this session has not seen are stored; the rest are already objects.
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const messageRefs = [];
  for (let i = 0; i < messages.length; i++) {
    messageRefs.push(store.putObject(messages[i], 'message'));
  }
  store.noteMessages(session.id, match.ids);

  const params = body
    ? {
        model: body.model ?? null,
        max_tokens: body.max_tokens ?? null,
        temperature: body.temperature ?? null,
        top_p: body.top_p ?? null,
        top_k: body.top_k ?? null,
        stream: body.stream ?? false,
        thinking: body.thinking ?? null,
        tool_choice: body.tool_choice ?? null,
        stop_sequences: body.stop_sequences ?? null,
        metadata: body.metadata ?? null,
        betas: req.headers['anthropic-beta'] ?? null
      }
    : null;

  store.append(session.id, 'request/start', {
    requestId,
    method: req.method,
    path: url.pathname,
    query: url.search || null,
    endpoint: MESSAGES_PATH.test(url.pathname) ? 'messages' : url.pathname,
    headers: redactHeaders(req.headers, redactOpts),
    params,
    messageCount: messages.length,
    messageRefs,
    newMessageRefs: match.newIds,
    systemId,
    toolsId,
    bodyBytes: bodyBuf.length,
    bodyId: body ? null : contentId(bodyBuf.toString('base64')),
    correlation: { matchScore: match.matchScore, isNewSession: match.isNew }
  });

  if (body) store.writeRaw(session.id, requestId + '.request.json', body);

  return { sessionId: session.id, requestId, startedAt };
}

function finishCapture({ store, ctx, onActivity }) {
  store.writeManifest(ctx.sessionId);
  onActivity({ kind: 'settled', sessionId: ctx.sessionId, requestId: ctx.requestId });
}

// ------------------------------------------------------------------- http plumbing

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 256 * 1024 * 1024) {
        reject(new Error('request body exceeds 256MB'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'content-length',
  'accept-encoding'
]);

function buildUpstreamHeaders(headers) {
  const out = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (DROP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    if (v === undefined) continue;
    out.set(k, Array.isArray(v) ? v.join(', ') : String(v));
  }
  // Identity encoding keeps the captured stream readable without a decompression pass.
  out.set('accept-encoding', 'identity');
  return out;
}

const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive'
]);

function copyDownstreamHeaders(headers) {
  const out = {};
  for (const [k, v] of headers.entries()) {
    if (DROP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

const KEEP_RESPONSE_HEADERS = [
  'content-type',
  'request-id',
  'x-request-id',
  'anthropic-organization-id',
  'anthropic-ratelimit-requests-remaining',
  'anthropic-ratelimit-tokens-remaining',
  'anthropic-ratelimit-input-tokens-remaining',
  'anthropic-ratelimit-output-tokens-remaining',
  'retry-after'
];

function pickResponseHeaders(headers) {
  const out = {};
  for (const key of KEEP_RESPONSE_HEADERS) {
    const value = headers.get(key);
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

function fail(res, status, type, message) {
  const payload = JSON.stringify({ type: 'error', error: { type, message: '[shrey] ' + message } });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(payload);
}

function safely(fn) {
  try {
    fn();
  } catch (err) {
    console.error('[shrey] capture error: ' + (err?.message ?? err));
  }
}
