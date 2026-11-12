import type { Pool } from 'pg';

// Record what the transaction enqueued even if the CDC bridge publishes and deletes
// the live row before the test's next query. Both tables belong to the test schema.
export async function observeOutbox(pool: Pool) {
  await pool.query(`
    CREATE TABLE observed_outbox AS
      SELECT id, created_at, kind, aggregate_id, payload, available_at FROM event_outbox WITH NO DATA;
    CREATE FUNCTION observe_outbox_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      INSERT INTO observed_outbox (id, created_at, kind, aggregate_id, payload, available_at)
        VALUES (NEW.id, NEW.created_at, NEW.kind, NEW.aggregate_id, NEW.payload, NEW.available_at);
      RETURN NULL;
    END $$;
    CREATE TRIGGER observe_outbox_insert AFTER INSERT ON event_outbox
      FOR EACH ROW EXECUTE FUNCTION observe_outbox_insert();
  `);
}
