import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { Git } from '../src/git.ts';
import { enforceTestOnlyChanges } from '../src/guard.ts';
import { discoverRepos, ManifestStore } from '../src/manifest.ts';
import { PromptLibrary, type PromptName } from '../src/prompts/render.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

function makeRepo(root: string, name: string, files: Record<string, string>): string {
  const repo = join(root, name);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  return repo;
}

const APP_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>';
const TEST_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" /></ItemGroup></Project>';

describe('repo discovery and manifest', () => {
  it('finds git repos under dir/* and records them as pending', () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-src-'));
    makeRepo(root, 'b', { 'README.md': 'b' });
    makeRepo(root, 'a', { 'README.md': 'a' });
    mkdirSync(join(root, 'not-a-repo'));
    const { repos } = discoverRepos(`${root}/*`);
    assert.deepEqual(repos, [join(root, 'a'), join(root, 'b')]);
    assert.throws(() => discoverRepos(join(root, 'not-a-repo')), /not a git repository/);

    const path = join(root, 'm.json');
    ManifestStore.openOrCreate(path, { source: root, target: 90, mutationTarget: 80, agent: 'claude' }, repos);
    const reopened = ManifestStore.openOrCreate(path, { source: root, target: 95, mutationTarget: 80, agent: 'copilot' }, repos);
    assert.equal(reopened.data.repos.length, 2);
    assert.equal(reopened.data.target, 95);
    assert.equal(ManifestStore.read(path).repos[0]!.status, 'pending');
  });

  it('serialises concurrent updates', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-m-'));
    const store = ManifestStore.openOrCreate(join(root, 'm.json'), { source: root, target: 90, mutationTarget: 80, agent: 'claude' }, ['/x', '/y']);
    await Promise.all([store.update('/x', (e) => (e.coverage = 50)), store.update('/y', (e) => (e.coverage = 60))]);
    const onDisk = JSON.parse(readFileSync(join(root, 'm.json'), 'utf8'));
    assert.deepEqual(onDisk.repos.map((r: { coverage: number }) => r.coverage), [50, 60]);
  });
});

describe('interrupted-run recovery', () => {
  it('stashes uncommitted and untracked work instead of destroying it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-stash-'));
    const repo = makeRepo(root, 'app', { 'a.txt': 'one' });
    const g = new Git(repo);
    const head = await g.head();
    writeFileSync(join(repo, 'a.txt'), 'two');
    writeFileSync(join(repo, 'stryker-config.json'), '{}');
    assert.equal(await g.stashAll('parked'), true);
    assert.equal(await g.isClean(), true);
    assert.equal(await g.head(), head);
    assert.match(git(repo, 'stash', 'list').toString(), /parked/);
    git(repo, 'stash', 'pop', '-q');
    assert.equal(readFileSync(join(repo, 'stryker-config.json'), 'utf8'), '{}');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'two');
    await g.resetTo(head);
    assert.equal(await g.stashAll('nothing'), false);
  });
});

describe('production-code guard', () => {
  it('keeps test changes and allowed hooks, reverts everything else', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-guard-'));
    const repo = makeRepo(root, 'app', {
      'src/App/App.csproj': APP_CSPROJ,
      'src/App/Program.cs': 'var app = WebApplication.Create();\napp.Run();\n',
      'src/App/Service.cs': 'class Service { int X() => 1; }\n',
      'tests/App.ComponentTests/App.ComponentTests.csproj': TEST_CSPROJ,
    });
    const g = new Git(repo);
    const checkpoint = await g.head();

    writeFileSync(join(repo, 'src/App/Program.cs'), 'var app = WebApplication.Create();\napp.Run();\n\npublic partial class Program { }\n');
    writeFileSync(join(repo, 'src/App/Service.cs'), 'class Service { [ExcludeFromCodeCoverage] int X() => 1; }\n');
    writeFileSync(join(repo, 'src/App/NewFile.cs'), 'class Sneaky {}\n');
    writeFileSync(join(repo, 'tests/App.ComponentTests/OrderTests.cs'), 'class OrderTests {}\n');

    const { reverted } = await enforceTestOnlyChanges(g, repo, checkpoint);
    assert.deepEqual(reverted.sort(), ['src/App/NewFile.cs', 'src/App/Service.cs']);
    assert.match(readFileSync(join(repo, 'src/App/Program.cs'), 'utf8'), /public partial class Program/);
    assert.equal(readFileSync(join(repo, 'src/App/Service.cs'), 'utf8'), 'class Service { int X() => 1; }\n');
    assert.equal(existsSync(join(repo, 'src/App/NewFile.cs')), false);
    assert.ok(existsSync(join(repo, 'tests/App.ComponentTests/OrderTests.cs')));
  });

  it('rejects Program.cs edits beyond the partial class hook', async () => {
    const root = mkdtempSync(join(tmpdir(), 'harness-guard2-'));
    const repo = makeRepo(root, 'app', { 'src/App/App.csproj': APP_CSPROJ, 'src/App/Program.cs': 'app.Run();\n' });
    const g = new Git(repo);
    const checkpoint = await g.head();
    writeFileSync(join(repo, 'src/App/Program.cs'), 'if (false) app.Run();\npublic partial class Program { }\n');
    assert.deepEqual((await enforceTestOnlyChanges(g, repo, checkpoint)).reverted, ['src/App/Program.cs']);
  });
});

describe('prompts', () => {
  const lib = new PromptLibrary();
  const vars = {
    repoPath: '/r', solution: 'App.sln', projectSummary: 'x', noTestProjectInstruction: 'x', previousAttempt: '', coverage: 10, target: 100,
    componentProjectName: 'App.ComponentTests', componentProjectDir: 'tests/App.ComponentTests', iteration: 1, branchCoverage: 5,
    componentProjects: 'x', gaps: 'GAPS', history: '', context: 'x', errors: 'E', notes: '', failures: 'F', testProjects: 'x',
    mutationTarget: 80, mutationScore: 40, survivors: 'S', question: 'Q?',
  };
  const names: PromptName[] = ['create-test-project', 'scaffold-component-tests', 'raise-coverage', 'fix-build', 'fix-tests', 'setup-stryker', 'kill-mutants', 'continue', 'answer'];

  for (const name of names) {
    it(`renders ${name} with every placeholder and partial resolved`, () => {
      const text = lib.render(name, vars);
      assert.doesNotMatch(text, /\{\{/);
    });
  }

  it('embeds the rules, standards and report contract in task prompts', () => {
    const text = lib.render('raise-coverage', vars);
    assert.match(text, /Do not commit/);
    assert.match(text, /HttpMessageHandler/);
    assert.match(text, /<harness-report>/);
    assert.match(text, /GAPS/);
  });

  it('fails loudly on a missing variable', () => {
    assert.throws(() => lib.render('fix-build', { solution: 'x' }), /no value was supplied/);
  });
});
