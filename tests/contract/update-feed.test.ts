/**
 * Contract: the update feed cannot turn its own fields into a path.
 *
 * The file's own header calls the update feed an RCE surface. The one extra
 * gift it must never receive is an arbitrary file write: an earlier build
 * joined the feed's `version` and the download URL's extension into the staged
 * path, and the version parser stops at the first non-digit — so
 * `1.0.0/../../../Startup` compared as 1.0.0, passed the "newer" gate, and
 * normalized into a write outside the download directory. Staging is now a
 * constant single-slot name, and the version string itself is gated before it
 * is compared or displayed. These tests pin that gate.
 */

import { describe, expect, it } from 'vitest';
import { isSafeVersion } from '../../apps/desktop/src/main/update-service';

describe('update feed fields cannot escape the download directory', () => {
  it('accepts the version shapes a release feed actually emits', () => {
    expect(isSafeVersion('0.2.0')).toBe(true);
    expect(isSafeVersion('1.0.0-beta.1')).toBe(true);
    expect(isSafeVersion('0.1.0+build.42')).toBe(false); // '+' is not part of the vocabulary
  });

  it('refuses versions that smuggle path segments', () => {
    expect(isSafeVersion('1.0.0/../../../Windows/Temp')).toBe(false);
    expect(isSafeVersion('..\\..\\x')).toBe(false);
    expect(isSafeVersion('1.0.0..1')).toBe(false);
    expect(isSafeVersion('')).toBe(false);
  });
});
