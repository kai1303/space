import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk';
import { HUDDLE_CAPACITY } from '@space/contracts';

export interface HuddleMedia {
 url: string;
 create(id:string):Promise<void>;
 remove(id:string):Promise<void>;
 exists(id:string):Promise<boolean>;
 token(id:string,actor:string,name:string):Promise<string>;
 webhook(body:string,authorization?:string):Promise<{event:string;room?:{name:string}}>;
}
export const huddleRoom = (id:string) => `space-huddle-${id}`;
export function huddleMedia(env:NodeJS.ProcessEnv=process.env):HuddleMedia|undefined {
 const {LIVEKIT_URL:host,LIVEKIT_PUBLIC_URL:url,LIVEKIT_API_KEY:key,LIVEKIT_API_SECRET:secret}=env;
 if(!host&&!url&&!key&&!secret)return undefined;
 if(!host||!url||!key||!secret||secret.length<32)throw new Error('Complete LiveKit configuration with a 32-character secret is required');
 if(!['http:','https:'].includes(new URL(host).protocol)||!['ws:','wss:'].includes(new URL(url).protocol))throw new Error('Invalid LiveKit URL');
 if(env.NODE_ENV==='production'&&(new URL(host).protocol!=='https:'||new URL(url).protocol!=='wss:'))throw new Error('LiveKit requires TLS in production');
 const rooms=new RoomServiceClient(host,key,secret,{requestTimeout:8});
 const receiver=new WebhookReceiver(key,secret);
 return {
  url,
  async create(id){await rooms.createRoom({name:huddleRoom(id),maxParticipants:HUDDLE_CAPACITY,emptyTimeout:60,departureTimeout:15});},
  async remove(id){try{await rooms.deleteRoom(huddleRoom(id));}catch(error){if((error as {code?:string}).code!=='not_found')throw error;}},
  async exists(id){return (await rooms.listRooms([huddleRoom(id)])).length>0;},
  async token(id,actor,name){const token=new AccessToken(key,secret,{identity:actor,name,ttl:60});
   token.addGrant({roomJoin:true,room:huddleRoom(id),canPublish:true,canSubscribe:true,canPublishData:true});return token.toJwt();},
  webhook:(body,authorization)=>receiver.receive(body,authorization),
 };
}
