/**
 * One workspace activation entry point (§4.5 / §4.8).
 *
 * ## The failure this file exists to catch
 *
 * Code intelligence and skills are both rooted in the project the user is
 * working on:
 *
 *   - the Basic provider answers a query by scanning the workspace it was
 *     *initialised* with, so a provider initialised for project A answers
 *     nothing for project B — and the Context Broker reads that as "this
 *     project has no code items", so the pack quietly loses the files;
 *   - a skill registry still pointing at project A injects A's rules into
 *     B's context, or none at all.
 *
 * Both used to be pinned once at start-up to whichever project was first in
 * the list. Opening a second project therefore changed the folder in the
 * Explorer and nothing else — a failure with no visible symptom, because the
 * UI looks right and only the injected content is wrong.
 *
 * So this test drives the real `IntelligenceManager`, the real
 * `BasicIntelligenceProvider` and the real `SkillRegistry` through the real
 * activation function, over two real directories on disk. It asserts what the
 * *product* needs to be true afterwards, not that a method was called.
 */

import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  BasicIntelligenceProvider,
  IntelligenceManager,
} from '@ucad/code-intelligence';
import { SkillRegistry, defaultSkillRoots } from '@ucad/skills';
import { BlobStore, silentLogger } from '@ucad/observability';

import {
  WorkspaceActivator,
  activateWorkspace,
  toWorkspaceActivationDto,
  type ActivatableWorkspace,
  type WorkspaceActivationOutcome,
} from '../../apps/desktop/src/main/workspace-activation';
import type { WorkspaceDto } from '@ucad/contracts';

/**
 * `app-container.ts` imports `safeStorage`, so the container-level cases at the
 * bottom of this file need the module to exist. Nothing below calls it: the
 * activation path never touches the OS key store.
 */
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: () => Buffer.alloc(0),
    decryptString: () => '',
  },
}));

import { UcadApp } from '../../apps/desktop/src/main/app-container';

let root: string;
let projectA: string;
let projectB: string;
let intelligence: IntelligenceManager;
let skills: SkillRegistry;
let blobs: BlobStore;

/** Writes a file, refusing to escape the fixture root. */
function write(base: string, rel: string, content: string): void {
  const file = path.resolve(base, rel);
  if (!file.startsWith(base + path.sep)) {
    throw new Error(`fixture path escapes the fixture root: ${rel}`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

/** A skill directory, in the `agentskills.io` layout UCAD documents. */
function writeSkill(base: string, name: string, body: string): void {
  write(
    base,
    path.join('.ucad', 'skills', name, 'SKILL.md'),
    ['---', `name: ${name}`, 'description: a project rule', '---', '', body].join('\n'),
  );
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ucad-ws-'));

  projectA = path.join(root, 'project-a');
  projectB = path.join(root, 'project-b');
  fs.mkdirSync(projectA, { recursive: true });
  fs.mkdirSync(projectB, { recursive: true });

  write(projectA, 'src/alpha.ts', 'export function alphaWidget() { return 1; }\n');
  write(projectB, 'src/beta.ts', 'export function betaWidget() { return 2; }\n');
  writeSkill(projectA, 'alpha-rules', 'Always run the alpha checks.');
  writeSkill(projectB, 'beta-rules', 'Always run the beta checks.');

  blobs = new BlobStore({ root: path.join(root, 'blobs') });
  intelligence = new IntelligenceManager({ db: {} as never, logger: silentLogger('test') });
  intelligence.register(new BasicIntelligenceProvider({ logger: silentLogger('test'), blobs }));

  // The registry starts with no project at all — the state the product was in
  // before a project had been opened.
  skills = new SkillRegistry({
    logger: silentLogger('test'),
    roots: defaultSkillRoots(undefined, [{ path: path.join(root, 'user-skills'), scope: 'user' }]),
  });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** Searches a workspace through the manager, the way the Context Broker does. */
async function search(workspaceId: string, query: string): Promise<{ status: string; paths: string[] }> {
  const outcome = await intelligence.query({
    kind: 'search',
    providerId: 'basic',
    input: { workspaceId, query, limit: 20 },
  });
  const result = outcome.result as { items?: Array<{ path?: string }> } | null;
  return {
    status: outcome.status,
    paths: (result?.items ?? []).map((item) => item.path ?? ''),
  };
}

/** The names of the skills the registry currently offers. */
function skillNames(): string[] {
  return skills.list().map((skill) => skill.name);
}

const deps = () => ({
  logger: silentLogger('test'),
  intelligence,
  skills,
  configDir: path.join(root, 'config'),
  cacheDir: path.join(root, 'cache'),
  providerId: 'basic',
  extraSkillRoots: [{ path: path.join(root, 'user-skills'), scope: 'user' as const }],
});

describe('workspace activation', () => {
  it('a workspace that was never activated has no searchable code', async () => {
    // The honest starting point: the provider knows nothing about this
    // workspace, so it cannot answer — and must say so rather than return
    // an empty result set that reads like "this project has no code".
    const outcome = await search('ws_unactivated', 'alphaWidget');
    expect(outcome.status).not.toBe('ok');
  });

  it('activating a project makes its code searchable and its skills apply', async () => {
    const result = await activateWorkspace(
      deps(),
      { id: 'ws_a', path: projectA, trustState: 'trusted' },
    );

    expect(result.workspaceId).toBe('ws_a');
    expect(result.intelligence).toBe('initialized');

    const found = await search('ws_a', 'alphaWidget');
    expect(found.status).toBe('ok');
    expect(found.paths.join('\n')).toContain('alpha.ts');
    // The other project is not visible from here.
    expect(found.paths.join('\n')).not.toContain('beta.ts');

    expect(skillNames()).toContain('alpha-rules');
  });

  it('switching project moves the code search and the skills with it', async () => {
    const result = await activateWorkspace(
      deps(),
      { id: 'ws_b', path: projectB, trustState: 'trusted' },
    );
    expect(result.workspaceId).toBe('ws_b');

    // The new project answers for itself...
    const beta = await search('ws_b', 'betaWidget');
    expect(beta.status).toBe('ok');
    expect(beta.paths.join('\n')).toContain('beta.ts');

    // ...and the previous project's rules are gone, not merely outranked.
    // A rule that survived the switch would be injected into a project the
    // user never wrote it for.
    expect(skillNames()).toContain('beta-rules');
    expect(skillNames()).not.toContain('alpha-rules');

    // The first project's code is no longer reachable from the second one.
    const alpha = await search('ws_b', 'alphaWidget');
    expect(alpha.paths.join('\n')).not.toContain('alpha.ts');

    // The roots on record are the ones in force now, so the UI can show what
    // UCAD is actually looking at.
    expect(result.skillRootsAtReturn).toContain(path.join(projectB, '.ucad', 'skills'));
  });

  it('switching back brings the first project back with it', async () => {
    await activateWorkspace(deps(), { id: 'ws_a', path: projectA, trustState: 'trusted' });

    const alpha = await search('ws_a', 'alphaWidget');
    expect(alpha.status).toBe('ok');
    expect(alpha.paths.join('\n')).toContain('alpha.ts');
    expect(skillNames()).toContain('alpha-rules');
    expect(skillNames()).not.toContain('beta-rules');
  });

  it('the user-scope roots keep working across a project switch', async () => {
    write(
      root,
      path.join('user-skills', 'personal-rule', 'SKILL.md'),
      ['---', 'name: personal-rule', 'description: a personal rule', '---', '', 'Prefer tabs.'].join('\n'),
    );

    await activateWorkspace(deps(), { id: 'ws_b', path: projectB, trustState: 'trusted' });

    // A personal rule is not a project's rule: it must not be lost when the
    // project changes.
    expect(skillNames()).toContain('personal-rule');
    expect(skillNames()).toContain('beta-rules');
  });

  it('a request that arrives mid-initialisation takes over; the last one wins', async () => {
    // The failure this replaces: activation is asynchronous, so opening B while
    // A's provider is still initialising used to interleave — B's skills went
    // in, then A's *slower* provider finished last and the provider was left
    // pointing at A. The screen says B; the code intelligence is A's, and A's
    // rules are the ones injected into B's context.
    //
    // The basic provider tolerates a stale root by design (it keys roots by
    // workspace), so it cannot show this. A provider that holds *one* root —
    // what an index or language server does — can. That is what is simulated.
    const events: string[] = [];
    let providerRoot: string | undefined;
    const singleRooted = {
      initializeProvider: async (
        providerId: string,
        ctx: Parameters<IntelligenceManager['initializeProvider']>[1],
      ): Promise<void> => {
        events.push(`start:${ctx.workspaceId}`);
        if (ctx.workspaceId === 'ws_a') {
          await new Promise((resolve) => setTimeout(resolve, 40));
        }
        providerRoot = ctx.workspaceRoot;
        events.push(`end:${ctx.workspaceId}`);
        await intelligence.initializeProvider(providerId, ctx);
      },
    };

    const activator = new WorkspaceActivator({ ...deps(), intelligence: singleRooted });

    const first = activator.activate({ id: 'ws_a', path: projectA, trustState: 'trusted' });
    // Let A actually begin, so B arrives while A is in flight rather than
    // before it started — the two paths are different.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = activator.activate({ id: 'ws_b', path: projectB, trustState: 'trusted' });

    const [firstOutcome, secondOutcome] = await Promise.all([first, second]);

    // One at a time, in the order the user asked: A's initialisation finishes
    // before B's starts, so the slower one cannot outlive the newer request.
    expect(events).toEqual(['start:ws_a', 'end:ws_a', 'start:ws_b', 'end:ws_b']);

    // The provider is left on the project that is open...
    expect(providerRoot).toBe(projectB);
    expect(secondOutcome.intelligence).toBe('initialized');
    // ...and the request that lost does not claim to be the state in force.
    expect(firstOutcome.intelligence).toBe('superseded');
    expect(firstOutcome.workspaceId).toBe('ws_a');
    // It names the request that took over, so "which one won" is answerable
    // from the outcome rather than by watching the provider.
    expect(firstOutcome.supersededBy).toBe('ws_b');

    // Skills and intelligence agree with each other: both are B's.
    expect(skillNames()).toContain('beta-rules');
    expect(skillNames()).not.toContain('alpha-rules');
  });

  it('a request superseded before it started touches nothing', async () => {
    const events: string[] = [];
    const recorder = {
      initializeProvider: async (
        providerId: string,
        ctx: Parameters<IntelligenceManager['initializeProvider']>[1],
      ): Promise<void> => {
        events.push(ctx.workspaceId);
        await intelligence.initializeProvider(providerId, ctx);
      },
    };

    const activator = new WorkspaceActivator({ ...deps(), intelligence: recorder });

    // Both requested in the same tick, the way a double-click on two recent
    // projects does it. The first one is already stale when its turn comes, so
    // it must not point the provider at a project the user has left.
    const [firstOutcome, secondOutcome] = await Promise.all([
      activator.activate({ id: 'ws_a', path: projectA, trustState: 'trusted' }),
      activator.activate({ id: 'ws_b', path: projectB, trustState: 'trusted' }),
    ]);

    expect(events).toEqual(['ws_b']);
    expect(firstOutcome.intelligence).toBe('superseded');
    expect(firstOutcome.supersededBy).toBe('ws_b');
    // The outcome still names the request it answers, not the winner.
    expect(firstOutcome.workspaceId).toBe('ws_a');
    expect(secondOutcome.intelligence).toBe('initialized');
    expect(skillNames()).toContain('beta-rules');
  });

  it('a request superseded before it started reports the roots at that moment, not the winner\'s', async () => {
    // The registry is on A, so "the roots when this returned" and "the roots
    // the winner will leave" are different values: a field claiming the latter
    // would be caught here. Two requests land in the same tick, so B is stale
    // before its turn comes and never runs at all.
    await activateWorkspace(deps(), { id: 'ws_a', path: projectA, trustState: 'trusted' });

    const activator = new WorkspaceActivator(deps());
    const [skipped, winner] = await Promise.all([
      activator.activate({ id: 'ws_b', path: projectB, trustState: 'trusted' }),
      activator.activate({ id: 'ws_c', path: projectB, trustState: 'trusted' }),
    ]);

    // B never ran, so nothing of B's was ever in force: the roots on record are
    // still A's. `skillRootsAtReturn` says exactly that instead of passing them
    // off as the winner's.
    expect(skipped.intelligence).toBe('superseded');
    expect(skipped.skillRootsAtReturn).toContain(path.join(projectA, '.ucad', 'skills'));
    expect(skipped.skillRootsAtReturn).not.toContain(path.join(projectB, '.ucad', 'skills'));

    // `supersededBy` names the request that will actually run and overwrite
    // this one — C, not B, which was skipped just as this one was.
    expect(skipped.supersededBy).toBe('ws_c');
    expect(winner.intelligence).toBe('initialized');
    expect(winner.skillRootsAtReturn).toContain(path.join(projectB, '.ucad', 'skills'));
  });

  it('with three requests queued behind one in flight, only the last one runs', async () => {
    // A→B→C: A has started, so B and C arrive while it is in flight. B is
    // already stale when its turn comes. One activation touches the provider,
    // and every request that lost names the same winner.
    const events: string[] = [];
    const slow = {
      initializeProvider: async (
        providerId: string,
        ctx: Parameters<IntelligenceManager['initializeProvider']>[1],
      ): Promise<void> => {
        events.push(ctx.workspaceId);
        await new Promise((resolve) => setTimeout(resolve, 20));
        await intelligence.initializeProvider(providerId, ctx);
      },
    };
    const activator = new WorkspaceActivator({ ...deps(), intelligence: slow });

    const first = activator.activate({ id: 'ws_a', path: projectA, trustState: 'trusted' });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = activator.activate({ id: 'ws_b', path: projectB, trustState: 'trusted' });
    const third = activator.activate({ id: 'ws_c', path: projectB, trustState: 'trusted' });

    const [firstOutcome, secondOutcome, thirdOutcome] = await Promise.all([first, second, third]);

    expect(events).toEqual(['ws_a', 'ws_c']);
    expect(firstOutcome.supersededBy).toBe('ws_c');
    expect(secondOutcome.supersededBy).toBe('ws_c');
    // B was skipped, so it reports the state it left untouched: A's roots.
    expect(secondOutcome.intelligence).toBe('superseded');
    expect(secondOutcome.skillRootsAtReturn).toContain(path.join(projectA, '.ucad', 'skills'));
    expect(thirdOutcome.intelligence).toBe('initialized');
    expect(skillNames()).toContain('beta-rules');
  });

  it('a failing provider degrades the workspace instead of breaking it', async () => {
    const brokenIntelligence = {
      initializeProvider: async (): Promise<void> => {
        throw new Error('provider exploded');
      },
    };

    const result = await activateWorkspace(
      { ...deps(), intelligence: brokenIntelligence },
      { id: 'ws_c', path: projectA, trustState: 'trusted' },
    );

    // NFR-09: intelligence degrades, it does not take the app down — and the
    // degradation is reported rather than swallowed.
    expect(result.intelligence).toBe('degraded');
    expect(skillNames()).toContain('alpha-rules');
  });
});

/**
 * What the Renderer is told, which is not the same as what was asked for.
 *
 * `recent.switchFailed`/`onActivated(next.name)` in the Recent Projects panel
 * navigate on the answered DTO's `name`. Reporting the *requested* row with
 * `activation: 'superseded'` would therefore take the user to a project whose
 * code intelligence and skills were never moved — the same failure this whole
 * module exists to prevent, one layer further out.
 */
describe('the activation answer the Renderer receives', () => {
  const row = (id: string) => ({
    id,
    path: `/projects/${id}`,
    name: id,
    trustState: 'trusted' as const,
  });

  const supersededOutcome = (requestedId: string, winnerId: string, root: string) => ({
    workspaceId: requestedId,
    workspaceRoot: `/projects/${requestedId}`,
    skillRootsAtReturn: [`${root}/.ucad/skills`],
    intelligence: 'superseded' as const,
    supersededBy: winnerId,
  });

  it('names the project actually in force when this request lost', () => {
    const requested = row('ws_b');
    const dto = toWorkspaceActivationDto(
      requested,
      supersededOutcome('ws_b', 'ws_c', '/projects/ws_c'),
      (id) => (id === 'ws_c' ? row('ws_c') : undefined),
    );

    expect(dto.id).toBe('ws_c');
    expect(dto.name).toBe('ws_c');
    expect(dto.activation).toBe('superseded');
    // The one that was asked for is kept beside it, so the two can be told
    // apart instead of inferred.
    expect(dto.requestedWorkspaceId).toBe('ws_b');
  });

  it('answers with the request itself when it is in force', () => {
    const requested = row('ws_b');
    const dto = toWorkspaceActivationDto(
      requested,
      {
        workspaceId: 'ws_b',
        workspaceRoot: requested.path,
        skillRootsAtReturn: ['/projects/ws_b/.ucad/skills'],
        intelligence: 'initialized',
      },
      () => undefined,
    );

    expect(dto.id).toBe('ws_b');
    expect(dto.activation).toBe('initialized');
    // Nothing to disambiguate: no second project is implied.
    expect(dto.requestedWorkspaceId).toBeUndefined();
  });

  it('answers with nothing when the project that took over cannot be resolved', () => {
    // The winner's row was removed while this activation was in flight. The
    // requested project is explicitly *not* in force, so falling back to it
    // would answer with the one row the mapping exists to keep out of this
    // answer — and the panel navigates on exactly those fields.
    const dto = toWorkspaceActivationDto(
      row('ws_b'),
      supersededOutcome('ws_b', 'ws_c', '/projects/ws_c'),
      () => undefined,
    );

    expect(dto).toBeNull();
  });

  it('reports degraded without pretending another project is open', () => {
    const requested = row('ws_b');
    const dto = toWorkspaceActivationDto(
      requested,
      {
        workspaceId: 'ws_b',
        workspaceRoot: requested.path,
        skillRootsAtReturn: ['/projects/ws_b/.ucad/skills'],
        intelligence: 'degraded',
      },
      () => undefined,
    );

    // The project did open; only its code intelligence did not. That is not a
    // reason to move the user somewhere else.
    expect(dto.id).toBe('ws_b');
    expect(dto.activation).toBe('degraded');
  });
});

/**
 * `activeWorkspaceId` is what every workspace-scoped handler reads (§4.5/§4.8):
 * `workspace.setTrust`, `mcp:upsert({ scope: 'workspace' })`, a session's file
 * writes, a permission request. Two properties of it matter and neither is
 * visible in the pure functions above:
 *
 *   - it follows the *last request*, not the last activation to finish — hence
 *     the synchronous write, before the first await;
 *   - a request that failed does not get to leave it on a project that never
 *     went into force, because then the app would scope operations to one
 *     project while the activation that matters never reached it.
 *
 * The class itself imports Electron and constructs twelve subsystems, so only
 * the parts `activateWorkspace` touches are supplied here; the method under
 * test is the real one, and `currentWorkspaceId` is read through the real
 * getter the IPC layer uses.
 */
describe("the container's active workspace", () => {
  const rowA: WorkspaceDto = {
    id: 'ws_a',
    path: '/projects/ws_a',
    name: 'project-a',
    trustState: 'trusted',
  };
  const rowB: WorkspaceDto = {
    id: 'ws_b',
    path: '/projects/ws_b',
    name: 'project-b',
    trustState: 'trusted',
  };

  interface FakeContainer {
    sessionStore: { getWorkspace(id: string): WorkspaceDto | undefined };
    workspaceActivator: {
      activate(workspace: ActivatableWorkspace): Promise<WorkspaceActivationOutcome>;
    };
    activeWorkspaceId: string | undefined;
  }

  /**
   * Only the fields `activateWorkspace` reads, plus the rows it looks up.
   *
   * The object is built on the real prototype so that the class's own getters
   * (`activator`, `currentWorkspaceId`) resolve the way they do in the app —
   * an object literal would run the method with a `this` that has no getters.
   * The constructor is skipped on purpose: it would build twelve subsystems.
   */
  function container(
    activate: (workspace: ActivatableWorkspace) => Promise<WorkspaceActivationOutcome>,
    activeId?: string,
  ): { app: FakeContainer; rows: Map<string, WorkspaceDto> } {
    const rows = new Map([
      [rowA.id, rowA],
      [rowB.id, rowB],
    ]);
    const app = Object.assign(Object.create(UcadApp.prototype) as FakeContainer, {
      sessionStore: { getWorkspace: (id: string) => rows.get(id) },
      workspaceActivator: { activate },
      activeWorkspaceId: activeId,
    });
    return { app, rows };
  }

  const activate = (app: FakeContainer, id: string): Promise<unknown> =>
    UcadApp.prototype.activateWorkspace.call(app as unknown as UcadApp, id);

  /** The public surface every workspace-scoped handler reads. */
  function currentWorkspaceId(app: FakeContainer): string | undefined {
    const getter = Object.getOwnPropertyDescriptor(UcadApp.prototype, 'currentWorkspaceId')?.get;
    return getter?.call(app as unknown as UcadApp) as string | undefined;
  }

  it('records the project it was asked for before awaiting anything', async () => {
    // Settling a promise with `null` would let a *newer* request write first and
    // be overwritten by an older one finishing later; recording synchronously
    // makes the order of requests the order of the field, which is what the
    // queue guarantees for the subsystems too.
    let seen: string | undefined;
    const { app } = container(async (workspace) => {
      seen = currentWorkspaceId(app);
      return {
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        skillRootsAtReturn: [],
        intelligence: 'initialized',
      };
    });

    const dto = (await activate(app, 'ws_b')) as WorkspaceDto;
    expect(seen).toBe('ws_b');
    expect(dto.id).toBe('ws_b');
    expect(currentWorkspaceId(app)).toBe('ws_b');
  });

  it('is left on the previous project when the activation throws', async () => {
    const { app } = container(async () => {
      throw new Error('激活队列故障');
    }, 'ws_a');

    await expect(activate(app, 'ws_b')).rejects.toThrow('激活队列故障');
    // Nothing was moved into force, so nothing may be scoped to B either.
    expect(currentWorkspaceId(app)).toBe('ws_a');
  });

  it('is not moved back when a newer request already claimed it', async () => {
    const created = container(async () => {
      // A newer request recorded itself before this one failed. The failure is
      // this request's; rolling the field back would undo the newer request.
      created.app.activeWorkspaceId = 'ws_b';
      throw new Error('激活队列故障');
    }, 'ws_a');

    await expect(activate(created.app, 'ws_a')).rejects.toThrow('激活队列故障');
    expect(currentWorkspaceId(created.app)).toBe('ws_b');
  });

  it('refuses to answer with the requested project when the winner is gone', async () => {
    const { app, rows } = container(async (workspace) => {
      return {
        workspaceId: workspace.id,
        workspaceRoot: workspace.path,
        skillRootsAtReturn: [],
        intelligence: 'superseded',
        supersededBy: 'ws_b',
      };
    }, 'ws_a');
    rows.delete('ws_b');

    // The answer cannot name the project in force, and naming the requested one
    // would navigate the user to a project whose code and rules were never
    // loaded. Failing loudly is the honest option; the panel shows the reason.
    await expect(activate(app, 'ws_a')).rejects.toThrow(/已不存在/);
  });
});
