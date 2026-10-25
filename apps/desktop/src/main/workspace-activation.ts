/**
 * §4.5 / §4.8 — one place where "this is the project we are working on" is
 * turned into the two things that depend on it.
 *
 * ## Why this file exists
 *
 * A workspace is not just a path. Two subsystems are rooted in it:
 *
 *   - **Code intelligence** (§4.8). The Basic provider answers a query by
 *     scanning the workspace it was *initialised* with. A provider that was
 *     initialised for project A answers nothing for project B — it throws
 *     `INTELLIGENCE_UNAVAILABLE` — and the Context Broker treats that as "no
 *     code items", so the pack quietly loses the project's files.
 *   - **Skills** (§4.5). A project's own rules live in `<project>/.ucad/skills`.
 *     A registry that still points at the previous project injects the *wrong
 *     project's* rules, or none at all.
 *
 * Both used to be pinned once, at startup, to whichever project happened to be
 * first in the list. Opening a second project therefore changed the folder the
 * Explorer showed and nothing else: the code items stayed missing and the
 * skills stayed wrong. That is the kind of failure a user cannot diagnose,
 * because the UI looks correct and only the injected content is wrong.
 *
 * So activation is a *named operation with one entry point*, and every path
 * that changes the project goes through it: opening one, switching to one, and
 * restoring one at start-up.
 *
 * ## Why it is a separate file
 *
 * `app-container.ts` is the composition root and imports Electron (`safeStorage`),
 * so it cannot be exercised by a Node test. This module takes its collaborators
 * as parameters and imports nothing from Electron, which lets the behaviour
 * that matters — "after activating project B, B's code is searchable and B's
 * skills are the ones that apply" — be tested against the real
 * `IntelligenceManager` and the real `SkillRegistry`.
 */

import type {
  IntelligenceInitializeContext,
  WorkspaceActivationDto,
  WorkspaceDto,
} from '@ucad/contracts';
import type { Logger } from '@ucad/observability';
import type { SkillRoot } from '@ucad/skills';

/** The parts of a workspace activation the caller has to supply. */
export interface ActivatableWorkspace {
  id: string;
  path: string;
  trustState: 'untrusted' | 'trusted' | 'restricted';
}

/**
 * The collaborators activation needs.
 *
 * These are structural types rather than the concrete classes so that a test
 * can pass the real ones (which it does) without this module depending on
 * their packages' internals.
 */
export interface WorkspaceActivationDeps {
  logger: Logger;
  intelligence: {
    initializeProvider(providerId: string, ctx: IntelligenceInitializeContext): Promise<void>;
  };
  skills: {
    useWorkspace(workspaceRoot: string | undefined, extraUserRoots: readonly SkillRoot[]): void;
    watchedRoots(): readonly SkillRoot[];
  };
  /** where the app keeps its own configuration */
  configDir: string;
  /** where the app keeps its own cache */
  cacheDir: string;
  /** the provider UCAD ships with (ADR-012) */
  providerId?: string;
  /** extra user-scope skill roots, e.g. the directory next to the database */
  extraSkillRoots?: readonly SkillRoot[];
}

/**
 * What activation actually did, so the caller can say it out loud.
 *
 * `workspaceId` / `workspaceRoot` name the request; `skillRoots` names the
 * state in force when the call returned. Those are the same thing on the
 * success path and deliberately not the same on the `superseded` one — the
 * fields say which is which rather than leaving the caller to guess why the id
 * and the roots disagree. `supersededBy` names the request that took over.
 */
export interface WorkspaceActivationOutcome {
  /** the workspace *this* request was for (never the winner on `superseded`) */
  workspaceId: string;
  /** the root of the workspace this request was for */
  workspaceRoot: string;
  /**
   * The skill roots in force when the call returned.
   *
   * On `superseded` these belong to the activation that won, not to
   * `workspaceId`: the request was skipped, so it has no roots of its own to
   * report and claiming otherwise would invent a state that never existed.
   */
  skillRoots: readonly string[];
  /**
   * Whether code intelligence was pointed at this workspace.
   *
   * `superseded` is the honest third answer: a newer activation was requested
   * before this one finished, so *this* request is not the state in force.
   * Reporting `initialized` there would be a claim the caller could disprove
   * by asking the provider what it is looking at.
   */
  intelligence: 'initialized' | 'degraded' | 'superseded';
  /** when `intelligence` is `superseded`: the workspace that took over */
  supersededBy?: string;
}

/**
 * Points both workspace-rooted subsystems at `workspace`.
 *
 * NFR-09: intelligence *degrades*, it never takes the app down. A provider that
 * cannot be initialised leaves the app usable — the project is still open, the
 * files are still readable — and the reason is in the log and in the returned
 * outcome, not swallowed.
 */
export async function activateWorkspace(
  deps: WorkspaceActivationDeps,
  workspace: ActivatableWorkspace,
): Promise<WorkspaceActivationOutcome> {
  const providerId = deps.providerId ?? 'basic';

  // Skills first: they are synchronous and cannot fail, and a project whose
  // rules are already the ones in force is correct even if intelligence is
  // not available yet.
  deps.skills.useWorkspace(workspace.path, deps.extraSkillRoots ?? []);
  const skillRoots = deps.skills.watchedRoots().map((root) => root.path);

  let intelligence: WorkspaceActivationOutcome['intelligence'] = 'initialized';
  try {
    await deps.intelligence.initializeProvider(providerId, {
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      configDir: deps.configDir,
      cacheDir: deps.cacheDir,
      trustState: workspace.trustState,
      logger: deps.logger.child('intelligence'),
    });
  } catch (error) {
    // `initializeProvider` already degrades internally; this catches the
    // unexpected (a provider that throws out of the manager, a bad context)
    // so activation still ends with a usable app.
    intelligence = 'degraded';
    deps.logger.warn('code intelligence failed to initialise for this workspace', {
      workspaceId: workspace.id,
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  deps.logger.info('workspace activated', {
    workspaceId: workspace.id,
    workspaceRoot: workspace.path,
    providerId,
    skillRoots,
    intelligence,
  });

  return {
    workspaceId: workspace.id,
    workspaceRoot: workspace.path,
    skillRoots,
    intelligence,
  };
}

/**
 * Turns an outcome into the answer the Renderer receives.
 *
 * The mapping exists because "the requested project" and "the project in force"
 * stop being the same thing when an activation is superseded. Returning the
 * requested row with `activation: 'superseded'` would make every other field —
 * path, name, trust — describe a project whose code intelligence is not loaded,
 * and the Recent Projects panel navigates on exactly those fields.
 *
 * So on `superseded` the DTO names the project that *is* in force (the newer
 * request), and the one that was asked for is kept in `requestedWorkspaceId`
 * so the caller can tell the two apart instead of having to infer it.
 */
export function toWorkspaceActivationDto(
  requested: WorkspaceDto,
  outcome: WorkspaceActivationOutcome,
  lookup: (workspaceId: string) => WorkspaceDto | undefined,
): WorkspaceActivationDto {
  const inForce =
    outcome.intelligence === 'superseded' && outcome.supersededBy !== undefined
      ? lookup(outcome.supersededBy) ?? requested
      : requested;

  return {
    ...inForce,
    activation: outcome.intelligence,
    ...(inForce.id === requested.id ? {} : { requestedWorkspaceId: requested.id }),
  };
}

/**
 * Serialised, last-request-wins activation (§4.5 / §4.8).
 *
 * ## The failure this class closes
 *
 * `activateWorkspace()` is asynchronous and sets two subsystems. Two
 * overlapping calls — the user opens a project while the previous one is still
 * initialising its provider, or a trust change and a project switch arrive
 * together — therefore interleave:
 *
 *     activate(A): skills <- A ... await initializeProvider(A) ...
 *     activate(B): skills <- B ... await initializeProvider(B) ...
 *     A's provider finishes LAST  => intelligence answers for A
 *
 * The result is not a crash and not an empty screen. It is project A's code
 * searchable while project B is on screen, and — worse — A's rules injected
 * into B's context. That is exactly the product claim the single activation
 * entry point exists to protect, so ordering cannot be left to whichever
 * provider happens to be slower.
 *
 * So requests go through one queue and carry a monotonic token:
 *
 *   - the queue makes the *order* of the two subsystems' work the same as the
 *     order the user asked for them, so the later request is the one that ends
 *     up in force;
 *   - the token lets a request that was already superseded before it started
 *     return without touching anything, and lets an in-flight request say so
 *     (`intelligence: 'superseded'`) rather than claim a state it no longer
 *     holds.
 */
export class WorkspaceActivator {
  private readonly deps: WorkspaceActivationDeps;
  /** id of the most recent request; anything older is stale */
  private requested = 0;
  /** the workspace named by the most recent request, for `supersededBy` */
  private latest: ActivatableWorkspace | null = null;
  /** the tail of the queue — never rejected, so one failure cannot poison it */
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: WorkspaceActivationDeps) {
    this.deps = deps;
  }

  activate(workspace: ActivatableWorkspace): Promise<WorkspaceActivationOutcome> {
    const token = ++this.requested;
    this.latest = workspace;
    const run = this.tail.then(() => this.#activate(token, workspace));
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #activate(
    token: number,
    workspace: ActivatableWorkspace,
  ): Promise<WorkspaceActivationOutcome> {
    if (token !== this.requested) {
      // A newer request arrived while this one waited its turn. Running it
      // would only be undone, so nothing is touched — and the answer says so.
      this.deps.logger.info('workspace activation skipped; superseded while queued', {
        workspaceId: workspace.id,
        skillRoots: this.#currentSkillRoots(),
      });
      return {
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        skillRoots: this.#currentSkillRoots(),
        intelligence: 'superseded',
        supersededBy: this.latest?.id ?? workspace.id,
      };
    }

    const outcome = await activateWorkspace(this.deps, workspace);

    // A newer request may have arrived while the provider initialised. The
    // queue guarantees it runs *after* this one, so the state on record is
    // already being replaced — say that instead of claiming to be in force.
    if (token !== this.requested) {
      this.deps.logger.info('workspace activation superseded by a newer one', {
        workspaceId: workspace.id,
        intelligence: outcome.intelligence,
      });
      return {
        ...outcome,
        // The roots reported are the ones the winner will leave in force, which
        // may still be the previous project's until the queue drains — say
        // which request took over and let the caller read the rest as
        // "state at the moment this returned".
        intelligence: 'superseded',
        supersededBy: this.latest?.id ?? workspace.id,
      };
    }

    return outcome;
  }

  /** The skill roots in force right now — what a skipped request leaves behind. */
  #currentSkillRoots(): readonly string[] {
    return this.deps.skills.watchedRoots().map((root) => root.path);
  }
}
