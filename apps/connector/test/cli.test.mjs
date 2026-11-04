import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions } from '../dist/main.js';

test('CLI accepts onboarding arguments, requires no repository/channel, and rejects unknown flags', () => {
  assert.deepEqual(parseOptions(['--url', 'http://localhost:3000', '--pair', 'a'.repeat(32)]), { url: 'http://localhost:3000', pair: 'a'.repeat(32), login: false, logout: false, help: false, connect: false });
  assert.equal(parseOptions(['--login']).login, true);
  assert.equal(parseOptions(['--connect']).connect, true);
  assert.throws(() => parseOptions(['--logout', '--connect']));
  assert.equal(parseOptions(['--logout']).logout, true);
  assert.throws(() => parseOptions(['--repo', '/tmp/project']));
  assert.throws(() => parseOptions(['--url', 'https://example.com?token=secret']));
  assert.throws(() => parseOptions(['--login', '--logout']));
  assert.throws(() => parseOptions(['--pair', 'bad']));
});


test('--connect prompts for a new code even with a saved platform connection', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const { ConnectorStore } = await import('../dist/storage.js');
  const home = await mkdtemp(join(tmpdir(), 'space-cli-'));
  try {
    const store = new ConnectorStore(join(home, '.config', 'space-connector'));
    const state = await store.load();
    state.connection = { origin: 'http://127.0.0.1:9', credential: 'credential', installation_id: 'i', workspace_id: 'w' };
    await store.save(state);
    await assert.rejects(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../dist/main.js', import.meta.url)), '--url', 'http://127.0.0.1:9', '--connect'], { env: { ...process.env, HOME: home }, timeout: 3000 }), error => {
      assert.match(error.stderr, /Provide --pair/);
      return true;
    });
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('CLI selects Kiro explicitly and rejects unknown providers', () => {
  assert.equal(parseOptions(['--provider', 'kiro']).provider, 'kiro');
  assert.equal(parseOptions(['--provider', 'codex']).provider, 'codex');
  assert.throws(() => parseOptions(['--provider', 'shell']));
});

test('Kiro CLI pairing signs in locally and reaches readiness without invoking ChatGPT', { timeout: 8000 }, async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { spawn } = await import('node:child_process'); const { fileURLToPath } = await import('node:url');
  const { createServer } = await import('node:http'); const { Server } = await import('socket.io');
  const home = await mkdtemp(join(tmpdir(), 'space-kiro-cli-')), bin=join(home,'bin');await mkdir(bin);
  await writeFile(join(bin,'kiro-cli'),`#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');const action=process.argv[2];
const auth=path.join(process.env.HOME,'signed-in');
if(action==='login'){fs.writeFileSync(auth,'local');process.exit(0);}
if(action==='whoami'){if(!fs.existsSync(auth))process.exit(1);console.log(JSON.stringify({accountType:'BuilderId',email:'test@example.test'}));process.exit(0);}
if(action!=='acp')process.exit(4);
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);const result=m.method==='initialize'?{protocolVersion:1,agentCapabilities:{loadSession:true}}:m.method==='session/new'?{sessionId:'probe',modes:{currentModeId:'space-chat'}}:null;
if(!result)process.exit(5);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
});
`,{mode:0o700});
  let resolveReady;const ready=new Promise(resolve=>{resolveReady=resolve;});
  const http=createServer((req,res)=>{let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{assert.equal(JSON.parse(body).provider,'kiro');res.setHeader('content-type','application/json');res.end(JSON.stringify({installation_id:'i',workspace_id:'w',provider:'kiro'}));});});
  const io=new Server(http);io.of('/agents').on('connection',socket=>socket.on('agent.heartbeat',(payload,ack)=>{ack({data:{installation_id:'i'}});if(payload.auth_status==='ready')resolveReady();}));
  await new Promise(resolve=>http.listen(0,'127.0.0.1',resolve));
  const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/main.js',import.meta.url)),'--provider','kiro','--url',`http://127.0.0.1:${http.address().port}`,'--pair','k'.repeat(32)],{env:{...process.env,HOME:home,PATH:bin+':'+process.env.PATH},stdio:'pipe'});
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk);
  const exited=new Promise(resolve=>child.once('exit',resolve));let timeout;
  try{
    await Promise.race([ready,exited.then(()=>{throw Error(output);}),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error(output||'Kiro readiness timed out')),6000);})]);
    const state=JSON.parse(await readFile(join(home,'.config','space-connector-kiro','state.json'),'utf8'));
    assert.equal(state.connection.provider,'kiro');assert.equal(state.credentials,undefined);
    assert.ok(output.includes('Kiro authorization and chat mode are ready'));assert.ok(!output.includes('Continue with ChatGPT'));
  }finally{clearTimeout(timeout);child.kill('SIGTERM');await exited;await new Promise(resolve=>io.close(resolve));await rm(home,{recursive:true,force:true});}
});

test('credential renewal uses an expiry deadline without spinning on short-lived tokens', async () => {
  const { credentialRenewalDelay } = await import('../dist/main.js');
  assert.equal(typeof credentialRenewalDelay, 'function');
  assert.equal(credentialRenewalDelay(3600000, 0), 3540000);
  assert.equal(credentialRenewalDelay(30000, 0), 24000);
  assert.equal(credentialRenewalDelay(0, 0), 1000);
});
