import { AppError, record, text, uuid } from './validation.js';

export type CallMode = 'audio' | 'video';
export type CallReason = 'completed' | 'cancelled' | 'declined' | 'missed' | 'failed' | 'access_revoked';
export interface DmCall {
  id: string; channel_id: string; workspace_id: string; caller_id: string; callee_id: string;
  caller_name: string; callee_name: string; caller_device: string; callee_device: string | null;
  mode: CallMode; state: 'ringing' | 'accepted' | 'ended'; reason: CallReason | null;
  revision: number; created_at: string; accepted_at: string | null; ended_at: string | null;
}
// Endpoint UUIDs are private resumption capabilities; never include them in a client response.
export type CallSession = Omit<DmCall, 'caller_device' | 'callee_device'> & { selected: boolean };
export interface CallIceConfig {
  iceServers: { urls: string[]; username?: string; credential?: string }[];
  iceTransportPolicy: 'all' | 'relay'; hasTurn: boolean; expiresAt?: number;
}
export interface CallSignal {
  call_id: string; generation: string;
  description?: {type: 'offer' | 'answer'; sdp: string};
  candidate?: {candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment: string | null};
  ready?: true;
}
export function callMode(value: unknown): CallMode {
  if (value !== 'audio' && value !== 'video') throw new AppError(400, 'invalid_call_mode');
  return value;
}
export function parseCallStart(input: unknown) {
  const v = record(input, ['id','channel_id','device_id','mode']);
  return {id:uuid(v.id),channel_id:uuid(v.channel_id),device_id:uuid(v.device_id),mode:callMode(v.mode)};
}
export function parseCallSignal(input: unknown): CallSignal {
  const v = record(input, ['call_id','generation','description','candidate','ready']);
  const result: CallSignal = {call_id:uuid(v.call_id),generation:uuid(v.generation)};
  if ([v.description,v.candidate,v.ready].filter(x=>x!==undefined).length!==1) throw new AppError(400,'invalid_call_signal');
  if (v.ready !== undefined) { if(v.ready!==true)throw new AppError(400,'invalid_call_signal'); result.ready=true; }
  if (v.description !== undefined) {
    const d=record(v.description,['type','sdp']);
    if(d.type!=='offer'&&d.type!=='answer')throw new AppError(400,'invalid_call_signal');
    result.description={type:d.type,sdp:text(d.sdp,32768)};
  }
  if(v.candidate!==undefined) {
    const c=record(v.candidate,['candidate','sdpMid','sdpMLineIndex','usernameFragment']);
    if(typeof c.candidate!=='string'||c.candidate.length>2048||c.candidate.includes('\0'))throw new AppError(400,'invalid_call_signal');
    for(const key of ['sdpMid','usernameFragment'])if(c[key]!=null&&(typeof c[key]!=='string'||(c[key] as string).length>256))throw new AppError(400,'invalid_call_signal');
    if(c.sdpMLineIndex!=null&&(!Number.isInteger(c.sdpMLineIndex)||Number(c.sdpMLineIndex)<0||Number(c.sdpMLineIndex)>32))throw new AppError(400,'invalid_call_signal');
    result.candidate={candidate:c.candidate,sdpMid:c.sdpMid as string??null,sdpMLineIndex:c.sdpMLineIndex as number??null,usernameFragment:c.usernameFragment as string??null};
  }
  return result;
}
