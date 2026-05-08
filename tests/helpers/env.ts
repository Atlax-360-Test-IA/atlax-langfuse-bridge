/**
 * tests/helpers/env.ts — Helper para manipular process.env en tests sin
 * violar I-12 (save/restore por clave específica, no `process.env = {...}`).
 *
 * Uso:
 *
 *   import { saveEnv, restoreEnv } from "./helpers/env";
 *
 *   describe("module that reads env", () => {
 *     const SAVED = saveEnv(["MY_VAR", "OTHER_VAR"]);
 *     afterEach(() => restoreEnv(SAVED));
 *
 *     test("...", () => {
 *       process.env["MY_VAR"] = "test-value";
 *       // ...
 *     });
 *   });
 *
 * Por qué importa: Bun expone `process.env` como un Proxy; reasignar el objeto
 * completo (`process.env = {...}`) no mantiene el contrato de modificar el
 * environment subyacente. Save/restore por clave es el único patrón que
 * funciona consistentemente entre versiones de Bun.
 */

export type EnvSnapshot = ReadonlyMap<string, string | undefined>;

/**
 * Captura el valor actual de cada clave especificada. Devuelve un Map
 * inmutable que se pasa a `restoreEnv()` en el afterEach.
 */
export function saveEnv(keys: readonly string[]): EnvSnapshot {
  const snap = new Map<string, string | undefined>();
  for (const k of keys) snap.set(k, process.env[k]);
  return snap;
}

/**
 * Restaura los valores guardados. Las claves que estaban undefined se eliminan
 * con `delete`, el resto se reasignan a su valor original.
 */
export function restoreEnv(snap: EnvSnapshot): void {
  for (const [k, v] of snap) {
    if (v !== undefined) process.env[k] = v;
    else delete process.env[k];
  }
}
