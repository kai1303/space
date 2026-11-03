-- Preserve effective access before removing the parent organization requirement.
UPDATE workspace_members wm SET active = false
WHERE wm.active AND NOT EXISTS (
  SELECT 1 FROM organization_members om
  WHERE om.organization_id = wm.organization_id AND om.user_id = wm.user_id AND om.active
);
UPDATE agent_installations ai SET enabled = false
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_members wm
  WHERE wm.workspace_id = ai.workspace_id AND wm.user_id = ai.owner_id AND wm.active
);
DELETE FROM channel_members cm
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_members wm
  WHERE wm.workspace_id = cm.workspace_id AND wm.user_id = cm.user_id AND wm.active
);

-- Workspace identities, roles, content and workspace audit history remain intact.
ALTER TABLE workspace_members DROP COLUMN organization_id;
ALTER TABLE workspaces DROP COLUMN organization_id;
DROP TABLE organization_events;
DROP TABLE organization_members;
DROP TABLE organizations;
