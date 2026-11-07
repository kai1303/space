import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import Fastify from 'fastify';
import {AppError} from '@space/contracts';
import {bootstrap} from '@space/postgres/bootstrap';
import {migrate} from '@space/postgres/migrate';
import {PostgresStore} from '@space/postgres/store';
import {ChatStore} from '@space/postgres/chat';
import {WorkspaceStore} from '@space/postgres/workspace';
import {registerChatRoutes} from '../../apps/server/dist/chat.js';
const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL is required');
const schema=`channel_permissions_${randomBytes(8).toString('hex')}`;
const admin=new Pool({connectionString:url});
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`});
const app=Fastify(),store=new PostgresStore(pool),chat=new ChatStore(pool);
app.decorateRequest('actorId','');
app.addHook('onRequest',async r=>{r.actorId=await store.authenticate(r.headers.authorization?.slice(7)??'');});
app.setErrorHandler((e,_r,reply)=>reply.code(e instanceof AppError?e.status:500).send({error:e instanceof AppError?e.code:'internal_error'}));
registerChatRoutes(app,chat);
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await app.close();await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
async function call(token:string,method:'GET'|'PATCH'|'POST'|'DELETE',path:string,payload?:object,status=200){
 const r=await app.inject({method,url:`/v1${path}`,headers:{authorization:`Bearer ${token}`},...(payload?{payload}:{})});
 assert.equal(r.statusCode,status,r.body);return r.statusCode===204?undefined:r.json();
}
const permissions=(token:string,id:string,status=200)=>call(token,'GET',`/channels/${id}/permissions`,undefined,status);
const patch=(token:string,id:string,revision:string,values:object,status=200)=>call(token,'PATCH',`/channels/${id}/permissions`,{revision,...values},status);
const send=(token:string,id:string,extra:object={},status=201)=>call(token,'POST',`/channels/${id}/messages`,{client_message_id:randomUUID(),text:'Hello',...extra},status);
async function fixture(){const a=await bootstrap(pool);const channel=await chat.createChannel(a.owner_id,a.workspace_id,{name:'permissions',private:false});await chat.addMember(a.owner_id,channel.id,{user_id:a.collaborator_id});return {...a,channel_id:channel.id};}

test('default capabilities preserve posting and expose independently delegated channel management',async()=>{
 const a=await fixture(); const owner=await permissions(a.owner_token,a.channel_id),member=await permissions(a.collaborator_token,a.channel_id);
 assert.equal(owner.posting,'everyone');assert.deepEqual(owner.manager_ids,[a.owner_id]);assert.equal(owner.capabilities.manage,true);
 assert.equal(member.capabilities.post,true);assert.equal(member.capabilities.invite,false);
 const delegated=await patch(a.owner_token,a.channel_id,owner.revision,{manager_ids:[a.owner_id,a.collaborator_id]});
 assert.equal((await permissions(a.collaborator_token,a.channel_id)).capabilities.manage,true);
 await patch(a.collaborator_token,a.channel_id,delegated.revision,{posting:'admins',allow_replies:false});
 assert.equal((await permissions(a.collaborator_token,a.channel_id)).capabilities.post,false,'manager is not a workspace admin');
});

test('posting, thread replies and broadcast restrictions are enforced by the shared send path',async()=>{
 const a=await fixture();let p=await permissions(a.owner_token,a.channel_id);
 const root=await send(a.owner_token,a.channel_id);
 p=await patch(a.owner_token,a.channel_id,p.revision,{posting:'admins',allow_replies:true});
 await send(a.collaborator_token,a.channel_id,{},403);
 await send(a.collaborator_token,a.channel_id,{thread_id:root.thread_id});
 p=await patch(a.owner_token,a.channel_id,p.revision,{allow_replies:false});
 await send(a.collaborator_token,a.channel_id,{thread_id:root.thread_id},403);
 p=await patch(a.owner_token,a.channel_id,p.revision,{posting:'selected',poster_ids:[a.collaborator_id]});
 await send(a.collaborator_token,a.channel_id);
 p=await patch(a.owner_token,a.channel_id,p.revision,{allow_broadcast:false});
 assert.ok(!(await chat.mentions.search(a.owner_id,a.channel_id)).items.some(item=>item.kind==='broadcast'));
 const broadcast={text:'@channel',document:{ops:[{insert:'@channel',attributes:{mention:{kind:'broadcast',id:'channel',label:'channel'}}}]},broadcast_confirmed:true};
 await send(a.owner_token,a.channel_id,broadcast,403);
 await pool.query("UPDATE workspace_members SET guest_type='multi' WHERE workspace_id=$1 AND user_id=$2",[a.workspace_id,a.collaborator_id]);
 p=await patch(a.owner_token,a.channel_id,p.revision,{posting:'members',poster_ids:[]});
 await send(a.collaborator_token,a.channel_id,{},403);
 p=await patch(a.owner_token,a.channel_id,p.revision,{posting:'everyone'});
 await send(a.collaborator_token,a.channel_id);
});

test('permission reads and updates reject outsiders, guests, stale revisions and malformed grants',async()=>{
 const a=await fixture(),b=await bootstrap(pool);const p=await permissions(a.owner_token,a.channel_id);
 await permissions(b.owner_token,a.channel_id,404);
 await patch(a.collaborator_token,a.channel_id,p.revision,{posting:'admins'},403);
 await patch(a.owner_token,a.channel_id,p.revision,{manager_ids:[b.owner_id]},400);
 await patch(a.owner_token,a.channel_id,p.revision,{poster_ids:Array.from({length:101},()=>randomUUID())},400);
 await patch(a.owner_token,a.channel_id,p.revision,{unexpected:true},400);
 await patch(a.owner_token,a.channel_id,p.revision,{posting:['admins']},400);
 await patch(a.owner_token,a.channel_id,p.revision,{invite:['members']},400);
 await pool.query("UPDATE workspace_members SET guest_type='multi' WHERE workspace_id=$1 AND user_id=$2",[a.workspace_id,a.collaborator_id]);
 await patch(a.owner_token,a.channel_id,p.revision,{manager_ids:[a.collaborator_id]},400);
 await patch(a.owner_token,a.channel_id,p.revision,{posting:'admins'});
 await patch(a.owner_token,a.channel_id,p.revision,{posting:'everyone'},409);
 await pool.query('UPDATE workspace_members SET active=false WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id]);
 await permissions(a.collaborator_token,a.channel_id,404);
});

test('concurrent editors have one winner and membership removal clears explicit grants durably',async()=>{
 const a=await fixture();const p=await permissions(a.owner_token,a.channel_id);
 const results=await Promise.all(['admins','members'].map(posting=>app.inject({method:'PATCH',url:`/v1/channels/${a.channel_id}/permissions`,headers:{authorization:`Bearer ${a.owner_token}`},payload:{revision:p.revision,posting}})));
 assert.deepEqual(results.map(r=>r.statusCode).sort(),[200,409]);
 let next=await permissions(a.owner_token,a.channel_id);
 next=await patch(a.owner_token,a.channel_id,next.revision,{manager_ids:[a.owner_id,a.collaborator_id],posting:'selected',poster_ids:[a.collaborator_id]});
 await call(a.owner_token,'DELETE',`/channels/${a.channel_id}/members/${a.collaborator_id}`,undefined,204);
 const cleaned=await permissions(a.owner_token,a.channel_id);
 assert.deepEqual(cleaned.manager_ids,[a.owner_id]);assert.deepEqual(cleaned.poster_ids,[]);assert.notEqual(cleaned.revision,next.revision);
 await call(a.collaborator_token,'POST',`/channels/${a.channel_id}/join`,{});
 assert.equal((await permissions(a.collaborator_token,a.channel_id)).capabilities.manage,false);
 const events=await pool.query("SELECT count(*)::int AS n FROM event_outbox WHERE payload->>'channel_id'=$1 AND payload->>'resource_scope'='metadata'",[a.channel_id]);assert.ok(events.rows[0].n>0);
});

test('member action policies are independent and private channels retain management',async()=>{
 const a=await fixture();let p=await permissions(a.owner_token,a.channel_id);
 await call(a.collaborator_token,'PATCH',`/channels/${a.channel_id}`,{topic:'No'},403);
 p=await patch(a.owner_token,a.channel_id,p.revision,{edit_details:'members',archive:'members',invite:'members',remove:'members'});
 await call(a.collaborator_token,'PATCH',`/channels/${a.channel_id}`,{topic:'Allowed'});
 await call(a.collaborator_token,'PATCH',`/channels/${a.channel_id}`,{archived:true});
 await send(a.owner_token,a.channel_id,{},409);
 await call(a.collaborator_token,'PATCH',`/channels/${a.channel_id}`,{archived:false});
 const privateChannel=await chat.createChannel(a.owner_id,a.workspace_id,{name:'private',private:true});
 await call(a.owner_token,'DELETE',`/channels/${privateChannel.id}/members/${a.owner_id}`,undefined,409);
});

test('existing acknowledgements survive restriction changes and direct messages stay independent',async()=>{
 const a=await fixture(),client_message_id=randomUUID();
 const original=await send(a.collaborator_token,a.channel_id,{client_message_id});
 const p=await permissions(a.owner_token,a.channel_id);
 await patch(a.owner_token,a.channel_id,p.revision,{posting:'admins',allow_replies:false});
 const replay=await send(a.collaborator_token,a.channel_id,{client_message_id});
 assert.equal(replay.id,original.id);
 await send(a.collaborator_token,a.channel_id,{},403);
 const direct=await chat.directMessages.open(a.owner_id,a.workspace_id,{user_id:a.collaborator_id});
 await send(a.collaborator_token,direct.id);
 await permissions(a.owner_token,direct.id,404);
});

test('channel broadcasts cannot override a stricter workspace policy',async()=>{
 const a=await fixture();
 await pool.query("INSERT INTO workspace_mention_settings(workspace_id,broadcast_permission) VALUES($1,'admins') ON CONFLICT(workspace_id) DO UPDATE SET broadcast_permission='admins'",[a.workspace_id]);
 assert.equal((await permissions(a.collaborator_token,a.channel_id)).capabilities.broadcast,false);
 const broadcast={text:'@channel',document:{ops:[{insert:'@channel',attributes:{mention:{kind:'broadcast',id:'channel',label:'channel'}}}]},broadcast_confirmed:true};
 await send(a.collaborator_token,a.channel_id,broadcast,403);
 await send(a.owner_token,a.channel_id,broadcast);
});

test('concurrent private-channel managers cannot both leave',async()=>{
 const a=await fixture();const channel=await chat.createChannel(a.owner_id,a.workspace_id,{name:'private-concurrent',private:true});
 await chat.addMember(a.owner_id,channel.id,{user_id:a.collaborator_id});
 const p=await permissions(a.owner_token,channel.id);
 await patch(a.owner_token,channel.id,p.revision,{manager_ids:[a.owner_id,a.collaborator_id]});
 const results=await Promise.all([[a.owner_token,a.owner_id],[a.collaborator_token,a.collaborator_id]].map(([token,user])=>app.inject({method:'DELETE',url:`/v1/channels/${channel.id}/members/${user}`,headers:{authorization:`Bearer ${token}`}})));
 assert.deepEqual(results.map(r=>r.statusCode).sort(),[204,409]);
 const remaining=await pool.query('SELECT count(*)::int AS n FROM channel_members WHERE channel_id=$1',[channel.id]);
 assert.equal(remaining.rows[0].n,1);
});

test('workspace removal and admin demotion cannot strand private channels',async()=>{
 const a=await fixture(),workspaces=new WorkspaceStore(pool);
 const channel=await chat.createChannel(a.owner_id,a.workspace_id,{name:'private-workspace',private:true});
 await chat.addMember(a.owner_id,channel.id,{user_id:a.collaborator_id});
 let p=await permissions(a.owner_token,channel.id);
 await patch(a.owner_token,channel.id,p.revision,{manager_ids:[a.collaborator_id]});
 await chat.removeMember(a.owner_id,channel.id,a.owner_id);
 await assert.rejects(()=>workspaces.removeMember(a.owner_id,a.workspace_id,a.collaborator_id),{code:'channel_needs_manager'});
 await workspaces.changeRole(a.owner_id,a.workspace_id,a.collaborator_id,{role:'admin'});
 p=await permissions(a.collaborator_token,channel.id);
 await patch(a.collaborator_token,channel.id,p.revision,{manager_ids:[]});
 await assert.rejects(()=>workspaces.changeRole(a.owner_id,a.workspace_id,a.collaborator_id,{role:'member'}),{code:'channel_needs_manager'});
});

test('legacy managerless private channels do not trap ordinary members',async()=>{
 const a=await fixture(),workspaces=new WorkspaceStore(pool);
 const channel=await chat.createChannel(a.owner_id,a.workspace_id,{name:'legacy-private',private:true});
 await chat.addMember(a.owner_id,channel.id,{user_id:a.collaborator_id});
 // Reproduce a pre-migration private channel whose creator already departed.
 await pool.query('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2',[channel.id,a.owner_id]);
 await workspaces.removeMember(a.owner_id,a.workspace_id,a.collaborator_id);
});

for(const action of ['join','create'] as const)test(`channel ${action} cannot restore membership after concurrent workspace removal`,{timeout:15000},async()=>{
 const a=await fixture(),workspaces=new WorkspaceStore(pool);
 const channel=await chat.createChannel(a.owner_id,a.workspace_id,{name:'membership-race',private:false});
 const operationPool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:1});
 let unblock!:()=>void,reached!:()=>void,paused=false;
 const gate=new Promise<void>(resolve=>{unblock=resolve;}),started=new Promise<void>(resolve=>{reached=resolve;});
 const connect=operationPool.connect.bind(operationPool);
 operationPool.connect=(async()=>{
   const client=await connect(),query=client.query.bind(client);
   client.query=((...args:any[])=>{
     const text=typeof args[0]==='string'?args[0]:args[0]?.text;
     const execute=()=>Reflect.apply(query,client,args);
     if(!paused&&text?.startsWith(action==='create'?'insert into "channels"':'insert into "channel_members"')){paused=true;reached();return gate.then(execute);}
     return execute();
   }) as typeof client.query;
   return client;
 }) as typeof operationPool.connect;
 const operationChat=new ChatStore(operationPool);
 const operation=(action==='join'?operationChat.join(a.collaborator_id,channel.id):operationChat.createChannel(a.collaborator_id,a.workspace_id,{name:'racing-private',private:true}))
   .then(value=>({value,error:undefined}),error=>({value:undefined,error}));
 try{
   await started;
   await workspaces.removeMember(a.owner_id,a.workspace_id,a.collaborator_id);
   unblock();
   assert.equal((await operation).error?.code,'not_found');
   assert.equal((await pool.query('SELECT count(*)::int AS n FROM channel_members WHERE workspace_id=$1 AND user_id=$2',[a.workspace_id,a.collaborator_id])).rows[0].n,0);
   if(action==='create')assert.equal((await pool.query('SELECT count(*)::int AS n FROM channels WHERE workspace_id=$1 AND created_by=$2',[a.workspace_id,a.collaborator_id])).rows[0].n,0);
 }finally{unblock();await operation;await operationPool.end();}
});
