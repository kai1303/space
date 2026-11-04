import {AppError,record,uuid} from './validation.js';
export const TYPING_TTL_MS=6000;
export type TypingEvent={channel_id:string;thread_id:string|null;source_id:string;user:{id:string;name:string};active:boolean;expires_at:number};
export function parseTypingInput(input:unknown){
 const value=record(input,['channel_id','thread_id','active']);
 if(typeof value.active!=='boolean')throw new AppError(400,'invalid_typing');
 return {channel_id:uuid(value.channel_id),thread_id:value.thread_id===undefined?null:uuid(value.thread_id),active:value.active};
}
