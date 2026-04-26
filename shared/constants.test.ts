import { describe, it, expect } from "bun:test";
import { COST_EPSILON } from "./constants";

describe("constants", () => {
  it("COST_EPSILON is 0.01", () => {
    expect(COST_EPSILON).toBe(0.01);
  });

  it("COST_EPSILON is a positive number", () => {
    expect(COST_EPSILON).toBeGreaterThan(0);
  });

  it("COST_EPSILON type is number", () => {
    expect(typeof COST_EPSILON).toBe("number");
  });
});
