/* ccproxy trajectory dashboard - no framework, no build step. */
(() => {
  'use strict';

  const API = './api';
  const $ = (id) => document.getElementById(id);
  // Issued by the server into this page only; every write must carry it.
  const TOKEN = (document.querySelector('meta[name="shrey-token"]') || {}).content || '';

  async function postJson(url, body) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shrey-token': TOKEN },
      body: JSON.stringify(body || {})
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    return { ok: res.ok && data.ok !== false, status: res.status, data };
  }

  const state = {
    sessions: [],
    filter: '',
    ledgerFilter: '',
    selectedSession: null,
    events: [],
    objects: new Map(),
    rows: [],
    visibleRows: [],
    rowNodes: new Map(), // row -> DOM node for the current render, for in-place selection
    seenRowKeys: new Set(), // rows already shown once; only new ones animate in
    animateRows: false,
    selectedRow: null,
    inspectorTab: 'rendered',
    follow: true,
    focus: null, // [startMs, endMs] timeline selection
    domain: null, // [t0, t1] of the rendered timeline
    live: false,
    partials: new Map(), // requestId -> growing block, cleared when the message lands
    pendingObjectIds: new Set()
  };

  // ------------------------------------------------------------ formatting

  const nf = new Intl.NumberFormat('en-US');
  const num = (n) => nf.format(Math.round(Number(n) || 0));

  function compact(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(v >= 1e7 ? 0 : 1) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 0 : 1) + 'k';
    return String(Math.round(v));
  }

  function dur(msValue) {
    if (msValue == null || Number.isNaN(msValue)) return '—';
    if (msValue < 1000) return Math.round(msValue) + 'ms';
    if (msValue < 60000) return (msValue / 1000).toFixed(2) + 's';
    const m = Math.floor(msValue / 60000);
    return m + 'm ' + Math.round((msValue % 60000) / 1000) + 's';
  }

  function clock(ts) {
    const d = new Date(ts);
    return String(d.getHours()).padStart(2, '0') + ':' +
      String(d.getMinutes()).padStart(2, '0') + ':' +
      String(d.getSeconds()).padStart(2, '0') + '.' +
      String(d.getMilliseconds()).padStart(3, '0');
  }

  function ago(ts) {
    const s = (Date.now() - ts) / 1000;
    if (s < 60) return Math.max(0, Math.round(s)) + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    const parts = [];
    for (const b of content) {
      if (typeof b === 'string') parts.push(b);
      else if (b && b.type === 'text') parts.push(b.text || '');
    }
    return parts.join('\n');
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function rowKey(row) {
    return (row.event ? row.event.seq : 'x') + ':' + row.key;
  }

  // --------------------------------------------------------------- fetching

  async function getJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(url + ' -> ' + res.status);
    return res.json();
  }

  async function refreshStatus() {
    try {
      const s = await getJson(API + '/status');
      $('proxy-pill').textContent = s.host + ':' + s.port + ' → ' + s.upstreamHost;
      const a = s.archive || {};
      let label = a.disabled ? 'archive off' : 'local only · set up push';
      let cls = 'dot warn';
      if (a.remote) {
        const repo = (a.web || a.remote).replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
        label = repo + ' · ' + a.pushes + ' pushes' + (a.pendingPush ? ' · queued' : '');
        cls = a.lastError ? 'dot err' : 'dot live';
      }
      if (a.lastError) label += ' · ' + a.lastError.slice(0, 40);
      const pill = $('archive-pill');
      pill.textContent = '';
      pill.append(el('i', cls), document.createTextNode(label));
      pill.title = a.remote ? a.remote + (a.lastError ? '\n' + a.lastError : '') : 'Captures stay local — click to set a GitHub repository';
      state.archive = a;
    } catch {
      /* the dashboard is a viewer; a failed poll is not worth interrupting for */
    }
  }

  async function refreshSessions() {
    try {
      state.sessions = await getJson(API + '/sessions');
      renderSessions();
      if (!state.selectedSession && state.sessions.length) selectSession(state.sessions[0].id);
      if (!state.sessions.length && !document.querySelector('.hero-empty')) renderAll();
    } catch {
      /* ignore */
    }
  }

  async function selectSession(id) {
    if (state.selectedSession === id) return;
    state.selectedSession = id;
    state.selectedRow = null;
    state.focus = null;
    const data = await getJson(API + '/sessions/' + encodeURIComponent(id));
    if (state.selectedSession !== id) return; // a later click won the race
    state.partials.clear();
    state.events = data.events || [];
    state.objects = new Map(Object.entries(data.objects || {}));
    state.seenRowKeys.clear();
    state.animateRows = false; // a freshly opened session appears as one piece
    closeInspector(true);
    renderSessions();
    renderAll();
    state.animateRows = true;
    scrollToBottom();
  }

  async function fetchObjects(ids) {
    const missing = ids.filter((i) => i && !state.objects.has(i) && !state.pendingObjectIds.has(i));
    if (!missing.length) return false;
    for (const i of missing) state.pendingObjectIds.add(i);
    try {
      const data = await getJson(API + '/objects?ids=' + missing.join(','));
      for (const [k, v] of Object.entries(data)) state.objects.set(k, v);
      return true;
    } catch {
      return false;
    } finally {
      for (const i of missing) state.pendingObjectIds.delete(i);
    }
  }

  // ------------------------------------------------------------- projection

  /**
   * Folds the event log into ledger rows. One pass, no lookbehind beyond the
   * current request, so a live append only has to project the new event.
   */
  function project(events) {
    const rows = [];
    const seenMessages = new Set();
    let requestId = null;
    let requestStart = null;
    // Each reply is already shown as the streamed response; the next request then
    // replays it as history under a different object id. Count replies shown and
    // absorb that many assistant messages from history, so each turn appears once.
    let shownReplies = 0;

    const push = (row) => {
      row.key = rows.length;
      row.requestId = requestId;
      rows.push(row);
    };

    for (const ev of events) {
      const d = ev.data || {};
      switch (ev.type) {
        case 'session/start':
          push({ kind: 'separator', sep: 'session', label: 'SESSION', detail: d.sessionId || '', time: ev.time, event: ev });
          break;

        case 'request/context':
          push({
            kind: 'row', tag: 'system', tagClass: 't-system',
            label: d.reason === 'initial' ? 'context' : 'context Δ',
            text: (d.toolNames || []).length + ' tools · system ' + (d.systemId || 'none').slice(0, 10) +
              ((d.toolNames || []).length ? '\n' + d.toolNames.join(', ') : ''),
            time: ev.time, event: ev
          });
          break;

        case 'request/start': {
          requestId = d.requestId;
          requestStart = ev.time;
          push({
            kind: 'separator', sep: 'request', label: d.requestId,
            detail: (d.params && d.params.model ? d.params.model : '') +
              ' · ' + num(d.messageCount) + ' msgs' +
              (d.params && d.params.stream ? ' · stream' : ''),
            time: ev.time, event: ev
          });
          // Only messages this ledger has not shown yet: the API replays the whole
          // history each request, and repeating it would bury the new content.
          for (const ref of d.messageRefs || []) {
            if (seenMessages.has(ref)) continue;
            seenMessages.add(ref);
            const msg = state.objects.get(ref);
            if (msg && msg.role === 'assistant' && shownReplies > 0) {
              shownReplies--;
              continue;
            }
            if (!msg) {
              push({ kind: 'row', tag: 'user', tagClass: 't-user', label: 'message', text: '[loading ' + ref.slice(0, 8) + '…]', time: ev.time, event: ev, ref });
              continue;
            }
            projectMessage(msg, ev, ref, push);
          }
          break;
        }

        case 'response/open':
          if (d.status >= 400) {
            push({ kind: 'row', tag: 'error', tagClass: 't-error', label: 'http ' + d.status, text: d.statusText || '', time: ev.time, event: ev, isError: true });
          }
          break;

        case 'response/message': {
          const t = d.timings || {};
          if ((d.content || []).length) shownReplies++;
          for (const block of d.content || []) {
            if (block.type === 'text') {
              push({ kind: 'row', tag: 'assistant', tagClass: 't-assistant', label: 'text', text: block.text || '', time: ev.time, event: ev, block });
            } else if (block.type === 'thinking') {
              push({ kind: 'row', tag: 'think', tagClass: 't-think', label: 'thinking', text: block.thinking || '', time: ev.time, event: ev, block });
            } else if (block.type === 'tool_use') {
              push({
                kind: 'row', tag: 'tool', tagClass: 't-tool', label: block.name || 'tool',
                text: JSON.stringify(block.input), time: ev.time, event: ev, block, indent: true
              });
            } else {
              push({ kind: 'row', tag: 'assistant', tagClass: 't-assistant', label: block.type || '?', text: JSON.stringify(block).slice(0, 400), time: ev.time, event: ev, block });
            }
          }
          push({
            kind: 'row', tag: 'assistant', tagClass: 't-assistant', label: 'stop',
            text: (d.stopReason || 'null') + ' · ' + dur(t.totalMs) +
              (t.ttftMs != null ? ' (ttft ' + dur(t.ttftMs) + ')' : '') +
              ' · in ' + num((d.usage || {}).input_tokens) + ' out ' + num((d.usage || {}).output_tokens),
            time: ev.time, event: ev, meta: true,
            span: { start: requestStart, total: t.totalMs, ttft: t.ttftMs, requestId: d.requestId, stop: d.stopReason }
          });
          break;
        }

        case 'response/error':
          push({
            kind: 'row', tag: 'error', tagClass: 't-error', label: d.stage || 'error',
            text: d.message || JSON.stringify(d.body || d.errors || {}).slice(0, 600),
            time: ev.time, event: ev, isError: true,
            span: { start: requestStart, total: d.durationMs, ttft: null, requestId: d.requestId, error: true }
          });
          break;

        default:
          break;
      }
    }
    return rows;
  }

  function projectMessage(msg, ev, ref, push) {
    const role = msg.role || 'user';
    const content = msg.content;
    const roleClass = role === 'user' ? 't-user' : 't-assistant';
    if (typeof content === 'string') {
      push({ kind: 'row', tag: role, tagClass: roleClass, label: 'message', text: content, time: ev.time, event: ev, ref, message: msg });
      return;
    }
    for (const block of content || []) {
      if (block.type === 'tool_result') {
        const body = typeof block.content === 'string' ? block.content : textOf(block.content);
        push({
          kind: 'row', tag: 'tool', tagClass: block.is_error ? 't-error' : 't-tool',
          label: block.is_error ? 'result ✗' : 'result',
          text: body, time: ev.time, event: ev, ref, block, message: msg, indent: true
        });
      } else if (block.type === 'text') {
        push({ kind: 'row', tag: role, tagClass: roleClass, label: 'message', text: block.text || '', time: ev.time, event: ev, ref, block, message: msg });
      } else if (block.type === 'tool_use') {
        push({ kind: 'row', tag: 'tool', tagClass: 't-tool', label: block.name || 'tool', text: JSON.stringify(block.input), time: ev.time, event: ev, ref, block, message: msg, indent: true });
      } else if (block.type === 'image') {
        push({ kind: 'row', tag: role, tagClass: roleClass, label: 'image', text: '[' + ((block.source || {}).media_type || 'image') + ']', time: ev.time, event: ev, ref, block, message: msg });
      } else {
        push({ kind: 'row', tag: role, tagClass: roleClass, label: block.type || '?', text: JSON.stringify(block).slice(0, 400), time: ev.time, event: ev, ref, block, message: msg });
      }
    }
  }

  // ---------------------------------------------------------------- sessions

  function renderSessions() {
    const list = $('session-list');
    const drawer = $('drawer-list');
    list.textContent = '';
    drawer.textContent = '';
    const filter = state.filter.toLowerCase();
    const shown = state.sessions.filter((s) =>
      !filter || (s.title || '').toLowerCase().includes(filter) || s.id.includes(filter) || (s.model || '').includes(filter));

    shown.forEach((s, i) => {
      const isSel = s.id === state.selectedSession;
      const isLive = Date.now() - s.updatedAt < 15000;

      const node = el('div', 'session' + (isSel ? ' sel' : ''));
      node.setAttribute('role', 'button');
      node.tabIndex = 0;
      node.append(el('div', 'title', s.title || '(untitled)'));
      const meta = el('div', 'meta');
      if (isLive) {
        const flag = el('span', 'live-flag');
        flag.append(el('i', 'dot live'), document.createTextNode('live'));
        meta.append(flag);
      } else {
        meta.append(el('span', null, ago(s.updatedAt)));
      }
      if (s.model) meta.append(el('span', 'model', s.model.replace(/^claude-/, '')));
      meta.append(el('span', null, s.requests + ' req'), el('span', null, compact(s.usage.output) + ' out'));
      if (s.errors) meta.append(el('span', 'err', s.errors + ' err'));
      node.append(meta);
      node.onclick = () => selectSession(s.id);
      node.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSession(s.id); } };
      list.append(node);

      const item = el('button', 'drawer-item' + (isSel ? ' sel' : ''));
      item.style.setProperty('--d', String(Math.min(i, 12)));
      item.append(el('span', 't', s.title || '(untitled)'));
      item.append(el('span', 'm', (isLive ? 'live' : ago(s.updatedAt)) + ' · ' + s.requests + ' req · ' + compact(s.usage.output) + ' out'));
      item.onclick = () => { setDrawer(false); selectSession(s.id); };
      drawer.append(item);
    });
    if (!shown.length) {
      list.append(el('div', 'list-empty', state.sessions.length ? 'Nothing matches' : 'Waiting for the first request'));
    }

    $('session-count').textContent = String(state.sessions.length);
    const totals = state.sessions.reduce((a, s) => {
      a.req += s.requests; a.in += s.usage.input; a.out += s.usage.output; a.cache += s.usage.cacheRead; return a;
    }, { req: 0, in: 0, out: 0, cache: 0 });
    $('session-foot').textContent = totals.req + ' requests · ' + compact(totals.in) + ' in · ' +
      compact(totals.out) + ' out · ' + compact(totals.cache) + ' cached';
  }

  function setDrawer(open) {
    $('drawer').classList.toggle('open', open);
    $('drawer').setAttribute('aria-hidden', String(!open));
    $('burger').setAttribute('aria-expanded', String(open));
  }

  // ------------------------------------------------------------------ trace

  function renderAll() {
    state.rows = project(state.events);
    renderHeaderBar();
    renderStats();
    renderTimeline();
    renderLedger();
  }

  function renderHeaderBar() {
    const s = state.sessions.find((x) => x.id === state.selectedSession);
    $('sb-title').textContent = s ? s.title : 'No session selected';
    $('sb-title').title = s ? s.id : '';
    $('sb-eyebrow').textContent = s ? s.id : 'Trajectory';
    $('sb-model').textContent = s ? (s.model || 'unknown') : '—';
    const empty = !state.sessions.length;
    $('bento').hidden = empty;
    $('timeline').hidden = empty;
  }

  /** Session metrics from the log itself, so they are exact for what is loaded. */
  function renderStats() {
    let requests = 0;
    let errors = 0;
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    const ttfts = [];
    for (const ev of state.events) {
      if (ev.type === 'request/start') requests++;
      else if (ev.type === 'response/error') errors++;
      else if (ev.type === 'response/message') {
        const u = ev.data.usage || {};
        input += u.input_tokens || 0;
        output += u.output_tokens || 0;
        cacheRead += u.cache_read_input_tokens || 0;
        cacheWrite += u.cache_creation_input_tokens || 0;
        const t = (ev.data.timings || {}).ttftMs;
        if (typeof t === 'number') ttfts.push(t);
      }
    }
    const prompt = input + cacheRead + cacheWrite;
    const rate = prompt ? cacheRead / prompt : null;

    $('st-cache').textContent = rate == null ? '—' : (rate * 100).toFixed(rate >= 0.995 || rate === 0 ? 0 : 1) + '%';
    $('st-cache-bar').style.transform = 'scaleX(' + (rate || 0) + ')';
    $('st-cache-note').textContent = prompt
      ? compact(cacheRead) + ' read · ' + compact(cacheWrite) + ' written · ' + compact(input) + ' uncached'
      : 'no prompt tokens yet';

    const med = median(ttfts);
    $('st-ttft').textContent = med == null ? '—' : dur(med);
    $('st-ttft-note').textContent = ttfts.length ? 'p90 ' + dur(percentile(ttfts, 90)) + ' · n=' + ttfts.length : 'no streams yet';

    $('st-req').textContent = String(requests || '—');
    $('st-req-note').textContent = errors ? errors + ' errored' : 'no errors';

    $('st-out').textContent = output ? compact(output) : '—';
    $('st-out-note').textContent = requests ? compact(output / requests) + ' / request' : '—';
  }

  function spans() {
    const out = [];
    for (const row of state.rows) {
      if (!row.span || row.span.start == null) continue;
      const total = row.span.total;
      if (total == null) continue;
      out.push({ ...row.span, row, end: row.span.start + total });
    }
    return out;
  }

  /**
   * The time between a tool_use reply landing and the next request leaving is
   * spent in the CLI: running tools. The proxy never sees that work directly,
   * but the gap is exactly its duration, so it gets its own lane.
   */
  function gaps(list) {
    const sorted = [...list].sort((a, b) => a.start - b.start);
    const out = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i];
      const b = sorted[i + 1];
      if (a.stop === 'tool_use' && b.start > a.end) {
        out.push({ start: a.end, end: b.start, total: b.start - a.end, from: a.requestId, to: b.requestId, row: b.row, gap: true });
      }
    }
    return out;
  }

  function renderTimeline() {
    const lanes = $('lanes');
    lanes.textContent = '';
    const list = spans();
    if (!list.length) {
      state.domain = null;
      $('brush').hidden = true;
      $('ax-left').textContent = '—';
      $('ax-right').textContent = '—';
      $('ax-note').textContent = 'no completed requests yet';
      return;
    }
    const t0 = Math.min(...list.map((s) => s.start));
    const t1 = Math.max(...list.map((s) => s.end));
    const width = Math.max(1, t1 - t0);
    state.domain = [t0, t1];
    const pct = (t) => ((t - t0) / width) * 100;
    const inFocus = (s) => !state.focus || (s.end >= state.focus[0] && s.start <= state.focus[1]);

    const reqTrack = lane(lanes, 'model');
    for (const s of list) {
      if (s.error) {
        reqTrack.append(bar('span err', pct(s.start), pct(s.end) - pct(s.start), s, inFocus(s)));
      } else if (s.ttft != null && s.ttft > 0) {
        // Split at the first token so waiting and decoding keep their real ratio.
        const mid = s.start + s.ttft;
        reqTrack.append(bar('span ttft', pct(s.start), pct(mid) - pct(s.start), s, inFocus(s)));
        reqTrack.append(bar('span decode', pct(mid), pct(s.end) - pct(mid), s, inFocus(s)));
      } else {
        reqTrack.append(bar('span whole', pct(s.start), pct(s.end) - pct(s.start), s, inFocus(s)));
      }
    }

    const toolTrack = lane(lanes, 'tool exec');
    for (const g of gaps(list)) {
      toolTrack.append(bar('span gap', pct(g.start), pct(g.end) - pct(g.start), g, inFocus(g)));
    }

    $('ax-left').textContent = clock(t0);
    $('ax-right').textContent = clock(t1) + ' · ' + dur(width);
    $('ax-note').textContent = state.focus ? 'focused ' + dur(state.focus[1] - state.focus[0]) : '';
    placeBrush();
  }

  function lane(parent, label) {
    const row = el('div', 'lane');
    const track = el('div', 'track');
    row.append(el('span', 'label', label), track);
    parent.append(row);
    return track;
  }

  function bar(cls, left, widthPct, s, focused) {
    const node = el('div', cls + (state.selectedRow && state.selectedRow === s.row && !s.gap ? ' sel' : '') + (focused ? '' : ' dim'));
    node.style.left = left + '%';
    node.style.width = Math.max(0.3, widthPct) + '%';
    node.onmousedown = (e) => e.stopPropagation();
    node.onclick = (e) => { e.stopPropagation(); if (s.row) selectRow(s.row, { fromTimeline: true }); };
    node.onmouseenter = (e) => showTip(e, s.gap
      ? [['tool exec', ''], ['after', s.from], ['before', s.to], ['start', clock(s.start)], ['end', clock(s.end)], ['total', dur(s.total)]]
      : [[s.requestId, s.error ? 'error' : (s.stop || '')], ['start', clock(s.start)], ['end', clock(s.end)], ['total', dur(s.total)],
          s.ttft != null ? ['ttft', dur(s.ttft)] : null,
          s.ttft != null ? ['decode', dur(s.total - s.ttft)] : null].filter(Boolean));
    node.onmouseleave = hideTip;
    return node;
  }

  function trackRect() {
    const track = document.querySelector('#lanes .track');
    return track ? track.getBoundingClientRect() : null;
  }

  function placeBrush() {
    const brush = $('brush');
    const rect = trackRect();
    if (!state.focus || !state.domain || !rect) {
      brush.hidden = true;
      return;
    }
    const host = $('timeline').getBoundingClientRect();
    const [t0, t1] = state.domain;
    const x = (t) => rect.left - host.left + ((t - t0) / Math.max(1, t1 - t0)) * rect.width;
    const a = Math.max(rect.left - host.left, x(state.focus[0]));
    const b = Math.min(rect.right - host.left, x(state.focus[1]));
    brush.style.transform = 'translateX(' + a + 'px)';
    brush.style.left = '0';
    brush.style.width = Math.max(2, b - a) + 'px';
    brush.hidden = false;
  }

  // ----------------------------------------------------------------- ledger

  function renderLedger() {
    const inner = $('ledger-inner');
    inner.textContent = '';
    state.rowNodes = new Map();
    state.visibleRows = [];
    const q = state.ledgerFilter.toLowerCase();

    if (!state.sessions.length) {
      inner.append(emptyHero());
      return;
    }

    for (const row of state.rows) {
      if (state.focus && row.time != null && (row.time < state.focus[0] || row.time > state.focus[1])) continue;
      if (q && row.kind === 'row' && !(row.text || '').toLowerCase().includes(q) &&
          !(row.label || '').toLowerCase().includes(q)) continue;

      const key = rowKey(row);
      const isNew = !state.seenRowKeys.has(key);
      state.seenRowKeys.add(key);

      if (row.kind === 'separator') {
        if (q) continue;
        const sep = el('div', 'sep ' + row.sep);
        sep.append(el('span', 'rid', row.label));
        if (row.detail) sep.append(el('span', 'detail', row.detail));
        sep.append(el('span', null, clock(row.time)));
        inner.append(sep);
        continue;
      }

      const node = el('div', 'row' + (row.indent ? ' indent' : '') + (state.selectedRow === row ? ' sel' : '') +
        (isNew && state.animateRows ? ' enter' : ''));
      node.setAttribute('role', 'listitem');
      const kind = el('div', 'kind');
      kind.append(el('span', 'tag ' + row.tagClass, row.tag), el('span', 'label', row.label));
      const body = el('div', 'body' + (row.meta ? ' meta' : '') + (row.isError ? ' error' : ''));
      body.textContent = row.meta || row.isError ? row.text : preview(row.text);
      node.append(kind, body);
      node.onclick = () => selectRow(row);
      inner.append(node);
      state.rowNodes.set(row, node);
      state.visibleRows.push(row);
    }

    // Provisional rows: whatever is streaming right now, not yet in the log.
    if (!q) {
      for (const [requestId, p] of state.partials) {
        const node = el('div', 'row streaming');
        const tagClass = p.type === 'thinking' ? 't-think' : p.type === 'tool_use' ? 't-tool' : 't-assistant';
        const kind = el('div', 'kind');
        kind.append(
          el('span', 'tag ' + tagClass, p.type === 'tool_use' ? 'tool' : p.type === 'thinking' ? 'think' : 'assistant'),
          el('span', 'label', p.name || 'streaming')
        );
        const body = el('div', 'body');
        body.textContent = preview(p.text);
        node.append(kind, body);
        node.title = requestId + ' — streaming';
        inner.append(node);
      }
    }

    if (!state.visibleRows.length && !state.partials.size) {
      inner.append(el('div', 'quiet', q || state.focus ? 'Nothing matches the current filter.' : 'No events yet.'));
    }
    if (state.follow) scrollToBottom();
  }

  function emptyHero() {
    const wrap = el('div', 'hero-empty');
    wrap.append(el('span', 'eyebrow', 'Waiting for traffic'));
    wrap.append(el('h2', null, 'Point Claude Code at the proxy.'));
    wrap.append(el('p', null, 'Every request and response is captured as it streams, then rendered here as a turn-aware trajectory. Start a session with:'));
    const cmd = el('div', 'command');
    const core = el('div', 'command-core');
    core.append(el('code', null, 'ccproxy claude'));
    const btn = ctaButton('Copy', 'copy');
    btn.onclick = () => copyText('ccproxy claude', btn.querySelector('.cta-label'), 'Copied', 'Copy');
    core.append(btn);
    cmd.append(core);
    wrap.append(cmd);
    return wrap;
  }

  function ctaButton(label, icon) {
    const b = el('button', 'cta');
    b.append(el('span', 'cta-label', label));
    const i = el('span', 'cta-icon');
    i.innerHTML = icon === 'copy'
      ? '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="7" rx="1.75" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M3.5 10V4.75c0-.7.55-1.25 1.25-1.25H10" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>'
      : '';
    b.append(i);
    return b;
  }

  function preview(text) {
    const str = String(text == null ? '' : text);
    return str.length > 1200 ? str.slice(0, 1200) + ' …' : str;
  }

  function scrollToBottom() {
    const led = $('ledger');
    led.scrollTop = led.scrollHeight;
  }

  function setFollow(on) {
    state.follow = on;
    $('btn-follow').setAttribute('aria-pressed', String(on));
    if (on) scrollToBottom();
  }

  // -------------------------------------------------------------- inspector

  function selectRow(row, { fromTimeline = false, fromKeyboard = false } = {}) {
    const prev = state.rowNodes.get(state.selectedRow);
    if (prev) prev.classList.remove('sel');
    state.selectedRow = row;
    const node = state.rowNodes.get(row);
    if (node) {
      node.classList.add('sel');
      if (fromTimeline || fromKeyboard) {
        setFollow(false);
        node.scrollIntoView({ block: fromTimeline ? 'center' : 'nearest', behavior: fromTimeline ? 'smooth' : 'auto' });
      }
    }
    openInspector();
    renderInspector();
    // Only the selection outline on the timeline changes; keep the ledger DOM.
    for (const s of document.querySelectorAll('#lanes .span.sel')) s.classList.remove('sel');
    renderTimeline();
  }

  function openInspector() {
    const ins = $('inspector');
    ins.classList.remove('closing');
    if (ins.hidden) {
      ins.hidden = false;
      $('panes').classList.add('with-inspector');
    }
  }

  function closeInspector(instant) {
    const ins = $('inspector');
    const prev = state.rowNodes.get(state.selectedRow);
    if (prev) prev.classList.remove('sel');
    state.selectedRow = null;
    if (ins.hidden) return;
    const done = () => {
      ins.hidden = true;
      ins.classList.remove('closing');
      $('panes').classList.remove('with-inspector');
    };
    if (instant) return done();
    ins.classList.add('closing');
    ins.addEventListener('animationend', done, { once: true });
  }

  function renderInspector() {
    const row = state.selectedRow;
    const content = $('ins-content');
    const tabs = $('ins-tabs');
    content.textContent = '';
    tabs.textContent = '';
    if (!row) return;

    $('ins-eyebrow').textContent = (row.requestId || 'event') + ' · seq ' + (row.event ? row.event.seq : '—');
    $('ins-title').textContent = (row.tag || '') + ' — ' + (row.label || '');
    const available = ['rendered', 'json', 'event'];
    if (row.requestId) available.push('request');
    if (!available.includes(state.inspectorTab)) state.inspectorTab = 'rendered';

    const ind = el('span', 'ind');
    tabs.style.setProperty('--n', String(available.length));
    tabs.style.setProperty('--k', String(available.indexOf(state.inspectorTab)));
    tabs.append(ind);
    available.forEach((name, k) => {
      const b = el('button', null, name);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(state.inspectorTab === name));
      b.onclick = () => {
        state.inspectorTab = name;
        tabs.style.setProperty('--k', String(k));
        for (const other of tabs.querySelectorAll('button')) other.setAttribute('aria-selected', String(other === b));
        renderInspectorBody(row);
      };
      tabs.append(b);
    });
    renderInspectorBody(row);
  }

  function renderInspectorBody(row) {
    const content = $('ins-content');
    content.textContent = '';

    if (state.inspectorTab === 'rendered') {
      content.append(label('facts'));
      const facts = el('dl', 'kv');
      addKv(facts, 'time', clock(row.time));
      addKv(facts, 'request', row.requestId || '—');
      addKv(facts, 'event', row.event ? row.event.type + ' #' + row.event.seq : '—');
      if (row.ref) addKv(facts, 'object', row.ref);
      if (row.block && row.block.id) addKv(facts, 'block id', row.block.id);
      if (row.block && row.block.tool_use_id) addKv(facts, 'tool_use_id', row.block.tool_use_id);
      if (row.block && row.block.name) addKv(facts, 'tool', row.block.name);
      content.append(facts);
      content.append(label('content'));
      let text = String(row.text == null ? '' : row.text);
      if (row.block && row.block.type === 'tool_use') text = JSON.stringify(row.block.input, null, 2);
      content.append(codeBlock(text));
    } else if (state.inspectorTab === 'json') {
      content.append(codeBlock(JSON.stringify(row.block || row.message || (row.event && row.event.data) || {}, null, 2)));
    } else if (state.inspectorTab === 'event') {
      content.append(codeBlock(JSON.stringify(row.event || {}, null, 2)));
    } else if (state.inspectorTab === 'request') {
      renderRequestTab(row, content);
    }
  }

  function renderRequestTab(row, content) {
    const start = state.events.find((e) => e.type === 'request/start' && e.data.requestId === row.requestId);
    const open = state.events.find((e) => e.type === 'response/open' && e.data.requestId === row.requestId);
    const done = state.events.find((e) => e.type === 'response/message' && e.data.requestId === row.requestId);

    if (done) {
      const u = done.data.usage || {};
      const t = done.data.timings || {};
      content.append(label('timing & usage'));
      const facts = el('dl', 'kv');
      addKv(facts, 'stop reason', done.data.stopReason || '—');
      addKv(facts, 'ttft', dur(t.ttftMs));
      addKv(facts, 'decode', dur(t.decodeMs));
      addKv(facts, 'total', dur(t.totalMs));
      addKv(facts, 'input', num(u.input_tokens));
      addKv(facts, 'output', num(u.output_tokens));
      addKv(facts, 'cache read', num(u.cache_read_input_tokens));
      addKv(facts, 'cache write', num(u.cache_creation_input_tokens));
      addKv(facts, 'sse events', num(done.data.sseEvents));
      content.append(facts);
    }
    if (start) {
      const p = start.data.params || {};
      content.append(label('parameters'));
      const facts = el('dl', 'kv');
      addKv(facts, 'model', p.model || '—');
      addKv(facts, 'max_tokens', p.max_tokens == null ? '—' : num(p.max_tokens));
      addKv(facts, 'temperature', p.temperature == null ? '—' : String(p.temperature));
      addKv(facts, 'thinking', p.thinking ? JSON.stringify(p.thinking) : '—');
      addKv(facts, 'stream', String(!!p.stream));
      addKv(facts, 'messages', num(start.data.messageCount));
      addKv(facts, 'body', num(start.data.bodyBytes) + ' bytes');
      addKv(facts, 'betas', p.betas || '—');
      if (open) {
        addKv(facts, 'status', String(open.data.status));
        addKv(facts, 'latency', dur(open.data.latencyMs));
        const rid = (open.data.headers || {})['request-id'] || (open.data.headers || {})['x-request-id'];
        if (rid) addKv(facts, 'request-id', rid);
      }
      content.append(facts);
      content.append(label('request headers'));
      content.append(codeBlock(JSON.stringify(start.data.headers || {}, null, 2)));
      if (start.data.systemId) {
        content.append(label('system prompt'));
        const btn = el('button', 'load-btn', 'Load ' + start.data.systemId.slice(0, 12) + '…');
        btn.onclick = async () => {
          btn.textContent = 'Loading…';
          await fetchObjects([start.data.systemId]);
          const value = state.objects.get(start.data.systemId);
          btn.replaceWith(codeBlock(typeof value === 'string' ? value : JSON.stringify(value, null, 2)));
        };
        content.append(btn);
      }
    }
  }

  function label(text) {
    return el('div', 'section-label', text);
  }

  function codeBlock(text) {
    const wrap = el('div', 'code');
    wrap.append(el('pre', null, text));
    const copy = el('button', 'copy', 'Copy');
    copy.onclick = () => copyText(text, copy, 'Copied', 'Copy');
    wrap.append(copy);
    return wrap;
  }

  async function copyText(text, labelNode, doneText, idleText) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.append(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* nothing further to try */ }
      ta.remove();
    }
    labelNode.textContent = doneText;
    labelNode.classList.add('done');
    setTimeout(() => { labelNode.textContent = idleText; labelNode.classList.remove('done'); }, 1400);
  }

  function addKv(dl, key, value) {
    dl.append(el('dt', null, key), el('dd', null, value));
  }

  // ---------------------------------------------------------------- tooltip

  let tipNode = null;
  function showTip(e, pairs) {
    hideTip();
    tipNode = el('div', 'tooltip');
    const width = Math.max(...pairs.map(([k]) => k.length));
    pairs.forEach(([k, v], i) => {
      if (i === 0) {
        tipNode.append(el('b', null, k), document.createTextNode(v ? '  ' + v : ''));
      } else {
        tipNode.append(document.createTextNode('\n' + k.padEnd(width + 2) + v));
      }
    });
    document.body.append(tipNode);
    const r = e.currentTarget.getBoundingClientRect();
    tipNode.style.left = Math.max(8, Math.min(window.innerWidth - tipNode.offsetWidth - 8, r.left)) + 'px';
    tipNode.style.top = (r.bottom + 8) + 'px';
  }
  function hideTip() {
    if (tipNode) tipNode.remove();
    tipNode = null;
  }

  // ------------------------------------------------------------------- live

  function connectLive() {
    const es = new EventSource(API + '/live');
    es.onopen = () => {
      state.live = true;
      $('live-dot').className = 'dot live';
      $('live-text').textContent = 'live';
    };
    es.onerror = () => {
      state.live = false;
      $('live-dot').className = 'dot err';
      $('live-text').textContent = 'reconnecting';
    };
    es.onmessage = async (msg) => {
      let payload;
      try { payload = JSON.parse(msg.data); } catch { return; }
      if (payload.kind === 'partial') {
        if (payload.sessionId === state.selectedSession) {
          state.partials.set(payload.requestId, payload.partial);
          scheduleRender();
        }
        return;
      }
      if (payload.kind === 'partial-end') {
        if (state.partials.delete(payload.requestId)) scheduleRender();
        return;
      }
      if (payload.kind === 'event') {
        touchSession(payload.summary);
        if (payload.sessionId === state.selectedSession) {
          state.events.push(payload.event);
          const refs = (payload.event.data && payload.event.data.messageRefs) || [];
          if (refs.length) await fetchObjects(refs);
          scheduleRender();
        } else if (!state.selectedSession) {
          selectSession(payload.sessionId);
        }
      }
    };
  }

  function touchSession(summary) {
    if (!summary) return;
    const i = state.sessions.findIndex((s) => s.id === summary.id);
    if (i === -1) state.sessions.unshift(summary);
    else state.sessions[i] = summary;
    state.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    scheduleSessionRender();
  }

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      const selected = state.selectedRow;
      renderAll();
      // Rows are re-projected; carry the selection over by stable key.
      if (selected) {
        const key = rowKey(selected);
        const again = state.rows.find((r) => rowKey(r) === key);
        if (again) {
          state.selectedRow = again;
          const node = state.rowNodes.get(again);
          if (node) node.classList.add('sel');
        }
      }
    });
  }
  let sessionRenderQueued = false;
  function scheduleSessionRender() {
    if (sessionRenderQueued) return;
    sessionRenderQueued = true;
    requestAnimationFrame(() => {
      sessionRenderQueued = false;
      renderSessions();
      renderHeaderBar();
    });
  }

  // ------------------------------------------------------- timeline brushing

  function wireTimeline() {
    const tl = $('timeline');
    const brush = $('brush');
    let drag = null;

    tl.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || !state.domain) return;
      const rect = trackRect();
      if (!rect) return;
      drag = { x0: Math.min(Math.max(e.clientX, rect.left), rect.right), rect, host: tl.getBoundingClientRect(), moved: false };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      const { rect, host } = drag;
      const x1 = Math.min(Math.max(e.clientX, rect.left), rect.right);
      if (Math.abs(x1 - drag.x0) < 4 && !drag.moved) return;
      drag.moved = true;
      const a = Math.min(drag.x0, x1);
      const b = Math.max(drag.x0, x1);
      brush.hidden = false;
      brush.style.left = '0';
      brush.style.transform = 'translateX(' + (a - host.left) + 'px)';
      brush.style.width = Math.max(2, b - a) + 'px';
      const [t0, t1] = state.domain;
      const toTime = (x) => t0 + ((x - rect.left) / rect.width) * (t1 - t0);
      drag.focus = [toTime(a), toTime(b)];
    });
    window.addEventListener('mouseup', () => {
      if (drag && drag.moved && drag.focus) {
        state.focus = drag.focus;
        setFollow(false);
        renderTimeline();
        renderLedger();
      }
      drag = null;
    });
    tl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (!state.focus) return;
      state.focus = null;
      renderTimeline();
      renderLedger();
    });
    window.addEventListener('resize', placeBrush);
  }

  // --------------------------------------------------------------- keyboard

  function moveSelection(delta) {
    const rows = state.visibleRows;
    if (!rows.length) return;
    let i = rows.indexOf(state.selectedRow);
    if (i === -1) i = delta > 0 ? -1 : rows.length;
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + delta))];
    if (next && next !== state.selectedRow) selectRow(next, { fromKeyboard: true });
  }

  function wireKeys() {
    document.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === 'Escape') {
        if (!$('settings').hidden) return closeSettings();
        if ($('drawer').classList.contains('open')) return setDrawer(false);
        if (typing) return e.target.blur();
        if (state.focus) {
          state.focus = null;
          renderTimeline();
          renderLedger();
          return;
        }
        return closeInspector();
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey || !$('settings').hidden) return;
      if (e.key === '/') {
        e.preventDefault();
        $('ledger-filter').focus();
      } else if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault();
        moveSelection(1);
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSelection(-1);
      } else if (e.key === 'f') {
        setFollow(!state.follow);
      }
    });
  }

  // ---------------------------------------------------------------- settings

  function renderArchiveFacts(a) {
    const dl = $('gh-status');
    dl.textContent = '';
    a = a || {};
    addKv(dl, 'pushing to', a.web || a.remote || 'nowhere — local only');
    addKv(dl, 'commits', String(a.commits || 0) + ' this run');
    addKv(dl, 'pushes', String(a.pushes || 0) + ' this run');
    addKv(dl, 'last push', a.lastPushAt ? ago(a.lastPushAt) : 'never');
    if (a.lastError) addKv(dl, 'last error', a.lastError);
    if (state.captureDir) addKv(dl, 'local copy', state.captureDir);
  }

  function setMsg(text, kind) {
    const msg = $('gh-msg');
    msg.textContent = text || '';
    msg.className = 'field-msg' + (kind ? ' ' + kind : '');
  }

  async function openSettings() {
    const modal = $('settings');
    modal.classList.remove('closing');
    modal.hidden = false;
    setMsg('');
    try {
      const s = await getJson(API + '/settings');
      state.captureDir = s.captureDir;
      $('gh-url').value = s.github.remote || '';
      $('gh-auto').hidden = !s.ghAuthenticated || !!s.github.remote;
      if (s.github.disabled) setMsg('This run was started with --no-github, so nothing can be pushed.', 'err');
      renderArchiveFacts(state.archive);
    } catch {
      setMsg('Could not load settings.', 'err');
    }
    setTimeout(() => $('gh-url').focus(), 60);
  }

  function closeSettings() {
    const modal = $('settings');
    if (modal.hidden) return;
    modal.classList.add('closing');
    modal.querySelector('.modal-shell').addEventListener('animationend', () => {
      modal.hidden = true;
      modal.classList.remove('closing');
    }, { once: true });
  }

  function busy(on, label) {
    for (const id of ['gh-save', 'gh-auto', 'gh-off']) $(id).disabled = on;
    $('gh-save').querySelector('.cta-label').textContent = on ? (label || 'Pushing') : 'Save & push';
  }

  async function saveRemote(value) {
    const clearing = value === null;
    if (!clearing && !String(value).trim()) {
      setMsg('Paste a repository URL, e.g. https://github.com/you/claude-traces', 'err');
      return;
    }
    busy(true, clearing ? 'Saving' : 'Pushing');
    setMsg(clearing ? '' : 'Linking the repository and pushing existing captures…');
    try {
      const r = await postJson(API + '/settings', { githubRemote: clearing ? null : String(value).trim() });
      if (!r.ok) {
        setMsg(r.data.error || 'That did not work.', 'err');
      } else if (clearing) {
        $('gh-url').value = '';
        setMsg('Captures now stay on this machine.', 'ok');
      } else {
        $('gh-url').value = r.data.remote || value;
        setMsg(r.data.error
          ? 'Saved, but the first push failed: ' + r.data.error
          : 'Saved. Captures push to ' + r.data.remote + '.', r.data.error ? 'err' : 'ok');
      }
      if (r.data.archive) state.archive = r.data.archive;
      renderArchiveFacts(state.archive);
      refreshStatus();
    } catch {
      setMsg('The proxy did not answer.', 'err');
    } finally {
      busy(false);
    }
  }

  async function autoCreateRemote() {
    busy(true, 'Creating');
    setMsg('Creating a private repository with the GitHub CLI…');
    try {
      const r = await postJson(API + '/settings/auto-create');
      if (!r.ok) {
        setMsg(r.data.error || 'Could not create the repository.', 'err');
      } else {
        $('gh-url').value = r.data.remote;
        $('gh-auto').hidden = true;
        setMsg('Created. Captures push to ' + r.data.remote + '.', 'ok');
      }
      if (r.data.archive) state.archive = r.data.archive;
      renderArchiveFacts(state.archive);
      refreshStatus();
    } catch {
      setMsg('The proxy did not answer.', 'err');
    } finally {
      busy(false);
    }
  }

  // ------------------------------------------------------------------- boot

  function wire() {
    $('session-filter').oninput = (e) => { state.filter = e.target.value; renderSessions(); };
    $('ledger-filter').oninput = (e) => { state.ledgerFilter = e.target.value; renderLedger(); };
    $('ins-close').onclick = () => closeInspector();
    $('burger').onclick = () => setDrawer(!$('drawer').classList.contains('open'));
    $('btn-follow').onclick = () => setFollow(!state.follow);
    $('btn-settings').onclick = openSettings;
    $('archive-pill').onclick = openSettings;
    for (const node of document.querySelectorAll('#settings [data-close]')) node.onclick = closeSettings;
    $('gh-save').onclick = () => saveRemote($('gh-url').value);
    $('gh-url').onkeydown = (e) => { if (e.key === 'Enter') saveRemote($('gh-url').value); };
    $('gh-off').onclick = () => saveRemote(null);
    $('gh-auto').onclick = autoCreateRemote;
    $('btn-flush').onclick = async (e) => {
      const btn = e.currentTarget;
      const lbl = btn.querySelector('.cta-label');
      btn.disabled = true;
      lbl.textContent = 'Pushing';
      try { await postJson(API + '/flush'); } catch { /* reported in the archive chip */ }
      await refreshStatus();
      btn.disabled = false;
      lbl.textContent = 'Push now';
    };
    $('ledger').addEventListener('scroll', () => {
      const led = $('ledger');
      const atBottom = led.scrollHeight - led.scrollTop - led.clientHeight < 40;
      if (!atBottom && state.follow) setFollow(false);
      else if (atBottom && !state.follow && !state.focus && !state.selectedRow) setFollow(true);
    }, { passive: true });
    wireTimeline();
    wireKeys();
  }

  wire();
  refreshStatus();
  refreshSessions();
  connectLive();
  setInterval(refreshStatus, 5000);
  setInterval(refreshSessions, 15000);
})();
