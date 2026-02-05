export type FileCidsNormalizationSource =
  | 'object'
  | 'array'
  | 'string-json'
  | 'string-invalid'
  | 'null'
  | 'other';

export type FileCidsNormalization = {
  value: Record<string, string>;
  source: FileCidsNormalizationSource;
};

export function normalizeFileCids(value: unknown): FileCidsNormalization {
  if (value == null) {
    return { value: {}, source: 'null' };
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        const normalized = normalizeFileCids(parsed);
        return { value: normalized.value, source: 'string-json' };
      }
      if (parsed && typeof parsed === 'object') {
        return { value: parsed as Record<string, string>, source: 'string-json' };
      }
    } catch {
      // fall through to invalid
    }
    return { value: {}, source: 'string-invalid' };
  }

  if (Array.isArray(value)) {
    const result: Record<string, string> = {};
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) {
        const [path, cid] = item;
        if (typeof path === 'string' && typeof cid === 'string') {
          result[path] = cid;
        }
        continue;
      }

      if (item && typeof item === 'object' && 'path' in item && 'cid' in item) {
        const path = (item as any).path;
        const cid = (item as any).cid;
        if (typeof path === 'string' && typeof cid === 'string') {
          result[path] = cid;
        }
      }
    }
    return { value: result, source: 'array' };
  }

  if (typeof value === 'object') {
    return { value: value as Record<string, string>, source: 'object' };
  }

  return { value: {}, source: 'other' };
}
