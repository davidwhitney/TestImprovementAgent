import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

export const ENV_PREFIX = 'COVERAGE_HARNESS_';

/** `--max-iterations` <-> `COVERAGE_HARNESS_MAX_ITERATIONS` */
export const envNameFor = (option: string) => `${ENV_PREFIX}${option.replaceAll('-', '_').toUpperCase()}`;

/**
 * Load a .env file into process.env without overriding variables that are already set, so the
 * real environment wins over the file. Every variable is loaded, not just harness settings, so
 * agent credentials (ANTHROPIC_API_KEY, GH_TOKEN, OPENROUTER_API_KEY…) reach the agent CLIs too.
 * Returns the path loaded, or undefined when there was no file.
 */
export function loadDotEnv(path: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = resolve(path ?? '.env');
  if (!existsSync(file)) {
    if (path) throw new Error(`--env-file ${path} does not exist`);
    return undefined;
  }
  for (const [key, value] of Object.entries(parseEnv(readFileSync(file, 'utf8')))) {
    if (env[key] === undefined) env[key] = value;
  }
  return file;
}

type OptionSpec = Record<string, { type: 'string' | 'boolean' }>;

/**
 * Fill CLI options that weren't passed on the command line from COVERAGE_HARNESS_* variables.
 * Precedence: command-line flag > environment variable (or .env file) > built-in default.
 */
export function applyEnvDefaults<T extends Record<string, string | boolean | undefined>>(
  options: OptionSpec,
  values: T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const out: Record<string, string | boolean | undefined> = { ...values };
  for (const [name, spec] of Object.entries(options)) {
    if (out[name] !== undefined) continue;
    const raw = env[envNameFor(name)];
    if (raw === undefined || raw === '') continue;
    if (spec.type === 'boolean') {
      if (/^(1|true|yes|on)$/i.test(raw)) out[name] = true;
      else if (/^(0|false|no|off)$/i.test(raw)) out[name] = false;
      else throw new Error(`${envNameFor(name)} must be true/false, got "${raw}"`);
    } else {
      out[name] = raw;
    }
  }
  return out as T;
}
