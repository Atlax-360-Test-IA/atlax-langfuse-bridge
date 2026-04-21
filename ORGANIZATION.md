# ORGANIZATION

| Campo                | Valor                                                                       |
| -------------------- | --------------------------------------------------------------------------- |
| **Owner legal**      | Atlax 360 Ltd (Irlanda)                                                     |
| **Repo actual**      | `github.com/Atlax-360-Test-IA/atlax-langfuse-bridge` (org Atlax, privado)   |
| **Destino repo**     | Mismo — ya en destino final                                                 |
| **Licencia**         | Propietaria Atlax 360                                                       |
| **Author of record** | Joserra González                                                            |
| **Git identity**     | Atlax: `Joserra / jgcalvo@atlax360.com` (via `includeIf` en `~/.gitconfig`) |
| **Migración**        | No aplica — ya en repo Atlax                                                |

## Notas

- `includeIf "gitdir:~/work/atlax-langfuse-bridge/"` activo en `~/.gitconfig` → identidad Atlax automática.
- Historial reescrito el 2026-04-18: eliminada identidad `arakiss/petruarakiss@gmail.com`, todos los commits ahora bajo `Joserra/jgcalvo@atlax360.com`.
- Propósito: bridge de observabilidad Claude Code → Langfuse para trazabilidad de sesiones.
- Git flow: `feat/* → main` (una PR).
