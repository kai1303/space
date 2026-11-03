CREATE TABLE navigator_settings (
 channel_id uuid PRIMARY KEY REFERENCES channels(id),
 mode text NOT NULL DEFAULT 'rules' CHECK(mode IN ('off','rules','semantic')),
 rules jsonb NOT NULL DEFAULT '[]',
 daily_token_limit integer NOT NULL DEFAULT 10000 CHECK(daily_token_limit BETWEEN 0 AND 1000000),
 cooldown_seconds integer NOT NULL DEFAULT 300 CHECK(cooldown_seconds BETWEEN 0 AND 86400)
);
CREATE TABLE navigator_threads (
 thread_id uuid PRIMARY KEY REFERENCES threads(id),
 last_sequence bigint NOT NULL DEFAULT 0,
 available_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token uuid
);
CREATE INDEX navigator_threads_pending ON navigator_threads(available_at);
CREATE FUNCTION enqueue_navigation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.author_type='human' THEN
  INSERT INTO navigator_threads(thread_id,last_sequence,available_at) VALUES(NEW.thread_id,NEW.sequence-1,now()+interval '1 second')
   ON CONFLICT(thread_id) DO UPDATE SET available_at=LEAST(navigator_threads.available_at,excluded.available_at);
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER messages_navigation AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION enqueue_navigation();
CREATE TABLE agent_thread_subscriptions (
 thread_id uuid PRIMARY KEY REFERENCES threads(id),
 installation_id uuid NOT NULL REFERENCES agent_installations(id),
 skill text NOT NULL, task_id uuid NOT NULL REFERENCES tasks(id),
 session_id uuid REFERENCES agent_sessions(id), approved_by uuid REFERENCES users(id),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed'))
);
CREATE TABLE navigator_decisions (
 id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id), thread_id uuid NOT NULL REFERENCES threads(id),
 through_sequence bigint NOT NULL, route text NOT NULL, decision jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(thread_id,through_sequence)
);
CREATE TABLE navigator_suggestions (
 id uuid PRIMARY KEY REFERENCES navigator_decisions(id), channel_id uuid NOT NULL REFERENCES channels(id),
 thread_id uuid NOT NULL REFERENCES threads(id), actor_id uuid NOT NULL REFERENCES users(id),
 goal text NOT NULL, candidates jsonb NOT NULL, decision jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','dismissed')),
 task_id uuid REFERENCES tasks(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX navigator_suggestions_thread ON navigator_suggestions(channel_id,thread_id,created_at DESC);
CREATE TABLE navigator_inferences (
 thread_id uuid NOT NULL REFERENCES threads(id), through_sequence bigint NOT NULL, level integer NOT NULL CHECK(level IN (1,2)),
 channel_id uuid NOT NULL REFERENCES channels(id), day date NOT NULL DEFAULT CURRENT_DATE,
 provider text NOT NULL, model text NOT NULL, reserved_tokens integer NOT NULL,
 input_tokens integer, output_tokens integer, latency_ms integer, result jsonb, error text,
 PRIMARY KEY(thread_id,through_sequence,level)
);
CREATE INDEX navigator_inference_budget ON navigator_inferences(channel_id,day);
-- Keep the global final-result key while allowing separately identified progress replies.
ALTER TABLE messages ADD COLUMN agent_milestone boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD CONSTRAINT messages_agent_milestone CHECK(NOT agent_milestone OR author_type='agent');
DROP INDEX messages_channel_task;
CREATE UNIQUE INDEX messages_channel_task ON messages(channel_id,task_id) WHERE NOT agent_milestone;
CREATE OR REPLACE FUNCTION maintain_message_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='INSERT' THEN
  INSERT INTO message_identities(id,workspace_id,channel_id,task_id,user_id,client_message_id,request_hash)
   VALUES(NEW.id,NEW.workspace_id,NEW.channel_id,CASE WHEN NEW.agent_milestone THEN NULL ELSE NEW.task_id END,NEW.user_id,NEW.client_message_id,NEW.request_hash);
  RETURN NEW;
 END IF;
 DELETE FROM message_identities WHERE id=OLD.id;
 RETURN OLD;
END; $$;
CREATE FUNCTION immutable_agent_milestone() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NEW.agent_milestone IS DISTINCT FROM OLD.agent_milestone THEN
  RAISE EXCEPTION 'message identity is immutable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER messages_immutable_milestone BEFORE UPDATE OF agent_milestone ON messages FOR EACH ROW EXECUTE FUNCTION immutable_agent_milestone();
