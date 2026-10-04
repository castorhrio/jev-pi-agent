/**
 * The adapter-loading contract of `host-entry`, as a gate.
 *
 * Round 38 removed `export default createAdapter` from adapter-universal
 * (a duplicate of the named export nothing default-imported), which made the
 * "named factory only" shape the one the real forked host loads — and it
 * turned out no test covered the resolver that accepts these shapes at all.
 * The resolver is the boundary between Main's `require.resolve` choice and
 * every adapter this product will ever load; a regression here surfaces as
 * "adapter module exports no AgentAdapter factory" inside a forked process,
 * minutes away from the code that caused it.
 */

import { describe, expect, it } from 'vitest';
import { resolveAdapterFactory } from '@ucad/agent-host';

const factory = () => ({}) as never;

/** The minimal AgentAdapter shape `isAdapter` accepts. */
const adapterLike = {
  manifest: { id: 'x', displayName: 'x', runtime: 'node', version: '0.0.0' },
  initialize: () => Promise.resolve(),
  createSession: () => Promise.resolve({} as never),
};

describe('resolveAdapterFactory — the adapter loading contract', () => {
  it('accepts each documented factory key, named keys first', () => {
    // The documented shapes (host-entry header): createAdapter,
    // createMockAdapter, a default factory, or an AgentAdapter object.
    expect(resolveAdapterFactory({ createAdapter: factory })).toBe(factory);
    expect(resolveAdapterFactory({ createMockAdapter: factory })).toBe(factory);
    expect(resolveAdapterFactory({ default: factory })).toBe(factory);
  });

  it('accepts a module that exports a factory under both keys without ambiguity', () => {
    // Named wins over default when both exist — the order is what makes
    // round 38's duplicate-export removal unobservable.
    const mod = { createAdapter: factory, default: () => ({}) as never };
    expect(resolveAdapterFactory(mod)).toBe(factory);
  });

  it('accepts an adapter object directly, wrapped as a factory', () => {
    const wrapped = resolveAdapterFactory(adapterLike);
    expect(wrapped).not.toBeNull();
    // The wrapper is synchronous for the object shape (the type allows a
    // promise; the object path has nothing to await).
    expect(wrapped!()).toBe(adapterLike);
  });

  it('rejects what is not an adapter module, by shape', () => {
    expect(resolveAdapterFactory(null)).toBeNull();
    expect(resolveAdapterFactory(undefined)).toBeNull();
    expect(resolveAdapterFactory('a string')).toBeNull();
    expect(resolveAdapterFactory(42)).toBeNull();
    expect(resolveAdapterFactory({})).toBeNull();
    expect(resolveAdapterFactory({ createAdapter: 'not a function' })).toBeNull();
    // Object-shaped but missing the adapter members: an object that merely
    // exists is not an adapter.
    expect(resolveAdapterFactory({ someKey: 'someValue' })).toBeNull();
  });

  it('the shape the real fork loads: named factory, no default', () => {
    // adapter-universal since round 38 exports exactly this shape; the
    // resolver must resolve it through the named key, not fall through.
    const universalLike = { createAdapter: factory };
    expect(resolveAdapterFactory(universalLike)).toBe(factory);
  });
});
