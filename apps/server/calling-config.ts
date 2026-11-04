import {createHmac} from 'node:crypto';
import type {CallIceConfig} from '@space/contracts';
export function callIceConfig(actor:string,env:Record<string,string|undefined>=process.env,now=Math.floor(Date.now()/1000)):CallIceConfig {
 const urls=(value:string|undefined)=>value?.split(',').map(s=>s.trim()).filter(Boolean)??[];
 const stun=urls(env.CALL_STUN_URLS),turn=urls(env.CALL_TURN_URLS);
 if(stun.length>4||turn.length>8||stun.some(s=>!/^stuns?:[^\s/@]+(?::\d+)?$/.test(s))||turn.some(s=>!/^turns?:[^\s/@]+(?:\?transport=(udp|tcp))?$/.test(s)))throw new Error('Invalid calling ICE URLs');
 if(turn.length&&!env.CALL_TURN_SECRET)throw new Error('CALL_TURN_SECRET is required');
 const relay=env.CALL_ICE_RELAY_ONLY==='true';
 if(relay&&!turn.length)throw new Error('Relay-only calling requires TURN');
 const username=`${now+3600}:${actor}`;
 return {iceServers:[...(stun.length?[{urls:stun}]:[]),...(turn.length?[{urls:turn,username,credential:createHmac('sha1',env.CALL_TURN_SECRET!).update(username).digest('base64')}]:[])],iceTransportPolicy:relay?'relay':'all',hasTurn:turn.length>0,...(turn.length?{expiresAt:(now+3600)*1000}:{})};
}
