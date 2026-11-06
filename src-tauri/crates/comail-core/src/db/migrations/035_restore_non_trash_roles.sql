-- Migration 033 cleared heuristic roles used by non-destructive mail views.
-- Restore recorded roles without overwriting roles changed since that upgrade.
UPDATE folders
SET role = (SELECT repair.role FROM folder_role_repairs repair WHERE repair.folder_id = folders.id)
WHERE role IS NULL
  AND EXISTS (SELECT 1 FROM folder_role_repairs repair
              WHERE repair.folder_id = folders.id AND repair.role <> 'trash');
