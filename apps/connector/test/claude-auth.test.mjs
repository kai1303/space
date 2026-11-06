import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('Claude native auth identity is account-bound and contains no credentials',async()=>{
 const {parseClaudeIdentity}=await import('../dist/claude-auth.js');
 const raw={loggedIn:true,authMethod:'claude.ai',email:'one@example.test',orgId:'organization',accessToken:'secret'};
 const identity=parseClaudeIdentity(JSON.stringify(raw));
 assert.ok(!JSON.stringify(identity).includes('secret'));
 assert.notEqual(identity.subject,parseClaudeIdentity(JSON.stringify({...raw,email:'two@example.test'})).subject);
 assert.throws(()=>parseClaudeIdentity(JSON.stringify({...raw,loggedIn:false})));
});
test('Claude local auth uses a private home and leaves authentication to the native CLI',async()=>{
 const {claudeEnvironment}=await import('../dist/claude-auth.js');
 const directory=await mkdtemp(join(tmpdir(),'claude-auth-'));
 try{const env=await claudeEnvironment(directory);assert.notEqual(env.HOME,process.env.HOME);assert.ok(env.CLAUDE_CONFIG_DIR.startsWith(env.HOME));assert.equal(env.ANTHROPIC_API_KEY,undefined);assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN,undefined);}finally{await rm(directory,{recursive:true,force:true});}
});
