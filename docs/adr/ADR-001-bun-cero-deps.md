# ADR-001 · Bun runtime con cero dependencias en producción

- **Status**: Accepted
- **Date**: 2026-04-01 (retroactiva)
- **Implements**: I-6 (modelo de pricing central)
- **Supersedes**: —
- **Superseded by**: —

## Context

El hook `Stop` de Claude Code tiene un timeout duro de 10 segundos. La latencia
de startup (carga de deps, JIT, parsing del entrypoint) consume budget útil
antes de que el hook empiece a hacer trabajo real (leer JSONL, agregar usage,
hacer fetch a Langfuse).

Restricciones del entorno operativo:

- **38 desarrolladores** en Linux/WSL/macOS/Windows, con setups heterogéneos
- **Ejecución por sesión**: el hook arranca cold start cada vez que Claude Code cierra una sesión
- **Sin gestor de procesos persistente**: no hay daemon que mantenga el runtime caliente
- **Cron del reconciler** corre cada 15 min — también cold start
- **Filesystem del dev sensible**: cada dependencia npm es un vector de supply-chain risk con acceso a `~/.claude/projects/**`

Alternativas consideradas:

1. **Node.js + tsx + dependencias mínimas** — startup ~300ms en frío, ~150ms con cache. Cada `import` resuelve el árbol de deps. Vector supply-chain.
2. **Deno** — startup ~200ms, permission model bueno, pero ecosistema npm con compatibilidad parcial. Devs Atlax no tienen Deno preinstalado.
3. **Python + venv** — startup ~500ms, cross-platform OK, pero sin TypeScript nativo y latencia de import muy variable.
4. **Bun + cero deps prod** — startup ~50ms, TS nativo sin tsx, APIs built-in cubren el caso (fetch, file I/O, crypto, spawn, HTTP server).

## Decision

Adoptar **Bun ≥1.3** como runtime único del hook, scripts operativos, MCP server,
y reconciler cron. Restricciones:

- `package.json.dependencies` permanece **vacío** (`{}`)
- `devDependencies` solo para tipos (`bun-types`) y herramientas build-time (`typescript`, `zod` para validación de schemas en tests)
- **Cero `node_modules`** en producción — el setup script (`setup/setup.sh`) verifica que Bun está instalado y rechaza si no
- Las APIs built-in cubren todo el alcance:
  - `fetch` global con `AbortSignal.timeout()` para HTTP
  - `Bun.file()` y `Bun.write()` para I/O
  - `crypto.subtle` y `crypto.randomUUID()` para hashing
  - `Bun.spawn()` para subprocess management
  - `Bun.serve()` para mock servers en E2E tests
- En CI: `oven-sh/setup-bun@v2` con `bun-version: "1.3.x"` (commit SHA pinned)

## Consequences

### Lo que se gana

- **Startup ~50ms** vs Node+tsx ~300ms — ratio 6×, dejando 9.95s útiles del budget de 10s del hook
- **Cero supply-chain risk en producción**: una dep maliciosa publicada en npm no puede entrar al hook
- **`MODEL_PRICING` única fuente de verdad** (I-6): al no haber deps npm, el pricing no puede vivir en un paquete externo que pueda divergir
- **Bundle size**: 0 — el script TS se ejecuta directamente sin compilation step
- **Diagnóstico simple**: un dev puede leer el código completo en una mañana (~3000 líneas TS sin black-box deps)

### Lo que se pierde / restricciones

- **Devs deben tener Bun instalado**: gestionado vía `setup/setup.sh` que detecta y rechaza si falta
- **APIs Bun-específicas no portables a Node sin cambios**: si en el futuro un dev quiere ejecutar el hook con Node, requiere refactor (uso de `Bun.file()`, `Bun.write()`, etc.)
- **No se puede usar librerías populares**: si un caso de uso futuro requiere parser complejo (HTML, PDF, etc.), hay que implementarlo a mano o reconsiderar este ADR
- **Zod en tests**: la única dep "intrusiva" es zod en `devDependencies` — usado solo en tests para validar schemas de respuesta. Se carga via dynamic import en consumers para mantener cero deps prod

### Implementa I-6

`shared/model-pricing.ts` es la SSoT de precios Anthropic. La extension del browser
tiene su espejo (`browser-extension/src/pricing.js`) — el test
`tests/extension-pricing.test.ts` los cross-valida en CI. Sin deps npm, no es
posible que el pricing viva en un paquete externo que pueda diverger silenciosamente.

### Validación periódica

Cada release mayor de Bun (1.4, 2.0): revisar este ADR. Si Bun cambia su modelo
de cero deps o añade fricción significativa, considerar nuevo ADR. La regla
"cero deps prod" es más fundamental que el runtime específico.

## References

- Discusión inicial: PR #1 (sprint inicial v0.1.0)
- Test cross-validation pricing: `tests/extension-pricing.test.ts`
- Setup script: `setup/setup.sh`
- CI Bun setup: `.github/workflows/ci.yml`
