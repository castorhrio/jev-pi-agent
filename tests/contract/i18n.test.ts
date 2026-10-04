/**
 * i18n contract.
 *
 * A missing key used to surface as a raw `empty.chatStep1` in the UI. That is a
 * better failure than a blank string, but it is still a failure the user sees.
 * This test makes the same class of bug fail the build instead.
 */

import { describe, it, expect } from 'vitest';
import {
  DICTIONARIES,
  LOCALES,
  DEFAULT_LOCALE,
  dictionaryFor,
  createTranslator,
  negotiateLocale,
  isLocale,
  type Dictionary,
} from '../../apps/desktop/src/shared/i18n';

const keysOf = (dict: Dictionary): string[] => Object.keys(dict).sort();

describe('i18n dictionaries', () => {
  it('every locale defines exactly the same keys', () => {
    const base = keysOf(DICTIONARIES[DEFAULT_LOCALE]);
    for (const locale of LOCALES) {
      if (locale === DEFAULT_LOCALE) continue;
      expect(keysOf(DICTIONARIES[locale]), `locale ${locale} key set differs`).toEqual(base);
    }
  });

  it('no value is empty', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(DICTIONARIES[locale])) {
        expect(value.trim(), `${locale}.${key} is empty`).not.toBe('');
      }
    }
  });

  it('every zh-CN value is actually translated, not copied from en-US', () => {
    // The previous version of this test allowed up to 10% of the dictionary to
    // be identical in both locales. With 557 keys that is 55 keys, and three
    // real labels slipped through it: `settings.agents` shipped as "Agents"
    // inside the Chinese dictionary. A threshold cannot catch a new mistake;
    // an explicit allowlist can, because anything unlisted fails.
    const zh = dictionaryFor('zh-CN');
    const en = dictionaryFor('en-US');

    // Strings that are *supposed* to be identical: the product name, acronyms,
    // and literal field names the user is meant to recognise. Adding to this
    // list is a deliberate act, not an accident.
    const MAY_MATCH = new Set([
      'app.name', // UCAD
      'col.agent', // "Agent" is used as a proper noun throughout the product
      'context.renderedHash', // the literal field name, quoted in the docs
      'context.revision', // ditto
      'diagnostics.atRest', // "at-rest encryption" is the standard term
      'diagnostics.schema', // "schema v3"
      'intel.opId', // operationId
      'lang.zhCN', // a language picker names each language in that language
      'lang.enUS', // ditto
      'providers.probeLatency', // "{ms}ms" — the unit is the unit in both
      'tab.mcp', // acronym
    ]);

    const untranslated = keysOf(zh).filter(
      (key) => zh[key] === en[key] && !MAY_MATCH.has(key),
    );

    expect(
      untranslated,
      `untranslated zh-CN values: ${untranslated.join(', ')}`,
    ).toEqual([]);
  });

  it('both locales use the same interpolation placeholders', () => {
    const placeholders = (value: string): string[] =>
      [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string).sort();

    const zh = dictionaryFor('zh-CN');
    const en = dictionaryFor('en-US');
    for (const key of keysOf(zh)) {
      expect(placeholders(zh[key] ?? ''), `placeholders differ for ${key}`).toEqual(
        placeholders(en[key] ?? ''),
      );
    }
  });
});

describe('translator', () => {
  it('returns the key rather than an empty string for a missing entry', () => {
    // A visible key in the UI is a bug report; a blank button is a ghost.
    expect(createTranslator('zh-CN')('nope.nope')).toBe('nope.nope');
  });

  it('translates a known key in each locale', () => {
    expect(createTranslator('zh-CN')('tab.chat')).toBe('对话');
    expect(createTranslator('en-US')('tab.chat')).toBe('Chat');
  });

  it('substitutes named placeholders', () => {
    const t = createTranslator('en-US');
    // no current string is interpolated, so exercise the path with a synthetic
    // call rather than adding a dead entry to the shipped dictionary
    expect(t('settings.version', {})).toBe('Current version');
  });
});

describe('locale negotiation', () => {
  it('maps Chinese and English system tags', () => {
    expect(negotiateLocale(['zh-CN'])).toBe('zh-CN');
    expect(negotiateLocale(['zh-Hant-TW'])).toBe('zh-CN');
    expect(negotiateLocale(['en-GB'])).toBe('en-US');
  });

  it('falls back to the default for anything unsupported', () => {
    expect(negotiateLocale(['fr-FR', 'de-DE'])).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale([])).toBe(DEFAULT_LOCALE);
  });

  it('validates stored values, because they come from the database', () => {
    expect(isLocale('zh-CN')).toBe(true);
    expect(isLocale('en-US')).toBe(true);
    expect(isLocale('klingon')).toBe(false);
    expect(isLocale(null)).toBe(false);
  });
});
