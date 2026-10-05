/**
 * Renderer state: persisted-entity queries plus the live session reducer
 * (§12.2). Two layers, deliberately not one global store holding the whole
 * event history.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentCatalogEntry,
  SessionDto,
  SettingsSnapshot,
  TurnEvent,
  UsageSummaryDto,
  WorkspaceDto,
  CodeIntelligenceManifest,
  IntelligenceStatus,
  ToolDescriptorDto,
  McpServerDto,
  DiagnosticsInfo,
} from '@ucad/contracts';
import { getApi } from '../api';
import { emptySessionView, mergeDeltaText, reduceEvent, type SessionViewState } from './session-reducer';

/**
 * The reads in `refresh` that are guarded individually, named after the field
 * each one fills.
 *
 * The key set is the whole point: a value and the reason it is missing share
 * one name, so a panel cannot look up a reason that does not exist and a new
 * guarded read cannot be added without deciding how it reports failure. This
 * replaced a `sessionsError` field plus four bare `.catch(() => fallback)`
 * calls, which is the shape that let a failed read render as an empty one.
 */
type EndpointKey =
  | 'sessions'
  | 'providers'
  | 'providerStatus'
  | 'tools'
  | 'usage'
  | 'diagnostics';

export interface AppData {
  workspace: WorkspaceDto | null;
  sessions: SessionDto[];
  activeSession: SessionDto | null;
  agents: AgentCatalogEntry[];
  settings: SettingsSnapshot | null;
  providers: CodeIntelligenceManifest[];
  providerStatus: IntelligenceStatus | null;
  tools: ToolDescriptorDto[];
  mcpServers: McpServerDto[];
  usage: UsageSummaryDto | null;
  diagnostics: DiagnosticsInfo | null;
  /** re-queries every persisted entity; call after a mutation */
  refresh: () => Promise<void>;
  /**
   * Set when the last load failed. A silent failure here is what made the app
   * look like "no project is open" when one was.
   */
  loadError: string | null;
  /**
   * Why an individually guarded read failed, keyed by the field it fills.
   *
   * These reads are guarded so one dead subsystem cannot blank the whole
   * window. The cost of guarding is that a failure then looks *exactly* like an
   * empty result unless the reason travels with it — and it did not:
   * `diagnostics.info()` failing rendered a red **"not encrypted"** badge, a
   * runtime card of `—`, and "no log entries" on the one page whose entire job
   * is telling the user what is actually true. A failed read is not a fact
   * about the world; `diagnostics: null` on its own is not a fact at all.
   *
   * Separate keys rather than one `loadError` because these reads fail
   * independently: a readable workspace says nothing about a readable log.
   */
  endpointErrors: Partial<Record<EndpointKey, string>>;
  /**
   * True until the first load settles, successfully or not.
   *
   * This is the third state, and it is the one that was missing. `sessions: []`
   * means two different things — "loaded, and there are none" and "has not
   * come back yet" — and the sidebar used to render the first as if it were
   * both. On a slow start that reads as *you have no sessions, click + to make
   * one*, which is a false statement that invites the user to create a
   * duplicate. This is the "'could not read it' shown
   * as 'there is nothing there'") as the failure mode that is more insidious
   * than a crash, because it has no sound.
   */
  loading: boolean;
}

const EMPTY: AppData = {
  workspace: null,
  sessions: [],
  activeSession: null,
  agents: [],
  settings: null,
  providers: [],
  providerStatus: null,
  tools: [],
  mcpServers: [],
  usage: null,
  diagnostics: null,
  refresh: async () => undefined,
  loadError: null,
  endpointErrors: {},
  loading: true,
};

export function useAppData(activeSessionId: string | null): AppData {
  const [data, setData] = useState<AppData>(EMPTY);
  const [tick, setTick] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = getApi();
    /**
     * Runs one optional read, records why it failed, and hands back a fallback
     * so a dead subsystem cannot reject the whole batch and blank the window.
     *
     * A thunk rather than a promise on purpose: `api.x.y()` that throws
     * *synchronously* never reaches the old `.catch(() => fallback)` shape
     * either, and a sync throw here would escape into the outer `catch` and
     * take the entire load down with it.
     *
     * Recording the reason is not something the caller can forget — that is
     * the entire point. The previous code wrote `.catch(() => [])` in four
     * places and each of those four was a panel quietly claiming there was
     * nothing there.
     */
    const endpointErrors: Partial<Record<EndpointKey, string>> = {};
    const guarded = async <T>(key: EndpointKey, read: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await read();
      } catch (err) {
        endpointErrors[key] = err instanceof Error ? err.message : String(err);
        return fallback;
      }
    };

    try {
      // The workspace comes first because the session list is scoped to it —
      // asking for "all sessions" would put another project's conversations in
      // this project's sidebar.
      const [workspaces, agents, settings, providers, tools, usage, diagnostics] =
        await Promise.all([
          api.workspace.listRecent(),
          api.agents.list(),
          api.settings.get(),
          guarded('providers', () => api.intelligence.listProviders(), []),
          guarded('tools', () => api.tools.list(), [] as ToolDescriptorDto[]),
          guarded('usage', () => api.usage.summary({}), null),
          guarded('diagnostics', () => api.diagnostics.info(), null),
        ]);

      const workspace = workspaces[0] ?? null;
      // A failed session list is NOT the same as an empty one. Swallowing it
      // made a real project look freshly installed: the sidebar said "no
      // sessions yet" when it actually could not read them. The reason is
      // kept so the UI can say so.
      const sessions = await guarded('sessions', () => api.sessions.list(workspace?.id), []);

      const activeSession =
        sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null;

      // No workspace means there is nothing to have a status for. That is an
      // absent fact rather than an unreadable one, so it records no error.
      const providerStatus = workspace
        ? await guarded('providerStatus', () => api.intelligence.status(workspace.id), null)
        : null;

      setData({
        workspace,
        sessions,
        activeSession,
        agents,
        settings,
        providers,
        providerStatus,
        tools,
        mcpServers: settings?.mcp?.servers ?? [],
        usage,
        diagnostics,
        refresh: async () => undefined,
        loadError: null,
        // Replaced wholesale, never merged: a read that succeeds this time must
        // not keep last time's reason on screen.
        endpointErrors,
        // The load has landed. Only now may the UI say "there are none".
        loading: false,
      });
      setLoadError(null);
    } catch (error) {
      // Every Main handler rejects with a real `Error` (`toUserError` in
      // main/ipc.ts), so the renderer never sees the `AppError` *object* that
      // `describeError` exists for — and it imports no runtime code from
      // `@ucad/contracts` on purpose, keeping the Vite bundle free of the CJS
      // contracts package.
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      // A failed load is also a settled load. Leaving `loading` true here would
      // leave the window saying "loading…" forever next to an error message.
      setData((current) => ({ ...current, loadError: message, loading: false }));
    }
  }, [activeSessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, tick]);

  // An adapter host can still be starting when the first query lands (a cold
  // start forks a process). Re-query briefly while the catalogue is empty so the
  // picker fills in on its own instead of looking permanently broken.
  useEffect(() => {
    if (data.agents.length > 0 || data.loadError) return;
    const timer = setTimeout(() => {
      setTick((value) => value + 1);
    }, 700);
    return () => clearTimeout(timer);
  }, [data.agents.length, data.loadError]);

  return { ...data, refresh, loadError };
}

/**
 * The NFR-03 recovery flow: on mount, read `latestSeq`, then backfill with
 * `events.since`, and only then attach the live subscription. Doing it in this
 * order is what closes the gap between a page load and the event stream.
 */
/**
 * Streaming deltas are coalesced in the Renderer too.
 *
 * Folding every delta straight into React state is quadratic: each one copies
 * the message array, so a 2 000-delta response does 2 000 array copies and
 * 2 000 re-renders. Deltas for the *same* message are therefore accumulated
 * into a pending buffer and committed on an animation frame — the user cannot
 * perceive 60 fps text, but they can perceive jank. Durable events (tool,
 * permission, decision, turn, error) flush the buffer first and are applied
 * immediately, so nothing that matters is ever delayed.
 */
const STREAM_COMMIT_MS = 60;

export interface SessionEvents {
  view: SessionViewState;
  /**
   * Set when the replay/subscription could not be established. Previously this
   * failure was invisible: `start()` rejected with nobody listening, so the
   * conversation stayed permanently empty with no indication that anything had
   * gone wrong. The user saw "no messages" and concluded they had no history.
   */
  error: string | null;
  /** Sequence gaps observed in the live stream (NFR-03). Surfaced, not hidden. */
  gaps: Array<{ afterSeq: number; count: number }>;
  /**
   * True while a session's history is still being replayed.
   *
   * An empty conversation and a conversation that has not arrived yet look
   * identical without it, and the difference matters: the first-run block tells
   * the user what will happen and invites them to type, so showing it over an
   * unfinished replay claims a history that may well be there.
   */
  replaying: boolean;
}

export function useSessionEvents(sessionId: string | null): SessionEvents {
  const [state, setState] = useState<SessionViewState>(() =>
    sessionId ? emptySessionView(sessionId) : emptySessionView(''),
  );
  const [error, setError] = useState<string | null>(null);
  const [gaps, setGaps] = useState<Array<{ afterSeq: number; count: number }>>([]);
  const [replaying, setReplaying] = useState(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  /**
   * The highest seq folded from the LIVE stream, kept outside React state so
   * gap detection can run synchronously in the event callback.
   *
   * It used to run inside a `setState` updater. An updater must be pure, but
   * this one called `setGaps` as a side effect — and React double-invokes
   * updaters in development, so every real gap was reported twice. Worse, the
   * natural "fix" of reading `state.lastSeq` in the callback would trail a
   * batch of queued updates, so the ref is the authority and the updaters stay
   * pure.
   */
  const liveSeqRef = useRef(0);
  /** The session the current view belongs to, so a switch resets the fold. */
  const viewSessionRef = useRef<string | null>(null);
  const pending = useRef<{ messageId: string; text: string; turnId: string; ts: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setState(emptySessionView(''));
      setError(null);
      setReplaying(false);
      setGaps([]);
      liveSeqRef.current = 0;
      viewSessionRef.current = null;
      return;
    }
    const api = getApi();
    let cancelled = false;

    // The replay folds its snapshot into the live view instead of replacing
    // it, so a session switch must start from a clean view — folding session
    // B's events into session A's view would merge two conversations. The seq
    // guard cannot tell those apart: both streams just count from one.
    if (viewSessionRef.current !== sessionId) {
      viewSessionRef.current = sessionId;
      liveSeqRef.current = 0;
      setGaps([]);
      setState(emptySessionView(sessionId));
    }

    const flushPending = () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const buf = pending.current;
      pending.current = null;
      if (!buf) return;
      setState((prev) => ({
        ...prev,
        // The buffer's deltas each advanced seq accounting when they arrived;
        // the commit merges their text and must not advance it again. A commit
        // that minted `lastSeq + 1` collided with the seq of the next real
        // event, which the reducer then dropped as already-folded — the
        // observable form was a turn whose `turn.completed` vanished, leaving
        // the composer stuck on Stop forever.
        messages: mergeDeltaText(prev, buf),
      }));
    };

    const start = async () => {
      /*
       * Subscribe BEFORE reading the store.
       *
       * The replay used to run first and the subscription was attached last,
       * which left a window: an event emitted while `latestSeq`/`since` were in
       * flight was in neither the snapshot nor the stream, and the turn it
       * belonged to never reached the transcript. Sending during that window is
       * not exotic — it is what happens when a send lands while the session
       * view is still attaching. Subscribing first closes it: everything after
       * the subscribe is delivered live, everything before is in the snapshot,
       * and an event in both is deduplicated by the reducer's seq guard.
       *
       * The reducer fold is idempotent, so overlap replays as a no-op. What
       * must NOT happen during replay is gap *detection*: a live event that the
       * snapshot also contains can arrive before the snapshot is folded, and
       * the ref has not seen the intervening seqs yet. `settled` gates it.
       */
      let settled = false;
      const handleEvent = (event: TurnEvent) => {
        if (event.sessionId !== sessionId) return;

        const folded = liveSeqRef.current;
        if (settled && event.seq > folded + 1 && folded > 0) {
          setGaps((g) => [...g, { afterSeq: folded, count: event.seq - folded - 1 }]);
        }
        liveSeqRef.current = Math.max(folded, event.seq);

        if (event.type === 'text.delta') {
          const payload = event.payload as { text: string; messageId: string };
          // Coalesce only into the same message; a new messageId commits now.
          if (pending.current?.messageId === payload.messageId) {
            pending.current.text += payload.text;
          } else {
            flushPending();
            pending.current = {
              messageId: payload.messageId,
              text: payload.text,
              turnId: event.turnId,
              ts: event.ts,
            };
          }
          // lastSeq still advances per delta so gap detection stays honest.
          setState((prev) => (event.seq > prev.lastSeq ? { ...prev, lastSeq: event.seq } : prev));
          if (!timer.current) {
            timer.current = setTimeout(flushPending, STREAM_COMMIT_MS);
          }
          return;
        }

        // Flush before folding so the durable event is reduced against a
        // transcript that already contains the buffered text, and so its own
        // seq guard sees the true head of the stream.
        flushPending();
        setState((prev) => reduceEvent(prev, event));
      };
      unsubscribeRef.current?.();
      unsubscribeRef.current = api.sessions.onEvent(handleEvent);

      // `since(0)` is the authoritative full backfill, so `latestSeq` is only
      // needed to detect a stream that moved before we attached.
      const latest = await api.events.latestSeq(sessionId);
      const backfill = await api.events.since({ sessionId, afterSeq: 0 });

      if (cancelled) return;

      // Fold the snapshot INTO the current view rather than replacing it:
      // events that arrived live while the reads were in flight are already in
      // `prev`, and replacing it here would silently discard them. Overlap is
      // dropped by the seq guard.
      setState((prev) => {
        let next = prev;
        for (const event of backfill) next = reduceEvent(next, event);
        return next;
      });
      setError(null);

      // If the store's head still moves past what we replayed, events landed
      // in the window between the snapshot and the subscribe (a backend that
      // snapshots before we attached). Say so (NFR-03 / V-3) rather than
      // presenting a silently truncated history as complete. The ref skips to
      // the store's head so a live event continuing from there is not counted
      // against the same hole twice.
      let acc = liveSeqRef.current;
      for (const event of backfill) acc = Math.max(acc, event.seq);
      liveSeqRef.current = Math.max(liveSeqRef.current, acc, latest);
      if (latest > liveSeqRef.current) {
        setGaps([{ afterSeq: liveSeqRef.current, count: latest - liveSeqRef.current }]);
      } else {
        setGaps([]);
      }
      settled = true;

      // Events that landed between the backfill and the subscription are a
      // real gap. Reporting it beats silently showing a truncated history.
    };

    // The catch is the whole point: an unhandled rejection here used to leave
    // the conversation permanently blank with no error anywhere.
    setReplaying(true);
    void start()
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        // A failed replay is finished too. Leaving this true would pin the
        // conversation on "loading…" beside the error explaining why.
        if (!cancelled) setReplaying(false);
      });

    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
      pending.current = null;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [sessionId]);

  return { view: state, error, gaps, replaying };
}

export function usePermissionQueue(
  state: SessionViewState,
): {
  pending: SessionViewState['permissions'];
  respond: (requestId: string, decision: string) => Promise<void>;
  busy: boolean;
  error: string | null;
} {
  const pending = useMemo(
    () => state.permissions.filter((p) => !p.resolved),
    [state.permissions],
  );
  // §4.9: an unanswered request is *rejected* after the timeout, not silently
  // dropped. That means the dialog can outlive the request it is showing, and a
  // click on a dead request used to reject into nothing at all — the user saw a
  // button that did nothing and had no way to learn the request had expired.
  const [busy, setBusy] = useState(false);

  // A new request must clear the previous failure, or an error about request A
  // is displayed above request B.
  const head = pending[0]?.requestId ?? null;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [head]);

  const respond = useCallback(async (requestId: string, decision: string) => {
    // Guarded, not merely styled: two rapid clicks would otherwise send two
    // responses for one request, and the second is a protocol error.
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await getApi().permissions.respond(requestId, decision as never);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return { pending, respond, busy, error };
}
