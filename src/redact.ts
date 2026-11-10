// Masks secrets before recordings hit the disk or an LLM prompt.

export const REDACTED = '[REDACTED]';

// matched anywhere in the normalised key
const SECRET_FRAGMENTS = ['password', 'passwd', 'passphrase', 'secret', 'token', 'apikey', 'authorization', 'cookie', 'jwt', 'bearer', 'credential', 'privatekey', 'signature'];
// too short to match as fragments, so whole key only
const SECRET_EXACT = ['auth', 'sid', 'sessionid', 'otp', 'pin', 'cvv', 'cvc', 'ssn', 'iban', 'cardnumber', 'pan'];

// credential-shaped values, whatever key they're under
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{8,}=*/g, // Authorization header value
  /\bsk-[A-Za-z0-9_-]{16,}\b/g, // OpenAI / Anthropic style API keys
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
];

const normaliseKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '');

/** extraKeys: names from --redact-keys */
export function isSecretKey(key: string, extraKeys: readonly string[] = []): boolean {
  const k = normaliseKey(key);
  if (!k) return false;
  if (extraKeys.some((x) => normaliseKey(x) === k)) return true;
  return SECRET_EXACT.includes(k) || SECRET_FRAGMENTS.some((f) => k.includes(f));
}

export function redactText(text: string): string {
  return SECRET_VALUE_PATTERNS.reduce((t, re) => t.replace(re, REDACTED), text);
}

// Everything under a secret key is masked (all of "credentials": {...}), but the
// structure stays so JSON pointers into the recording still resolve.
export function redactJson(value: unknown, extraKeys: readonly string[] = [], underSecret = false): unknown {
  if (Array.isArray(value)) return value.map((v) => redactJson(v, extraKeys, underSecret));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactJson(v, extraKeys, underSecret || isSecretKey(k, extraKeys));
    return out;
  }
  if (underSecret && value !== null) return REDACTED;
  return typeof value === 'string' ? redactText(value) : value;
}

// JSON gets key-aware redaction, anything else just the value patterns
export function redactBody(body: string, extraKeys: readonly string[] = []): string {
  try {
    return JSON.stringify(redactJson(JSON.parse(body), extraKeys));
  } catch {
    return redactText(body);
  }
}

// tokens love query strings
export function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}
