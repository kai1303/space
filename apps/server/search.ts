import {createHash} from 'node:crypto';
import type {FastifyInstance} from 'fastify';
import {AppError,record,uuid} from '@space/contracts';
import type {EventBus} from '@space/events';
import {SearchStore,type SearchHit} from '@space/postgres/search';
import {TypesenseSearch,type TypesenseOptions} from './typesense.js';
import {parseSearchQuery} from './search-query.js';

export async function indexMessage(store:SearchStore,engine:TypesenseSearch,id:string,channel:string):Promise<void> {
  const document=await store.document(id,channel);
  if(!document){await engine.removeOlder(id);return;}
  // Immutable revision IDs make overlapping consumers and delayed writes unable to replace newer content.
  await engine.upsert([document]);
  await engine.removeOlder(id,document.revision);
  const current=await store.document(id,channel);
  if(current?.id!==document.id)await engine.removeDocument(document.id);
  // shortcut: an ambiguous timed-out write can leave an unreachable old revision. Hydration hides it; rebuild removes it.
}
export async function startSearchConsumer(bus:EventBus,store:SearchStore,engine:TypesenseSearch):Promise<()=>Promise<void>> {
  const stop=await bus.subscribe('search.>',{durable:'message-search-v1',queue:'message-search-v1',maxPending:4},async delivery=>{
    try {
      if(delivery.event.kind==='search.backfill')await store.backfillPage(delivery.event.data.after===undefined?undefined:uuid(delivery.event.data.after));
      else await indexMessage(store,engine,uuid(delivery.event.data.message_id),uuid(delivery.event.data.channel_id));
      await delivery.ack();
    }
    catch {await delivery.retry(5000);}
  });
  try {await store.enable();return stop;} catch(error) {await stop();throw error;}
}
export function registerSearch(app:FastifyInstance,store:SearchStore,getEvents:()=>Promise<EventBus>,options?:TypesenseOptions) {
  let engine:TypesenseSearch|undefined,stop:(()=>Promise<void>)|undefined;
  let active=0;
  const perActor=new Map<string,number>();
  app.addHook('onReady',async()=>{
    if(!options)return;
    const bus=await getEvents();
    engine=new TypesenseSearch({...options,collection:options.collection??`${bus.stream.toLowerCase()}_messages_v1`});
    if(options.indexing!==false)stop=await startSearchConsumer(bus,store,engine);
  });
  app.addHook('preClose',async()=>{await stop?.();});
  app.get<{Params:{workspaceId:string}}>('/v1/workspaces/:workspaceId/search',async request=>{
    const actor=request.actorId,workspace=uuid(request.params.workspaceId);
    if(active>=16||(perActor.get(actor)??0)>=2)throw new AppError(429,'search_busy');
    active++;perActor.set(actor,(perActor.get(actor)??0)+1);
    try {
      const input=record(request.query,['q','channel_id','cursor']),query=parseSearchQuery(input.q);
      const channel=input.channel_id===undefined?undefined:uuid(input.channel_id);
      const channels=await store.channels(actor,workspace,channel,query.channel);
      if(!engine)throw new AppError(503,'search_unavailable');
      if(!channels.length)return {items:[],next_cursor:null};
      const hash=createHash('sha256').update(JSON.stringify([actor,workspace,input.q,channel])).digest('hex').slice(0,24);
      let scanned=0,until=Date.now(),last:{at:number;order:number}|undefined;
      if(input.cursor!==undefined){
        try {
          if(typeof input.cursor!=='string'||input.cursor.length>256)throw new Error();
          const value=JSON.parse(Buffer.from(input.cursor,'base64url').toString());
          if(value.hash!==hash||!Number.isSafeInteger(value.scanned)||value.scanned<0||value.scanned>=5000||!Number.isSafeInteger(value.last?.at)||!Number.isSafeInteger(value.last?.order)||value.last.order<1||!Number.isSafeInteger(value.until)||value.until<0||value.until>Date.now())throw new Error();
          scanned=value.scanned;until=value.until;last=value.last;
        }catch{throw new AppError(400,'invalid_cursor');}
      }
      const filters=[`workspace_id:=${workspace}`,`channel_id:=[${channels.join(',')}]`,`created_at:<=${until}`];
      if(query.from){
        const authors=query.from==='me'?[actor]:await store.authors(workspace,query.from);
        if(!authors.length)return {items:[],next_cursor:null};
        filters.push(`author_id:=[${authors.join(',')}]`);
      }
      if(query.hasLink)filters.push('has_link:=true');
      if(query.before!==undefined)filters.push(`created_at:<${query.before}`);
      if(query.after!==undefined)filters.push(`created_at:>=${query.after}`);
      const items:SearchHit[]=[],seen=new Set<string>();
      let more=false;
      // Bound stale-candidate work even when the index is substantially behind the source of truth.
      for(let batch=0;batch<5&&scanned<5000;batch++){
        const pageFilters=[...filters,...(last?[`(created_at:<${last.at} || (created_at:=${last.at} && search_order:<${last.order}))`]:[])];
        const candidates=await engine.candidates(query.text,pageFilters.join(' && '));
        const valid=new Map((await store.hydrate(actor,workspace,candidates,query.threadsOnly)).map(hit=>[hit.id,hit]));
        more=candidates.length===50;
        for(let i=0;i<candidates.length;i++){
          const candidate=candidates[i]!;scanned++;last={at:candidate.created_at,order:candidate.search_order};
          const hit=valid.get(candidate.message_id);
          if(hit&&!seen.has(hit.id)){items.push(hit);seen.add(hit.id);}
          if(items.length===20||scanned>=5000){more=i<candidates.length-1||more;break;}
        }
        if(items.length===20||!more)break;
      }
      return {items,next_cursor:more&&scanned<5000?Buffer.from(JSON.stringify({hash,scanned,until,last})).toString('base64url'):null};
    } finally {active--;const left=(perActor.get(actor)??1)-1;if(left)perActor.set(actor,left);else perActor.delete(actor);}
  });
}
