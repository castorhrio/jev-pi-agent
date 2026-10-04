import { useEffect, useState } from 'react';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { AppData } from '../state/hooks';
import type { SessionViewState } from '../state/session-reducer';
import { DiffView } from './Panels';

type PreviewTab = 'context' | 'tools' | 'decisions' | 'plan';

/**
 * The preview column.
 *
 * Codex App's third column is the reason that product can be supervised rather
 * than just chatted with: whatever the agent is working on is visible next to
 * what it is saying. For UCAD the two things worth watching are the context it
 * was given and the tools it is calling - so those are the first two tabs, and
 * decisions follow because "why did it do that" is the question this product
 * exists to answer.
 */
export function PreviewPane({
  data,
  view,
}: {
  data: AppData;
  view: SessionViewState;
}): JSX.Element {
  const t = useT();
  const [tab, setTab] = useState<PreviewTab>('context');
  const [pack, setPack] = useState<Awaited<ReturnType<typeof loadPack>>>(null);
  const [diff, setDiff] = useState<string | null>(null);

  useEffect(() => {
    const packId = view.context?.packId;
    if (!packId) {
      setPack(null);
      return;
    }
    let cancelled = false;
    void loadPack(packId).then((result) => {
      if (!cancelled) setPack(result);
    });
    return () => {
      cancelled = true;
    };
  }, [view.context?.packId, view.context?.revision]);

  useEffect(() => {
    if (tab !== 'plan' || diff !== null || !data.workspace) return;
    let cancelled = false;
    void getApi()
      .git.diff({})
      .then((d) => {
        if (!cancelled) setDiff(d.binary ? '' : d.patch);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tab, diff, data.workspace]);

  const tabs: Array<{ id: PreviewTab; label: string; count?: number }> = [
    { id: 'context', label: t('context.title') },
    {
      id: 'tools',
      label: t('preview.tools'),
      count: view.tools.length || undefined,
    },
    {
      id: 'decisions',
      label: t('decision.title'),
      count: view.decisions.length || undefined,
    },
    { id: 'plan', label: t('preview.plan') },
  ];

  return (
    <aside className="preview" aria-label={t('common.preview')}>
      <div className="preview-tabs" role="navigation" aria-label={t('common.preview')}>
        {tabs.map((entry) => (
          <button
            key={entry.id}
            className={`preview-tab ${tab === entry.id ? 'active' : ''}`}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {entry.count !== undefined && <span className="count"> {entry.count}</span>}
          </button>
        ))}
      </div>

      <div className="preview-body">
        {tab === 'context' && <ContextTab view={view} pack={pack} />}
        {tab === 'tools' && <ToolsTab view={view} />}
        {tab === 'decisions' && <DecisionsTab view={view} />}
        {tab === 'plan' && (
          <div className="block">
            <div className="block-title">{t('tab.changes')}</div>
            {diff === null ? (
              <div className="faint">{t('common.loading')}</div>
            ) : diff === '' ? (
              <div className="faint">{t('empty.diff')}</div>
            ) : (
              <DiffView patch={diff} />
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

async function loadPack(packId: string) {
  return getApi()
    .context.getPack(packId)
    .catch(() => null);
}

function ContextTab({
  view,
  pack,
}: {
  view: SessionViewState;
  pack: Awaited<ReturnType<typeof loadPack>>;
}): JSX.Element {
  const t = useT();
  if (!view.context) {
    return (
      <>
        <div className="faint">{t('context.waiting')}</div>
        <div className="faint" style={{ fontSize: 11.5, marginTop: 8, lineHeight: 1.7 }}>
          {t('context.waitingDetail')}
        </div>
      </>
    );
  }

  const items = pack?.items ?? [];

  return (
    <>
      <div className="block">
        <div className="block-title">{t('context.title')}</div>
        <div className="defs">
          <Row k={t('context.strategy')} v={view.context.strategy} />
          <Row k={t('context.items')} v={view.context.itemCount} />
          <Row
            k={t('context.omitted')}
            v={view.context.omittedCount || (pack?.omitted.length ?? 0)}
          />
          <Row k={t('context.revision')} v={view.context.revision} />
          <Row k="mode" v={view.context.injectionMode} />
          <Row k={t('context.estimateSource')} v={view.context.estimateSource} />
        </div>
        <div className="faint" style={{ fontSize: 10.5, marginTop: 6 }}>
          {t('context.estimateNote')}
        </div>
      </div>

      {items.length > 0 && (
        <div className="block">
          <div className="block-title">{t('context.items')}</div>
          <div className="defs">
            {items.slice(0, 12).map((item) => (
              <Row
                key={item.id}
                k={item.kind}
                v={
                  <span className="truncate" title={item.source.reference ?? item.id}>
                    {item.freshness.stale ? '! ' : ''}
                    {(item.source.reference ?? item.id).split(/[\\/]/).pop()}
                  </span>
                }
              />
            ))}
          </div>
          {items.length > 12 && (
            <div className="faint" style={{ fontSize: 10.5, marginTop: 5 }}>
              +{items.length - 12}
            </div>
          )}
        </div>
      )}

      {pack?.injection && (
        <div className="block">
          <div className="block-title">{t('context.renderedHash')}</div>
          <div className="code" style={{ maxHeight: 200, fontSize: 10.5 }}>
            {pack.injection.renderedHash}
          </div>
        </div>
      )}
    </>
  );
}

function ToolsTab({ view }: { view: SessionViewState }): JSX.Element {
  const t = useT();
  if (view.tools.length === 0 && view.commands.length === 0) {
    return <div className="faint">{t('preview.noTools')}</div>;
  }
  return (
    <>
      {view.tools.length > 0 && (
        <div className="block">
          <div className="block-title">{t('preview.tools')}</div>
          <div className="defs">
            {view.tools
              .slice()
              .reverse()
              .slice(0, 10)
              .map((tool) => (
                <div className="def" key={tool.toolCallId}>
                  <span className="k mono truncate" title={tool.name}>
                    {tool.name}
                  </span>
                  <span className={`badge ${statusBadge(tool.status)}`}>
                    {tool.durationMs !== undefined ? `${tool.durationMs}ms` : tool.status}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}

      {view.commands.length > 0 && (
        <div className="block">
          <div className="block-title">{t('preview.commands')}</div>
          <div className="defs">
            {view.commands
              .slice()
              .reverse()
              .map((cmd) => (
                <div className="def" key={cmd.commandId}>
                  <span className="k mono truncate" title={cmd.command}>
                    $ {cmd.command}
                  </span>
                  <span className={`badge ${cmd.exitCode === 0 ? 'ok' : cmd.exitCode === null ? '' : 'err'}`}>
                    {cmd.exitCode === null ? '...' : cmd.exitCode}
                  </span>
                </div>
              ))}
          </div>
        </div>
      )}
    </>
  );
}

function DecisionsTab({ view }: { view: SessionViewState }): JSX.Element {
  const t = useT();
  if (view.decisions.length === 0) {
    return <div className="faint">{t('empty.decision')}</div>;
  }
  return (
    <div className="defs">
      {view.decisions
        .slice()
        .reverse()
        .map((decision) => (
          <div className="block" key={decision.requestId}>
            <div className="block-title">
              <span>{decision.kind}</span>
              <span>{Math.round(decision.confidence * 100)}%</span>
            </div>
            <div style={{ fontSize: 12.5 }}>{decision.summary}</div>
            <div className="faint" style={{ fontSize: 11.5, marginTop: 4 }}>
              {decision.rationale}
            </div>
            <div className="faint" style={{ fontSize: 10.5, marginTop: 4 }}>
              {decision.engineId}
              {decision.fallbackUsed && <span className="badge warn" style={{ marginLeft: 6 }}>fallback</span>}
            </div>
          </div>
        ))}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }): JSX.Element {
  return (
    <div className="def">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  );
}

function statusBadge(status: string): string {
  if (status === 'ok') return 'ok';
  if (status === 'error' || status === 'denied') return 'err';
  return '';
}
