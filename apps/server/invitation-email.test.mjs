import { test } from 'node:test';
import assert from 'node:assert/strict';
import { invitationEmailConfig, registerInvitationEmailDelivery } from './dist/invitation-email.js';

test('SMTP is explicitly unavailable without configuration and rejects unsafe or incomplete settings',()=>{
 assert.equal(invitationEmailConfig({}),undefined);
 assert.throws(()=>invitationEmailConfig({SPACE_SMTP_HOST:'localhost'}),/SMTP requires/);
 const env={SPACE_SMTP_HOST:'localhost',SPACE_SMTP_FROM:'space@example.test',SPACE_PUBLIC_URL:'https://space.example.test',SPACE_INVITATION_ENCRYPTION_KEY:'ab'.repeat(32)};
 assert.equal(invitationEmailConfig(env).port,587);
 assert.throws(()=>invitationEmailConfig({...env,NODE_ENV:'production',SPACE_PUBLIC_URL:'http://space.example.test'}),/HTTPS/);
 assert.throws(()=>invitationEmailConfig({...env,SPACE_SMTP_USER:'user'}),/configured together/);
});
test('durable email consumer retries delivery failure, then acknowledges completed jobs without sending again',async()=>{
 const hooks={},calls=[],id='9a13aa4d-d380-4284-a6c8-03bf0c1c6634';let handler,job={id,email:'recipient@example.test',token:'secret',workspace_name:'Workspace'};
 const bus={subscribe:async(filter,options,fn)=>{assert.equal(filter,'invitation.email_requested.*');assert.equal(options.maxPending,4);handler=fn;return async()=>{calls.push('stopped');};}};
 const store={emailAttempt:async()=>job,emailFinished:async(_id,sent)=>{calls.push(sent?'sent':'failed');}};
 const mailer={invitation:async()=>{throw new Error('simulated SMTP failure');},close:()=>calls.push('closed')};
 registerInvitationEmailDelivery({addHook:(name,hook)=>{hooks[name]=hook;}},async()=>bus,store,mailer);
 await hooks.onReady();const message={event:{data:{email_id:id}},ack:async()=>calls.push('ack'),retry:async delay=>calls.push(['retry',delay])};
 await handler(message);assert.deepEqual(calls,['failed',['retry',30000]]);
 job=null;await handler(message);assert.equal(calls.at(-1),'ack');
 await hooks.preClose();assert.deepEqual(calls.slice(-2),['stopped','closed']);
});
