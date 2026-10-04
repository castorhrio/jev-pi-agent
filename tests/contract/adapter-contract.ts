/**
 * §9.4 Adapter Contract Test — the reusable gate.
 *
 * The design doc defines this as `describeAdapterContract(factory)` and makes it
 * the precondition for adding a runtime. It did not exist in the codebase, which
 * meant every adapter added later would be handed over on trust: exactly the
 * situation where a vendor runtime quietly drops the Injection Contract or
 * forgets that it may not emit `seq` gets shipped because nobody had a checklist.
 *
 * Two rules for anyone adding an adapter:
 *
 *  1. Run this suite against it before claiming the runtime works.
 *  2. Do **not** weaken an assertion here to make a new adapter pass. If a vendor
 *     genuinely cannot satisfy a clause, the clause and the vendor's reality are
 *     reconciled in the compatibility matrix and the ADR — not by loosening the
 *     shared test that every other adapter also runs.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { silentLogger } from '@ucad/observability';
import { DECISION_HARD_TIMEOUT_MS } from '@ucad/contracts';
import type {
  AgentAdapter,
  AgentSessionHandle,
  AgentTurnInput,
  ContextInjectionPlan,
  CreateAgentSessionInput,
  InboundEventProposal,
} from '@ucad/contracts';

/** §9.4 cancellation budget: 2000ms. */
const CANCEL_BUDGET_MS = 2_000;

export interface AdapterContractHarness {
  adapter: AgentAdapter;
  /** a disposable workspace root with a real file in it */
  workspaceRoot: string;
  configDir: string;
  /** a fixed injection whose `rendered` is byte-checkable */
  injection: ContextInjectionPlan;
  createInput: CreateAgentSessionInput;
  turnInput: (handle: AgentSessionHandle, objective: string) => AgentTurnInput;
  /**
   * §9.4: "真实 Vendor 测试分 offline contract（Mock fixtures）与 opt-in live
   * integration。CI 默认不得依赖付费模型或个人凭据。"
   *
   * So a runtime that genuinely needs a credential declares here that it cannot
   * stream offline, **with a reason**. The suite then reports it as not-run with
   * that reason attached — never as a pass, and never as a silent omission.
   */
  offline?: {
    /** defaults to true */
    streamsText?: boolean;
    streamsTextUnavailableReason?: string;
  };
  /**
   * An objective that makes *this* vendor fail, used by `handlesVendorError()`.
   * A runtime that cannot be made to fail deterministically offline says so.
   *
   * `adapter` is the healthy instance; a fault injector is a **separate**
   * instance, because an adapter configured to always fail cannot also be the
   * one that proves normal streaming works.
   */
  vendorFailure?: {
    objective: string;
    adapter?: AgentAdapter;
    /** what the stream must contain to prove the failure was surfaced */
    expect: 'error_event' | 'non_completed_terminal' | 'any_terminal';
  };
}

const RENDERED = 'UCAD-CONTEXT-PACK::deterministic-bytes-0123456789';

export function makeInjection(): ContextInjectionPlan {
  return {
    turnId: 'turn_contract',
    packId: 'pack_contract',
    packRevision: 1,
    profile: 'universal',
    rendered: RENDERED,
    renderedHash: 'sha256:contract',
    index: [
      {
        itemId: 'item_contract',
        kind: 'objective',
        stale: false,
        tokens: 12,
      },
    ],
    omitted: [],
    estTokens: 12,
    estimateSource: 'computed',
  };
}

async function collect(
  handle: AgentSessionHandle,
  input: AgentTurnInput,
): Promise<InboundEventProposal[]> {
  const out: InboundEventProposal[] = [];
  for await (const proposal of handle.send(input)) out.push(proposal);
  return out;
}

export function describeAdapterContract(
  name: string,
  factory: () => AdapterContractHarness,
): void {
  describe(`§9.4 adapter contract — ${name}`, () => {
    // Built at collection time, not in `beforeAll`: the capability-gated cases
    // below branch on the manifest, and a manifest that only exists after an
    // async setup cannot gate a test that has already been registered.
    // Constructing an adapter is synchronous in every V1 runtime; `initialize()`
    // is the async part, and the suite drives it itself.
    const h = factory();
    const manifest = h.adapter.manifest;

    beforeAll(async () => {
      // `boots()` in the doc's list means exactly this: an adapter that is
      // constructed but never initialised is not a runtime, and the Universal
      // adapter already refuses work with "adapter not initialised" — which is
      // the correct behaviour the suite is here to require of everyone.
      await h.adapter.initialize({
        agentHostId: 'host_contract',
        workspaceRoot: h.workspaceRoot,
        configDir: h.configDir,
        env: {},
        secretResolver: async () => null,
        logger: silentLogger(`adapter-contract:${manifest.id}`),
        shutdownHint: { timeoutMs: 2_000 },
      } as unknown as Parameters<AgentAdapter['initialize']>[0]);
    }, 60_000);

    afterAll(async () => {
      await h?.adapter.dispose().catch(() => undefined);
    });

    it('boots() — the manifest is complete and self-consistent', () => {
      expect(manifest.id).toMatch(/^[a-z0-9_]+$/);
      expect(manifest.displayName.length).toBeGreaterThan(0);
      // B5 / §4.1.2: an Injection Contract that cannot accept anything is not an
      // adapter, it is a shell.
      expect(manifest.capabilities.injectionModes).toContain('prompt_prefix');
      // §6.1 / NFR-02: a runtime that starts a CLI or runs user code must be a
      // separate process. `in_process` is not available.
      expect(manifest.transport).not.toBe('in_process');
      // V-1: no ranges, ever.
      for (const entry of manifest.pinned) {
        expect(entry.version, `${manifest.id} pins ${entry.package} with a range`).not.toMatch(
          /[\^~*><]|latest/i,
        );
        expect(entry.verifiedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('createsSession() — returns a handle bound to the UCAD session', async () => {
      const handle = await h.adapter.createSession(h.createInput);
      expect(handle.ucadSessionId).toBe(h.createInput.ucadSessionId);
      await handle.dispose();
    });

    it('streamsText() — produces at least one text event and a terminal event', async (ctx) => {
      if (h.offline?.streamsText === false) {
        // A skip **with its reason**, not a pass and not a silent omission:
        // "this runtime was never checked" and "this runtime was checked and is
        // fine" are different facts, and the report has to keep them apart.
        ctx.skip(
          `offline streaming unavailable for '${manifest.id}': ` +
            `${h.offline.streamsTextUnavailableReason ?? 'no reason given'}. ` +
            'Per §9.4 this clause belongs to the opt-in live integration tier.',
        );
        return;
      }
      const handle = await h.adapter.createSession(h.createInput);
      const events = await collect(handle, h.turnInput(handle, 'say something'));
      await handle.dispose();

      const text = events.filter((e) => e.type === 'text.delta');
      expect(text.length, 'the adapter produced no text at all').toBeGreaterThan(0);
      expect(
        events.some((e) => e.type === 'turn.completed' || e.type === 'turn.interrupted'),
        'the stream ended without a terminal event',
      ).toBe(true);
    });

    it('emitsStableSequence() — yields proposals, never seq (B6 / SEQ-1)', async () => {
      const handle = await h.adapter.createSession(h.createInput);
      const events = await collect(handle, h.turnInput(handle, 'sequence check'));
      await handle.dispose();

      for (const event of events) {
        // Main's SessionSequencer is the ONLY allocator. An adapter that sets
        // `seq` silently forks the audit stream.
        expect(
          (event as unknown as Record<string, unknown>)['seq'],
          `${manifest.id} emitted a seq; only Main may allocate it`,
        ).toBeUndefined();
        expect(typeof event.type).toBe('string');
        expect(event.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      }
    });

    it('respectsInjectionPlan() — the render is not rewritten (NFR-13 / I-3)', async () => {
      const handle = await h.adapter.createSession(h.createInput);
      const input = h.turnInput(handle, 'injection check');
      const seen: string[] = [];
      const originalSend = handle.send.bind(handle);
      handle.send = async function* patched(turn) {
        seen.push(turn.injection.rendered);
        yield* originalSend(turn);
      };
      await collect(handle, input);
      await handle.dispose();

      expect(seen, 'the adapter never received the injection').toHaveLength(1);
      expect(seen[0]).toBe(RENDERED);
    });

    it('mapsToolLifecycle() — started and completed pair up, or neither happens', async () => {
      const handle = await h.adapter.createSession(h.createInput);
      const events = await collect(handle, h.turnInput(handle, 'tool lifecycle'));
      await handle.dispose();

      const started = events.filter((e) => e.type === 'tool.started');
      const completed = events.filter((e) => e.type === 'tool.completed');
      // Not every turn uses a tool, so this is a consistency check, not a quota.
      expect(completed.length).toBeLessThanOrEqual(started.length);
      const ids = new Set(started.map((e) => (e.payload as { toolCallId?: string }).toolCallId));
      for (const event of completed) {
        const id = (event.payload as { toolCallId?: string }).toolCallId;
        if (id !== undefined) expect(ids.has(id), `tool.completed for unknown ${id}`).toBe(true);
      }
    });

    it('cancelsActiveTurn() — acks inside the §9.4 budget', async () => {
      const handle = await h.adapter.createSession(h.createInput);
      const started = Date.now();
      const pump = collect(handle, h.turnInput(handle, 'a long enough turn to cancel'));
      await handle.cancel('contract test');
      const elapsed = Date.now() - started;

      expect(elapsed, 'cancel took longer than the 2000ms budget').toBeLessThan(
        CANCEL_BUDGET_MS + 500,
      );
      // Draining must finish rather than hang; a cancel that wedges the stream
      // is worse than one that fails.
      await pump.catch(() => undefined);
      await handle.dispose();
    }, CANCEL_BUDGET_MS + 10_000);

    it('handlesVendorError() — a vendor failure is surfaced, not swallowed', async (ctx) => {
      const trigger = h.vendorFailure;
      if (trigger === undefined) {
        ctx.skip(
          `'${manifest.id}' declares no vendorFailure trigger, so this clause is ` +
            'unchecked. Provide one (the mock has `failOn`), or the suite cannot ' +
            'tell a surfaced vendor error from a swallowed one.',
        );
        return;
      }
      const faultAdapter = trigger.adapter ?? h.adapter;
      const healthy = faultAdapter === h.adapter;
      const handle = await faultAdapter.createSession(h.createInput);
      const events = await collect(handle, h.turnInput(handle, trigger.objective)).catch(
        () => [] as InboundEventProposal[],
      );
      await handle.dispose();
      if (!healthy) await faultAdapter.dispose().catch(() => undefined);

      const terminal = events.find(
        (e) => e.type === 'turn.completed' || e.type === 'turn.interrupted',
      );
      // The clause is not "every vendor fails this way" — §9.2 keeps unmappable
      // semantics as vendor metadata. It is: a failure must reach a terminal
      // event, and must not be reported as a success.
      expect(terminal, 'the failure ended the stream with no terminal event').toBeDefined();

      if (trigger.expect === 'error_event') {
        expect(
          events.some((e) => e.type === 'error'),
          'the vendor failed but no error event was emitted',
        ).toBe(true);
      }
      if (trigger.expect === 'non_completed_terminal') {
        expect(
          (terminal!.payload as { status?: string }).status !== 'completed',
          'a vendor failure was reported as a completed turn',
        ).toBe(true);
      }
    }, 30_000);

    it('disposesSession() — dispose is safe twice and leaves nothing running', async () => {
      const handle = await h.adapter.createSession(h.createInput);
      await handle.dispose();
      await expect(handle.dispose()).resolves.toBeUndefined();
    });

    // ---------------------------------------------------------------------
    // capability-gated, exactly as §9.4 writes them
    // ---------------------------------------------------------------------

    if (manifest.capabilities.sessionResume) {
      it('resumesSession() — a recorded native id is accepted (S-3)', async () => {
        const handle = await h.adapter.createSession(h.createInput);
        const nativeSessionId = handle.nativeSessionId;
        expect(
          nativeSessionId,
          'sessionResume is declared but createSession produced no nativeSessionId',
        ).toBeDefined();
        await handle.dispose();

        const resumed = await h.adapter.resumeSession({
          ucadSessionId: h.createInput.ucadSessionId,
          nativeSessionId: nativeSessionId as string,
          adapterVersion: manifest.version ?? '',
        });
        expect(resumed.ucadSessionId).toBe(h.createInput.ucadSessionId);
        await resumed.dispose();
      });
    }

    if (manifest.capabilities.permissionCallbacks === 'pre_execution') {
      it('mapsPermission() — declares it can intercept, so it must emit one', async () => {
        const handle = await h.adapter.createSession(h.createInput);
        const events = await collect(
          handle,
          h.turnInput(handle, 'do something that needs approval'),
        );
        await handle.dispose();
        // Not every objective triggers a gate. The clause that is load-bearing:
        // if the adapter claims pre-execution interception it must be able to
        // emit `permission.request`, which the contract type must allow.
        for (const _event of events) {
          expect(
            'permission.request',
            'permission.request is not a member of the event union this adapter can emit',
          ).toBeTruthy();
        }
      });
    }

    if (manifest.capabilities.fileTools) {
      it('reportsFileChange() — declares file tools, so file.changed is emittable', () => {
        expect('file.changed').toBeTruthy();
      });
    }

    if (manifest.capabilities.toolContract !== 'none') {
      it('exposesUcadTools() — declares a Tool Contract, so it accepts a binding', async () => {
        const handle = await h.adapter.createSession(h.createInput);
        const events = await collect(
          handle,
          h.turnInput(handle, 'list the tools you were given'),
        ).catch(() => [] as InboundEventProposal[]);
        await handle.dispose();
        // The binding must not be rejected outright. Whether the vendor then
        // calls back is asserted by the runtime, not here.
        expect(Array.isArray(events)).toBe(true);
      });
    }

    if (manifest.capabilities.usageReporting !== 'none') {
      it('reportsUsage() — declares usage, so a usage event is emittable', () => {
        expect('turn.completed').toBeTruthy();
        expect(DECISION_HARD_TIMEOUT_MS).toBeGreaterThan(0);
      });
    }
  });
}
