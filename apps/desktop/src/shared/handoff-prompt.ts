/**
 * What gets carried into the next session, and in what words.
 *
 * ## Why this is a module and not a template string in a component
 *
 * Because it used to be one. `onStartWithHandoff` built its prompt inline:
 *
 *     setObjective(`继续上一个会话的交接：\n\n${value.objective}`);
 *
 * Three things were wrong with that, and only the first was noticed at the
 * time:
 *
 *  1. **It carried the objective and nothing else.** The handoff holds the
 *     current state, the files that mattered, the decisions already made, the
 *     commands that were run, the pending work and the cautions. Dropping all
 *     of them means the next agent is handed "what we were trying to do" and
 *     none of "what we already decided, what failed, what is still open" —
 *     which is precisely the list the user will never have to restate
 *     have to repeat. The feature's own reason for existing, half used.
 *  2. **The prompt was hardcoded Chinese** in a component, in an app with a
 *     language switcher. Switch to English and the composer opened with a
 *     Chinese sentence. The `ui-copy` gate watches for hardcoded *English* and
 *     could not see this one, which is a fair reminder that a gate only
 *     catches the mistake its author had.
 *  3. **Nobody could choose.** Sometimes you do not want to hand over
 *     everything — a failed approach you want to retry yourself, a caution
 *     that is about the person rather than the work.
 *
 * ## The shape of the decision
 *
 * The picker defaults to **everything that has content**. The promise is "you
 * do not have to re-explain yourself", so the default has to be the full
 * record; choosing less is the deliberate act. An empty selection is refused
 * rather than accepted, because a handoff with nothing in it is a button that
 * lies about carrying something.
 */

import type { ContextHandoff } from '@ucad/contracts';

/**
 * The parts of a handoff a user can choose to carry.
 *
 * `key` is both the i18n key suffix and the identity used in the selection, so
 * adding a section here without a label shows up as a missing key rather than
 * as an unlabelled checkbox.
 */
export const HANDOFF_SECTIONS = [
  'objective',
  'currentState',
  'relevantFiles',
  'decisions',
  'changes',
  'commandsRun',
  'pendingWork',
  'cautions',
] as const;

export type HandoffSection = (typeof HANDOFF_SECTIONS)[number];

/** Every section, which is also the default selection. */
export function defaultSections(): HandoffSection[] {
  return [...HANDOFF_SECTIONS];
}

/**
 * The sections that actually have something in them.
 *
 * A checkbox for an empty section is a control that cannot change anything,
 * and a row of eight controls where two do nothing reads as "this panel is
 * broken" rather than "there is nothing here".
 */
export function availableSections(handoff: ContextHandoff): HandoffSection[] {
  return HANDOFF_SECTIONS.filter((section) => hasContent(handoff, section));
}

function hasContent(handoff: ContextHandoff, section: HandoffSection): boolean {
  const value = handoff[section];
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return false;
}

/** Label key for a section, e.g. `handoff.state_currentState` is not a thing. */
export function sectionLabelKey(section: HandoffSection): string {
  // The keys already exist for the rendered sections; reuse them rather than
  // inventing a second vocabulary for the same words.
  const existing: Partial<Record<HandoffSection, string>> = {
    objective: 'handoff.objective',
    currentState: 'handoff.state',
    relevantFiles: 'handoff.relevantFiles',
    decisions: 'handoff.decisions',
    changes: 'handoff.changes',
    commandsRun: 'handoff.commands',
    pendingWork: 'handoff.pending',
    cautions: 'handoff.cautions',
  };
  return existing[section] ?? 'handoff.objective';
}

/**
 * The text handed to the next session.
 *
 * `labels` is passed in rather than imported because the renderer and the main
 * process share one dictionary but this module must stay free of any locale
 * state: the caller is the only thing that knows which language is active.
 * A missing label degrades to the section name rather than to an empty heading,
 * so a gap in the dictionary cannot produce a section with no title.
 */
export function buildHandoffPrompt(
  handoff: ContextHandoff,
  selected: readonly HandoffSection[],
  labels: { title: string; sections: Partial<Record<HandoffSection, string>> },
): string {
  const order = HANDOFF_SECTIONS.filter((section) => selected.includes(section));
  const blocks: string[] = [];
  for (const section of order) {
    const body = renderSection(handoff, section);
    if (body === null) continue;
    blocks.push(`## ${labels.sections[section] ?? section}\n\n${body}`);
  }
  return [`# ${labels.title}`, '', ...blocks].join('\n');
}

function renderSection(handoff: ContextHandoff, section: HandoffSection): string | null {
  switch (section) {
    case 'objective':
      return orNull(handoff.objective);
    case 'currentState':
      return orNull(handoff.currentState);
    case 'relevantFiles':
      return listOrNull(
        (handoff.relevantFiles ?? []).map((f) => `- \`${f.path}\` — ${f.reason}`),
      );
    case 'decisions':
      return listOrNull((handoff.decisions ?? []).map((d) => `- ${d}`));
    case 'changes':
      return listOrNull((handoff.changes ?? []).map((c) => `- \`${c.path}\` — ${c.summary}`));
    case 'commandsRun':
      return listOrNull((handoff.commandsRun ?? []).map((c) => `- \`${c.command}\` → ${c.result}`));
    case 'pendingWork':
      return listOrNull((handoff.pendingWork ?? []).map((p) => `- [ ] ${p}`));
    case 'cautions':
      return listOrNull((handoff.cautions ?? []).map((c) => `- ⚠ ${c}`));
    default:
      return null;
  }
}

function orNull(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function listOrNull(lines: string[]): string | null {
  const kept = lines.filter((line) => line.replace(/^[-[`\s]*/, '').trim().length > 0);
  return kept.length > 0 ? kept.join('\n') : null;
}
