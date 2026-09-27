/**
 * Streaming capture for the Anthropic Messages SSE protocol.
 *
 * Two jobs, kept separate on purpose:
 *   1. record the raw stream faithfully (packed, but never re-worded), and
 *   2. assemble the reply the CLI actually received.
 *
 * The raw record outlives the interpretation: if assembly is ever wrong, the packed
 * deltas are still there to re-derive from. Text runs keep their individual pieces
 * because token boundaries are data, not noise.
 */
export class SseCapture {
  constructor({ startedAt = Date.now() } = {}) {
    this.startedAt = startedAt;
    this.buffer = '';
    this.packed = [];
    this.eventCount = 0;
    this.blocks = new Map();
    this.message = null;
    this.stopReason = null;
    this.stopSequence = null;
    this.usage = {};
    this.ttftMs = null;
    this.firstByteMs = null;
    this.completedAt = null;
    this.errors = [];
    this.run = null; // open run of same-kind deltas
  }

  /** Feeds one decoded chunk of the wire stream. */
  feed(text, now = Date.now()) {
    if (this.firstByteMs === null) this.firstByteMs = now - this.startedAt;
    this.buffer += text;

    // SSE frames are separated by a blank line. Keep the trailing partial frame.
    let idx;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.#handleFrame(frame, now);
    }
  }

  /** Flushes any trailing frame the stream ended without a blank line after. */
  end(now = Date.now()) {
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.#handleFrame(rest, now);
    this.completedAt = now;
  }

  #handleFrame(frame, now) {
    let name = null;
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    if (raw === '[DONE]') return;

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.#closeRun();
      this.packed.push({ k: 'raw', name, t: now - this.startedAt, text: raw });
      this.eventCount++;
      return;
    }
    this.eventCount++;
    this.#record(name ?? payload.type, payload, now);
    this.#assemble(name ?? payload.type, payload, now);
  }

  // ------------------------------------------------------------ raw recording

  /**
   * Consecutive deltas on the same block and of the same kind collapse into one row
   * carrying a base timestamp and per-piece gaps. Gaps may be zero or negative - the
   * wall clock can step - and the format says so rather than smoothing it away.
   */
  #record(name, payload, now) {
    const t = now - this.startedAt;
    if (name === 'content_block_delta' && payload.delta) {
      const kind = payload.delta.type;
      const value = deltaValue(payload.delta);
      const run = this.run;
      if (run && run.index === payload.index && run.type === kind) {
        run.dts.push(t - run.tLast);
        run.tLast = t;
        run.vals.push(value);
        return;
      }
      this.#closeRun();
      this.run = { k: 'deltas', index: payload.index, type: kind, t0: t, tLast: t, dts: [], vals: [value] };
      return;
    }
    this.#closeRun();
    this.packed.push({ k: 'event', name, t, data: payload });
  }

  #closeRun() {
    if (!this.run) return;
    const { k, index, type, t0, dts, vals } = this.run;
    this.packed.push({ k, index, type, t0, dts, vals });
    this.run = null;
  }

  // -------------------------------------------------------------- assembly

  #assemble(name, payload, now) {
    switch (name) {
      case 'message_start': {
        const m = payload.message ?? {};
        this.message = {
          id: m.id,
          model: m.model,
          role: m.role ?? 'assistant',
          stopReason: m.stop_reason ?? null
        };
        if (m.usage) Object.assign(this.usage, m.usage);
        break;
      }
      case 'content_block_start': {
        this.blocks.set(payload.index, {
          index: payload.index,
          ...structuredCloneSafe(payload.content_block),
          _text: [],
          _json: []
        });
        break;
      }
      case 'content_block_delta': {
        const block = this.blocks.get(payload.index);
        const d = payload.delta ?? {};
        const value = deltaValue(d);
        if (this.ttftMs === null && typeof value === 'string' && value.length > 0) {
          // The first non-empty token, matching how time-to-first-token is normally read.
          this.ttftMs = now - this.startedAt;
        }
        if (!block) break;
        if (d.type === 'text_delta') block._text.push(d.text ?? '');
        else if (d.type === 'thinking_delta') block._text.push(d.thinking ?? '');
        else if (d.type === 'input_json_delta') block._json.push(d.partial_json ?? '');
        else if (d.type === 'signature_delta') block.signature = (block.signature ?? '') + (d.signature ?? '');
        else if (d.type === 'citations_delta') (block.citations ??= []).push(d.citation);
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks.get(payload.index);
        if (block) finalizeBlock(block);
        break;
      }
      case 'message_delta': {
        if (payload.delta) {
          if (payload.delta.stop_reason !== undefined) this.stopReason = payload.delta.stop_reason;
          if (payload.delta.stop_sequence !== undefined) this.stopSequence = payload.delta.stop_sequence;
        }
        if (payload.usage) Object.assign(this.usage, payload.usage);
        break;
      }
      case 'message_stop': {
        this.completedAt = now;
        break;
      }
      case 'error': {
        this.errors.push(payload.error ?? payload);
        break;
      }
      default:
        // ping and any event type added after this build contribute nothing,
        // which is the correct behaviour for an unrecognised frame.
        break;
    }
  }

  /**
   * A cheap snapshot of the block currently being written, for the live view.
   * Deliberately not the whole message: the dashboard only needs the growing edge.
   */
  partial() {
    const blocks = [...this.blocks.values()].sort((a, b) => a.index - b.index);
    const last = blocks[blocks.length - 1];
    if (!last) return { blocks: 0, type: null, name: null, text: '', ttftMs: this.ttftMs };
    let text = '';
    if (last._text?.length) text = last._text.join('');
    else if (last._json?.length) text = last._json.join('');
    else text = last.text ?? last.thinking ?? '';
    return {
      blocks: blocks.length,
      type: last.type ?? null,
      name: last.name ?? null,
      text,
      ttftMs: this.ttftMs
    };
  }

  /** The assembled reply, in the same shape a non-streaming response would have. */
  result() {
    for (const block of this.blocks.values()) finalizeBlock(block);
    const content = [...this.blocks.values()]
      .sort((a, b) => a.index - b.index)
      .map((b) => {
        const { index, _text, _json, ...rest } = b;
        return rest;
      });
    const completedAt = this.completedAt ?? Date.now();
    return {
      id: this.message?.id ?? null,
      model: this.message?.model ?? null,
      role: this.message?.role ?? 'assistant',
      content,
      stop_reason: this.stopReason,
      stop_sequence: this.stopSequence,
      usage: this.usage,
      timings: {
        firstByteMs: this.firstByteMs,
        ttftMs: this.ttftMs,
        totalMs: completedAt - this.startedAt,
        decodeMs: this.ttftMs === null ? null : completedAt - this.startedAt - this.ttftMs
      },
      sseEvents: this.eventCount,
      errors: this.errors
    };
  }
}

function deltaValue(delta) {
  switch (delta.type) {
    case 'text_delta':
      return delta.text ?? '';
    case 'thinking_delta':
      return delta.thinking ?? '';
    case 'input_json_delta':
      return delta.partial_json ?? '';
    case 'signature_delta':
      return delta.signature ?? '';
    default:
      return delta;
  }
}

function finalizeBlock(block) {
  if (block._text?.length) {
    const joined = block._text.join('');
    if (block.type === 'thinking') block.thinking = joined;
    else block.text = joined;
    block._text = [];
  }
  if (block._json?.length) {
    const joined = block._json.join('');
    try {
      block.input = JSON.parse(joined);
    } catch {
      // Truncated tool arguments are kept verbatim rather than guessed at; a partial
      // JSON string is the honest record of what the model actually emitted.
      block.input = joined;
      block.inputIncomplete = true;
    }
    block._json = [];
  }
}

function structuredCloneSafe(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? {}));
  } catch {
    return {};
  }
}
