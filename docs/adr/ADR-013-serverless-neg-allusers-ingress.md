# ADR-013 · Cloud Run tras Serverless NEG con `allUsers` invoker + ingress restringido

- **Status**: Accepted
- **Date**: 2026-05-10
- **Implements**: —
- **Scope**: applicable (proyectos con Cloud Run detrás de Cloud LB)

## Context

Durante F4 PRO Langfuse (cutover a `https://langfuse.atlax360.ai`) había que decidir cómo
proteger el backend Cloud Run (`langfuse-web`) frente a invocaciones directas a la URL
`*.run.app`, manteniendo al mismo tiempo un Cloud LB (HTTPS frontend + Cloud Armor + cert
managed) como única vía de entrada.

Tres alternativas evaluadas:

1. **IAM invoker restringido a la SA del LB**: parecía el patrón más seguro (no `allUsers`).
   Probado en F4: el LB recibió `403 Forbidden` del Cloud Run.

   Causa raíz: **Serverless NEG no adjunta tokens IAM** a las requests HTTP que reenvía al
   backend. No existe el concepto de "identidad del LB" en este path — el NEG actúa como un
   reverse proxy puro. Verificado contra la documentación oficial de Cloud Run + Serverless
   NEG.

2. **`allUsers` invoker + acceso público a `.run.app`**: trivial, pero deja la URL
   `langfuse-web-ihuioarrxq-ew.a.run.app` accesible para cualquiera, bypassing Cloud Armor y
   las reglas WAF. Inaceptable para una herramienta con datos de 38 devs.

3. **`allUsers` invoker + `ingress: internal-and-cloud-load-balancing`**: Cloud Run acepta
   invocaciones desde cualquier identidad pero **solo si vienen del LB o de la VPC interna**.
   La URL pública `.run.app` devuelve `403/404` cuando se accede desde fuera. La seguridad
   real la aporta el `ingress`, no el IAM check.

## Decision

Adoptamos el **patrón 3**: cualquier Cloud Run que se exponga a internet a través de un Cloud
LB con Serverless NEG debe configurarse con:

```yaml
metadata:
  annotations:
    run.googleapis.com/ingress: internal-and-cloud-load-balancing
spec:
  template:
    spec:
      # ... container spec ...
```

Y en IAM:

```bash
gcloud run services add-iam-policy-binding langfuse-web \
  --member=allUsers \
  --role=roles/run.invoker \
  --region=europe-west1
```

La autenticación de usuarios (cuando aplique) se delega al **nivel de aplicación** (NextAuth
en este caso), no al IAM check de Cloud Run. La protección perimetral se delega al \*\*Cloud LB

- Cloud Armor\*\*, no al IAM check.

## Consequences

**Lo que ganamos:**

- Patrón funciona out-of-the-box sin trabajos adicionales sobre tokens IAM o Workload Identity.
- La superficie pública queda restringida al hostname del LB (`langfuse.atlax360.ai`); la URL
  `.run.app` deja de ser un vector. Validado en F4: `curl https://langfuse-web-*.run.app`
  devuelve `403`.
- Cloud Armor (rate limiting, WAF rules, geo-blocks) queda en la única ruta posible — no hay
  bypass por la URL `.run.app`.

**Lo que perdemos:**

- `allUsers` en IAM en el listado de IAM bindings produce un warning visual en consola y en
  auditorías superficiales que solo miran IAM. Hay que documentar (este ADR) que es
  intencional y que la seguridad la aporta el ingress.
- Si en el futuro se requiere auth a nivel de Cloud Run (por ejemplo, IAP frente al LB para
  internal-only), hay que añadirlo explícitamente — el patrón actual no lo hace.

**Cómo aplicar a proyectos futuros:**

Cualquier servicio Cloud Run en Atlax que se exponga vía Cloud LB usa este par
(`allUsers` + `ingress: internal-and-cloud-load-balancing`). Si se requiere un servicio
interno-only sin LB, se usa el patrón opuesto: IAM invoker específico + `ingress: internal`.

**Anti-pattern explícitamente rechazado:**

> "Voy a quitar `allUsers` y poner el SA del LB como invoker para mejorar seguridad."

NO funciona. Serverless NEG no pasa identidad. El intento devolverá `403` en producción y
forzará un rollback. La seguridad de este path no se mide por la presencia de `allUsers`.

## References

- F4 PRO Langfuse cutover (2026-05-10) — descubrimiento del 403 Forbidden
- [Cloud Run Serverless NEG docs](https://cloud.google.com/load-balancing/docs/negs/serverless-neg-concepts)
- [Cloud Run ingress settings](https://cloud.google.com/run/docs/securing/ingress)
- [ADR-012](./ADR-012-clickhouse-gce-self-hosted.md) — decisión hermana de arquitectura PRO
