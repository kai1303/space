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
