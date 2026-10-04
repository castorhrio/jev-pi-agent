/**
 * One logger that satisfies all three contract logger shapes
 * (HostLogger / IntelligenceLogger / DecisionLogger). Every write is redacted
 * before it reaches a sink, so NFR-08 holds by construction rather than by
 * remembering to be careful at each call site.
 */

import { redact, redactText } from './redact';
import { nowIso } from './time';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogRecord {
  ts: string;
  level: LogLevel;
  scope: string;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface LogSink {
  write(rec: LogRecord): void;
}

export class MemoryLogSink implements LogSink {
  readonly records: LogRecord[] = [];
  private readonly limit: number;

  constructor(limit = 2000) {
    this.limit = limit;
  }

  write(rec: LogRecord): void {
    this.records.push(rec);
    if (this.records.length > this.limit) {
      this.records.splice(0, this.records.length - this.limit);
    }
  }
}

export class FileLogSink implements LogSink {
  private readonly stream: fs.WriteStream | null = null;
  private readonly fallback: LogRecord[] = [];

  constructor(filePath: string) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
      this.stream.on('error', () => {
        /* logging must never crash the app */
      });
    } catch {
      this.stream = null;
    }
  }

  write(rec: LogRecord): void {
    const line = JSON.stringify(rec);
    if (this.stream) {
      this.stream.write(`${line}\n`);
    } else {
      this.fallback.push(rec);
      if (this.fallback.length > 500) this.fallback.shift();
    }
  }
}

/** Fans one record out to several sinks. */
export class MultiLogSink implements LogSink {
  constructor(private readonly sinks: LogSink[]) {}

  write(rec: LogRecord): void {
    for (const sink of this.sinks) {
      try {
        sink.write(rec);
      } catch {
        /* a broken sink must not take down the caller */
      }
    }
  }
}

export class Logger {
  private readonly scope: string;
  private readonly sink: LogSink;

  constructor(opts: { scope: string; sink?: LogSink }) {
    this.scope = opts.scope;
    this.sink = opts.sink ?? new MultiLogSink([]);
  }

  child(scope: string): Logger {
    return new Logger({ scope: `${this.scope}:${scope}`, sink: this.sink });
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.emit('debug', msg, meta);
  }

  info(msg: string, meta?: Record<string, unknown>): void {
    this.emit('info', msg, meta);
  }

  warn(msg: string, meta?: Record<string, unknown>): void {
    this.emit('warn', msg, meta);
  }

  error(msg: string, meta?: Record<string, unknown>): void {
    this.emit('error', msg, meta);
  }

  /** IntelligenceLogger.progress */
  progress(
    operationId: string,
    staged: string,
    completed: number,
    total?: number,
  ): void {
    this.emit('info', `progress:${staged}`, {
      operationId,
      staged,
      completed,
      ...(total !== undefined ? { total } : {}),
    });
  }

  /** DecisionLogger.decided */
  decided(
    requestId: string,
    kind: string,
    engineId: string,
    latencyMs: number,
  ): void {
    this.emit('info', 'decision', { requestId, kind, engineId, latencyMs });
  }

  private emit(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    const rec: LogRecord = {
      ts: nowIso(),
      level,
      scope: this.scope,
      msg: redactText(msg),
      ...(meta ? { meta: redact(meta) } : {}),
    };
    try {
      this.sink.write(rec);
    } catch {
      /* logging must never crash the app */
    }
  }
}

/** Discards everything. Useful in tests and in the Renderer-less surfaces. */
export const NULL_SINK: LogSink = { write: () => undefined };

export function silentLogger(scope = 'ucad'): Logger {
  return new Logger({ scope, sink: NULL_SINK });
}
