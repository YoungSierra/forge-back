-- ============================================================
-- Migration 048 — RLS: catálogo global forge_nodes legible por usuarios logueados
--
-- Contexto: al enrutar las lecturas del canvas por el JWT del usuario (dbAsUser, Frente 3 etapa 2),
-- las queries se unen a forge_nodes (la DNA de cada nodo). forge_nodes tiene RLS activa pero SIN
-- política -> el rol authenticated ve 0 filas -> el `forge_nodes(...)` anidado vendría NULL y los
-- nodos perderían su definición. forge_nodes es un CATÁLOGO GLOBAL read-only (no tiene datos por org),
-- así que debe ser legible por cualquier usuario logueado.
--
-- Segura: service-role (backend) ya lo ignora por BYPASSRLS; esto solo habilita la lectura por JWT.
-- Idempotente.
-- ============================================================

alter table v57.forge_nodes enable row level security;
drop policy if exists fnodes_read on v57.forge_nodes;
create policy fnodes_read on v57.forge_nodes
  for select
  using ( auth.uid() is not null );  -- cualquier usuario autenticado ve el catálogo (no hay datos por org)
