import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {TypesenseSearch} from '@space/server/typesense';
import type {SearchDocument} from '@space/postgres/search';

test('bulk import checks every result, including HTTP 200 partial failure',async t=>{
 let fail=true;
 const server=createServer((req,res)=>{
  res.setHeader('content-type','application/json');
  if(req.url?.includes('/import'))res.end(fail?'[{invalid json]':'{"success":true}\n{"success":false,"error":"bad field"}');
  else res.end('{}');
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();});
 const engine=new TypesenseSearch({url:`http://127.0.0.1:${(server.address() as {port:number}).port}`,apiKey:'test'});
 const documents=[{id:'a'},{id:'b'}] as SearchDocument[];
 await assert.rejects(engine.upsert(documents));fail=false;
 await assert.rejects(engine.upsert(documents),/search_index_failed/);
});
