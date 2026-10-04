/**
 * Locale context for the Renderer.
 *
 * The initial locale comes from Main (stored preference, else the OS
 * language), and changing it here also calls `app.setLocale` so the native menu
 * relabels itself. One source of truth for both surfaces is the point: a
 * Chinese menu with an English page is worse than no localization.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { UcadApi } from '@ucad/contracts';
import { createTranslator, DEFAULT_LOCALE, type Locale, type Translate } from '../../shared/i18n';

interface I18nValue {
  locale: Locale;
  t: Translate;
  setLocale: (locale: Locale) => Promise<void>;
  /** true until Main has answered; avoids a flash of the wrong language */
  ready: boolean;
}

const I18nContext = createContext<I18nValue>({
  locale: DEFAULT_LOCALE,
  t: createTranslator(DEFAULT_LOCALE),
  setLocale: async () => undefined,
  ready: false,
});

export function I18nProvider({
  children,
  api,
}: {
  children: ReactNode;
  api: UcadApi;
}): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const stored = await api.app.getLocale();
        if (!cancelled && (stored === 'zh-CN' || stored === 'en-US')) {
          setLocaleState(stored);
        }
      } catch {
        // A missing locale is not worth failing startup over; the default stands.
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const setLocale = useCallback(
    async (next: Locale) => {
      setLocaleState(next);
      document.documentElement.lang = next;
      try {
        await api.app.setLocale(next);
      } catch {
        // The UI already switched; the stored preference is best-effort.
      }
    },
    [api],
  );

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<I18nValue>(
    () => ({ locale, t: createTranslator(locale), setLocale, ready }),
    [locale, setLocale, ready],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}

/** Shorthand for the common case. */
export function useT(): Translate {
  return useContext(I18nContext).t;
}
