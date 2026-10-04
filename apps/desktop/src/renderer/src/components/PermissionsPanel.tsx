/**
 * Permission rules.
 *
 * The PermissionDialog answers one request at a time and then forgets about it.
 * The consequences of the answers that persist — "本次会话允许", "本项目允许" —
 * were written to `permission_rules` and were never shown to the user, so a
 * granted-and-forgotten rule looked exactly like no rule at all. This panel is
 * that list, and the only place a grant can be taken back.
 *
 * Scope is the part that is easy to misread, so it is stated three ways: a
 * badge, a plain-language column, and a filter. "Allow once" is deliberately
 * absent: it is not persistable (`PersistablePermissionDecision`), and saying
 * so prevents the reasonable assumption that it left a trace.
 */

import { useCallback, useEffect, useState } from 'react';
import type { PermissionRule } from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { Translate } from '../../../shared/i18n';

type Scope = 'all' | PermissionRule['scope'];

const SCOPES: ReadonlyArray<Scope> = ['all', 'session', 'workspace', 'global'];

export function PermissionsPanel(): JSX.Element {
  const t = useT();
  const [scope, setScope] = useState<Scope>('all');
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    void getApi()
      .permissions.listRules(scope === 'all' ? undefined : scope)
      .then((list) => {
        if (cancelled) return;
        setRules(list);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setRules([]);
        setError(errorMessage(cause, t));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope, t]);

  useEffect(() => load(), [load]);

  const revoke = useCallback(
    async (ruleId: string) => {
      setRevokeError(null);
      setRevoking(ruleId);
      try {
        await getApi().permissions.revokeRule(ruleId);
        load();
      } catch (cause) {
        setRevokeError(errorMessage(cause, t));
      } finally {
        setRevoking(null);
      }
    },
    [load, t],
  );

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('rules.title')}</h1>
        <p>{t('rules.subtitle')}</p>
      </div>

      <div className="card">
        <div className="row-gap" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
          {SCOPES.map((value) => (
            <button
              key={value}
              className={scope === value ? 'primary' : ''}
              onClick={() => setScope(value)}
            >
              {value === 'all' ? t('rules.filterAll') : t(`rules.scope_${value}`)}
            </button>
          ))}
          <span className="faint" style={{ fontSize: 11 }}>
            {t('rules.scopeHint')}
          </span>
        </div>

        {error && <div className="notice error">{error}</div>}
        {revokeError && (
          <div className="notice error" style={{ marginTop: 8 }}>
            {revokeError}
          </div>
        )}
        {!error && loading && <div className="faint">{t('common.loading')}</div>}
        {!error && !loading && rules.length === 0 && (
          <div className="empty" style={{ padding: '20px 8px' }}>
            {t('rules.empty')}
          </div>
        )}

        {rules.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>{t('rules.scope')}</th>
                <th>{t('rules.category')}</th>
                <th>{t('rules.matcher')}</th>
                <th>{t('rules.decision')}</th>
                <th>{t('rules.createdAt')}</th>
                <th style={{ width: 1 }}>
                  <span className="sr-only">{t('col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id}>
                  <td>
                    <span className={`badge ${scopeBadge(rule.scope)}`}>
                      {t(`rules.scope_${rule.scope}`)}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 11 }}>
                    {rule.category}
                  </td>
                  <td>
                    <div className="truncate" title={rule.matcher.value} style={{ maxWidth: 320 }}>
                      {rule.matcher.value}
                    </div>
                    <div className="faint mono" style={{ fontSize: 10.5 }}>
                      {rule.matcher.kind}
                    </div>
                  </td>
                  <td>
                    <span
                      className={`badge ${rule.decision === 'deny' ? 'err' : 'accent'}`}
                      title={t('rules.decisionFrom')}
                    >
                      {t(`permission.${rule.decision}`)}
                    </span>
                  </td>
                  <td className="mono" style={{ fontSize: 10.5 }}>
                    {rule.createdAt.slice(0, 19).replace('T', ' ')}
                  </td>
                  <td style={{ width: 1 }}>
                    <button
                      className="danger"
                      disabled={revoking === rule.id}
                      onClick={() => void revoke(rule.id)}
                    >
                      {revoking === rule.id ? t('rules.revoking') : t('rules.revoke')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="faint" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.7 }}>
          {t('rules.onceNote')}
        </div>
      </div>
    </div>
  );
}

function scopeBadge(scope: PermissionRule['scope']): string {
  if (scope === 'global') return 'err';
  if (scope === 'workspace') return 'warn';
  return '';
}

function errorMessage(error: unknown, t: Translate): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return t('common.unknown');
}
