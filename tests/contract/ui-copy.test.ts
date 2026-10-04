import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Two of the four defect classes that only screenshots could catch, turned
 * into gates.
 *
 * Background: rounds 7-12 kept finding the same two mistakes again and again
 * while every test was green.
 *
 *  1. **Duplicated copy** — two different components reusing one i18n key for
 *     two different situations. The terminal printed "No console yet. Click
 *     New console" twice on one screen, and the second copy sat directly above
 *     an input box, telling the user to do the thing they could already do.
 *
 *  2. **Hardcoded English** — a panel in a Chinese UI with an English label.
 *     Rounds 7 and 9 found twelve of these across the usage, agent, provider
 *     and storage tables.
 *
 * Both are cheap to scan for statically, and a gate that catches a *class*
 * beats fixing one instance. This is deliberately narrow: it reports real
 * findings rather than trying to be a general linter.
 */

const SRC = 'apps/desktop/src/renderer/src';
const componentsDir = join(SRC, 'components');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return name.endsWith('.tsx') ? [full] : [];
  });
}

const files = tsxFiles(componentsDir);

/**
 * Shorten a finding path to `src/components/X.tsx`. Written with `split`/`join`
 * rather than `String.replace` because `join` emits `\` on Windows, so the
 * forward-slash literal never matched and every finding printed the full path.
 */
const SRC_POSIX = SRC.split('\\').join('/');
const rel = (file: string): string =>
  file.split('\\').join('/').replace(`${SRC_POSIX}/`, 'src/');

describe('no hardcoded UI copy (defect class: English in a translated panel)', () => {
  /**
   * Attributes that are rendered to the user. `placeholder` and `title` both
   * show up in the interface; `aria-label` is announced.
   */
  const USER_FACING_ATTR = /(?:placeholder|title|aria-label)\s*=\s*"([^"]*)"/g;

  /**
   * Words that are legitimately not translated: keyboard keys, CSS-ish
   * tokens, and the fields the app shows a user *as identifiers* rather than
   * as prose.
   */
  const ALLOWED = [
    // Keyboard keys and literal key names.
    'Escape',
    'Enter',
    'Tab',
    // Technical identifiers a user is expected to recognise verbatim.
    'npx',
    'mcp/token',
    'providerId',
    'key',
    'agent',
    // Product / protocol names.
    'MCP',
    'Agent',
    'HTTP',
    'STDIO',
  ];

  /**
   * Values that are examples or identifiers rather than prose: a URL, a path,
   * a dotted identifier. `placeholder="https://mcp.example.com/mcp"` is
   * correct untranslated — a translated URL would be a different URL.
   */
  const looksLikeIdentifier = (value: string): boolean =>
    /^(https?:\/\/|\/|\.\/|[a-z]+[._-][a-z0-9._-]+$)/i.test(value);

  it('finds no user-facing attribute with an untranslated literal', () => {
    const findings: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(USER_FACING_ATTR)) {
        const value = match[1]!.trim();
        if (value.length === 0) continue;
        if (ALLOWED.includes(value)) continue;
        // A URL, path or dotted identifier is an example, not prose.
        if (looksLikeIdentifier(value)) continue;
        // Anything with a non-ASCII character is already localized.
        if (/[^\x20-\x7E]/.test(value)) continue;
        // Single words that are also i18n keys or CSS classes are not prose.
        if (value.includes('{') || value.includes('`')) continue;
        findings.push(`${rel(file)}: ${match[0].slice(0, 70)}`);
      }
    }

    expect(
      findings,
      `hardcoded user-facing copy:\n  ${findings.join('\n  ')}`,
    ).toEqual([]);
  });

  it('finds no bare English JSX text node', () => {
    const findings: string[] = [];
    // A text node: `>Some words here<` that is not an expression and not a tag.
    const TEXT_NODE = />([A-Z][A-Za-z]+(?: [A-Za-z]+)+)\s*</g;

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(TEXT_NODE)) {
        const value = match[1]!.trim();
        if (ALLOWED.includes(value)) continue;
        if (looksLikeIdentifier(value)) continue;
        if (/[^\x20-\x7E]/.test(value)) continue;
        // A literal inside `<th>` is the table-header defect, which the check
        // below owns. Without this, one bad header is reported by two gates
        // and the same line shows up twice in the report.
        const before = source.slice(Math.max(0, match.index! - 80), match.index);
        if (/<th\b[^<>]*$/.test(before)) continue;
        findings.push(`${rel(file)}: ${value}`);
      }
    }

    expect(
      findings,
      `bare English JSX text:\n  ${findings.join('\n  ')}`,
    ).toEqual([]);
  });

  it('finds no hardcoded table header', () => {
    const findings: string[] = [];
    // `<th>Some Label</th>` — a column heading written as a literal.
    const TH = /<th(?![^>]*className)([^>]*)>\s*([A-Za-z][A-Za-z ]*)\s*<\/th>/g;

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(TH)) {
        if (match[1]!.includes('{')) continue; // rendered expression
        findings.push(`${rel(file)}: <th>${match[2]!.trim()}</th>`);
      }
    }

    expect(
      findings,
      `hardcoded table headers:\n  ${findings.join('\n  ')}`,
    ).toEqual([]);
  });
});

/**
 * The "duplicated copy" half of this file is deliberately **not** a gate.
 *
 * The round-10 defect was `CommandConsole` reusing `terminal.empty`, so the
 * same sentence appeared twice on one screen. That is worth catching — but the
 * obvious static check for it (one i18n key rendered standalone more than
 * once) was tried here and reported **eleven** findings on clean code:
 * `empty.explorer` used by three empty states, `tab.changes` used as a
 * heading in two panels, `settings.title` in three places. Every one of them
 * is correct.
 *
 * Distinguishing "reused because it is the same thing" from "reused because
 * someone copy-pasted" is not decidable from the source alone, and a gate that
 * cries wolf gets switched off — which is worse than not having it, because
 * people stop reading the other three checks in this file too.
 *
 * So this class stays manual, and the two instances found in rounds 7 and 10
 * are recorded as known limitations rather than papered over with a noisy rule.
 */
describe('duplicated copy is still a manual check', () => {
  it('documents the known instances so they are not lost', () => {
    // Each entry is a real defect that shipped and was found by looking.
    const known = [
      'terminal.empty used by both the PTY card and the command console (round 10)',
      'change panel showed English labels under Chinese headings (round 7)',
    ];
    // The list is documentation, not an assertion — it is here so a future
    // reader knows this gap was considered and rejected, not overlooked.
    expect(known).toHaveLength(2);
  });
});
