export interface DegradationEntry {
  type: "degradation";
  source: string;
  error: string;
  ts: string;
}

export function emitDegradation(source: string, err: unknown): void {
  const entry: DegradationEntry = {
    type: "degradation",
    source,
    error: err instanceof Error ? err.message : String(err),
    ts: new Date().toISOString(),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}
