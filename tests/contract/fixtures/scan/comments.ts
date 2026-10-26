/** A doc block that must be blanked, newlines included. */
export function tricky(value: number): number {
  // A line comment with a URL https://example.com — the slashes are prose.
  const text = 'not // a comment';
  const template = `text // not a comment ${value /* inline */ + 1}`;
  const pattern = /[//]/;
  return pattern.test(text) ? value / 2 : template.length;
}
