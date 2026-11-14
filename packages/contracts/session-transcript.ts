import { shellExecution, type ShellExecution } from './shell-execution.js';
import { AppError, record, text } from './validation.js';

export interface TranscriptItem {
  shell?: ShellExecution;
  position: number;
  kind: 'tool' | 'message';
  id: string;
  name: string;
  status?: 'completed' | 'interrupted';
}
export interface TranscriptChunk extends TranscriptItem {
  part: number;
  last: boolean;
  data: string;
}

export function parseTranscriptChunk(value: unknown): TranscriptChunk {
  const v = record(value, ['position','kind','id','name','part','last','data','status','shell']);
  if (![v.position,v.part].every(n => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 2147483647)
      || (v.status !== undefined && v.status !== 'completed' && v.status !== 'interrupted')
      || (v.kind !== 'tool' && v.kind !== 'message') || typeof v.last !== 'boolean'
      || typeof v.data !== 'string' || !v.data.length || v.data.length > 12000 || v.data.includes('\0'))
    throw new AppError(400,'invalid_transcript_chunk');
  return {...(v.shell && v.name==='shell' ? {shell:shellExecution(v.shell)} : {}),...(v.status==='completed' || v.status==='interrupted'?{status:v.status}:{}),position:Number(v.position), part:Number(v.part), kind:v.kind, id:text(v.id,128), name:text(v.name,200), last:v.last, data:v.data};
}
