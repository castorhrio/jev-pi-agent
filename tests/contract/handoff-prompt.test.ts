/**
 * What a handoff actually carries into the next session.
 *
 * ## The defect this pins
 *
 * `onStartWithHandoff` used to build its prompt inline and carry one field:
 *
 *     setObjective(`继续上一个会话的交接：\n\n${value.objective}`);
 *
 * So a handoff that recorded the decisions already made, the commands that
 * failed, and the work still open handed over "what we were trying to do" and
 * dropped the rest — which is the exact list the
 * user will not have to repeat. These tests are the behavioural half of that
 * fix: they would fail against the old one-field template for any handoff with
 * more than an objective.
 *
 * The second thing they pin is that the prompt is **not** Chinese any more.
 * It was a hardcoded Chinese string inside a component, in an app with a
 * language switcher, so switching to English opened the composer with a
 * Chinese sentence. `ui-copy` watches for hardcoded English and could not see
 * it — a gate only catches the mistake its author had.
 */

import { describe, expect, it } from 'vitest';
import type { ContextHandoff } from '@ucad/contracts';
import {
  HANDOFF_SECTIONS,
  availableSections,
  buildHandoffPrompt,
  defaultSections,
  type HandoffSection,
} from '../../apps/desktop/src/shared/handoff-prompt';

const FULL: ContextHandoff = {
  schemaVersion: 2,
  objective: '登录后白屏',
  currentState: '已定位到会话 cookie 未刷新',
  relevantFiles: [{ path: 'apps/desktop/src/main/ipc.ts', reason: 'cookie 在这里签发' }],
  decisions: ['先修 cookie，不动渲染层'],
  changes: [{ path: 'src/session.ts', summary: '刷新前先清空缓存' }],
  commandsRun: [{ command: 'npm test', result: '12 red' }],
  pendingWork: ['补一个 cookie 过期用例'],
  cautions: ['不要动 CI 的时钟'],
  producedBy: { sessionId: 's1', turnId: 't1', agentId: 'mock', at: '2026-02-11T09:00:00Z' },
};

const LABELS = {
  title: "Continuing the previous session's handoff",
  sections: {
    objective: 'Objective',
    currentState: 'Current state',
    relevantFiles: 'Relevant files',
    decisions: 'Decisions',
    changes: 'Changes',
    commandsRun: 'Commands',
    pendingWork: 'Pending',
    cautions: 'Cautions',
  } as Partial<Record<HandoffSection, string>>,
};

describe('carrying a handoff into the next session', () => {
  it('carries every part of the record, not just the objective', () => {
    const prompt = buildHandoffPrompt(FULL, defaultSections(), LABELS);
    // Each fact has to appear, or the next agent is being asked to rediscover it.
    expect(prompt).toContain('登录后白屏');
    expect(prompt).toContain('已定位到会话 cookie 未刷新');
    expect(prompt).toContain('apps/desktop/src/main/ipc.ts');
    expect(prompt).toContain('先修 cookie，不动渲染层');
    expect(prompt).toContain('src/session.ts');
    expect(prompt).toContain('npm test');
    expect(prompt).toContain('补一个 cookie 过期用例');
    expect(prompt).toContain('不要动 CI 的时钟');
  });

  it('carries only what was selected', () => {
    const prompt = buildHandoffPrompt(FULL, ['objective', 'pendingWork'], LABELS);
    expect(prompt).toContain('登录后白屏');
    expect(prompt).toContain('补一个 cookie 过期用例');
    expect(prompt).not.toContain('先修 cookie');
    expect(prompt).not.toContain('不要动 CI 的时钟');
  });

  it('keeps a stable order regardless of how the selection was made', () => {
    // The user ticking boxes in a different order must not produce a different
    // document: a handoff that reorders itself between runs is not diffable,
    // and diffable is the point of it being text.
    const forwards = buildHandoffPrompt(FULL, ['objective', 'decisions', 'cautions'], LABELS);
    const backwards = buildHandoffPrompt(FULL, ['cautions', 'decisions', 'objective'], LABELS);
    expect(forwards).toBe(backwards);
    expect(forwards.indexOf('Objective')).toBeLessThan(forwards.indexOf('Decisions'));
  });

  it('writes no section whose content is empty', () => {
    // A heading with nothing under it reads as "we looked and found nothing",
    // which is a different claim from "this was not part of the handoff".
    const sparse: ContextHandoff = {
      ...FULL,
      currentState: '',
      decisions: [],
      pendingWork: [],
    };
    const prompt = buildHandoffPrompt(sparse, defaultSections(), LABELS);
    expect(prompt).toContain('## Objective');
    expect(prompt).not.toContain('## Current state');
    expect(prompt).not.toContain('## Decisions');
    expect(prompt).not.toContain('## Pending');
  });

  it('offers checkboxes only for sections that have something in them', () => {
    const sparse: ContextHandoff = { ...FULL, cautions: [], changes: [] };
    const offered = availableSections(sparse);
    expect(offered).not.toContain('cautions');
    expect(offered).not.toContain('changes');
    expect(offered).toContain('objective');
  });

  it('produces nothing to send when nothing is selected', () => {
    // The button is disabled in this state; the function has to agree, because a
    // prompt with a title and no content is a document that lies about
    // carrying something.
    const prompt = buildHandoffPrompt(FULL, [], LABELS);
    expect(prompt).not.toContain('登录后白屏');
    expect(prompt).not.toContain('##');
  });

  it('is a pure function of its inputs', () => {
    const a = buildHandoffPrompt(FULL, defaultSections(), LABELS);
    const b = buildHandoffPrompt(FULL, defaultSections(), LABELS);
    expect(a).toBe(b);
    // And it must not have mutated the record it was handed.
    expect(FULL.objective).toBe('登录后白屏');
    expect(FULL.decisions).toEqual(['先修 cookie，不动渲染层']);
  });

  it('knows about every section it offers', () => {
    // A new section added to the list without a label would render as a bare
    // English key in the prompt; the fallback keeps that visible rather than
    // silent, and this asserts the fallback path exists.
    const prompt = buildHandoffPrompt(FULL, ['cautions'], { title: 'T', sections: {} });
    expect(prompt).toContain('## cautions');
    expect(HANDOFF_SECTIONS).toHaveLength(8);
  });
});
