import { existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export type RepoStatus = 'pending' | 'in-progress' | 'complete' | 'blocked' | 'stalled' | 'skipped' | 'error';
export type Phase = 'prepare' | 'coverlet' | 'baseline' | 'scaffold' | 'coverage' | 'stryker-setup' | 'mutation' | 'done';

export interface HistoryEntry {
  at: string;
  phase: Phase;
  iteration: number;
  outcome: string;
  coverage?: number;
  mutationScore?: number;
}

export interface RepoEntry {
  name: string;
  path: string;
  status: RepoStatus;
  phase?: Phase;
  solution?: string;
  branch?: string;
  baselineCoverage?: number;
  coverage?: number;
  branchCoverage?: number;
  mutationScore?: number;
  iterations: { coverage: number; mutation: number };
  agentInvocations: number;
  startedAt?: string;
  updatedAt?: string;
  completedAt?: string;
  notes: string[];
  history: HistoryEntry[];
}

export interface Manifest {
  version: 1;
  source: string;
  target: number;
  mutationTarget: number;
  agent: string;
  createdAt: string;
  updatedAt: string;
  repos: RepoEntry[];
}

const isGitRepo = (dir: string) => existsSync(join(dir, '.git'));

/**
 * `--src /abs/dir/*` means "every git repo directly inside dir"; `--src /abs/repo` means that one repo.
 */
export function discoverRepos(src: string): { repos: string[]; root: string } {
  const glob = src.endsWith('/*') || src.endsWith('\\*');
  const base = resolve(glob ? src.slice(0, -2) : src);
  if (!existsSync(base) || !statSync(base).isDirectory()) throw new Error(`--src ${src}: ${base} is not a directory`);
  if (!glob) {
    if (!isGitRepo(base)) throw new Error(`--src ${src} is not a git repository (use ${base}/* to process every repo inside it)`);
    return { repos: [base], root: dirname(base) };
  }
  const repos = readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => join(base, e.name))
    .filter(isGitRepo)
    .sort();
  return { repos, root: base };
}

export const defaultManifestPath = (root: string) => join(root, 'coverage-harness.manifest.json');

/** Owns the manifest file. Writes are atomic (tmp + rename) and serialised, so parallel repo workers are safe. */
export class ManifestStore {
  readonly path: string;
  readonly data: Manifest;
  private queue: Promise<void> = Promise.resolve();

  private constructor(path: string, data: Manifest) {
    this.path = path;
    this.data = data;
  }

  static openOrCreate(path: string, init: Omit<Manifest, 'version' | 'createdAt' | 'updatedAt' | 'repos'>, repoPaths: string[]): ManifestStore {
    const now = new Date().toISOString();
    const data: Manifest = existsSync(path)
      ? (JSON.parse(readFileSync(path, 'utf8')) as Manifest)
      : { version: 1, createdAt: now, updatedAt: now, repos: [], ...init };
    // The latest invocation's targets win; previously completed repos keep their recorded numbers.
    Object.assign(data, init);
    for (const repo of repoPaths) {
      if (!data.repos.some((r) => r.path === repo)) {
        data.repos.push({ name: basename(repo), path: repo, status: 'pending', iterations: { coverage: 0, mutation: 0 }, agentInvocations: 0, notes: [], history: [] });
      }
    }
    const store = new ManifestStore(path, data);
    store.flushSync();
    return store;
  }

  static read(path: string): Manifest {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  }

  entry(repoPath: string): RepoEntry {
    const e = this.data.repos.find((r) => r.path === repoPath);
    if (!e) throw new Error(`Repo ${repoPath} is not in the manifest`);
    return e;
  }

  async update(repoPath: string, mutate: (e: RepoEntry) => void): Promise<void> {
    const e = this.entry(repoPath);
    mutate(e);
    e.updatedAt = new Date().toISOString();
    e.notes = e.notes.slice(-30);
    e.history = e.history.slice(-300);
    this.queue = this.queue.then(() => this.flushSync());
    await this.queue;
  }

  flushSync(): void {
    this.data.updatedAt = new Date().toISOString();
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`);
    renameSync(tmp, this.path);
  }
}
