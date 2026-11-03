/**
 * The main-chain verifier, judged without a desktop.
 *
 * ## Why this file exists
 *
 * `scripts/verify-main-chain.mjs` is the answer to "the six steps were never run
 * on a real machine". A check nobody can re-run is a claim, so the parts of the
 * run that are *decisions* — what environment the child gets, which sentence the
 * screen must show for which feed — are pinned here, where CI can turn them red.
 * What remains manual is the launch itself: the OS key store, the tray and the
 * vendor network are exactly what a container cannot provide.
 *
 * Two of these pins are parity checks against the product, and they are the
 * reason the file exists at all:
 *
 *  - the feed expectations are read from `FEED_REFUSAL_STATUS_MESSAGE` / the
 *    unanswered-check wording in `update-service.ts`. A verifier that keeps an
 *    old sentence after the product rewords it does not fail — it keeps passing,
 *    about something else;
 *  - the workspace seed is compared with the column list in
 *    `packages/session/src/session-store.ts`, which is the shape the app itself
 *    reads back on start-up. A column renamed there and not here inserts a row
 *    the app cannot see, and the run then reports a missing project.
 *
 * The environment pin is the one that came from this round's own blocked run: the
 * app stopped with "Encryption is not available" on a machine whose keyring was
 * fine, because Chromium picks its key store backend from the *declared* desktop.
 * A verifier that does not declare one measures a machine, not the product.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DRIVEN_STEPS,
  FEED_VARIANTS,
  MANUAL_STEPS,
  appEnv,
  closeVerdict,
  parseSteps,
  profileDataDir,
  stepCoverage,
  trayMenuLabels,
  trayMenuVerdict,
} from '../../scripts/verify-main-chain.mjs';
import { FEED_REFUSAL_STATUS_MESSAGE } from '../../apps/desktop/src/main/update-service';
import { checkFeedUrl } from '../../apps/desktop/src/main/update-feed';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

/** The parent environment, as the script would read it. */
const parentEnv = {
  PATH: '/usr/bin:/bin',
  XDG_RUNTIME_DIR: '/run/user/1000',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
  DISPLAY: ':42',
  XAUTHORITY: '/tmp/xvfb-run.AAA/Xauthority',
};

describe('the environment a verification child is launched with', () => {
  it('declares a desktop, because that is what selects the key store backend', () => {
    const env = appEnv('/tmp/profile', {}, { platform: 'linux', parentEnv });

    expect(env.XDG_CURRENT_DESKTOP).toBeTruthy();
    expect(env.DESKTOP_SESSION).toBeTruthy();
  });

  it('inherits the session bus and the display instead of inventing them', () => {
    // The keyring lives on the caller's bus; a stripped environment is how a run
    // ends up "blocked: no Secret Service" on a machine that has one. `XAUTHORITY`
    // is the one people forget, and without it the X server refuses the connect
    // and the app never prints a line to read.
    const env = appEnv('/tmp/profile', {}, { platform: 'linux', parentEnv });

    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(parentEnv.DBUS_SESSION_BUS_ADDRESS);
    expect(env.XDG_RUNTIME_DIR).toBe(parentEnv.XDG_RUNTIME_DIR);
    expect(env.DISPLAY).toBe(parentEnv.DISPLAY);
    expect(env.XAUTHORITY).toBe(parentEnv.XAUTHORITY);
    expect(env.HOME).toBe('/tmp/profile');
  });

  it('leaves an explicitly declared desktop alone', () => {
    // A KDE session must not be rewritten to GNOME's: the whole point is to ask
    // the environment the operator has, not to pretend to have one.
    const env = appEnv(
      '/tmp/profile',
      {},
      { platform: 'linux', parentEnv: { ...parentEnv, XDG_CURRENT_DESKTOP: 'KDE' } },
    );

    expect(env.XDG_CURRENT_DESKTOP).toBe('KDE');
  });

  it('points a Windows profile at the directory the app actually uses', () => {
    // The document says the six steps belong on Windows; a verifier that reads
    // the Linux layout would fail at the step that proves the keyring.
    expect(profileDataDir('/tmp/p', 'win32')).toBe(join('/tmp/p', 'AppData', 'Roaming', 'ucad'));
    expect(profileDataDir('/tmp/p', 'linux')).toBe(join('/tmp/p', '.config', 'ucad'));

    const env = appEnv('/tmp/p', {}, { platform: 'win32', parentEnv });
    expect(env.APPDATA).toBe(join('/tmp/p', 'AppData', 'Roaming'));
    expect(env.ELECTRON_DISABLE_SANDBOX).toBeUndefined();
  });

  it('lets a feed override through per run, and not otherwise', () => {
    expect(appEnv('/tmp/p', { UCAD_UPDATE_FEED: 'https://example.test/f.json' }, { platform: 'linux', parentEnv }).UCAD_UPDATE_FEED).toBe(
      'https://example.test/f.json',
    );
    expect(appEnv('/tmp/p', {}, { platform: 'linux', parentEnv }).UCAD_UPDATE_FEED).toBeUndefined();
  });
});

describe('the steps the verifier will and will not drive', () => {
  it('accepts the five steps it has code for, in the order asked', () => {
    expect(parseSteps('1,2,3,4,5')).toEqual({ steps: [1, 2, 3, 4, 5], rejected: [] });
    // Repeated and out-of-order requests are a request for each step once; the
    // order is kept because the transcript reads in the order it ran.
    expect(parseSteps('2,1,2')).toEqual({ steps: [2, 1], rejected: [] });
  });

  it('refuses step 6 instead of passing having driven nothing', () => {
    // The defect this rules out: `--steps 6` used to launch the app, drive no
    // step at all, and exit 0 with "PASS — steps 6 recorded above". Step 6 is
    // the five fixture states a person walks under `npm run dev:web`, so the
    // honest answer is a refusal that names the other command.
    const verdict = parseSteps('6');

    expect(verdict.steps).toEqual([]);
    expect(verdict.rejected).toHaveLength(1);
    expect(verdict.rejected[0]!.reason).toContain('npm run dev:web');
    // The sentence is read from the table, not retyped here.
    expect(MANUAL_STEPS[6]).toContain('npm run dev:web');
  });

  it('refuses a number that is not a step, and a token that is not a number', () => {
    expect(parseSteps('9').rejected[0]!.reason).toContain(DRIVEN_STEPS.join(', '));
    const mixed = parseSteps('1,bogus');
    // The drivable half is still reported, so the refusal can say what it would
    // have run — but a non-empty `rejected` ends the run, so nothing half-runs.
    expect(mixed.steps).toEqual([1]);
    expect(mixed.rejected[0]!.reason).toContain('bogus');
  });

  it('refuses an empty request rather than defaulting to nothing at all', () => {
    const verdict = parseSteps('');

    expect(verdict.steps).toEqual([]);
    expect(verdict.rejected).toHaveLength(1);
    expect(verdict.rejected[0]!.reason).toContain('--steps');
  });

  it('has a dispatch for every step it declares, and declares every dispatch', () => {
    // Both directions, because the two lists can drift apart silently: a step in
    // `DRIVEN_STEPS` with no `wants(n)` behind it runs nothing and (before
    // `stepCoverage`) said so to nobody, and a `wants(n)` naming a step that is
    // not declared can never fire.
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'verify-main-chain.mjs'), 'utf8');
    const dispatched = [...source.matchAll(/wants\((\d+)\)/g)].map((match) => Number(match[1]));

    expect([...new Set(dispatched)].sort()).toEqual([...DRIVEN_STEPS].sort());
    expect(source).toContain(`parseSteps(flag('steps', DRIVEN_STEPS.join(',')))`);
  });

  it('turns a requested step that neither passed nor failed into a failure', () => {
    // The silent skip: a step whose selector stopped matching records evidence,
    // takes an `if` with no `else`, and ends without a verdict. Silence used to
    // read as success, because the verdict only counted failures.
    expect(stepCoverage({ requested: [1, 2], passed: [1], failed: [] })).toEqual([
      { step: 2, message: expect.stringContaining('neither passed nor failed') },
    ]);
    // A step that failed is already accounted for; a step that passed needs no
    // second opinion.
    expect(stepCoverage({ requested: [1], passed: [], failed: [1] })).toEqual([]);
    expect(stepCoverage({ requested: [1, 2], passed: [1, 2], failed: [] })).toEqual([]);
  });

  it('wires both refusals into the run, in the order that matters', () => {
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'verify-main-chain.mjs'), 'utf8');

    // The `--steps` refusal comes before anything is launched: a run that starts
    // the app and then reports the problem has already spent the operator's
    // display and key store on a request it was never going to honour.
    expect(source.indexOf('if (STEP_REQUEST.rejected.length)')).toBeGreaterThan(-1);
    expect(source.indexOf('if (STEP_REQUEST.rejected.length)')).toBeLessThan(
      source.indexOf('await seedWorkspace()'),
    );
    // And the coverage check comes before the PASS line, or the verdict is
    // printed about a set of steps that never checked for gaps.
    expect(source.indexOf('for (const gap of stepCoverage({')).toBeGreaterThan(-1);
    expect(source.indexOf('for (const gap of stepCoverage({')).toBeLessThan(
      source.indexOf("STEPS.join(', ')} recorded above"),
    );
  });
});

describe('the feed cases the verifier expects', () => {
  it('names the sentence the product writes, for each refusal', () => {
    // The parity check: `expect` is a regex over text the product owns. Without
    // this, rewording 更新源必须使用 https in `update-service.ts` would leave the
    // verifier asserting a sentence no build can produce.
    const refused = FEED_VARIANTS.filter((variant) => variant.refused);
    expect(refused.length).toBeGreaterThan(0);
    for (const variant of refused) {
      const sentence = Object.values(FEED_REFUSAL_STATUS_MESSAGE).find((message) =>
        variant.expect.test(message),
      );
      expect(
        sentence,
        `${variant.label}: no refusal sentence in update-service.ts matches ${variant.expect}`,
      ).toBeTruthy();
    }
  });

  it('refuses what the product itself refuses, for the same reason', () => {
    // The loop a real run closes: the value here goes into `UCAD_UPDATE_FEED`,
    // the product's own rule decides whether it is a feed, and the sentence that
    // rule produces is what this verifier expects on screen. Testing the three
    // together is the only way a reworded sentence or a widened rule shows up
    // here instead of in a manual run three weeks later.
    for (const variant of FEED_VARIANTS.filter((row) => row.refused)) {
      const verdict = checkFeedUrl(variant.value);
      expect(verdict.ok, `${variant.label}: the product no longer refuses this value`).toBe(false);
      expect(
        FEED_REFUSAL_STATUS_MESSAGE[verdict.reason],
        `${variant.label}: no screen sentence for the refusal ${verdict.reason}`,
      ).toMatch(variant.expect);
    }
  });

  it('keeps the unreachable-feed case a real https URL', () => {
    // The third row is about a *failed check*, not a refused configuration: it
    // must stay valid enough to reach the network, or it tests the wrong branch.
    const unreachable = FEED_VARIANTS.find((variant) => !variant.refused);

    expect(unreachable?.value.startsWith('https://')).toBe(true);
    expect(unreachable?.expect.source).toContain('检查更新失败');
  });
});

describe('what step 5 is allowed to call a pass', () => {
  it('needs the window to say it is hidden, not just the process to be alive', () => {
    // The failure this rules out is the one a user cannot recover from: the app
    // hid itself into a tray that was never built, so the process is alive and
    // nothing is on screen. "Is the process alive" answers yes to that.
    expect(closeVerdict({ choice: '隐藏到托盘', exited: null, visibility: 'hidden' })).toEqual({
      ok: true,
      message: 'the window is hidden and the process is alive',
    });
    expect(closeVerdict({ choice: '隐藏到托盘', exited: null, visibility: 'visible' }).ok).toBe(false);
    expect(
      closeVerdict({ choice: '隐藏到托盘', exited: null, visibility: 'unreadable (the page did not answer)' }).ok,
    ).toBe(false);
    // A destroyed page target is the renderer-initiated close's own doing, and
    // the window is still off screen — the claim step 5 makes holds, and the
    // message says which close was measured.
    const gone = closeVerdict({
      choice: '隐藏到托盘',
      exited: null,
      visibility: 'gone (the page target no longer exists)',
    });
    expect(gone.ok).toBe(true);
    expect(gone.message).toContain('renderer-initiated');
  });

  it('keeps the tray fault path a pass, because the app said why it quit', () => {
    // On a host with no indicator host the app's own rule is "closing quits",
    // and the document asks for that branch to be recorded rather than failed.
    // The same exit *without* the log line is a silent quit, which is not.
    expect(
      closeVerdict({ choice: '隐藏到托盘', exited: { code: 0 }, visibility: 'n/a', trayUnavailable: true }).ok,
    ).toBe(true);
    expect(
      closeVerdict({ choice: '隐藏到托盘', exited: { code: 0 }, visibility: 'n/a', trayUnavailable: false }).ok,
    ).toBe(false);
  });

  it('holds 退出应用 to the opposite rule', () => {
    expect(closeVerdict({ choice: '退出应用', exited: { code: 0 }, visibility: 'n/a' }).ok).toBe(true);
    expect(closeVerdict({ choice: '退出应用', exited: null, visibility: 'hidden' }).ok).toBe(false);
  });
});

describe('the tray menu step 5 asserts', () => {
  const i18nSource = readFileSync(
    join(REPO_ROOT, 'apps', 'desktop', 'src', 'shared', 'i18n.ts'),
    'utf8',
  );
  const expected = trayMenuLabels(i18nSource);

  it('reads the expected labels out of the product table, not out of this file', () => {
    // The expectation is read from `i18n.ts` — the same table
    // `buildTrayMenuTemplate()` translates from — so a renamed label cannot
    // leave the verifier asserting a sentence no build can produce.
    expect(expected).toHaveLength(3);
    for (const label of expected) expect(label.length).toBeGreaterThan(0);
    // The three things the tray has to carry: get the window back, open a
    // project, and actually quit.
    expect(expected[0]).toContain('显示主窗口');
    expect(expected[2]).toContain('退出');
  });

  it('says nothing rather than guessing when the table is not there', () => {
    expect(trayMenuLabels('')).toEqual([]);
  });

  it('passes only when the app logged a menu carrying all three items', () => {
    // The observation half: the app writes the rows it built to its own log, so
    // the menu is checked instead of described. A menu that lost 退出 UCAD is
    // the app alive with no way out, which is the defect this step exists for.
    const logLine = JSON.stringify({ msg: 'tray menu built', meta: { items: expected } });

    expect(trayMenuVerdict({ logLine, expected, trayFault: null }).ok).toBe(true);
    expect(trayMenuVerdict({ logLine, expected, trayFault: null }).message).toContain('退出');

    const missingQuit = JSON.stringify({ msg: 'tray menu built', meta: { items: expected.slice(0, 2) } });
    const verdict = trayMenuVerdict({ logLine: missingQuit, expected, trayFault: null });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain(expected[2]!);
  });

  it('separates "no tray here" from "a menu that said nothing"', () => {
    // A host with no notification area has no menu to check, and the document
    // asks for that branch to be recorded rather than failed. The same silence
    // *with* a tray is the silent failure the tray exists to prevent.
    expect(
      trayMenuVerdict({ logLine: null, expected, trayFault: 'tray unavailable; closing the window will quit' }).ok,
    ).toBe(true);
    expect(trayMenuVerdict({ logLine: null, expected, trayFault: null }).ok).toBe(false);
  });
});

describe('the workspace row the verifier seeds', () => {
  it('inserts exactly the columns the app reads back', () => {
    // `activateMostRecentWorkspace()` restores the row this write creates, so the
    // column list is a contract with `session-store.ts`, not a private choice.
    const script = readFileSync(join(REPO_ROOT, 'scripts', 'verify-main-chain.mjs'), 'utf8');
    const store = readFileSync(
      join(REPO_ROOT, 'packages', 'session', 'src', 'session-store.ts'),
      'utf8',
    );

    const declared = /const WORKSPACE_COLUMNS =\s*'([^']+)'/.exec(store)?.[1];
    expect(declared, 'the workspace column list moved; this gate must move with it').toBeTruthy();

    const inserted = /INSERT OR REPLACE INTO workspaces \(([^)]+)\)/.exec(script)?.[1];
    expect(inserted).toBeTruthy();
    expect(inserted!.replace(/\s+/g, ' ').trim()).toBe(declared!.replace(/\s+/g, ' ').trim());
  });
});
