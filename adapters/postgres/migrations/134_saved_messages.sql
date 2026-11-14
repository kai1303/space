CREATE INDEX hub_saved_owner_date ON hub_saved_messages(workspace_id,user_id,created_at DESC,message_id DESC);
DROP TRIGGER hub_saved_delivery ON hub_saved_messages;
-- Owner revisions use the same transition-table shape as personal sidebar changes.
CREATE TRIGGER saved_created AFTER INSERT ON hub_saved_messages
  REFERENCING NEW TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
CREATE TRIGGER saved_cleared AFTER DELETE ON hub_saved_messages
  REFERENCING OLD TABLE AS changed_rows FOR EACH STATEMENT EXECUTE FUNCTION deliver_sidebar_changes();
