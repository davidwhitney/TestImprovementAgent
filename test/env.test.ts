import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { applyEnvDefaults, envNameFor, loadDotEnv } from '../src/env.ts';

const OPTIONS = { target: { type: 'string' }, 'max-iterations': { type: 'string' }, 'skip-mutation': { type: 'boolean' } } as const;

describe('.env support', () => {
  it('maps option names to prefixed variables', () => {
    assert.equal(envNameFor('max-iterations'), 'COVERAGE_HARNESS_MAX_ITERATIONS');
  });

  it('loads a file without overriding the real environment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-env-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'COVERAGE_HARNESS_TARGET=90\nCOVERAGE_HARNESS_STALL_LIMIT=5\n# comment\nANTHROPIC_API_KEY="sk-test"\n');
    const env: NodeJS.ProcessEnv = { COVERAGE_HARNESS_TARGET: '100' };
    assert.equal(loadDotEnv(file, env), file);
    assert.equal(env.COVERAGE_HARNESS_TARGET, '100');
    assert.equal(env.COVERAGE_HARNESS_STALL_LIMIT, '5');
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test');
  });

  it('is optional by default but an explicit --env-file must exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'harness-env2-'));
    const cwd = process.cwd();
    process.chdir(dir);
    try {
      assert.equal(loadDotEnv(undefined, {}), undefined);
    } finally {
      process.chdir(cwd);
    }
    assert.throws(() => loadDotEnv(join(dir, 'missing.env'), {}), /does not exist/);
  });

  it('fills only options not given on the command line, parsing booleans', () => {
    const env = { COVERAGE_HARNESS_TARGET: '90', COVERAGE_HARNESS_MAX_ITERATIONS: '60', COVERAGE_HARNESS_SKIP_MUTATION: 'yes' };
    const values = applyEnvDefaults(OPTIONS, { target: '100' } as Record<string, string | boolean | undefined>, env);
    assert.deepEqual(values, { target: '100', 'max-iterations': '60', 'skip-mutation': true });
    assert.throws(() => applyEnvDefaults(OPTIONS, {}, { COVERAGE_HARNESS_SKIP_MUTATION: 'maybe' }), /must be true\/false/);
  });
});
