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

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
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
} from '../../apps/desktop/src/main/workspace-activation';

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
    expect(result.skillRoots).toContain(path.join(projectB, '.ucad', 'skills'));
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
    skillRoots: [`${root}/.ucad/skills`],
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
        skillRoots: ['/projects/ws_b/.ucad/skills'],
        intelligence: 'initialized',
      },
      () => undefined,
    );

    expect(dto.id).toBe('ws_b');
    expect(dto.activation).toBe('initialized');
    // Nothing to disambiguate: no second project is implied.
    expect(dto.requestedWorkspaceId).toBeUndefined();
  });

  it('reports degraded without pretending another project is open', () => {
    const requested = row('ws_b');
    const dto = toWorkspaceActivationDto(
      requested,
      {
        workspaceId: 'ws_b',
        workspaceRoot: requested.path,
        skillRoots: ['/projects/ws_b/.ucad/skills'],
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
