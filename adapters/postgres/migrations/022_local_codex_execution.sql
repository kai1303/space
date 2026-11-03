-- Upgrade paired installations without implicitly granting access to a channel.
UPDATE agent_definitions SET capabilities='{"skills":["codex.run"],"controls":{"progress_stream":true}}'::jsonb
WHERE id='41a5de8a-63df-4c25-8666-1d0290bc921f' AND name='Local Codex';
