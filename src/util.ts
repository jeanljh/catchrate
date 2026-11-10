
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// for double-quoted attributes
export function escapeAttr(s: unknown): string {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// first non-empty line, ANSI colours stripped
export function firstLine(message: string | undefined | null, max = 300): string | null {
  if (!message) return null;
  const clean = message.replace(/\u001b\[[0-9;]*m/g, '');
  const line = clean.split('\n').find((l) => l.trim()) ?? '';
  return line.length > max ? line.slice(0, max - 3) + '...' : line;
}

export function tail(text = '', lines = 15): string {
  return text.trim().split('\n').slice(-lines).join('\n');
}

export const pct = (s: number | null | undefined): string => (s === null || s === undefined ? 'n/a' : `${Math.round(s * 100)}%`);

// title path minus the file name, e.g. "Cart › shows totals"
export const testTitle = (t: { titlePath: readonly string[] }): string => t.titlePath.slice(1).join(' › ');
