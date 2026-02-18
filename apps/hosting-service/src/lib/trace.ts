/**
 * Lightweight request tracing, toggled via TRACE_REQUESTS=true.
 *
 * Usage:
 *   const trace = createTrace();
 *   const result = await span(trace, 'db:settings', () => getCachedSettings(...));
 *   logTrace(trace, 'GET /index.html', logger);
 */

export const TRACE_ENABLED = process.env.TRACE_REQUESTS === 'true';

export interface Span {
  name: string;
  durationMs: number;
}

export interface RequestTrace {
  spans: Span[];
  startMs: number;
}

export function createTrace(): RequestTrace | null {
  if (!TRACE_ENABLED) return null;
  return { spans: [], startMs: performance.now() };
}

export async function span<T>(
  trace: RequestTrace | null | undefined,
  name: string,
  fn: () => Promise<T>
): Promise<T> {
  if (!trace) return fn();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    trace.spans.push({ name, durationMs: +(performance.now() - t0).toFixed(2) });
  }
}

export function logTrace(
  trace: RequestTrace | null,
  label: string,
  logger: { info: (msg: string, ctx?: Record<string, unknown>) => void }
) {
  if (!trace) return;
  const totalMs = +(performance.now() - trace.startMs).toFixed(2);
  const breakdown: Record<string, unknown> = { total: totalMs };
  for (const s of trace.spans) {
    breakdown[s.name] = s.durationMs;
  }
  logger.info(`TRACE ${label}`, breakdown);
}
