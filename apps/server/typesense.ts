import { AppError } from '@space/contracts';
import type { SearchDocument } from '@space/postgres/search';

export interface TypesenseOptions {url:string;apiKey:string;collection?:string;indexing?:boolean}
export function typesenseConfig():TypesenseOptions|undefined {
  const url=process.env.TYPESENSE_URL,apiKey=process.env.TYPESENSE_API_KEY;
  if(!url&&!apiKey)return;
  if(!url||!apiKey)throw new Error('TYPESENSE_URL and TYPESENSE_API_KEY are both required');
  return {url,apiKey,collection:process.env.TYPESENSE_COLLECTION};
}
export class TypesenseSearch {
  readonly collection:string;
  private ready?:Promise<void>;
  constructor(private readonly options:TypesenseOptions) {
    const url=new URL(options.url);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!options.apiKey)throw new Error('invalid Typesense configuration');
    this.collection=options.collection??'space_messages_v1';
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(this.collection))throw new Error('invalid Typesense collection');
  }
  private async request(path:string,method='GET',body?:string):Promise<Response> {
    let response:Response;
    try { response=await fetch(new URL(path,this.options.url.endsWith('/')?this.options.url:this.options.url+'/'),{method,headers:{'X-TYPESENSE-API-KEY':this.options.apiKey,'content-type':path.includes('/import')?'text/plain':'application/json'},body,signal:AbortSignal.timeout(10_000)}); }
    catch {throw new AppError(503,'search_unavailable');}
    return response;
  }
  initialize():Promise<void> {
    return this.ready??=(async()=>{
      const existing=await this.request(`collections/${this.collection}`);
      if(existing.ok)return;
      if(existing.status!==404)throw new AppError(503,'search_unavailable');
      const created=await this.request('collections','POST',JSON.stringify({name:this.collection,fields:[
        {name:'message_id',type:'string',facet:true},{name:'workspace_id',type:'string',facet:true},
        {name:'channel_id',type:'string',facet:true},{name:'author_id',type:'string',facet:true},
        {name:'text',type:'string'},{name:'created_at',type:'int64',sort:true},
        {name:'search_order',type:'int64',sort:true},{name:'revision',type:'int64',sort:true},{name:'has_link',type:'bool'}
      ]}));
      if(!created.ok&&created.status!==409)throw new AppError(503,'search_unavailable');
    })().catch(error=>{this.ready=undefined;throw error;});
  }
  async upsert(documents:SearchDocument[]):Promise<void> {
    if(!documents.length)return;
    await this.initialize();
    const response=await this.request(`collections/${this.collection}/documents/import?action=upsert`,'POST',documents.map(doc=>JSON.stringify(doc)).join('\n'));
    if(!response.ok)throw new AppError(503,'search_unavailable');
    const results=(await response.text()).trim().split('\n').map(line=>JSON.parse(line));
    if(results.length!==documents.length||results.some(result=>result.success!==true))throw new AppError(503,'search_index_failed');
  }
  async removeOlder(message:string,revision?:number):Promise<void> {
    await this.initialize();
    const filter=`message_id:=${message}${revision===undefined?'':` && revision:<${revision}`}`;
    const response=await this.request(`collections/${this.collection}/documents?${new URLSearchParams({filter_by:filter})}`,'DELETE');
    if(!response.ok)throw new AppError(503,'search_unavailable');
  }
  async removeDocument(id:string):Promise<void> {
    const response=await this.request(`collections/${this.collection}/documents/${encodeURIComponent(id)}`,'DELETE');
    if(!response.ok&&response.status!==404)throw new AppError(503,'search_unavailable');
  }
  async candidates(q:string,filter:string):Promise<SearchDocument[]> {
    await this.initialize();
    const params=new URLSearchParams({q,query_by:'text',filter_by:filter,limit:'50',sort_by:'created_at:desc,search_order:desc,revision:desc',prefix:'true',num_typos:'0',drop_tokens_threshold:'0',highlight_fields:'none',include_fields:'id,message_id,workspace_id,channel_id,revision,created_at,search_order'});
    const response=await this.request(`collections/${this.collection}/documents/search?${params}`);
    if(!response.ok)throw new AppError(503,'search_unavailable');
    const result=await response.json() as {hits?:{document:SearchDocument}[]};
    if(!Array.isArray(result.hits)||result.hits.length>50)throw new AppError(503,'search_unavailable');
    return result.hits.map(hit=>hit.document);
  }
  async removeCollection():Promise<void> {
    const response=await this.request(`collections/${this.collection}`,'DELETE');
    if(!response.ok&&response.status!==404)throw new AppError(503,'search_unavailable');
    this.ready=undefined;
  }
}
