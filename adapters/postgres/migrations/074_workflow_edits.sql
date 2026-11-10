ALTER TABLE published_help_workflows ADD COLUMN revision integer NOT NULL DEFAULT 1;
CREATE TRIGGER published_help_workflow_edit_delivery AFTER UPDATE ON published_help_workflows
  FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();

-- Bind retries to the same publication settings, including requests admitted by the previous API.
ALTER TABLE help_workflow_requests ADD COLUMN routing jsonb;
CREATE FUNCTION snapshot_help_request_routing() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT jsonb_build_object('name',name,'normal',normal_channel,'urgent',urgent_channel)
    INTO NEW.routing FROM published_help_workflows WHERE id=NEW.workflow_id;
  RETURN NEW;
END; $$;
CREATE TRIGGER help_request_routing BEFORE INSERT ON help_workflow_requests
  FOR EACH ROW EXECUTE FUNCTION snapshot_help_request_routing();
UPDATE help_workflow_requests r SET routing=jsonb_build_object('name',w.name,'normal',w.normal_channel,'urgent',w.urgent_channel)
  FROM published_help_workflows w WHERE w.id=r.workflow_id;
ALTER TABLE help_workflow_requests ALTER COLUMN routing SET NOT NULL;
