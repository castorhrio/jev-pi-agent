/**
 * §11.2 — the User Terminal.
 *
 * What this surface is: a real PTY. `node-pty` is spawned in **Main**, and this
 * component only ever sees a chunked data channel and a keystroke channel over
 * the typed preload bridge — `node-pty` never crosses into the Renderer (NFR-01).
 * The screen itself is `xterm.js`, so echo, cursor addressing and full-screen
 * programs (`vim`, `top`, `htop`) work the way they do in a real terminal.
 *
 * The three shells §11.2 requires the UI to keep apart:
 *
 *  1. **This one — the User Terminal.** The user's own shell, in the project
 *     folder. Not permission-gated: the human is not the agent, and gating a
 *     person's own shell would make the tool useless.
 *  2. **The UCAD-managed agent shell** (§9, NFR-02). `CommandRunner`, which the
 *     agent runs commands through and which the Permission Engine gates. Those
 *     commands appear as `command.*` cards in the transcript.
 *  3. **The vendor shell**, inside the agent's own runtime. UCAD does not
 *     intercept it and does not pretend to.
 *
 * The non-PTY command console (piped stdio) is deliberately still here, below
 * the terminal. It is the surface that works when the optional `node-pty`
 * native module failed to build, so removing it would have left those machines
 * with no way to run a command at all.
 *
 * Degradation is always stated, never implied: an absent PTY shows Main's own
 * reason for it; a session that has produced nothing yet says so instead of
 * showing an empty pane that reads as "the command produced no output".
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { PtyAvailabilityDto, PtyDataEvent, PtyExitEvent, TerminalDataEvent, UcadApi } from '@ucad/contracts';
import { getApi } from '../api';
import { useT } from '../i18n-context';
import type { AppData } from '../state/hooks';

// ---------------------------------------------------------------------------
// session registry
// ---------------------------------------------------------------------------

/**
 * Module scope on purpose. Switching to another surface unmounts this panel, and
 * a pty must not die because the user glanced at the Explorer: the sessions live
 * here, `xterm` is rebuilt on return, and the scrollback is replayed into it.
 */
interface PtySession {
  id: string;
  cwd: string;
  /** Everything the shell has produced, bounded (NFR-06). Replayed on remount. */
  replay: string;
  /** Received but not yet painted. Coalesced like the transcript deltas. */
  pending: string;
  state: 'running' | 'ended';
  /** Shown verbatim when the shell ends. A PTY has an exit code; a pipe does not. */
  exit: string | null;
  xterm: Terminal | null;
  fit: FitAddon | null;
}

const sessions = new Map<string, PtySession>();

/**
 * NFR-06: a terminal is unbounded by nature. 256 KiB of replay per session is
 * the same ceiling the event log uses for an inline payload; past that the view
 * is rebuilt from the live tail rather than from a buffer that grew all day.
 */
const REPLAY_LIMIT_BYTES = 256 * 1024;

/** A PTY can emit far faster than a screen repaints; commit on a tick. */
const PAINT_INTERVAL_MS = 16;

/** The shell exists before the pane has been laid out, so start at a sane size. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

const MONO =
  'ui-monospace, "Cascadia Code", "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

// ---------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------

export function TerminalPanel({ data }: { data: AppData }): JSX.Element {
  const t = useT();
  const api = useMemo(() => getApi(), []);
  const [availability, setAvailability] = useState<PtyAvailabilityDto | null>(null);
  const [ids, setIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const workspacePath = data.workspace?.path ?? null;
  const hasSession = data.sessions.length > 0;

  // Availability is asked once, on mount. It is a property of the install (did
  // the native module build?), not of the pane, so it does not change under the
  // user while they are typing.
  useEffect(() => {
    let cancelled = false;
    void api.terminal
      .ptyStatus()
      .then((status) => {
        if (!cancelled) setAvailability(status);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // Main is the only thing that knows. If even the status call fails, the
        // terminal is not usable and the reason has to be on screen.
        setAvailability({
          available: false,
          reason: message(error),
          platform: 'unknown',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  // One subscription for the whole surface, filtered by terminalId. Output
  // lands in the registry even when the pane is not mounted, so a session that
  // was running in the background is still complete when the user comes back.
  useEffect(() => {
    const offData = api.terminal.onPtyData((event: PtyDataEvent) => {
      const session = sessions.get(event.terminalId);
      if (session === undefined) return;
      session.replay = tail(session.replay + event.chunk, REPLAY_LIMIT_BYTES);
      session.pending += event.chunk;
    });
    const offExit = api.terminal.onPtyExit((event: PtyExitEvent) => {
      const session = sessions.get(event.terminalId);
      if (session === undefined) return;
      session.state = 'ended';
      session.exit = `exit ${event.exitCode}`;
      setIds((list) => list);
    });
    return () => {
      offData();
      offExit();
    };
  }, [api]);

  // The paint tick. Folding every chunk straight into xterm would make a busy
  // build stutter; one write per frame is what a terminal can actually show.
  useEffect(() => {
    const timer = setInterval(() => {
      for (const session of sessions.values()) {
        if (session.pending.length === 0 || session.xterm === null) continue;
        const data = session.pending;
        session.pending = '';
        session.xterm.write(data);
      }
    }, PAINT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const create = useCallback(async () => {
    setFailure(null);
    if (!workspacePath) {
      setFailure(t('terminal.needsWorkspace'));
      return;
    }
    setBusy(true);
    try {
      const { terminalId } = await api.terminal.ptyCreate({
        cwd: workspacePath,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      sessions.set(terminalId, {
        id: terminalId,
        cwd: workspacePath,
        replay: '',
        pending: '',
        state: 'running',
        exit: null,
        xterm: null,
        fit: null,
      });
      setIds((list) => [...list, terminalId]);
      setSelected(terminalId);
    } catch (error) {
      // Main refuses with the real reason (a missing native module, a directory
      // outside the workspace). "Nothing happened" would read as a dead button.
      setFailure(`${t('terminal.failed')}: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }, [api, workspacePath, t]);

  const kill = useCallback(
    async (id: string) => {
      try {
        await api.terminal.ptyKill(id);
      } catch (error) {
        const session = sessions.get(id);
        if (session) session.exit = message(error);
        setIds((list) => list);
      }
    },
    [api],
  );

  const active = selected === null ? null : sessions.get(selected) ?? null;
  const ptyReady = availability?.available === true;

  return (
    <div className="pane">
      <div className="pane-head">
        <h1>{t('terminal.title')}</h1>
        <p>{t('terminal.subtitle')}</p>
      </div>

      <div className="notice info" style={{ marginBottom: 10 }}>
        {t('terminal.distinct')}
      </div>

      {availability === null ? (
        <div className="notice" style={{ marginBottom: 10 }}>
          {t('terminal.noOutputHint')}
        </div>
      ) : ptyReady ? (
        <div className="notice info" style={{ marginBottom: 10 }}>
          {t('terminal.ptyNotice')}
        </div>
      ) : (
        // Honesty: no PTY means no interactive terminal, and the user is told
        // which of the two it is and why. The piped console below still works.
        <div className="notice error" style={{ marginBottom: 10 }}>
          {availability.reason ?? t('terminal.notRunning')}
        </div>
      )}

      {failure && (
        <div className="notice error" style={{ marginBottom: 10 }}>
          {failure}
        </div>
      )}

      <div className="split">
        <div className="card split-list">
          <div className="block-title">
            <span>{t('terminal.consoles')}</span>
            {ptyReady && (
              <button className="link" onClick={() => void create()} disabled={busy}>
                + {t('terminal.new')}
              </button>
            )}
          </div>

          {ids.length === 0 ? (
            // Each empty state names its own situation: without node-pty there
            // is nothing to create or list, and the per-console "no output
            // yet" line would be claiming a console that does not exist.
            <div className="faint">{ptyReady ? t('terminal.empty') : t('terminal.noConsoles')}</div>
          ) : (
            ids.map((id) => {
              const session = sessions.get(id);
              if (session === undefined) return null;
              return (
                <div
                  key={id}
                  className={`row-item ${id === selected ? 'active' : ''}`}
                  onClick={() => setSelected(id)}
                >
                  <div className="t mono">
                    {t('terminal.output')} {shortId(id)}
                  </div>
                  <div className="m">
                    <span className={session.state === 'running' ? 'dot running' : 'dot err'} />
                    <span>{session.state === 'running' ? t('terminal.running') : t('terminal.ended')}</span>
                    <span className="spacer" />
                    {session.state === 'running' && (
                      <button
                        className="danger"
                        style={{ padding: '0 6px', fontSize: 10.5 }}
                        onClick={(event) => {
                          event.stopPropagation();
                          void kill(id);
                        }}
                      >
                        {t('terminal.kill')}
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}

          {!hasSession && (
            <div className="faint" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
              {t('terminal.needsSession')}
            </div>
          )}
        </div>

        <div className="split-main">
          <div className="card">
            <div className="block-title">
              <span>{active ? `${t('terminal.output')} · ${shortId(active.id)}` : t('terminal.noSelection')}</span>
              {active && <span className="badge">{active.state === 'running' ? t('terminal.running') : t('terminal.ended')}</span>}
            </div>

            {active === null ? (
              // The body matches the state: a list worth picking from says
              // "select one"; an empty list says how to fill it; no node-pty
              // says why there is nothing. "还没有控制台，点击新建控制台" here
              // used to sit under a hidden button and contradict the card
              // beside it.
              <div className="empty">
                {ptyReady ? (ids.length > 0 ? t('terminal.noSelection') : t('terminal.empty')) : t('terminal.noConsoles')}
              </div>
            ) : (
              <>
                {active.exit && (
                  <div className="notice" style={{ marginBottom: 10 }}>
                    {active.exit}
                  </div>
                )}
                <PtyView session={active} api={api} />
              </>
            )}
          </div>

          {/*
            The piped command console. Not the same thing as the terminal above:
            no echo, no cursor addressing, no full-screen programs, no per-command
            exit code. It stays because it is the one that works without the
            optional native module.
          */}
          <CommandConsole api={api} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// the terminal itself
// ---------------------------------------------------------------------------

function PtyView({ session, api }: { session: PtySession; api: UcadApi }): JSX.Element {
  const t = useT();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);

  useLayoutEffect(() => {
    const el = hostRef.current;
    if (el === undefined || el === null) return;

    const term = new Terminal({
      fontFamily: MONO,
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: false,
      theme: themeFor(prefersLight()),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    session.xterm = term;
    session.fit = fit;

    const refit = (): void => {
      try {
        fit.fit();
      } catch {
        // A pane with no layout yet has nothing to measure. The next resize or
        // the next activation will fit it.
      }
    };
    refit();
    // A second pass on the next frame: the first runs before the card has its
    // final height, and a terminal that stays at the wrong size never recovers
    // on its own.
    const raf = requestAnimationFrame(refit);
    if (session.replay.length > 0) {
      term.write(session.replay);
    }
    if (session.pending.length > 0) {
      term.write(session.pending);
      session.pending = '';
    }
    term.focus();

    // Keystrokes go straight to the PTY — the pty does the echo and the line
    // editing, which is the entire reason this is a PTY and not a form field.
    const offData = term.onData((data) => {
      void api.terminal.ptyWrite(session.id, data).catch((error: unknown) => {
        session.exit = message(error);
      });
    });
    const offResize = term.onResize(({ cols, rows }) => {
      void api.terminal.ptyResize(session.id, cols, rows).catch(() => undefined);
    });

    // Window resize, pane resize, and returning to this tab after the surface
    // was swapped out. All three end in the same place: fit, then tell the PTY.
    const observer = new ResizeObserver(() => refit());
    observer.observe(el);
    const onWindowResize = (): void => refit();
    window.addEventListener('resize', onWindowResize);
    const onFocus = (): void => refit();
    window.addEventListener('focus', onFocus);

    // A terminal that has not said anything yet must not read as a command that
    // produced no output — but a shell banner usually lands within a frame, so
    // the notice waits a moment before claiming there is nothing.
    const timer = setTimeout(() => setShowEmpty(session.replay.length === 0), 700);
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const onScheme = (): void => {
      term.options.theme = themeFor(media.matches);
    };
    media.addEventListener('change', onScheme);

    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      observer.disconnect();
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('focus', onFocus);
      media.removeEventListener('change', onScheme);
      offData.dispose();
      offResize.dispose();
      // The pty keeps running; only this view goes away. The replay buffer is
      // what rebuilds it when the user comes back.
      session.xterm = null;
      session.fit = null;
      term.dispose();
    };
  }, [api, session]);

  return (
    <div style={{ position: 'relative' }}>
      <div className="console-out pty-host" ref={hostRef} onClick={() => session.xterm?.focus()} />
      {showEmpty && session.state === 'running' && (
        <div className="pty-empty">
          <div>{t('terminal.noOutput')}</div>
          <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
            {t('terminal.noOutputHint')}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// the piped command console (the surface that needs no native module)
// ---------------------------------------------------------------------------

type ConsoleState = 'running' | 'killed' | 'ended';

interface Segment {
  kind: 'sent' | 'output';
  stream: 'stdout' | 'stderr';
  text: string;
}

interface ConsoleEntry {
  id: string;
  cwd: string;
  state: ConsoleState;
  segments: Segment[];
  error: string | null;
}

const MAX_SEGMENTS = 400;
const MAX_SEGMENT_CHARS = 64 * 1024;
const STICK_SLACK_PX = 24;

function CommandConsole({ api }: { api: UcadApi }): JSX.Element {
  const t = useT();
  const [consoles, setConsoles] = useState<ConsoleEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const off = api.terminal.onData((event: TerminalDataEvent) => {
      const stream = streamOf(event);
      setConsoles((list) =>
        list.map((entry) =>
          entry.id === event.terminalId
            ? push(entry, { kind: 'output', stream, text: event.chunk })
            : entry,
        ),
      );
    });
    return () => {
      off();
    };
  }, [api]);

  const create = useCallback(async () => {
    setFailure(null);
    setBusy(true);
    try {
      const { terminalId } = await api.terminal.create({
        cwd: '.',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });
      setConsoles((list) => [
        ...list,
        { id: terminalId, cwd: '.', state: 'running', segments: [], error: null },
      ]);
      setSelected(terminalId);
    } catch (error) {
      setFailure(`${t('terminal.failed')}: ${message(error)}`);
    } finally {
      setBusy(false);
    }
  }, [api, t]);

  const kill = useCallback(
    async (id: string) => {
      try {
        await api.terminal.kill(id);
        setConsoles((list) => list.map((entry) => (entry.id === id ? { ...entry, state: 'killed' } : entry)));
      } catch (error) {
        setConsoles((list) =>
          list.map((entry) => (entry.id === id ? { ...entry, state: 'ended', error: message(error) } : entry)),
        );
      }
    },
    [api],
  );

  const send = useCallback(async () => {
    const command = input.trim();
    if (!selected || !command) return;
    const entry = consoles.find((item) => item.id === selected);
    if (!entry || entry.state !== 'running') {
      setFailure(t('terminal.notRunning'));
      return;
    }
    setFailure(null);
    setInput('');
    setConsoles((list) =>
      list.map((item) =>
        item.id === selected ? push(item, { kind: 'sent', stream: 'stdout', text: `${command}\n` }) : item,
      ),
    );
    try {
      await api.terminal.write(selected, `${command}\n`);
    } catch (error) {
      setConsoles((list) =>
        list.map((item) =>
          item.id === selected ? { ...item, state: 'ended', error: message(error) } : item,
        ),
      );
    }
  }, [api, consoles, input, selected, t]);

  const active = consoles.find((entry) => entry.id === selected) ?? null;

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div className="block-title">
        <span>{t('terminal.exitCodeNote')}</span>
        <button className="link" onClick={() => void create()} disabled={busy}>
          + {t('terminal.new')}
        </button>
      </div>

      {failure && (
        <div className="notice error" style={{ marginBottom: 10 }}>
          {failure}
        </div>
      )}

      {consoles.length > 0 && (
        <div className="block-title" style={{ marginTop: 8 }}>
          <span>{t('terminal.consoles')}</span>
          <span className="spacer" />
          {consoles.map((entry) => (
            <button
              key={entry.id}
              className={`link ${entry.id === selected ? 'active' : ''}`}
              onClick={() => setSelected(entry.id)}
            >
              {shortId(entry.id)}
            </button>
          ))}
        </div>
      )}

      {active?.error && (
        <div className="notice error" style={{ marginBottom: 10 }}>
          {active.error}
        </div>
      )}

      {active ? (
        <ConsoleOutput segments={active.segments} />
      ) : (
        /*
         * Its own copy, not `terminal.empty`. That key is the PTY card's text,
         * and reusing it printed the same sentence twice on one screen — so the
         * two consoles looked like one repeated accident, and "click New
         * console" sat directly above an input box, telling the user to do the
         * one thing they could already do. This one points at the input that is
         * actually right below it.
         */
        <div className="empty">{t('terminal.emptyCommand')}</div>
      )}

      <div className="console-in">
        <span className="console-caret">$</span>
        <input
          value={input}
          placeholder={t('terminal.inputPlaceholder')}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void send();
          }}
          disabled={active?.state !== 'running'}
        />
        <button
          onClick={() => void send()}
          disabled={active?.state !== 'running' || input.trim() === ''}
        >
          {t('terminal.send')}
        </button>
        {active?.state === 'running' && (
          <button className="danger" onClick={() => void kill(active.id)}>
            {t('terminal.kill')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Autoscroll that never steals the reading position, inherited from the console
 * this replaced: a view that yanks the viewport to the bottom mid-read is
 * unusable, so following is opt-out by scrolling up.
 */
function ConsoleOutput({ segments }: { segments: Segment[] }): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLPreElement>(null);
  const following = useRef(true);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node && following.current) node.scrollTop = node.scrollHeight;
  }, [segments]);

  const onScroll = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= STICK_SLACK_PX;
  }, []);

  if (segments.length === 0) {
    return (
      <div className="console-out empty-console">
        <div>{t('terminal.noOutput')}</div>
        <div className="faint" style={{ fontSize: 11.5, marginTop: 6 }}>
          {t('terminal.noOutputHint')}
        </div>
      </div>
    );
  }

  return (
    <pre className="console-out" ref={ref} onScroll={onScroll} aria-label={t('terminal.output')}>
      {segments.map((segment, index) => (
        <span
          key={index}
          className={segment.kind === 'sent' ? 'console-line sent' : `console-line ${segment.stream}`}
        >
          {segment.kind === 'sent' && <span className="console-tag">{t('terminal.youSent')}</span>}
          {segment.text}
        </span>
      ))}
    </pre>
  );
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The design system's own palette, so the terminal is not a foreign object. */
function themeFor(light: boolean): Record<string, string> {
  return light
    ? {
        background: '#fbfbfc',
        foreground: '#1b1b1f',
        cursor: '#1b1b1f',
        selectionBackground: 'rgba(109, 124, 255, 0.25)',
        black: '#1b1b1f',
        red: '#c0392b',
        green: '#1e7a34',
        yellow: '#8a6100',
        blue: '#2f4fd8',
        magenta: '#8a3ab9',
        cyan: '#0f6f7f',
        white: '#d8d8dd',
        brightBlack: '#6a6a76',
        brightRed: '#e04a3a',
        brightGreen: '#28a14a',
        brightYellow: '#b58200',
        brightBlue: '#4a6bff',
        brightMagenta: '#a855c9',
        brightCyan: '#18909f',
        brightWhite: '#ffffff',
      }
    : {
        background: '#08080a',
        foreground: '#ecedee',
        cursor: '#ecedee',
        selectionBackground: 'rgba(109, 124, 255, 0.3)',
        black: '#101012',
        red: '#f85149',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#6d7cff',
        magenta: '#9d6dff',
        cyan: '#58a6ff',
        white: '#c9c9d1',
        brightBlack: '#63636e',
        brightRed: '#ff7b72',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#8b96ff',
        brightMagenta: '#c39bff',
        brightCyan: '#79c0ff',
        brightWhite: '#ffffff',
      };
}

function prefersLight(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: light)').matches;
}

function tail(text: string, limit: number): string {
  return text.length > limit ? text.slice(text.length - limit) : text;
}

function push(entry: ConsoleEntry, segment: Segment): ConsoleEntry {
  const segments = [...entry.segments, segment];
  return {
    ...entry,
    segments:
      segments.length > MAX_SEGMENTS
        ? segments.slice(segments.length - MAX_SEGMENTS)
        : segments.map((item) =>
            item.text.length > MAX_SEGMENT_CHARS
              ? { ...item, text: item.text.slice(item.text.length - MAX_SEGMENT_CHARS) }
              : item,
          ),
  };
}

/** The push payload carries a `stream` field the Renderer contract omits. */
function streamOf(event: TerminalDataEvent): 'stdout' | 'stderr' {
  const raw = (event as { stream?: unknown }).stream;
  return raw === 'stderr' ? 'stderr' : 'stdout';
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortId(id: string): string {
  return id.length > 18 ? `${id.slice(0, 18)}…` : id;
}
