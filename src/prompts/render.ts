import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

export type PromptName =
  | 'setup-coverlet'
  | 'scaffold-component-tests'
  | 'raise-coverage'
  | 'fix-build'
  | 'fix-tests'
  | 'setup-stryker'
  | 'kill-mutants'
  | 'continue'
  | 'answer';

/**
 * Tiny template language: `{{name}}` substitutes a variable, `{{> partial}}` inlines `_partial.md`.
 * An override directory is searched first so users can customise any prompt without forking.
 */
export class PromptLibrary {
  private readonly dirs: string[];

  constructor(overrideDir?: string) {
    this.dirs = overrideDir ? [overrideDir, DEFAULT_PROMPTS_DIR] : [DEFAULT_PROMPTS_DIR];
  }

  private load(file: string): string {
    for (const dir of this.dirs) {
      const p = join(dir, file);
      if (existsSync(p)) return readFileSync(p, 'utf8');
    }
    throw new Error(`Prompt template not found: ${file} (searched ${this.dirs.join(', ')})`);
  }

  render(name: PromptName, vars: Record<string, string | number | undefined>): string {
    let text = this.load(`${name}.md`);
    for (let depth = 0; depth < 5 && /\{\{>\s*[\w-]+\s*\}\}/.test(text); depth++) {
      text = text.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, partial: string) => this.load(`_${partial}.md`).trim());
    }
    text = text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
      const v = vars[key];
      if (v === undefined) throw new Error(`Prompt ${name} references {{${key}}} but no value was supplied`);
      return String(v);
    });
    return text.replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
}
