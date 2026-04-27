import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { loadEnvFile } from "./env-loader";

const TMP = join(tmpdir(), `env-loader-test-${process.pid}`);
const TMP_ENV = join(TMP, "reconcile.env");

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
  // Clean up any env vars set during tests
  delete process.env["TEST_VAR_A"];
  delete process.env["TEST_VAR_B"];
  delete process.env["TEST_VAR_C"];
  delete process.env["TEST_EXISTING"];
});

describe("loadEnvFile", () => {
  it("sets env vars from file", () => {
    writeFileSync(TMP_ENV, "TEST_VAR_A=hello\nTEST_VAR_B=world\n");
    delete process.env["TEST_VAR_A"];
    delete process.env["TEST_VAR_B"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("hello");
    expect(process.env["TEST_VAR_B"]).toBe("world");
  });

  it("does not overwrite already-set vars", () => {
    process.env["TEST_EXISTING"] = "original";
    writeFileSync(TMP_ENV, "TEST_EXISTING=override\n");
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_EXISTING"]).toBe("original");
  });

  it("skips comment lines", () => {
    writeFileSync(TMP_ENV, "# comment\nTEST_VAR_C=value\n");
    delete process.env["TEST_VAR_C"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_C"]).toBe("value");
  });

  it("skips blank lines without throwing", () => {
    writeFileSync(TMP_ENV, "\n\nTEST_VAR_A=ok\n\n");
    delete process.env["TEST_VAR_A"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("ok");
  });

  it("silences error when file does not exist", () => {
    expect(() => loadEnvFile("/nonexistent/path/file.env")).not.toThrow();
  });

  it("skips lines without = sign", () => {
    writeFileSync(TMP_ENV, "INVALID_LINE\nTEST_VAR_A=valid\n");
    delete process.env["TEST_VAR_A"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("valid");
  });

  it("handles value with = in it (only splits on first =)", () => {
    writeFileSync(TMP_ENV, "TEST_VAR_A=base64==\n");
    delete process.env["TEST_VAR_A"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("base64==");
  });

  it("strips UTF-8 BOM from file start", () => {
    // BOM = ﻿ (EF BB BF in UTF-8)
    writeFileSync(TMP_ENV, "﻿TEST_VAR_A=bom-value\n");
    delete process.env["TEST_VAR_A"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("bom-value");
  });

  it("strips enclosing double quotes from value", () => {
    writeFileSync(TMP_ENV, 'TEST_VAR_A="http://localhost:3000"\n');
    delete process.env["TEST_VAR_A"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("http://localhost:3000");
  });

  it("strips enclosing single quotes from value", () => {
    writeFileSync(TMP_ENV, "TEST_VAR_A='my secret value'\n");
    delete process.env["TEST_VAR_A"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("my secret value");
  });

  it("does not strip mismatched quotes", () => {
    writeFileSync(TMP_ENV, "TEST_VAR_A=\"mismatched'\n");
    delete process.env["TEST_VAR_A"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("\"mismatched'");
  });

  it("does not strip single quote at start only", () => {
    writeFileSync(TMP_ENV, "TEST_VAR_A='no-end\n");
    delete process.env["TEST_VAR_A"];
    loadEnvFile(TMP_ENV);
    expect(process.env["TEST_VAR_A"]).toBe("'no-end");
  });
});
