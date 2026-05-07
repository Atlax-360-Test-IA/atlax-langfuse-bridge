/**
 * shared/anthropic-admin-client.ts — Cliente REST mínimo para la Anthropic Admin API.
 *
 * Solo expone los dos endpoints que el bridge necesita para reconciliación de
 * coste real:
 *   - GET /v1/organizations/me                     (validar key + obtener org)
 *   - GET /v1/organizations/cost_report            (coste agregado por modelo/día)
 *
 * Cero dependencias — fetch built-in + AbortSignal.timeout.
 *
 * Granularidad: el endpoint cost_report agrega por modelo + día + workspace +
 * service_tier. NO expone session_id ni user_email — la atribución sesión-level
 * del bridge sigue siendo estimada desde el JSONL local. La señal real solo
 * sirve como verificación día/modelo (drift sistémico, no per-sesión).
 *
 * Ver RFC-001 (`docs/rfcs/RFC-001-anthropic-admin-api-cost-report.md`) para
 * el análisis de granularidad y la decisión de Opción C+matiz.
 */

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface AnthropicAdminConfig {
  apiKey: string;
  timeoutMs?: number;
}

export interface OrganizationInfo {
  id: string;
  type: "organization";
  name: string;
}

export interface CostReportRow {
  currency: "USD";
  amount: string; // decimal string, USD (NOT cents — official docs say "lowest units" but actual response is USD with decimals)
  workspace_id: string | null;
  description: string;
  cost_type: "tokens" | "web_search" | "code_execution" | string;
  context_window?: string;
  model?: string;
  service_tier?: string;
  token_type?: string;
  inference_geo?: string;
}

export interface CostReportBucket {
  starting_at: string; // ISO 8601
  ending_at: string;
  results: CostReportRow[];
}

export interface CostReportResponse {
  data: CostReportBucket[];
  has_more: boolean;
  next_page: string | null;
}

export interface CostReportParams {
  startingAt: string; // ISO 8601 datetime, day-aligned
  endingAt: string;
  groupBy?: Array<"workspace_id" | "description">;
  limit?: number;
  page?: string;
}

function resolveConfig(
  override?: Partial<AnthropicAdminConfig>,
): AnthropicAdminConfig {
  const apiKey = override?.apiKey ?? process.env["ANTHROPIC_ADMIN_API_KEY"];
  if (!apiKey || typeof apiKey !== "string") {
    throw new Error(
      "[anthropic-admin-client] ANTHROPIC_ADMIN_API_KEY no configurada",
    );
  }
  // Admin keys empiezan por sk-ant-admin*; standard keys por sk-ant-api*.
  // Standard keys autentican pero todos los endpoints /v1/organizations/* responden 404.
  if (!apiKey.startsWith("sk-ant-admin")) {
    throw new Error(
      "[anthropic-admin-client] La key proporcionada no parece Admin API key (debe empezar por 'sk-ant-admin'). Las keys estándar (sk-ant-api*) no tienen acceso a /v1/organizations/*",
    );
  }
  return {
    apiKey,
    timeoutMs: override?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function adminRequest<T>(
  path: string,
  cfg: AnthropicAdminConfig,
): Promise<T> {
  const url = `${ANTHROPIC_API_BASE}${path}`;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      "User-Agent": "atlax-langfuse-bridge/1.0",
    },
    signal: AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[anthropic-admin-client] GET ${path} → ${res.status}: ${body.slice(0, 200)}`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Valida la key contra /v1/organizations/me. Útil al arrancar el reconciler
 * para fallar rápido si la key es inválida o tiene scope incorrecto.
 */
export async function getOrganization(
  override?: Partial<AnthropicAdminConfig>,
): Promise<OrganizationInfo> {
  const cfg = resolveConfig(override);
  return adminRequest<OrganizationInfo>("/v1/organizations/me", cfg);
}

/**
 * Devuelve el cost report agregado por día y modelo dentro de [startingAt, endingAt].
 *
 * No incluye Priority Tier (los costes Priority requieren el endpoint
 * `usage_report/messages` con tokens, no este). El bridge actual solo trata
 * con tier "standard" para sesiones API-key, y para seats Premium el coste
 * real no es accesible vía API (H1/A3 — RFC-001).
 */
export async function getCostReport(
  params: CostReportParams,
  override?: Partial<AnthropicAdminConfig>,
): Promise<CostReportResponse> {
  const cfg = resolveConfig(override);
  const qs = new URLSearchParams();
  qs.set("starting_at", params.startingAt);
  qs.set("ending_at", params.endingAt);
  for (const dim of params.groupBy ?? []) qs.append("group_by[]", dim);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.page) qs.set("page", params.page);
  return adminRequest<CostReportResponse>(
    `/v1/organizations/cost_report?${qs.toString()}`,
    cfg,
  );
}

/**
 * Suma el coste real (USD) por modelo a partir de un cost_report. La key del
 * mapa es el `model` ID exacto (ej. "claude-sonnet-4-6"). Filas sin `model`
 * (ej. web_search costs) van a una entrada especial "__non_token__".
 */
export function sumCostByModel(
  report: CostReportResponse,
): Map<string, number> {
  const acc = new Map<string, number>();
  for (const bucket of report.data) {
    for (const row of bucket.results) {
      const key = row.model ?? "__non_token__";
      const usd = Number(row.amount);
      if (!Number.isFinite(usd)) continue;
      acc.set(key, (acc.get(key) ?? 0) + usd);
    }
  }
  return acc;
}
