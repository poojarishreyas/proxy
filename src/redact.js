import crypto from 'node:crypto';

/** Headers whose values are credentials. Never written to disk verbatim. */
const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'anthropic-auth-token'
]);

/** Headers that describe the hop, not the call; they would mislead on replay. */
const HOP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer'
]);

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Short, stable content address. Collision-free enough for a capture store. */
export function contentId(input) {
  return sha256(typeof input === 'string' ? input : JSON.stringify(input)).slice(0, 24);
}

/**
 * A credential becomes a stable fingerprint rather than disappearing: you can still
 * tell two sessions apart by which key signed them without the key leaving this machine.
 */
export function fingerprintSecret(value) {
  const str = String(value);
  const digest = sha256(str).slice(0, 12);
  const tail = str.length > 4 ? str.slice(-4) : '';
  return `«redacted:${digest}${tail ? `:…${tail}` : ''}»`;
}

export function redactHeaders(headers, { redact = true } = {}) {
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(headers ?? {})) {
    const key = rawKey.toLowerCase();
    if (HOP_HEADERS.has(key)) continue;
    const value = Array.isArray(rawValue) ? rawValue.join(', ') : String(rawValue ?? '');
    out[key] = redact && SECRET_HEADERS.has(key) ? fingerprintSecret(value) : value;
  }
  return out;
}

/** Identity of the credential in play, so sessions can be grouped per key. */
export function credentialId(headers) {
  const raw = headers['x-api-key'] ?? headers.authorization ?? '';
  if (!raw) return null;
  return sha256(String(raw)).slice(0, 12);
}

const BODY_PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{16,}/g, 'sk-ant-«redacted»'],
  [/gh[pousr]_[A-Za-z0-9]{16,}/g, 'gh_«redacted»'],
  [/AKIA[0-9A-Z]{16}/g, 'AKIA«redacted»'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '«redacted private key»']
];

/**
 * Scrubs credential shapes from captured text. This is a safety net for material that
 * reaches a remote repository, not a claim of complete secret detection.
 */
export function scrubText(text, { redact = true } = {}) {
  if (!redact || typeof text !== 'string') return text;
  let out = text;
  for (const [pattern, replacement] of BODY_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

export function scrubDeep(value, opts = {}) {
  if (!opts.redact) return value;
  if (typeof value === 'string') return scrubText(value, opts);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, opts);
    return out;
  }
  return value;
}
