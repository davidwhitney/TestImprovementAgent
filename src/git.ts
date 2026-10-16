import { createHash } from 'node:crypto';
import { existsSync, readFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { run, runChecked } from './util/exec.ts';

const COMMITTER_ENV = {
  // Only used when the repo/global git config has no identity, so commits never fail on a fresh machine.
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? 'coverage-harness',
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? 'coverage-harness@localhost',
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? 'coverage-harness',
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL ?? 'coverage-harness@localhost',
};

export class Git {
  readonly repo: string;

  constructor(repo: string) {
    this.repo = repo;
  }

  private git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
    return runChecked('git', args, { cwd: this.repo, env });
  }

  async hasIdentity(): Promise<boolean> {
    const r = await run('git', ['config', 'user.email'], { cwd: this.repo });
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  async status(): Promise<string[]> {
    const out = await this.git(['status', '--porcelain']);
    return out.split('\n').filter(Boolean);
  }

  async isClean(): Promise<boolean> {
    return (await this.status()).length === 0;
  }

  async head(): Promise<string> {
    return (await this.git(['rev-parse', 'HEAD'])).trim();
  }

  /** Identifies the exact code state: HEAD plus any uncommitted changes. */
  async fingerprint(): Promise<string> {
    const diff = await this.git(['diff', 'HEAD']);
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard'])).trim();
    const hash = createHash('sha1').update(diff).update(untracked).digest('hex').slice(0, 8);
    return `${(await this.head()).slice(0, 12)}-${hash}`;
  }

  async hasCommits(): Promise<boolean> {
    return (await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd: this.repo })).code === 0;
  }

  async currentBranch(): Promise<string> {
    return (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  }

  /** Check out the harness work branch, creating it from the current HEAD the first time. */
  async ensureBranch(name: string): Promise<void> {
    if ((await this.currentBranch()) === name) return;
    const exists = (await run('git', ['rev-parse', '--verify', `refs/heads/${name}`], { cwd: this.repo })).code === 0;
    await this.git(exists ? ['checkout', name] : ['checkout', '-b', name]);
  }

  /** Keep harness scratch files out of `git status` without touching the repo's tracked .gitignore. */
  async excludeLocally(patterns: string[]): Promise<void> {
    let excludePath = (await this.git(['rev-parse', '--git-path', 'info/exclude'])).trim();
    if (!isAbsolute(excludePath)) excludePath = join(this.repo, excludePath);
    mkdirSync(dirname(excludePath), { recursive: true });
    const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : '';
    const missing = patterns.filter((p) => !current.split('\n').includes(p));
    if (missing.length) appendFileSync(excludePath, `${current.endsWith('\n') || !current ? '' : '\n'}${missing.join('\n')}\n`);
  }

  /** Commit everything. Returns the new sha, or undefined when there was nothing to commit. */
  async commitAll(message: string): Promise<string | undefined> {
    await this.git(['add', '-A']);
    if ((await run('git', ['diff', '--cached', '--quiet'], { cwd: this.repo })).code === 0) return undefined;
    const env = (await this.hasIdentity()) ? undefined : COMMITTER_ENV;
    await this.git(['commit', '--no-verify', '-q', '-m', message], env);
    return this.head();
  }

  /** Throw away every change since `sha` (tracked and untracked; ignored files such as bin/obj are kept). */
  async resetTo(sha: string): Promise<void> {
    await this.git(['reset', '--hard', '-q', sha]);
    await this.git(['clean', '-fdq']);
  }

  /** Park uncommitted changes (including untracked files) in a recoverable stash. Returns false when there was nothing to save. */
  async stashAll(message: string): Promise<boolean> {
    const env = (await this.hasIdentity()) ? undefined : COMMITTER_ENV;
    const out = await this.git(['stash', 'push', '--include-untracked', '-q', '-m', message], env);
    return !/No local changes/i.test(out) && (await this.git(['stash', 'list'])).includes(message);
  }

  /** Files changed relative to `sha`, including untracked files, as repo-relative paths. */
  async changedFiles(sha: string): Promise<string[]> {
    const tracked = (await this.git(['diff', '--name-only', sha])).split('\n');
    const untracked = (await this.git(['ls-files', '--others', '--exclude-standard'])).split('\n');
    return [...new Set([...tracked, ...untracked].filter(Boolean))];
  }

  async diff(sha: string, file: string): Promise<string> {
    return this.git(['diff', sha, '--', file]);
  }

  async existedAt(sha: string, file: string): Promise<boolean> {
    return (await run('git', ['cat-file', '-e', `${sha}:${file}`], { cwd: this.repo })).code === 0;
  }

  /** Put individual files back the way they were at `sha` (deleting files that did not exist then). */
  async restoreFiles(sha: string, files: string[]): Promise<void> {
    for (const file of files) {
      if (await this.existedAt(sha, file)) {
        await this.git(['checkout', sha, '--', file]);
      } else {
        rmSync(join(this.repo, file), { force: true });
        await run('git', ['rm', '--cached', '-q', '--ignore-unmatch', file], { cwd: this.repo });
      }
    }
  }
}
