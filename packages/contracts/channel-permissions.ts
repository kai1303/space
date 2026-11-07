import {AppError,record,uuid} from './validation.js';
export type ChannelMemberPolicy = 'managers' | 'members';
export interface ChannelPermissions {
  revision: string;
  posting: 'everyone' | 'members' | 'admins' | 'selected';
  poster_ids: string[];
  manager_ids: string[];
  allow_replies: boolean;
  allow_broadcast: boolean;
  invite: ChannelMemberPolicy;
  remove: ChannelMemberPolicy;
  edit_details: ChannelMemberPolicy;
  archive: ChannelMemberPolicy;
}
export interface ChannelCapabilities {
  post: boolean; reply: boolean; broadcast: boolean; invite: boolean; remove: boolean;
  edit_details: boolean; archive: boolean; manage: boolean;
}
export interface ChannelPermissionSnapshot extends ChannelPermissions { capabilities: ChannelCapabilities }
export type ChannelPermissionsUpdate = Partial<Omit<ChannelPermissions,'revision'>> & {revision:string};
export const channelPermissionDefaults: ChannelPermissions = {
  revision:'0',posting:'everyone',poster_ids:[],manager_ids:[],allow_replies:true,allow_broadcast:true,
  invite:'managers',remove:'managers',edit_details:'managers',archive:'managers',
};
export function parseChannelPermissionsUpdate(input:unknown):ChannelPermissionsUpdate {
  const v=record(input,['revision','posting','poster_ids','manager_ids','allow_replies','allow_broadcast','invite','remove','edit_details','archive']);
  if(typeof v.revision!=='string'||! /^(0|[1-9]\d{0,18})$/.test(v.revision)||BigInt(v.revision)>9223372036854775807n)throw new AppError(400,'invalid_revision');
  if(Object.keys(v).length<2)throw new AppError(400,'empty_update');
  const result:ChannelPermissionsUpdate={revision:v.revision};
  if('posting' in v){if(typeof v.posting!=='string'||!['everyone','members','admins','selected'].includes(v.posting))throw new AppError(400,'invalid_posting_permission');result.posting=v.posting as ChannelPermissions['posting'];}
  for(const key of ['allow_replies','allow_broadcast'] as const)if(key in v){if(typeof v[key]!=='boolean')throw new AppError(400,'invalid_permission');result[key]=v[key];}
  for(const key of ['invite','remove','edit_details','archive'] as const)if(key in v){if(typeof v[key]!=='string'||!['managers','members'].includes(v[key]))throw new AppError(400,'invalid_permission');result[key]=v[key] as ChannelMemberPolicy;}
  for(const key of ['poster_ids','manager_ids'] as const)if(key in v){
    if(!Array.isArray(v[key])||v[key].length>100)throw new AppError(400,'invalid_permission_members');
    const ids=v[key].map(uuid);if(new Set(ids).size!==ids.length)throw new AppError(400,'duplicate_permission_member');result[key]=ids;
  }
  return result;
}
