CREATE TABLE workspace_invitations (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
 request_id uuid NOT NULL, request_hash text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('email','link')), email text,
 role text NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member')),
 guest_type text NOT NULL DEFAULT 'none' CHECK(guest_type IN ('none','single','multi')),
 channel_ids uuid[] NOT NULL DEFAULT '{}', created_by uuid NOT NULL REFERENCES users(id),
 token_hash text NOT NULL UNIQUE, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 expires_at timestamptz NOT NULL CHECK(isfinite(expires_at)),
 expires_in_days integer NOT NULL CHECK(expires_in_days BETWEEN 1 AND 30),
 use_limit integer NOT NULL CHECK(use_limit BETWEEN 1 AND 1000), use_count integer NOT NULL DEFAULT 0,
 revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
 delivery_status text NOT NULL CHECK(delivery_status IN ('unavailable','queued','sent','failed','not_applicable')),
 UNIQUE(workspace_id,request_id), UNIQUE(workspace_id,id),
 CHECK(use_count BETWEEN 0 AND use_limit), CHECK(cardinality(channel_ids)<=100),
 CHECK((kind='email' AND email IS NOT NULL AND use_limit=1) OR (kind='link' AND email IS NULL)),
 CHECK((guest_type='none') OR (role='member' AND ((guest_type='single' AND cardinality(channel_ids)=1) OR (guest_type='multi' AND cardinality(channel_ids)>0))))
);
CREATE INDEX workspace_invitations_page ON workspace_invitations(workspace_id,kind,id);
CREATE UNIQUE INDEX workspace_invitations_pending_email ON workspace_invitations(workspace_id,email) WHERE kind='email' AND revoked_at IS NULL AND use_count=0;
CREATE TABLE workspace_invitation_resends (
 invitation_id uuid NOT NULL REFERENCES workspace_invitations(id), request_id uuid NOT NULL,
 version integer NOT NULL, PRIMARY KEY(invitation_id,request_id)
);
CREATE TABLE workspace_invitation_acceptances (
 invitation_id uuid NOT NULL REFERENCES workspace_invitations(id), user_id uuid NOT NULL REFERENCES users(id),
 accepted_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(invitation_id,user_id)
);
CREATE TABLE workspace_invitation_emails (
 id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
 invitation_id uuid NOT NULL REFERENCES workspace_invitations(id), version integer NOT NULL,
 token_ciphertext text, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sent','failed','cancelled')),
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
 created_at timestamptz NOT NULL DEFAULT now(), sent_at timestamptz,
 UNIQUE(invitation_id,version)
);
CREATE FUNCTION enqueue_invitation_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('invitation.email_requested',NEW.id::text,jsonb_build_object('email_id',NEW.id));
 RETURN NEW;
END; $$;
CREATE TRIGGER invitation_email_event AFTER INSERT ON workspace_invitation_emails FOR EACH ROW EXECUTE FUNCTION enqueue_invitation_email();
CREATE TRIGGER invitations_resource_delivery AFTER INSERT OR UPDATE ON workspace_invitations FOR EACH ROW EXECUTE FUNCTION enqueue_resource_delivery();
