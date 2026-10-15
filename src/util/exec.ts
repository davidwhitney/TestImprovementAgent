import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

export interface RunOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** Written to the child's stdin, which is then closed. stdin is always closed so CLIs never wait on it. */
  input?: string;
  /** Hard wall-clock limit. */
  timeoutMs?: number;
  /** Kill the process if it produces no stdout/stderr for this long (agents that hang retrying a dead provider). */
  idleTimeoutMs?: number;
  /** Tee stdout+stderr to this file. */
  logFile?: string;
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  idledOut: boolean;
  durationMs: number;
}

const MAX_CAPTURE = 32 * 1024 * 1024;
const active = new Set<ChildProcess>();

/** Kill every child we started (used on SIGINT so agents don't keep editing after the harness exits). */
export function killAllChildren(): void {
  for (const child of active) killTree(child);
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, 'SIGTERM'); // negative pid = whole process group (we spawn detached)
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    try {
      if (child.exitCode === null && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 10_000).unref();
}

function append(buf: string, chunk: string): string {
  const next = buf + chunk;
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

export function run(command: string, args: string[], opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  let log: WriteStream | undefined;
  if (opts.logFile) {
    mkdirSync(dirname(opts.logFile), { recursive: true });
    log = createWriteStream(opts.logFile, { flags: 'a' });
    log.write(`\n$ ${command} ${args.map((a) => (a.length > 200 ? `${a.slice(0, 200)}…` : a)).join(' ')}\n`);
  }

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });
    active.add(child);

    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;
    let idledOut = false;
    let idleTimer: NodeJS.Timeout | undefined;

    const resetIdle = () => {
      if (!opts.idleTimeoutMs) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idledOut = true;
        killTree(child);
      }, opts.idleTimeoutMs);
    };
    resetIdle();

    const hardTimer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, opts.timeoutMs)
      : undefined;

    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      resetIdle();
      stdout = append(stdout, chunk);
      log?.write(chunk);
      if (opts.onStdoutLine) {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) opts.onStdoutLine(line);
      }
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
      resetIdle();
      stderr = append(stderr, chunk);
      log?.write(chunk);
    });

    child.stdin!.on('error', () => {
      /* child may exit before reading stdin */
    });
    child.stdin!.end(opts.input ?? '');

    const finish = (code: number | null) => {
      active.delete(child);
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      if (pending && opts.onStdoutLine) opts.onStdoutLine(pending);
      const durationMs = Date.now() - started;
      log?.end(`\n[exit ${code}${timedOut ? ' timeout' : ''}${idledOut ? ' idle-timeout' : ''} after ${Math.round(durationMs / 1000)}s]\n`);
      resolve({ code, stdout, stderr, timedOut, idledOut, durationMs });
    };
    child.on('error', (err) => {
      stderr += String(err);
      finish(127);
    });
    child.on('close', (code) => finish(code));
  });
}

/** Run and throw if the exit code is non-zero. For short deterministic commands (git, dotnet sln). */
export async function runChecked(command: string, args: string[], opts: RunOptions): Promise<string> {
  const r = await run(command, args, opts);
  if (r.code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  }
  return r.stdout;
}
