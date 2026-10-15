import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { styleText } from 'node:util';

type Level = 'info' | 'warn' | 'error' | 'success' | 'debug';

const colours: Record<Level, Parameters<typeof styleText>[0]> = {
  info: 'cyan',
  warn: 'yellow',
  error: 'red',
  success: 'green',
  debug: 'gray',
};

export interface LogSinks {
  /** Human-readable log files (every level, including agent activity, regardless of --verbose). */
  textFiles: string[];
  /** Structured JSONL event streams, one object per line: {ts, repo, type, ...data}. */
  eventFiles: string[];
}

function appendSafe(file: string, line: string): void {
  try {
    appendFileSync(file, line);
  } catch {
    // Logging must never take the harness down (e.g. a repo directory removed mid-run).
  }
}

/**
 * Console + file logger. A child logger keeps its parent's sinks and adds its own, so a repo's
 * lines land both in the repo's own log and in the run-wide log next to the manifest.
 */
export class Logger {
  readonly prefix: string;
  readonly verbose: boolean;
  readonly sinks: LogSinks;

  constructor(prefix: string, verbose: boolean, sinks: Partial<LogSinks> = {}) {
    this.prefix = prefix;
    this.verbose = verbose;
    this.sinks = { textFiles: sinks.textFiles ?? [], eventFiles: sinks.eventFiles ?? [] };
    for (const f of [...this.sinks.textFiles, ...this.sinks.eventFiles]) mkdirSync(dirname(f), { recursive: true });
  }

  child(prefix: string, extra: Partial<LogSinks> = {}): Logger {
    return new Logger(prefix, this.verbose, {
      textFiles: [...this.sinks.textFiles, ...(extra.textFiles ?? [])],
      eventFiles: [...this.sinks.eventFiles, ...(extra.eventFiles ?? [])],
    });
  }

  info(msg: string): void {
    this.write('info', msg);
  }
  warn(msg: string): void {
    this.write('warn', msg);
  }
  error(msg: string): void {
    this.write('error', msg);
  }
  success(msg: string): void {
    this.write('success', msg);
  }
  debug(msg: string): void {
    this.write('debug', msg);
  }

  /** Record a structured event (for jq / dashboards) without printing anything. */
  event(type: string, data: Record<string, unknown> = {}): void {
    if (this.sinks.eventFiles.length === 0) return;
    const line = `${JSON.stringify({ ts: new Date().toISOString(), repo: this.prefix, type, ...data })}\n`;
    for (const f of this.sinks.eventFiles) appendSafe(f, line);
  }

  private write(level: Level, msg: string): void {
    const ts = new Date().toISOString();
    const fileLine = `${ts} ${level.toUpperCase().padEnd(7)} [${this.prefix}] ${msg}\n`;
    for (const f of this.sinks.textFiles) appendSafe(f, fileLine);
    if (level === 'debug' && !this.verbose) return;
    const out = `${styleText('gray', ts.slice(11, 19))} ${styleText(colours[level], `[${this.prefix}]`)} ${msg}`;
    (level === 'error' ? console.error : console.log)(out);
  }
}

export const formatDuration = (ms: number): string => {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
};

/**
 * Run `fn` while periodically logging that it is still alive. `activity()` can report the
 * latest thing the work did (e.g. the agent's last tool call) so long silences are visible.
 */
export async function withHeartbeat<T>(
  log: Logger,
  what: string,
  intervalMs: number,
  fn: () => Promise<T>,
  activity?: () => { at: number; text: string } | undefined,
): Promise<T> {
  const started = Date.now();
  const timer =
    intervalMs > 0
      ? setInterval(() => {
          const elapsed = Date.now() - started;
          const last = activity?.();
          const lastText = last ? `; last activity ${formatDuration(Date.now() - last.at)} ago: ${last.text}` : '';
          log.info(`… ${what} still running (${formatDuration(elapsed)} elapsed${lastText})`);
          log.event('heartbeat', { what, elapsedMs: elapsed, lastActivity: last?.text, idleMs: last ? Date.now() - last.at : undefined });
        }, intervalMs)
      : undefined;
  timer?.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}
