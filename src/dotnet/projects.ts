import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { run, runChecked } from '../util/exec.ts';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', '.coverage-harness', 'StrykerOutput', 'packages', '.vs', '.idea', 'TestResults']);
const PROJECT_EXT = new Set(['.csproj', '.fsproj', '.vbproj']);

export interface DotnetProject {
  path: string; // absolute path to the project file
  name: string;
  assemblyName: string;
  dir: string;
  isTest: boolean;
  isWeb: boolean;
  isExecutable: boolean;
  hasCoverletCollector: boolean;
  hasCoverletMsbuild: boolean;
  hasComponentTests: boolean;
}

export interface Solution {
  path: string;
  projects: DotnetProject[];
}

/** Walk the repo (bounded depth) yielding files that match the predicate. */
export function findFiles(root: string, match: (file: string) => boolean, maxDepth = 6): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(full, depth + 1);
      } else if (match(full)) {
        out.push(full);
      }
    }
  };
  walk(root, 0);
  return out;
}

export function findProjectFiles(repo: string): string[] {
  return findFiles(repo, (f) => PROJECT_EXT.has(extname(f)));
}

/**
 * Pick the "main" solution: prefer shallow ones, then one named after the repo, then the one with most projects.
 */
export function findSolution(repo: string): string | undefined {
  const candidates = findFiles(repo, (f) => f.endsWith('.sln') || f.endsWith('.slnx'), 3);
  if (candidates.length === 0) return undefined;
  const repoName = basename(repo).toLowerCase();
  const score = (sln: string) => {
    const depth = relative(repo, sln).split(sep).length - 1;
    const name = basename(sln).replace(/\.slnx?$/, '').toLowerCase();
    const projectCount = (readFileSync(sln, 'utf8').match(/\.(cs|fs|vb)proj/g) ?? []).length;
    return -depth * 1000 + (name === repoName ? 500 : 0) + projectCount;
  };
  return candidates.sort((a, b) => score(b) - score(a))[0];
}

/** Read a file plus every Directory.Build.props/targets between it and the repo root. */
function projectText(projectPath: string, repo: string): string {
  let text = readFileSync(projectPath, 'utf8');
  let dir = dirname(projectPath);
  while (dir.startsWith(repo)) {
    for (const f of ['Directory.Build.props', 'Directory.Build.targets']) {
      const p = join(dir, f);
      if (existsSync(p)) text += `\n${readFileSync(p, 'utf8')}`;
    }
    if (dir === repo) break;
    dir = dirname(dir);
  }
  return text;
}

const hasPackageRef = (text: string, id: string) =>
  new RegExp(`<PackageReference\\s+(Include|Update)\\s*=\\s*"${id.replaceAll('.', '\\.')}"`, 'i').test(text);

export function classifyProject(projectPath: string, repo: string): DotnetProject {
  const own = readFileSync(projectPath, 'utf8');
  const text = projectText(projectPath, repo);
  const name = basename(projectPath).replace(/\.\w+proj$/, '');
  const dir = dirname(projectPath);
  const isTest =
    /<IsTestProject>\s*true/i.test(own) ||
    hasPackageRef(own, 'Microsoft.NET.Test.Sdk') ||
    /Include="(xunit|xunit\.v3|NUnit|MSTest\.TestFramework|MSTest)"/i.test(own) ||
    /Sdk="MSTest\.Sdk/i.test(own);
  const isWeb = /Sdk="Microsoft\.NET\.Sdk\.Web"/i.test(own);
  const isExecutable = !isTest && (isWeb || /Sdk="Microsoft\.NET\.Sdk\.Worker"/i.test(own) || /<OutputType>\s*(Exe|WinExe)/i.test(own));
  const hasComponentTests =
    isTest &&
    (/ComponentTests?$/i.test(name) ||
      findFiles(dir, (f) => f.endsWith('.cs'), 4).some((f) => /WebApplicationFactory<|TestServer\b|HostApplicationFactory/.test(readFileSync(f, 'utf8'))));
  return {
    path: projectPath,
    name,
    assemblyName: /<AssemblyName>\s*([^<$]+?)\s*<\/AssemblyName>/.exec(own)?.[1] ?? name,
    dir,
    isTest,
    isWeb,
    isExecutable,
    hasCoverletCollector: hasPackageRef(text, 'coverlet.collector'),
    hasCoverletMsbuild: hasPackageRef(text, 'coverlet.msbuild'),
    hasComponentTests,
  };
}

export async function listSolutionProjects(sln: string): Promise<string[]> {
  const r = await run('dotnet', ['sln', sln, 'list'], { cwd: dirname(sln), timeoutMs: 120_000 });
  if (r.code !== 0) {
    // Fall back to scraping the solution file (works for both .sln and .slnx).
    const text = readFileSync(sln, 'utf8');
    const rels = [...text.matchAll(/"([^"]+\.(?:cs|fs|vb)proj)"/g)].map((m) => m[1]!.replaceAll('\\', '/'));
    return [...new Set(rels)].map((p) => join(dirname(sln), p)).filter(existsSync);
  }
  return r.stdout
    .split('\n')
    .map((l) => l.trim().replaceAll('\\', '/'))
    .filter((l) => /\.(cs|fs|vb)proj$/.test(l))
    .map((l) => join(dirname(sln), l))
    .filter(existsSync);
}

export async function loadSolution(sln: string, repo: string): Promise<Solution> {
  const files = await listSolutionProjects(sln);
  // Test projects the agent created but forgot to add to the solution still count, so scan the repo too.
  const extraTests = findProjectFiles(repo)
    .filter((p) => !files.includes(p))
    .map((p) => classifyProject(p, repo))
    .filter((p) => p.isTest);
  return { path: sln, projects: [...files.map((p) => classifyProject(p, repo)), ...extraTests] };
}

/** Create a solution containing every project when the repo has none. */
export async function createSolution(repo: string): Promise<string | undefined> {
  const projects = findProjectFiles(repo);
  if (projects.length === 0) return undefined;
  const name = basename(repo);
  await runChecked('dotnet', ['new', 'sln', '-n', name, '--format', 'sln'], { cwd: repo });
  const sln = join(repo, `${name}.sln`);
  await runChecked('dotnet', ['sln', sln, 'add', ...projects], { cwd: repo });
  return sln;
}

/**
 * Entry-point files that may legitimately stay uncovered: Program.cs / Main of executable projects.
 * Everything those files call must still be covered.
 */
export function entryPointFiles(solution: Solution): string[] {
  const out: string[] = [];
  for (const p of solution.projects.filter((x) => x.isExecutable)) {
    for (const f of findFiles(p.dir, (f) => f.endsWith('.cs'), 3)) {
      if (basename(f) === 'Program.cs') out.push(f);
      else if (statSync(f).size < 200_000 && /\bstatic\s+(async\s+)?[\w<>]+\s+Main\s*\(/.test(readFileSync(f, 'utf8'))) out.push(f);
    }
  }
  return out;
}

export const testProjects = (s: Solution) => s.projects.filter((p) => p.isTest);
export const productionProjects = (s: Solution) => s.projects.filter((p) => !p.isTest);
