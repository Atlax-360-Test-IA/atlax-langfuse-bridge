# ADR-017 · `NODE_TLS_REJECT_UNAUTHORIZED=0` para Memorystore Redis en VPC privada

- **Status**: Accepted
- **Date**: 2026-05-11
- **Implements**: —
- **Scope**: applicable (proyectos Atlax que conectan Cloud Run a Memorystore Redis)

## Context

Cloud Run `langfuse-web` y `langfuse-worker` se conectan a Memorystore Redis vía
Direct VPC egress. La conexión es TLS-encrypted (`REDIS_TLS_ENABLED=true`,
`REDIS_PORT=6378`), pero al pasar el código de producción a Cloud Run con el SDK
de Redis incluido en Langfuse (ioredis/BullMQ) el servicio fallaba al verificar
el certificado del peer con:

```
Error: unable to verify the first certificate
code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'
```

Causa raíz: Memorystore usa una CA propia de Google (no AWS-style Let's Encrypt)
que **no está incluida en el bundle CA estándar de Node.js**. El `tls` module
de Node no la encuentra y rechaza la conexión, aunque la red sea privada y el
cifrado esté activo.

Soluciones evaluadas:

1. **Inyectar la CA de Google manualmente** vía `NODE_EXTRA_CA_CERTS`. Requiere:
   (a) descargar el bundle de `pki.goog`, (b) mantenerlo en un secret, (c)
   rotarlo cuando Google lo actualice. **Operacionalmente caro** y crea un
   vector de fallo silencioso si el bundle expira.
2. **Usar `rejectUnauthorized: false` en config del cliente ioredis**. No es
   expuesto fácilmente por Langfuse — habría que parchear el código upstream
   o forkear el contenedor.
3. **`NODE_TLS_REJECT_UNAUTHORIZED=0`**. Variable estándar Node; desactiva
   verificación de cert para TODO el proceso. Aplicable sin parche de código.

## Decision

Aceptar la opción 3: `NODE_TLS_REJECT_UNAUTHORIZED=0` en las dos revisiones
de Cloud Run (`langfuse-web`, `langfuse-worker`) que se conectan a Memorystore
Redis. El cifrado TLS sigue activo end-to-end; solo se omite la verificación
del peer certificate.

Aplicado en `infra/cloud-run.yaml` líneas 124 (web) y 291 (worker).

## Rationale — por qué es aceptable en este caso

El anti-pattern `NODE_TLS_REJECT_UNAUTHORIZED=0` es CRITICAL en el caso general
porque permite MITM por cualquier red intermedia. Aquí el riesgo está acotado
por tres controles defensivos:

1. **Red privada VPC**: el tráfico va por la VPC interna de GCP, no por internet.
   La superficie de ataque MITM se reduce a "compromiso de red interna de GCP"
   o "compromiso de un nodo del VPC peering", ambos escenarios fuera del modelo
   de amenazas de un FinOps observability stack.
2. **Direct VPC egress en Cloud Run**: las revisiones tienen
   `run.googleapis.com/vpc-access-egress: private-ranges-only`. El tráfico no
   sale al internet público; solo a CIDRs RFC-1918 expuestos por el VPC connector.
3. **Memorystore Auth password**: además del TLS hay autenticación a nivel
   aplicación (`REDIS_AUTH` desde Secret Manager). Un atacante MITM necesitaría
   también capturar la password Redis, que sí va por la conexión cifrada.

Riesgo residual aceptado: si Google compromise se materializa al nivel del VPC
interno (escenario que comprometería también el resto de servicios GCP), la
falta de pin del cert añade un vector menor adicional. Aceptado.

## Consequences

### Positivas

- Cero parche de imagen Langfuse — usamos el contenedor oficial sin modificar.
- Sin operación de rotación de bundle CA (que cambia silenciosamente cuando
  Google actualiza su PKI).
- Aplicable a cualquier servicio Cloud Run que use Memorystore — patrón reusable
  en proyectos hermanos (atlax-claude-dashboard si en algún momento migra a
  Cloud Run con Redis).

### Negativas / Riesgos

- **Cualquier otra llamada TLS del proceso pierde verificación**. Mitigación:
  Langfuse web/worker solo hacen llamadas TLS a Memorystore + Postgres (esta vía
  Cloud SQL Auth Proxy, sin verificación de cert peer) + ClickHouse (intra-VPC
  HTTP, sin TLS) + GCS (signed URLs, los firma el SDK con HMAC, no depende del
  cert del peer). El alcance del downgrade es contenido pero el patrón "todo el
  proceso pierde verificación" es genuinamente más amplio que el problema que
  resuelve.
- **Auditores externos lo flagging como CRITICAL al primer pase**. Mitigación:
  este ADR. Cualquier review externo encuentra el flag y este documento explica
  por qué se acepta.

### Trade-off explícito vs Opción 1 (NODE_EXTRA_CA_CERTS)

Si en un futuro el modelo de amenazas cambia (ej. exposición a co-tenants en
proyecto multi-tenant, requisito de compliance que exija full chain validation,
o se añade exposición pública del worker), **revisar este ADR y migrar a
Opción 1**. El coste operacional de la opción 1 era el blocker en F1 PRO con
ventana de despliegue ajustada; deja de serlo cuando el equipo tiene rutinas
de rotación de secrets establecidas.

## Alternatives Considered

### `NODE_EXTRA_CA_CERTS` con bundle de Google PKI

Descartada por coste operacional + riesgo de fallo silencioso por bundle
expirado. Documentada como path de upgrade si el modelo de amenazas cambia.

### Patchear imagen Langfuse para usar `rejectUnauthorized: false` en config ioredis

Descartada. Requiere fork del contenedor y rebases periódicos. Coste de
mantenimiento desproporcionado para evitar un flag de proceso.

### Sin TLS (REDIS_TLS_ENABLED=false)

Inaceptable. Aunque la red es privada, dejar tráfico sin cifrar viola defense
in depth. TLS sin verificación de cert sigue cifrando el contenido.

## References

- `infra/cloud-run.yaml:124,291` — flag aplicado
- Google Cloud Memorystore Redis Auth: https://cloud.google.com/memorystore/docs/redis/auth-overview
- Node.js `NODE_TLS_REJECT_UNAUTHORIZED`: https://nodejs.org/api/cli.html#node_tls_reject_unauthorizedvalue
- Issue Langfuse self-hosting + Memorystore: documentado internamente en runbook
