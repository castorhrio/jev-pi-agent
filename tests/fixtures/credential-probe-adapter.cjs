/**
 * A probe adapter for the credential-channel test.
 *
 * It exists because the credential the user saves in Settings lives in Main's
 * OS keychain, and the process that actually talks to the provider is a
 * *forked* child. Nothing in-process can prove that the two are connected —
 * only a real fork can, so this fixture is loaded the same way a real adapter
 * is: `fork()`ed as a CommonJS module by `host-entry`.
 *
 * It does one thing: when a turn runs, it asks the injected
 * `secretResolver` for a credential and reports the answer as the turn's text.
 * The test then reads that text from Main's side of the protocol.
 *
 * Plain CommonJS on purpose — the fork requires this file directly, with no
 * build step in between.
 */

'use strict';

/** The ref the probe asks for. Mirrors a catalogue provider's own secret. */
const REF = { providerId: 'openai', key: 'api-key' };

function createAdapter() {
  // Replaced by the Host at `initialize`. Until then a lookup answers
  // "nothing", so a probe that ran too early would be visible rather than
  // silently reading the environment.
  let secretResolver = async () => null;

  return {
    manifest: {
      id: 'credential-probe',
      displayName: 'Credential probe',
      kind: 'mock',
      isDefaultRuntime: false,
      version: '0.0.1',
      pinned: [],
      transport: 'child_process',
      providerBinding: 'ucad_managed',
      capabilities: {
        streaming: true,
        sessionResume: false,
        modelSelection: false,
        fileTools: false,
        shellTools: false,
        permissionCallbacks: 'none',
        nativeSandbox: false,
        mcp: false,
        skills: false,
        subagents: false,
        usageReporting: 'none',
        injectionModes: ['prompt_prefix'],
        toolContract: 'none',
        contextWindowTokens: 128000,
      },
    },

    async initialize(ctx) {
      secretResolver = ctx.secretResolver;
    },

    async listModels() {
      return [];
    },

    async createSession(input) {
      return {
        ucadSessionId: input.ucadSessionId,
        async *send(turn) {
          const value = await secretResolver(REF);
          yield {
            hostSeq: 1,
            turnId: turn.turnId,
            type: 'text.delta',
            source: { kind: 'agent', agentId: 'credential-probe' },
            payload: {
              text: value === null ? '<no-credential>' : value,
              messageId: 'msg_probe',
            },
            ts: new Date().toISOString(),
          };
        },
        async cancel() {},
        async dispose() {},
      };
    },

    async resumeSession() {
      throw new Error('the probe does not resume');
    },

    async dispose() {},
  };
}

module.exports = { createAdapter };
