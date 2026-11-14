import { afterEach, it, expect, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentSessionSummary } from '@space/contracts';
import { SessionAgentHandoff } from './SessionAgentHandoff.js';
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it('shows the chosen agent owner and only shares the request and edited excerpt',async()=>{
 const id='91359f39-ee06-44f9-b829-ad751dac1999';
 const fetch=vi.fn(async(path:string)=>({ok:true,json:async()=>path.endsWith('navigator')?{
   candidates:[{installation_id:'self',name:'Current',skill:'a',persistent_sessions:true},{installation_id:'helper',name:'Helper',skill:'b',persistent_sessions:true}]}:
   path.includes('profiles/agent')?{kind:'agent',owner_name:'Sam'}:{id}}));
 vi.stubGlobal('fetch',fetch);
 const user=userEvent.setup(),refresh=vi.fn();
 render(<SessionAgentHandoff session={{id:'parent',installation_id:'self',workspace_id:'w'} as AgentSessionSummary} viewer="me" channel="ch"
   related={[]} turns={[]} writable refresh={refresh}/>);
 await user.click(screen.getByRole('button',{name:'Ask another agent'}));
 await user.click(await screen.findByRole('combobox',{name:'Agent'}));
 await screen.findByRole('option',{name:'Helper · b'});
 expect(screen.queryByRole('option',{name:'Current · a'})).toBeNull();
 await user.click(screen.getByRole('option',{name:'Helper · b'}));
 await screen.findByText('Agent owner · Sam');
 await user.type(screen.getByLabelText('Request'),'Review storage');
 await user.type(screen.getByLabelText('Context to share'),'Only this excerpt');
 await user.click(screen.getByRole('button',{name:'Start linked session'}));
 const link=await screen.findByRole('link',{name:'Open helper session'});
 expect(link.getAttribute('href')).toBeTruthy();
 const call=vi.mocked(globalThis.fetch).mock.calls.find(([path])=>String(path).endsWith('/team/helpers'))!;
 expect(JSON.parse(String(call[1]?.body))).toEqual({installation_id:'helper',skill:'b',prompt:'Review storage',context:'Only this excerpt'});
 expect(refresh).toHaveBeenCalledOnce();
});

it('retries an owner lookup without losing the request or context',async()=>{
 let attempts=0;
 vi.stubGlobal('fetch',vi.fn(async(path:string)=>{
   if(path.endsWith('navigator'))return Response.json({candidates:[{installation_id:'helper',name:'Helper',skill:'review',persistent_sessions:true}]});
   return ++attempts===1 ? Response.json({error:'unavailable'},{status:503}) : Response.json({kind:'agent',owner_name:'Sam'});
 }));
 render(<SessionAgentHandoff session={{id:'s',workspace_id:'w',installation_id:'self'} as AgentSessionSummary}
   channel="c" viewer="v" writable turns={[]} related={[]} refresh={async()=>{}}/>);
 await userEvent.click(screen.getByRole('button',{name:'Ask another agent'}));
 await userEvent.click(screen.getByRole('combobox',{name:'Agent'}));
 await userEvent.click(await screen.findByRole('option',{name:'Helper · review'}));
 await userEvent.type(screen.getByLabelText('Request'),'Review the draft');
 await userEvent.type(screen.getByLabelText('Context to share'),'Design notes');
 expect(screen.getByRole('button',{name:'Start linked session'})).toHaveProperty('disabled',true);
 await userEvent.click(screen.getByRole('button',{name:'Retry owner'}));
 await screen.findByText('Agent owner · Sam');
 expect(screen.getByLabelText('Request')).toHaveProperty('value','Review the draft');
 expect(screen.getByLabelText('Context to share')).toHaveProperty('value','Design notes');
 expect(screen.getByRole('button',{name:'Start linked session'})).toHaveProperty('disabled',false);
});
