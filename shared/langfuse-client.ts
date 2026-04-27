/**
 * shared/langfuse-client.ts — Cliente REST minimalista para Langfuse
 *
 * Encapsula auth, timeout y error handling. Usado por tools agénticos
 * (ver tools/) y extensible a otros consumers (scripts/) en iteración posterior.
 *
 * Cero dependencias. Fetch built-in + AbortSignal.timeout.
 */

export interface LangfuseConfig {
  host: string;
  publicKey: string;
  secretKey: string;
  timeoutMs?: number;
}

export interface LangfuseTrace {
  id: string;
  name: string | null;
  timestamp: string;
  userId: string | null;
  sessionId: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
  input: unknown;
  output: unknown;
  observations: unknown[];
  scores: unknown[];
}

export interface TraceListParams {
  tags?: string[] | undefined;
  userId?: string | undefined;
  sessionId?: string | undefined;
  fromTimestamp?: string | undefined;
  toTimestamp?: string | undefined;
  limit?: number | undefined;
  orderBy?: string | undefined;
}

export interface ScoreBody {
  id?: string | undefined;
  traceId: string;
  observationId?: string | undefined;
  name: string;
  value: number | string | boolean;
  dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN" | undefined;
  comment?: string | undefined;
}

// Allowlist for LANGFUSE_HOST — prevents SSRF via misconfigured env var.
// Accepts HTTPS for any host, or HTTP for localhost/127.0.0.1 only.
export function isSafeHost(raw: string): boolean {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2048)
    return false;
  if (raw.includes("/../") || raw.includes("/..%2F") || raw.includes("%2F.."))
    return false;
  try {
    const u = new URL(raw);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:")
      return u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return false;
  } catch {
    return false;
  }
}

function buildConfig(override?: Partial<LangfuseConfig>): LangfuseConfig {
  const host =
    override?.host ??
    process.env["LANGFUSE_HOST"] ??
    "https://cloud.langfuse.com";
  if (!isSafeHost(host)) {
    throw new Error(
      `[langfuse-client] LANGFUSE_HOST blocked (must be https:// or http://localhost): ${host}`,
    );
  }
  const publicKey = override?.publicKey ?? process.env["LANGFUSE_PUBLIC_KEY"];
  const secretKey = override?.secretKey ?? process.env["LANGFUSE_SECRET_KEY"];
  if (!publicKey || !secretKey) {
    throw new Error(
      "[langfuse-client] LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY missing",
    );
  }
  return {
    host: host.replace(/\/$/, ""),
    publicKey,
    secretKey,
    timeoutMs: override?.timeoutMs ?? 10_000,
  };
}

function authHeader(cfg: LangfuseConfig): string {
  return (
    "Basic " +
    Buffer.from(`${cfg.publicKey}:${cfg.secretKey}`).toString("base64")
  );
}

async function request<T>(
  path: string,
  init: RequestInit,
  cfg: LangfuseConfig,
): Promise<T> {
  const res = await fetch(`${cfg.host}${path}`, {
    ...init,
    headers: {
      Authorization: authHeader(cfg),
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(cfg.timeoutMs!),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[langfuse-client] ${init.method ?? "GET"} ${path} → ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * GET /api/public/traces/:id — retrieve a single trace by ID.
 * Returns null if not found (404), throws on other errors.
 */
export async function getTrace(
  id: string,
  override?: Partial<LangfuseConfig>,
): Promise<LangfuseTrace | null> {
  const cfg = buildConfig(override);
  try {
    return await request<LangfuseTrace>(
      `/api/public/traces/${encodeURIComponent(id)}`,
      { method: "GET" },
      cfg,
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("→ 404")) return null;
    throw err;
  }
}

/**
 * GET /api/public/traces?tags=…&limit=… — list traces with filters.
 */
export async function listTraces(
  params: TraceListParams,
  override?: Partial<LangfuseConfig>,
): Promise<{ data: LangfuseTrace[]; meta: { totalItems: number } }> {
  const cfg = buildConfig(override);
  const qs = new URLSearchParams();
  if (params.tags) for (const t of params.tags) qs.append("tags", t);
  if (params.userId) qs.set("userId", params.userId);
  if (params.sessionId) qs.set("sessionId", params.sessionId);
  if (params.fromTimestamp) qs.set("fromTimestamp", params.fromTimestamp);
  if (params.toTimestamp) qs.set("toTimestamp", params.toTimestamp);
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.orderBy) qs.set("orderBy", params.orderBy);

  return request(`/api/public/traces?${qs.toString()}`, { method: "GET" }, cfg);
}

/**
 * POST /api/public/scores — attach a score (NUMERIC, CATEGORICAL, or BOOLEAN).
 * Scores are the canonical Langfuse annotation mechanism — prefer over
 * metadata patches, which would require a separate ingestion event.
 */
export async function createScore(
  body: ScoreBody,
  override?: Partial<LangfuseConfig>,
): Promise<{ id: string }> {
  const cfg = buildConfig(override);
  return request(
    "/api/public/scores",
    { method: "POST", body: JSON.stringify(body) },
    cfg,
  );
}
