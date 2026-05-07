import { COST_EPSILON } from "./constants";

export type DriftStatus =
  | "OK"
  | "MISSING"
  | "TURNS_DRIFT"
  | "COST_DRIFT"
  | "COST_NOT_CALCULATED"
  | "END_DRIFT";

export function classifyDrift(
  local: { turns: number; totalCost: number; end: string | null | undefined },
  remote: { metadata?: Record<string, unknown> | null } | null,
  generationCost?: number | null,
): DriftStatus {
  if (!remote) return "MISSING";
  const meta = remote.metadata ?? null;
  const rTurns = typeof meta?.["turns"] === "number" ? meta["turns"] : null;
  const rCost =
    typeof meta?.["estimatedCostUSD"] === "number"
      ? meta["estimatedCostUSD"]
      : null;
  const rEnd =
    typeof meta?.["sessionEnd"] === "string" ? meta["sessionEnd"] : null;
  if (rTurns !== local.turns) return "TURNS_DRIFT";
  if (Math.abs((rCost ?? 0) - local.totalCost) > COST_EPSILON)
    return "COST_DRIFT";
  if (rEnd !== local.end) return "END_DRIFT";
  if (
    local.totalCost > COST_EPSILON &&
    generationCost !== null &&
    generationCost !== undefined &&
    generationCost < COST_EPSILON
  )
    return "COST_NOT_CALCULATED";
  return "OK";
}
