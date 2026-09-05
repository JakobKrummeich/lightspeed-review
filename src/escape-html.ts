/** Ampersand first: escaping it after the others would double-escape them. */
const REPLACEMENTS: [RegExp, string][] = [
  [/&/g, "&amp;"],
  [/</g, "&lt;"],
  [/>/g, "&gt;"],
  [/"/g, "&quot;"],
  [/'/g, "&#39;"],
];

/** Everything interpolated into a page is escaped: diff content is attacker-controlled. */
export function escapeHtml(value: string): string {
  let escaped = value;
  for (const [pattern, replacement] of REPLACEMENTS) {
    escaped = escaped.replace(pattern, replacement);
  }
  return escaped;
}
