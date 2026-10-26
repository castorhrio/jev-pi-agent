/** Interpolations are code, so their comments are blanked too. */
export const nested = (name: string): string =>
  `outer ${`inner ${name /* deep */}`} tail // text`;

export const objectInInterpolation = (): string => `${ { a: 1, b: '}' } /* after */ }`;

export const escaped = (): string => `a \` b ${'// still text'} c`;
