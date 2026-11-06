ALTER TABLE outbox ADD COLUMN direct boolean NOT NULL DEFAULT false;
ALTER TABLE outbox ADD COLUMN direct_connection uuid;
CREATE INDEX outbox_direct_deadlines ON outbox(id,lease_until) WHERE direct AND state='delivering';
