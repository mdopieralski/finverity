// One JSON object per line on stdout. The fields are the dimensions a metrics pipeline would use
// (route, status, outcome, durationMs); there is no exporter (README "Limitations").
// Never log tokens, request bodies or anything a client typed beyond ids and amounts.

export type Level = 'info' | 'warn' | 'error';

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_SILENT === '1') {
    return; // the e2e suite sets this; the logging test turns it back on to inspect lines
  }
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields }, (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v
  );
  process.stdout.write(`${line}\n`);
}
