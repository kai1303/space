"""Seed a dedicated demo DB. Standard PG* environment variables configure psql."""
import json
import subprocess
import urllib.request

samples = [
    ('pay', 'payments', 'Payments recovery', 'For a duplicate card capture after a retry, reconcile the processor transaction IDs before issuing a refund.', False),
    ('vpn', 'network', 'VPN access', 'Renew the VPN client certificate after the device enrollment expires.', False),
    ('pay-internal', 'payments', 'Internal escalation', 'Escalate duplicate card captures to the private payments incident room.', True),
]
sql = """
BEGIN;
INSERT INTO kb.entities VALUES ('payments','Payments'),('mina','Mina'),('network','Network') ON CONFLICT DO NOTHING;
INSERT INTO kb.ownership (id,service,person,url,private) VALUES ('payments-owner','payments','mina','https://catalog.example/services/payments/ownership',true) ON CONFLICT DO NOTHING;
INSERT INTO kb.access VALUES
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000003',true),
('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000004',false) ON CONFLICT DO NOTHING;
"""
def literal(value):
    return "'" + value.replace("'", "''") + "'"

for key, service, title, body, private in samples:
    payload = json.dumps({'model': 'all-minilm:22m', 'input': title + '\n' + body}).encode()
    req = urllib.request.Request('http://127.0.0.1:11434/api/embed', payload, {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=20) as response:
        vector, = json.load(response)['embeddings']
    assert len(vector) == 384
    values = [key, service, title, body, 'https://catalog.example/runbooks/' + key, json.dumps(vector)]
    sql += 'INSERT INTO kb.passages VALUES (' + ','.join(map(literal, values)) + ',' + str(private) + ') ON CONFLICT DO NOTHING;\n'
sql += """SELECT pgcontext.upsert_points('kb_passages',ARRAY['pay','vpn','pay-internal']);
COMMIT;
SELECT * FROM graph.build();
"""
subprocess.run(['psql','-X','-w','-v','ON_ERROR_STOP=1'],input=sql,text=True,check=True)
