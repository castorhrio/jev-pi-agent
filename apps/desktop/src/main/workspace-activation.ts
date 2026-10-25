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

import type { IntelligenceInitializeContext } from '@ucad/contracts';
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

/** What activation actually did, so the caller can say it out loud. */
export interface WorkspaceActivationOutcome {
  workspaceId: string;
  workspaceRoot: string;
  /** the skill roots in force after activation */
  skillRoots: readonly string[];
  /** whether code intelligence was pointed at this workspace */
  intelligence: 'initialized' | 'degraded';
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
