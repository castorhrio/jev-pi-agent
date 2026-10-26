/** A `)` that closes a control-flow header is followed by a statement. */
export function keeps(source: string): boolean {
  if (source) /[//]/.test(source); // statement position
  while (source) /[/]/.test(source);
  for (let i = 0; i < 1; i += 1) /[/*]/.test(source);
  return /[/]/.test(source) && source !== '//';
}
