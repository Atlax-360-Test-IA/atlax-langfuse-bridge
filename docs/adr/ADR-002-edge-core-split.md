# ADR-002 · Topología edge/core — el hook y el reconciler nunca migran a Cloud Run

- **Status**: Accepted
- **Date**: 2026-04-26 (formalizado en Sprint 15, retroactivo al diseño inicial)
- **Implements**: I-13
- **Supersedes**: —
- **Superseded by**: —
- **Related**: [ADR-003](./ADR-003-langfuse-idempotent.md) (idempotencia upstream),
  [ADR-006](./ADR-006-two-layer-consistency.md) (dos capas)

## Context

Al planificar la migración a PRO (Cloud Run) en Sprint 15, surgió la pregunta
natural: **¿se puede centralizar el hook y el reconciler en un servicio Cloud
Run para simplificar el despliegue?**

La respuesta inicial parecía SÍ — Cloud Run es server-side, gestiona escalado,
y simplifica la operación (no hay que mantener systemd timers en cada máquina dev).

Análisis detallado destapó razones técnicas para descartar la centralización:

### Razones por las que NO se puede centralizar

1. **Los JSONLs viven en `~/.claude/projects/**/sessions/\*.jsonl`\*\* — son escritos
   por Claude Code en cada turno, en la máquina del dev. No hay endpoint público
   donde estén disponibles. Centralizar requiere:
   - Endpoint custom de upload (vector SSRF — cada dev sube ficheros a un servicio público)
   - O cambiar el modelo de eventos (Claude Code no expone webhook stream)
   - Ambos son arquitecturas más complejas que el modelo edge actual

2. **`~/.atlax-ai/tier.json`** se escribe desde la statusline de Claude Code en
   la máquina del dev. La statusline solo puede ejecutar comandos locales — no
   puede llamar a un servicio Cloud Run con el contexto del turno (env vars,
   credentials).

3. **`~/.atlax-ai/reconcile.env`** es config por-dev (cada uno con su `WINDOW_HOURS`
   personalizado, sus credenciales Langfuse, su email para el reconciler).
   Centralizar requeriría una BD multi-tenant para almacenar config por-dev.

4. **El cron systemd/launchd** vive en la máquina del dev por necesidad: cubre
   modos de fallo del hook que solo son detectables localmente (kill -9 del
   parent, crash del terminal, reboot). Un cron en Cloud Run no tiene visibilidad
   sobre el estado de Claude Code en la máquina del dev.

### Riesgo de no formalizarlo

Sin este ADR, en futuras revisiones alguien con buenas intenciones podría
intentar "simplificar" el deployment migrando el hook a Cloud Run. El test
`tests/cloud-run-boundary.test.ts` (17 tests) es un guard estructural, pero
sin documentación del **por qué** podría ser desactivado por error.

## Decision

El sistema se divide formalmente en dos zonas con propiedades arquitectónicas
distintas:

### Edge (máquina del dev) — NUNCA migra

| Componente                    | Razón                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `hooks/langfuse-sync.ts`      | Lee JSONL en `~/.claude/projects/`, escrito por Claude Code en máquina dev    |
| `scripts/reconcile-traces.ts` | Escanea `~/.claude/projects/**/sessions/*.jsonl` en sistema de archivos local |
| `scripts/detect-tier.ts`      | Comprueba existencia de `~/.claude/.credentials.json` (I-8)                   |
| `shared/jsonl-discovery.ts`   | `os.homedir()` + glob de `~/.claude/projects/**`                              |
| `shared/env-loader.ts`        | Lee `~/.atlax-ai/reconcile.env` con config por-dev                            |
| `browser-extension/`          | Corre en Chrome del dev, intercepta SSE de claude.ai                          |
| `scripts/statusline.sh`       | Invocado por Claude Code en cada turno                                        |
| `scripts/backup-langfuse.sh`  | Usa `docker exec` — refusa correr si detecta `K_SERVICE` (Cloud Run env)      |

### Core (Cloud Run en PRO) — sí migra

| Componente                          | Destino PRO                        |
| ----------------------------------- | ---------------------------------- |
| `langfuse-web` (HTTP API + UI)      | Cloud Run service                  |
| `langfuse-worker` (event processor) | Cloud Run service                  |
| `postgres`                          | Cloud SQL (PITR enabled)           |
| `redis`                             | Memorystore Standard tier          |
| `clickhouse`                        | ClickHouse Cloud o GKE self-hosted |
| `minio` → S3                        | GCS bucket con HMAC keys           |
| `litellm-proxy` (opt-in)            | Cloud Run service (opt-in)         |

### Regla operativa

**Si una función toca cualquiera de:**

- `os.homedir()` (incluyendo `import.meta.dir` que resuelve al filesystem dev)
- `~/.atlax-ai` (config por-dev)
- `~/.claude/projects` (JSONLs locales)
- `~/.claude/.credentials.json` (existencia, nunca contenido)
- `execSync("git ...")` (ejecuta git CLI en CWD del dev)
- `systemctl --user` o `launchctl` (cron user-space del dev)

**...entonces es código edge y permanece local.**

### Validación automática

`tests/cloud-run-boundary.test.ts` (17 tests) verifica estructuralmente:

1. `langfuse-client.ts:isSafeHost()` rechaza `*.run.app` sin TLS
2. `CLAUDE.md` documenta I-13 con la lista de componentes edge
3. `infra/cloud-run.yaml` declara solo los componentes core (no hook ni reconciler)
4. El manifest usa Secret Manager refs para todas las credenciales

Los tests fallan en CI si alguien intenta migrar un componente edge sin actualizar
la documentación o el manifest.

## Consequences

### Lo que se gana

- **En PRO solo cambia `LANGFUSE_HOST`**: de `http://localhost:3000` a la URL
  de Cloud Run. El hook y el reconciler **no se modifican**. Esto reduce el
  riesgo de la migración: el código edge ya está probado en PoC con miles de
  sesiones reales.

- **Cero superficie de ataque**: ningún endpoint público lee el filesystem del
  dev. Si Cloud Run se compromete, los JSONLs del dev siguen privados.

- **Cobertura completa de modos de fallo**: el reconciler local detecta crashes
  del hook que un servicio remoto no podría ver (Claude Code crashed, máquina
  apagada, etc.).

- **Privacidad de tier**: `account` queda `null` cuando la fuente es
  `credentials-exists` (I-8) — Cloud Run nunca recibe el contenido de
  `.credentials.json`.

### Lo que se pierde / restricciones

- **Cada dev debe tener systemd timer/launchd configurado** para el reconciler.
  Mitigación: `setup/setup.sh` automatiza la instalación. `docs/systemd/README.md`
  documenta el proceso.

- **Onboarding de nuevos devs requiere setup local** (~5 minutos). No hay
  "self-service web sign-up" como un servicio centralizado tendría.

- **Updates del hook requieren `git pull` en cada máquina**: mitigado vía
  `bash setup/setup.sh` que es idempotente y sobreescribe la versión instalada.

- **Configuración por-dev no es centralizable**: `WINDOW_HOURS` específico,
  exclusiones, etc. viven en el dev. Si Atlax360 quisiera "política central
  de retención de datos", requeriría refactor (probablemente como subset
  controlado por Cloud Run que el edge respeta).

### Implementa I-13

I-13 es la formalización canónica de esta decisión. El test
`tests/cloud-run-boundary.test.ts` es el "ADR ejecutable" — verifica
estructuralmente que el split se mantiene en cada PR.

### Migration path (cuando llegue el momento)

1. Provisionar core en Cloud Run según `infra/cloud-run.yaml`
2. Setup secrets en Secret Manager según `infra/backup-story.md`
3. **Único cambio en el dev**: `export LANGFUSE_HOST="https://langfuse.atlax360.com"`
   en `~/.zshrc`
4. **No se reinstala nada** del hook ni del reconciler. Solo cambia el destino.

## References

- Plan PRO: `infra/cloud-run.yaml` (manifest referencia)
- Backup story: `infra/backup-story.md` (RPO ≤ 1 min)
- Test ADR ejecutable: `tests/cloud-run-boundary.test.ts`
- Sprint 15 PR: #27 (formalización de I-13)
- Documentación operativa: `docs/operations/runbook.md` (incluye rollback para PRO)
