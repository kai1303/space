import type { Pool } from 'pg';
import { AppError, uuid } from '@space/contracts';

export interface SearchDocument {
  id:string; message_id:string; workspace_id:string; channel_id:string; author_id:string;
  text:string; created_at:number; search_order:number; revision:number; has_link:boolean;
}
export interface SearchHit {
  id:string; channel_id:string; channel_name:string; channel_kind:'channel'|'direct'; thread_id:string;
  text:string; created_at:string; author:{id:string;name:string}; is_reply:boolean;
}
export class SearchStore {
  constructor(readonly pool:Pool) {}
  async document(id:string,channel:string):Promise<SearchDocument|null> {
    const {rows}=await this.pool.query(`SELECT m.id AS message_id,m.workspace_id,m.channel_id,coalesce(m.user_id,m.installation_id) AS author_id,
      m.text, m.document,m.search_order::float8 AS search_order, (extract(epoch FROM m.created_at)*1000)::float8 AS created_at,m.search_revision::float8 AS revision
      FROM messages m WHERE m.channel_id=$1 AND m.id=$2 AND m.agent_session_id IS NULL AND m.deleted_at IS NULL`,[uuid(channel),uuid(id)]);
    const row=rows[0];if(!row)return null;
    const links=(row.document?.ops??[]).flatMap((op:{attributes?:{link?:string}})=>op.attributes?.link?[op.attributes.link]:[]);
    const text=[row.text,...links].join(' ').slice(0,32000);
    return {id:`${row.message_id}_${row.revision}`,message_id:row.message_id,workspace_id:row.workspace_id,channel_id:row.channel_id,author_id:row.author_id,text,created_at:Math.trunc(row.created_at),revision:row.revision,search_order:row.search_order,has_link:/https?:\/\/|mailto:/i.test(text)};
  }
  async channels(actor:string,workspace:string,channel?:string,name?:string):Promise<string[]> {
    const active=await this.pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND active',[uuid(workspace),uuid(actor)]);
    if(!active.rowCount)throw new AppError(404,'not_found');
    const {rows}=await this.pool.query(`SELECT c.id FROM channels c JOIN channel_members cm ON cm.channel_id=c.id AND cm.workspace_id=c.workspace_id
      WHERE c.workspace_id=$1 AND cm.user_id=$2 AND ($3::uuid IS NULL OR c.id=$3) AND ($4::text IS NULL OR lower(c.name)=$4) ORDER BY c.id LIMIT 2049`,[workspace,actor,channel?uuid(channel):null,name??null]);
    if(rows.length>2048)throw new AppError(422,'search_scope_too_large');
    return rows.map(row=>row.id);
  }
  async authors(workspace:string,name:string):Promise<string[]> {
    const {rows}=await this.pool.query(`SELECT u.id FROM users u JOIN workspace_members w ON w.user_id=u.id
      WHERE w.workspace_id=$1 AND lower(u.display_name)=$2
      UNION SELECT i.id FROM agent_installations i JOIN agent_definitions d ON d.id=i.definition_id
      WHERE i.workspace_id=$1 AND lower(d.name)=$2 LIMIT 101`,[workspace,name]);
    if(rows.length>100)throw new AppError(400,'invalid_search');
    return rows.map(row=>row.id);
  }
  async hydrate(actor:string,workspace:string,candidates:SearchDocument[],threadsOnly=false):Promise<SearchHit[]> {
    if(!candidates.length)return [];
    const {rows}=await this.pool.query(`SELECT m.id,m.channel_id,CASE WHEN c.kind='direct' THEN coalesce(peer.display_name,c.name)||CASE WHEN c.direct_user_low=c.direct_user_high THEN ' (you)' ELSE '' END ELSE c.name END AS channel_name,c.kind AS channel_kind,m.thread_id,m.text,m.created_at,
      coalesce(m.user_id,m.installation_id) AS author_id,coalesce(u.display_name,d.name,'Agent') AS author_name,
      m.search_revision::text AS revision,
      EXISTS(SELECT 1 FROM messages earlier WHERE earlier.channel_id=m.channel_id AND earlier.thread_id=m.thread_id AND earlier.sequence<m.sequence AND earlier.agent_session_id IS NULL) AS is_reply,
      EXISTS(SELECT 1 FROM messages sibling WHERE sibling.channel_id=m.channel_id AND sibling.thread_id=m.thread_id AND sibling.id<>m.id AND sibling.agent_session_id IS NULL) AS has_thread
      FROM messages m JOIN channels c ON c.id=m.channel_id AND c.workspace_id=m.workspace_id
      JOIN channel_members cm ON cm.channel_id=m.channel_id AND cm.workspace_id=m.workspace_id AND cm.user_id=$1
      JOIN workspace_members wm ON wm.workspace_id=m.workspace_id AND wm.user_id=$1 AND wm.active
      LEFT JOIN users peer ON c.kind='direct' AND peer.id=CASE WHEN c.direct_user_low=$1::uuid THEN c.direct_user_high ELSE c.direct_user_low END
      LEFT JOIN users u ON u.id=m.user_id LEFT JOIN agent_installations i ON i.id=m.installation_id LEFT JOIN agent_definitions d ON d.id=i.definition_id
      WHERE m.workspace_id=$2 AND m.channel_id=ANY($3::uuid[]) AND m.id=ANY($4::uuid[]) AND m.agent_session_id IS NULL AND m.deleted_at IS NULL`,[uuid(actor),uuid(workspace),candidates.map(d=>uuid(d.channel_id)),candidates.map(d=>uuid(d.message_id))]);
    const current=new Map(rows.map(row=>[row.id,row]));
    return candidates.flatMap(candidate=>{
      const row=current.get(candidate.message_id);
      if(!row||row.revision!==String(candidate.revision)||(threadsOnly&&!row.has_thread))return [];
      return [{id:row.id,channel_id:row.channel_id,channel_name:row.channel_name,channel_kind:row.channel_kind,thread_id:row.thread_id,text:row.text,created_at:row.created_at.toISOString(),author:{id:row.author_id,name:row.author_name},is_reply:row.is_reply}];
    });
  }
  async enable():Promise<void> {
    // Commit activation and its recovery obligation together. The SEARCH stream drops work before a durable consumer exists.
    await this.pool.query(`WITH enabled AS (UPDATE message_search_state SET enabled=true WHERE id AND NOT enabled RETURNING id)
      INSERT INTO event_outbox(kind,aggregate_id,payload) SELECT 'search.backfill','all','{}'::jsonb FROM enabled`);
  }
  async enqueueBackfill():Promise<void> {
    await this.pool.query("INSERT INTO event_outbox(kind,aggregate_id,payload) VALUES('search.backfill','all','{}')");
  }
  async backfillPage(after?:string):Promise<void> {
    // Each durable continuation does finite indexed work; a crashed page can safely be delivered again.
    await this.pool.query(`WITH batch AS MATERIALIZED (SELECT id,channel_id FROM message_identities WHERE id>$1 ORDER BY id LIMIT 500),
      queued AS (INSERT INTO event_outbox(kind,aggregate_id,payload) SELECT 'search.message',id::text,jsonb_build_object('message_id',id,'channel_id',channel_id) FROM batch RETURNING id)
      INSERT INTO event_outbox(kind,aggregate_id,payload) SELECT 'search.backfill','all',jsonb_build_object('after',(SELECT id::text FROM batch ORDER BY id DESC LIMIT 1))
      WHERE (SELECT count(*) FROM batch)=500`,[after===undefined?'00000000-0000-0000-0000-000000000000':uuid(after)]);
  }
}
