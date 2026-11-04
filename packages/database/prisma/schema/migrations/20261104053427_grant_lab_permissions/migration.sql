

-- ===== Hand-written invariants =====
-- Hospitals that already exist: their system roles gain the lab and assistant permissions added in this release
-- (new hospitals get them from the role template in packages/shared/src/permissions.ts).
INSERT INTO "RolePermission" ("tenantId", "roleId", permission)
SELECT r."tenantId", r.id, v.permission
FROM "Role" r
JOIN (VALUES
  ('RECEPTIONIST', 'LAB_READ'), ('RECEPTIONIST', 'LAB_BOOK'), ('RECEPTIONIST', 'ASSISTANT_USE'),
  ('DOCTOR', 'LAB_READ'), ('DOCTOR', 'LAB_BOOK')
) AS v(role_name, permission) ON v.role_name = r.name
WHERE r."isSystem" = true
ON CONFLICT DO NOTHING;

