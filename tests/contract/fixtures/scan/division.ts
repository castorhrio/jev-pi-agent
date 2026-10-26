/** A slash after a value divides; it does not open a literal. */
export function ratio(a: number, b: number): number {
  const half = a / b; // divide, then comment
  const url = 'https://example.com/a//b';
  const pattern = /\/*/;
  return pattern.test(url) ? half / 2 : 0;
}
