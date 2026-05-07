/**
 * Tests para shared/anthropic-admin-client.ts
 * Mockea fetch a nivel global para no tocar la API real.
 */

import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import {
  getOrganization,
  getCostReport,
  sumCostByModel,
  type CostReportResponse,
} from "./anthropic-admin-client";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ORG_FIXTURE = {
  id: "42baa236-3c97-40c0-a83c-53a4fd115264",
  type: "organization" as const,
  name: "Atlax 360",
};

const COST_REPORT_FIXTURE: CostReportResponse = {
  data: [
    {
      starting_at: "2026-05-01T00:00:00Z",
      ending_at: "2026-05-02T00:00:00Z",
      results: [
        {
          currency: "USD",
          amount: "197.4518",
          workspace_id: null,
          description: "Claude Haiku 4.5 Usage - Input Tokens",
          cost_type: "tokens",
          model: "claude-haiku-4-5-20251001",
          service_tier: "standard",
          token_type: "uncached_input_tokens",
        },
        {
          currency: "USD",
          amount: "7.936",
          workspace_id: null,
          description: "Claude Haiku 4.5 Usage - Output Tokens",
          cost_type: "tokens",
          model: "claude-haiku-4-5-20251001",
          service_tier: "standard",
          token_type: "output_tokens",
        },
        {
          currency: "USD",
          amount: "3572.0415",
          workspace_id: null,
          description: "Claude Sonnet 4.6 Usage - Input Tokens",
          cost_type: "tokens",
          model: "claude-sonnet-4-6",
          service_tier: "standard",
          token_type: "uncached_input_tokens",
        },
        {
          currency: "USD",
          amount: "1539.6165",
          workspace_id: null,
          description: "Claude Sonnet 4.6 Usage - Output Tokens",
          cost_type: "tokens",
          model: "claude-sonnet-4-6",
          service_tier: "standard",
          token_type: "output_tokens",
        },
      ],
    },
  ],
  has_more: false,
  next_page: null,
};

// ─── resolveConfig (vía endpoints exportados) ────────────────────────────────

describe("resolveConfig — credential validation", () => {
  const savedKey = process.env["ANTHROPIC_ADMIN_API_KEY"];
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    if (savedKey !== undefined)
      process.env["ANTHROPIC_ADMIN_API_KEY"] = savedKey;
    else delete process.env["ANTHROPIC_ADMIN_API_KEY"];
  });

  test("rechaza ausencia de ANTHROPIC_ADMIN_API_KEY", async () => {
    delete process.env["ANTHROPIC_ADMIN_API_KEY"];
    await expect(getOrganization()).rejects.toThrow(
      "ANTHROPIC_ADMIN_API_KEY no configurada",
    );
  });

  test("rechaza key con prefijo standard (sk-ant-api*) — 404 en /v1/organizations/*", async () => {
    process.env["ANTHROPIC_ADMIN_API_KEY"] = "sk-ant-api03-fake";
    await expect(getOrganization()).rejects.toThrow("no parece Admin API key");
  });

  test("acepta key con prefijo sk-ant-admin*", async () => {
    process.env["ANTHROPIC_ADMIN_API_KEY"] = "sk-ant-admin01-fake";
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(ORG_FIXTURE)),
    );
    const org = await getOrganization();
    expect(org.id).toBe(ORG_FIXTURE.id);
  });
});

// ─── getOrganization ─────────────────────────────────────────────────────────

describe("getOrganization", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["ANTHROPIC_ADMIN_API_KEY"] = "sk-ant-admin01-test";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env["ANTHROPIC_ADMIN_API_KEY"];
  });

  test("retorna org info en 200", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(ORG_FIXTURE)),
    );
    const org = await getOrganization();
    expect(org.name).toBe("Atlax 360");
  });

  test("propaga error en 401", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 })),
    );
    await expect(getOrganization()).rejects.toThrow("401");
  });

  test("envía headers x-api-key + anthropic-version + User-Agent", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(ORG_FIXTURE)),
    );
    await getOrganization();
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-admin01-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["User-Agent"]).toContain("atlax-langfuse-bridge");
  });

  test("usa override.apiKey cuando se proporciona", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(ORG_FIXTURE)),
    );
    await getOrganization({ apiKey: "sk-ant-admin01-override" });
    const init = fetchSpy.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-ant-admin01-override");
  });
});

// ─── getCostReport ───────────────────────────────────────────────────────────

describe("getCostReport", () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env["ANTHROPIC_ADMIN_API_KEY"] = "sk-ant-admin01-test";
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    delete process.env["ANTHROPIC_ADMIN_API_KEY"];
  });

  test("retorna report con buckets diarios", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(COST_REPORT_FIXTURE)),
    );
    const report = await getCostReport({
      startingAt: "2026-05-01T00:00:00Z",
      endingAt: "2026-05-02T00:00:00Z",
    });
    expect(report.data).toHaveLength(1);
    expect(report.data[0]!.results).toHaveLength(4);
    expect(report.has_more).toBe(false);
  });

  test("incluye starting_at y ending_at en query string", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(COST_REPORT_FIXTURE)),
    );
    await getCostReport({
      startingAt: "2026-05-01T00:00:00Z",
      endingAt: "2026-05-08T00:00:00Z",
    });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("starting_at=2026-05-01T00%3A00%3A00Z");
    expect(url).toContain("ending_at=2026-05-08T00%3A00%3A00Z");
  });

  test("serializa group_by como param repetido", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(makeResponse(COST_REPORT_FIXTURE)),
    );
    await getCostReport({
      startingAt: "2026-05-01T00:00:00Z",
      endingAt: "2026-05-08T00:00:00Z",
      groupBy: ["workspace_id", "description"],
    });
    const url = fetchSpy.mock.calls[0]![0] as string;
    expect(url).toContain("group_by%5B%5D=workspace_id");
    expect(url).toContain("group_by%5B%5D=description");
  });

  test("propaga error en 403 (key sin permisos admin)", async () => {
    fetchSpy.mockImplementation(() =>
      Promise.resolve(new Response("forbidden", { status: 403 })),
    );
    await expect(
      getCostReport({
        startingAt: "2026-05-01T00:00:00Z",
        endingAt: "2026-05-08T00:00:00Z",
      }),
    ).rejects.toThrow("403");
  });
});

// ─── sumCostByModel ──────────────────────────────────────────────────────────

describe("sumCostByModel", () => {
  test("agrupa correctamente input + output por modelo", () => {
    const m = sumCostByModel(COST_REPORT_FIXTURE);
    expect(m.get("claude-haiku-4-5-20251001")).toBeCloseTo(197.4518 + 7.936, 3);
    expect(m.get("claude-sonnet-4-6")).toBeCloseTo(3572.0415 + 1539.6165, 3);
  });

  test("filas sin model van a __non_token__", () => {
    const r: CostReportResponse = {
      data: [
        {
          starting_at: "2026-05-01T00:00:00Z",
          ending_at: "2026-05-02T00:00:00Z",
          results: [
            {
              currency: "USD",
              amount: "12.50",
              workspace_id: null,
              description: "Web Search Usage",
              cost_type: "web_search",
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    };
    const m = sumCostByModel(r);
    expect(m.get("__non_token__")).toBe(12.5);
  });

  test("ignora amounts no finitos", () => {
    const r: CostReportResponse = {
      data: [
        {
          starting_at: "2026-05-01T00:00:00Z",
          ending_at: "2026-05-02T00:00:00Z",
          results: [
            {
              currency: "USD",
              amount: "not-a-number",
              workspace_id: null,
              description: "Bad row",
              cost_type: "tokens",
              model: "claude-sonnet-4-6",
            },
            {
              currency: "USD",
              amount: "10",
              workspace_id: null,
              description: "Good row",
              cost_type: "tokens",
              model: "claude-sonnet-4-6",
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    };
    const m = sumCostByModel(r);
    expect(m.get("claude-sonnet-4-6")).toBe(10);
  });

  test("retorna mapa vacío para report sin data", () => {
    const empty: CostReportResponse = {
      data: [],
      has_more: false,
      next_page: null,
    };
    expect(sumCostByModel(empty).size).toBe(0);
  });

  test("acumula a través de múltiples buckets diarios", () => {
    const r: CostReportResponse = {
      data: [
        {
          starting_at: "2026-05-01T00:00:00Z",
          ending_at: "2026-05-02T00:00:00Z",
          results: [
            {
              currency: "USD",
              amount: "100",
              workspace_id: null,
              description: "input",
              cost_type: "tokens",
              model: "claude-sonnet-4-6",
            },
          ],
        },
        {
          starting_at: "2026-05-02T00:00:00Z",
          ending_at: "2026-05-03T00:00:00Z",
          results: [
            {
              currency: "USD",
              amount: "50",
              workspace_id: null,
              description: "input",
              cost_type: "tokens",
              model: "claude-sonnet-4-6",
            },
          ],
        },
      ],
      has_more: false,
      next_page: null,
    };
    expect(sumCostByModel(r).get("claude-sonnet-4-6")).toBe(150);
  });
});
