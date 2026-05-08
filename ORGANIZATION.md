# Organización

Este repositorio sigue las convenciones canónicas del ecosistema Atlax360.

## Documentos clave

| Documento                                                    | Descripción                                                               |
| ------------------------------------------------------------ | ------------------------------------------------------------------------- |
| [`README.md`](./README.md)                                   | Quick start, setup, comandos operativos                                   |
| [`ARCHITECTURE.md`](./ARCHITECTURE.md)                       | SDD canónico §1–§14: identidad, stack, dominio, contratos, observabilidad |
| [`CHANGELOG.md`](./CHANGELOG.md)                             | Historial semver retroactivo desde v0.1.0                                 |
| [`CLAUDE.md`](./CLAUDE.md)                                   | Instrucciones operativas para Claude Code (invariantes I-1..I-14)         |
| [`docs/adr/`](./docs/adr/)                                   | Architectural Decision Records (Michael Nygard)                           |
| [`docs/operations/runbook.md`](./docs/operations/runbook.md) | Runbook operativo (validar, drift, rollback, cron health)                 |
| [`docs/systemd/README.md`](./docs/systemd/README.md)         | Instalación cron reconciler (systemd user units)                          |

## Notas

- **Idioma**: castellano para narrativa, inglés para código y términos técnicos
- **Versionado**: semver retroactivo (MAJOR breaking, MINOR feature, PATCH fix/refactor/docs)
- **ADRs**: inmutables una vez `Accepted` — un cambio de decisión = nuevo ADR con `Supersedes: ADR-NNN`
