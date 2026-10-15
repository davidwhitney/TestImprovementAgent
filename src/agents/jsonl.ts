/** Parse one line of a JSONL event stream, ignoring non-JSON noise some CLIs print. */
export function parseJsonLine(line: string): Record<string, any> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export const oneLine = (s: string, max = 160) => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

export function describeToolInput(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.filePath ?? o.path ?? o.pattern ?? o.description;
  return typeof v === 'string' ? oneLine(v, 120) : '';
}
