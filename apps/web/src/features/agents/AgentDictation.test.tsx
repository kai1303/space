import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {AgentDictation} from './AgentDictation.js';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});

function setup(getUserMedia:()=>Promise<unknown>) {
  vi.stubGlobal('navigator',Object.assign(Object.create(navigator),{mediaDevices:{getUserMedia}}));
  vi.stubGlobal('MediaRecorder', class {
    state='inactive';
    start(){this.state='recording';}
    stop(){this.state='inactive';}
  });
  vi.stubGlobal('OfflineAudioContext',class {});
  const insert=vi.fn(), busy=vi.fn();
  const view=render(<div><AgentDictation insert={insert} disabled={false} onBusy={busy}/></div>);
  fireEvent.click(screen.getByRole('button',{name:'Dictate'}));
  return {...view,insert,busy};
}

it('discards a late microphone grant after cancellation', async()=>{
  let accept!:(value:unknown)=>void;
  const permission=new Promise(resolve=>{accept=resolve;});
  const {insert,busy}=setup(()=>permission);
  fireEvent.click(screen.getByRole('button',{name:'Cancel dictation'}));
  const stop=vi.fn();
  await act(async()=>accept({getTracks:()=>[{stop}]}));
  expect(stop).toHaveBeenCalledOnce();expect(insert).not.toHaveBeenCalled();expect(busy).toHaveBeenLastCalledWith(false);
});

it('releases the microphone when the session becomes hidden', async()=>{
  const stop=vi.fn();
  const {container,insert}=setup(async()=>({getTracks:()=>[{stop}]}));
  await screen.findByRole('button',{name:'Finish dictation'});
  await act(async()=>{container.hidden=true;});
  expect(stop).toHaveBeenCalledOnce();expect(insert).not.toHaveBeenCalled();
});

it('allows retry after microphone permission is denied',async()=>{
  const stop=vi.fn();
  const grant=vi.fn().mockRejectedValueOnce(new DOMException('Denied','NotAllowedError')).mockResolvedValueOnce({getTracks:()=>[{stop}]});
  const {insert}=setup(grant);
  expect((await screen.findByRole('alert')).textContent).toMatch(/access was denied/i);
  fireEvent.click(screen.getByRole('button',{name:'Retry'}));
  await screen.findByRole('button',{name:'Finish dictation'});
  fireEvent.click(screen.getByRole('button',{name:'Cancel dictation'}));
  expect(stop).toHaveBeenCalledOnce();expect(insert).not.toHaveBeenCalled();
});

it('terminates transcription and ignores a result arriving after Cancel', async()=>{
  const stop=vi.fn(),transcribe=vi.fn(),terminate=vi.fn();
  const {insert}=setup(async()=>({getTracks:()=>[{stop}]}));
  let recorder!: {ondataavailable:(event:{data:Blob})=>void;onstop:()=>void};
  vi.stubGlobal('MediaRecorder',class {
    constructor(){recorder=this;}
    state='inactive';mimeType='audio/webm';ondataavailable=(_event:{data:Blob})=>{};onstop=()=>{};
    start(){this.state='recording';}
    stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['audio'])});this.onstop?.();}
  });
  vi.stubGlobal('Blob',globalThis.Blob.prototype.arrayBuffer ? globalThis.Blob : class extends Blob {async arrayBuffer(){return new ArrayBuffer(4);}});
  vi.stubGlobal('OfflineAudioContext',class {async decodeAudioData(){return {getChannelData:()=>new Float32Array(5000).fill(.1)};}});
  let worker!: {onmessage:(event:{data:{phase:string;text:string}})=>void};
  vi.stubGlobal('Worker',class {
    constructor(){worker=this;}
    onmessage=(_e:{data:{phase:string;text:string}})=>{};terminate=terminate;postMessage=transcribe;
  });
  await screen.findByRole('button',{name:'Finish dictation'});
  expect(recorder).toBeTruthy();
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Finish dictation'})));
  expect(stop).toHaveBeenCalledOnce();expect(transcribe).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button',{name:'Cancel dictation'}));
  act(()=>worker.onmessage({data:{phase:'done',text:'late words'}}));
  expect(terminate).toHaveBeenCalledOnce();expect(insert).not.toHaveBeenCalled();
});
