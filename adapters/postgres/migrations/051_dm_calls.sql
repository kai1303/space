CREATE TABLE dm_calls (
 id uuid PRIMARY KEY, channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 caller_id uuid NOT NULL REFERENCES users(id), callee_id uuid NOT NULL REFERENCES users(id),
 caller_device uuid NOT NULL, callee_device uuid,
 mode text NOT NULL CHECK(mode IN ('audio','video')),
 state text NOT NULL DEFAULT 'ringing' CHECK(state IN ('ringing','accepted','ended')),
 reason text CHECK(reason IN ('completed','cancelled','declined','missed','failed','access_revoked')),
 revision integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz, ended_at timestamptz,
 CHECK(caller_id<>callee_id), CHECK((state='ended')=(reason IS NOT NULL)), CHECK((state='ended')=(ended_at IS NOT NULL))
);
CREATE INDEX dm_calls_caller_recent ON dm_calls(caller_id,created_at DESC);
CREATE INDEX dm_calls_history ON dm_calls(channel_id,created_at DESC,id);
-- An active call occupies each participant once; expiry ends it, never transfers ownership.
CREATE TABLE dm_call_participants (
 user_id uuid PRIMARY KEY REFERENCES users(id), call_id uuid NOT NULL REFERENCES dm_calls(id) ON DELETE CASCADE,
 device_id uuid, expires_at timestamptz NOT NULL
);
CREATE INDEX dm_call_participants_call ON dm_call_participants(call_id);
CREATE FUNCTION dm_call_changed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('chat.changed',NEW.id::text,
  jsonb_build_object('keys',ARRAY['call-user:'||NEW.caller_id,'call-user:'||NEW.callee_id,'channel:'||NEW.channel_id,'workspace:'||NEW.workspace_id]));
 IF TG_OP='INSERT' THEN
  INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('call.deadline',NEW.id::text,'{}',NEW.created_at+interval '30 seconds');
  UPDATE direct_message_views SET hidden=false,last_activity_at=now() WHERE channel_id=NEW.channel_id;
 ELSIF NEW.state='ended' AND OLD.state<>'ended' THEN
  DELETE FROM dm_call_participants WHERE call_id=NEW.id;
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER dm_call_changed AFTER INSERT OR UPDATE ON dm_calls FOR EACH ROW EXECUTE FUNCTION dm_call_changed();
CREATE FUNCTION dm_call_presence_deadline() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO event_outbox(kind,aggregate_id,payload,available_at) VALUES('call.deadline',NEW.call_id::text,'{}',NEW.expires_at);
 RETURN NULL;
END; $$;
CREATE TRIGGER dm_call_presence_deadline AFTER INSERT OR UPDATE ON dm_call_participants FOR EACH ROW EXECUTE FUNCTION dm_call_presence_deadline();
CREATE FUNCTION dm_call_membership_revoked() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' OR NOT NEW.active THEN
  UPDATE dm_calls SET state='ended',reason='access_revoked',ended_at=now(),revision=revision+1
   WHERE id IN (SELECT call_id FROM dm_call_participants WHERE user_id=OLD.user_id)
    AND workspace_id=OLD.workspace_id AND state<>'ended';
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER dm_call_membership_revoked AFTER UPDATE OF active OR DELETE ON workspace_members FOR EACH ROW EXECUTE FUNCTION dm_call_membership_revoked();
