import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,realpath,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {projectMcp,projectToolNames,resolveProject} from '../dist/project-tools.js';
import {localSessionStore} from '../dist/session-storage.js';
import {parseOptions} from '../dist/main.js';

test('project selection is explicit, canonical and part of persistent session identity',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'space-project-scope-'));
 try{
  const first=join(directory,'first'),second=join(directory,'second');await mkdir(first);await mkdir(second);
  const storage={directory,connection:{origin:'http://localhost:3000',workspace_id:'w',installation_id:'i',credential:'c'},identity:{issuer:'test',subject:'u',client_id:'c'}};
  const a=await localSessionStore({...storage,project:first}),b=await localSessionStore({...storage,project:second});
  assert.notEqual(a.directory,b.directory);
  await assert.rejects(resolveProject('relative/project'));await assert.rejects(resolveProject(join(directory,'missing')));
  await writeFile(join(directory,'file'),'test');await assert.rejects(resolveProject(join(directory,'file')));
  assert.equal(await resolveProject(first+'/../first'),await realpath(first));
  assert.equal(parseOptions(['--project',first]).project,first);
  assert.throws(()=>parseOptions(['--logout','--project',first]));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('real project file server reads/edits inside the selected root and rejects traversal and symlink escapes',{timeout:10000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'space-file-tools-'));
 const project=join(directory,'project'),outside=join(directory,'outside');await mkdir(project);await mkdir(outside);
 await writeFile(join(project,'inside.txt'),'inside');await writeFile(join(outside,'secret.txt'),'outside');await symlink(outside,join(project,'escape'));
 const command=projectMcp(project),child=spawn(command.command,command.args,{stdio:'pipe'}),pending=new Map();let sequence=0;
 child.stderr.resume();
 const lines=createInterface({input:child.stdout});lines.on('line',line=>{const message=JSON.parse(line);const result=pending.get(message.id);if(result){pending.delete(message.id);result(message);}});
 const rpc=(method,params)=>new Promise(resolve=>{const id=++sequence;pending.set(id,resolve);child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
 try{
  const ready=await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'space-test',version:'1'}});assert.ok(ready.result);
  child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');
  const tools=await rpc('tools/list',{});for(const name of projectToolNames)assert.ok(tools.result.tools.some(tool=>tool.name===name));
  const call=(name,args)=>rpc('tools/call',{name,arguments:args});
  const read=await call('read_text_file',{path:join(project,'inside.txt')});assert.match(JSON.stringify(read.result),/inside/);assert.ok(!read.result.isError);
  const write=await call('write_file',{path:join(project,'created.txt'),content:'created'});assert.ok(!write.result.isError);assert.equal(await readFile(join(project,'created.txt'),'utf8'),'created');
  for(const path of [join(outside,'secret.txt'),project+'/../outside/secret.txt',join(project,'escape','secret.txt')]){
   const denied=await call('read_text_file',{path});assert.ok(denied.error||denied.result?.isError);assert.ok(!JSON.stringify(denied).includes('"text":"outside"'));
  }
  const deniedWrite=await call('write_file',{path:join(project,'escape','new.txt'),content:'escape'});assert.ok(deniedWrite.error||deniedWrite.result?.isError);
 }finally{const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;lines.close();await rm(directory,{recursive:true,force:true});}
});
