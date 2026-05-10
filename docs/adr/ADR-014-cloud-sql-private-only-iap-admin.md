# ADR-014 · Cloud SQL private-only con acceso admin vía IAP tunnel

- **Status**: Accepted
- **Date**: 2026-05-10
- **Implements**: —
- **Scope**: applicable (proyectos con Cloud SQL en GCP)

## Context

Durante F1 PRO Langfuse había que decidir si la instancia Cloud SQL Postgres
(`langfuse-pg`, n1-standard-1, db `langfuse`) llevaría IP pública además de IP privada en la
VPC interna.

Tres alternativas:

1. **IP pública + Authorized Networks**: la opción "fácil". `gcloud sql connect` o `psql` desde
   la laptop del admin. Authorized Networks restringe a IPs concretas. Problema: la lista de
   IPs autorizadas se cae con cada cambio de ISP del admin, y la IP pública sigue siendo un
   vector accesible al planeta — incluso restringida por whitelist, expone el banner Postgres
   y queda en escaneos masivos.

2. **IP pública + Cloud SQL Auth Proxy**: el patrón "moderno" de Google. Auth Proxy v2 abre un
   socket local autenticado por IAM. Problema: aún requiere IP pública en la instancia y
   añade un binario más en el path crítico de admin.

3. **IP privada únicamente + IAP tunnel**: la instancia solo tiene IP en la VPC
   (`10.20.96.3` en este caso). Para acceso admin: SSH vía IAP a una VM del mismo VPC, y
   desde la VM se accede a Postgres con `psql` o un contenedor cliente.

## Decision

Adoptamos **IP privada únicamente** para Cloud SQL en PRO. El acceso administrativo se hace
vía IAP tunnel a una VM ya existente del VPC (en este caso `clickhouse-vm`, que tenemos por
otras razones — ver [ADR-012](./ADR-012-clickhouse-gce-self-hosted.md)).

Patrón canónico documentado:

```bash
# 1. SSH vía IAP a una VM del VPC (no requiere IP pública en la VM)
gcloud compute ssh clickhouse-vm --zone=europe-west1-b --tunnel-through-iap

# 2. Desde la VM, contenedor cliente psql contra IP privada de Cloud SQL
docker run --rm -it postgres:16 psql \
  "postgresql://langfuse:<pwd>@10.20.96.3/langfuse"

# 3. Para SQL con caracteres especiales ($, \, comillas):
#    SCP el archivo SQL primero, luego psql -f
gcloud compute scp /tmp/update.sql clickhouse-vm:/tmp/ --tunnel-through-iap
# en la VM: docker run ... psql ... -f /tmp/update.sql
```

Cloud SQL Auth Proxy v2 está **explícitamente descartado** porque falla con el error
`instance does not have IP of type PUBLIC` cuando se ejecuta desde fuera del VPC contra una
instancia private-only — incluso pasando `--private-ip`. La máquina local no es parte del VPC,
así que el flag no arregla el problema fundamental.

## Consequences

**Lo que ganamos:**

- Superficie de ataque a Postgres = 0 desde internet. La instancia no aparece en
  `shodan.io` ni en escaneos masivos. El único path de admin requiere identidad IAM válida +
  IAP grant.
- Cumplimiento del principio de mínima exposición sin bibliotecas adicionales (no Auth Proxy,
  no túneles SSH manuales, no VPN).
- Compatible con el patrón ya establecido para acceso admin a la VM ClickHouse (mismo IAP
  tunnel, misma VM gateway). Un solo path de admin para toda la VPC PRO.

**Lo que perdemos:**

- `gcloud sql connect` no funciona directamente desde la laptop. Hay que añadir un paso
  (SSH a VM intermedia) que en algunos workflows duplica la fricción.
- Pasar SQL con caracteres especiales requiere SCP + `psql -f` en vez de heredoc en la
  shell local. Documentado: el `$` se corrompe en interpolación shell anidada (descubierto en
  F3 al actualizar el hash bcrypt del admin Langfuse, que contenía `$2b$12$...`).
- Si la VM gateway (`clickhouse-vm`) cae, perdemos el path de admin de Postgres también — son
  destinos distintos pero el path es compartido. Mitigación: el VPC tiene varias VMs
  candidatas (Cloud Run worker en momentos puntuales, VMs de Memorystore, etc.); en
  emergencia se puede aprovisionar una VM efímera con `gcloud compute instances create
--no-address` y descartarla al terminar.

**Cómo aplicar a proyectos futuros:**

Cualquier proyecto Atlax con Cloud SQL en PRO usa **IP privada únicamente desde el primer
día**. No provisionar IP pública "solo para acceso ocasional" — la presión de mantener
Authorized Networks acaba en lista permisiva que se documenta en commits sucesivos (anti-pattern
observable en proyectos legacy).

Si el proyecto no tiene una VM persistente en el VPC para servir de gateway IAP, considerar
si Cloud SQL es realmente la opción correcta — frecuentemente el coste de mantener una VM
mínima para admin no compensa frente a alternativas managed sin IP pública (ej. Cloud SQL
Studio en consola, que sí funciona contra private-only sin gateway propia).

## Anti-patterns explícitamente rechazados

> "Voy a poner IP pública con Authorized Networks restringidas — es lo más fácil para el equipo."

La lista de Authorized Networks decae. Devs cambian de ISP, viajan, trabajan desde casa con
IP dinámica. La presión operativa empuja a abrir el rango. Mejor empezar con private-only y
no tener que cerrar nada.

> "Voy a usar Cloud SQL Auth Proxy v2 con `--private-ip` desde mi laptop."

Falla con `instance does not have IP of type PUBLIC` aunque la docs sugiera lo contrario. El
Auth Proxy v2 no atraviesa la frontera del VPC desde la laptop. Verificado en F3 PRO Langfuse
(2026-05-10).

## References

- F3 PRO Langfuse cutover (2026-05-10) — descubrimiento del fallo Cloud SQL Auth Proxy v2
- [Cloud SQL private IP docs](https://cloud.google.com/sql/docs/postgres/configure-private-ip)
- [IAP TCP forwarding for SSH](https://cloud.google.com/iap/docs/using-tcp-forwarding)
- [ADR-012](./ADR-012-clickhouse-gce-self-hosted.md) — la VM `clickhouse-vm` que sirve como
  gateway IAP para este patrón
