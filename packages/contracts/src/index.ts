/**
 * @ucad/contracts — the single cross-plane dependency.
 *
 * Zero implementation, zero vendor types (NFR-04). Every type in the technical
 * design §4 / §6 / §7 is defined here, and the Zod schemas under
 * `events.payloadSchemas` are what Main validates against on admission (SEQ-6).
 */

export * from './common';
export * from './error';
export * from './permission';
export * from './secret';
export * from './context';
export * from './agent';
export * from './intelligence';
export * from './decision';
export * from './session-state';
export * from './usage';
export * from './events';
export * from './host-protocol';
export * from './internal';
export * from './ipc';
