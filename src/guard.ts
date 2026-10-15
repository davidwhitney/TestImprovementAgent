import { basename, relative, sep } from 'node:path';
import type { Git } from './git.ts';
import { classifyProject, findProjectFiles } from './dotnet/projects.ts';

const ALWAYS_ALLOWED = [/\.slnx?$/, /(^|\/)Directory\.Packages\.props$/, /^\.config\/dotnet-tools\.json$/, /^stryker-config\.(json|ya?ml)$/, /^\.coverage-harness\//];

/** Lines an agent may add to production code: the `public partial class Program` hook and InternalsVisibleTo. */
const PROGRAM_HOOK = /^\s*(public\s+partial\s+class\s+Program\s*(\{\s*\}|;)?|\{|\}|\/\/.*|)\s*$/;
const IVT = /^\s*(<InternalsVisibleTo\s+Include="[^"]+"\s*\/>|<\/?ItemGroup>|<AssemblyAttribute\s+Include="System\.Runtime\.CompilerServices\.InternalsVisibleTo(Attribute)?">|<_Parameter1>[^<]+<\/_Parameter1>|<\/AssemblyAttribute>|)\s*$/;

/**
 * Directories that hold only test code. A test project dir that also contains a production
 * project (e.g. a test csproj dropped at the repo root) does not count, so it can't whitelist everything.
 */
export function testDirectories(repo: string): string[] {
  const projects = findProjectFiles(repo).map((p) => classifyProject(p, repo));
  const prodDirs = projects.filter((p) => !p.isTest).map((p) => p.dir);
  return projects
    .filter((p) => p.isTest && p.dir !== repo)
    .map((p) => p.dir)
    .filter((dir) => !prodDirs.some((pd) => pd === dir || pd.startsWith(dir + sep)))
    .map((dir) => relative(repo, dir).split(sep).join('/'));
}

function changedLines(diff: string): { added: string[]; removed: string[] } {
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
    else if (line.startsWith('-')) removed.push(line.slice(1));
  }
  return { added, removed };
}

export interface GuardOutcome {
  reverted: string[];
}

/**
 * Revert every change since `checkpoint` that is not test code, except the narrow allowed hooks.
 * Deterministic enforcement of the "document, don't modify" rule, independent of what the agent claims.
 */
export async function enforceTestOnlyChanges(git: Git, repo: string, checkpoint: string): Promise<GuardOutcome> {
  const testDirs = testDirectories(repo);
  const changed = await git.changedFiles(checkpoint);
  const violations: string[] = [];

  for (const file of changed) {
    if (ALWAYS_ALLOWED.some((r) => r.test(file))) continue;
    if (testDirs.some((d) => file === d || file.startsWith(`${d}/`))) continue;

    const existed = await git.existedAt(checkpoint, file);
    if (existed && (basename(file) === 'Program.cs' || /\.(cs|fs|vb)proj$/.test(file))) {
      const { added, removed } = changedLines(await git.diff(checkpoint, file));
      const pattern = basename(file) === 'Program.cs' ? PROGRAM_HOOK : IVT;
      if (removed.every((l) => l.trim() === '') && added.every((l) => pattern.test(l))) continue;
    }
    violations.push(file);
  }

  if (violations.length) await git.restoreFiles(checkpoint, violations);
  return { reverted: violations };
}
