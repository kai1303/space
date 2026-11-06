import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {ToolApprovals} from './ToolApprovals.js';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const item={id:'approval',session_id:'session',task_id:'task',execution_id:'execution',kind:'command' as const,title:'Run tests',details:'pnpm test',status:'pending' as const,created_at:'2026-11-06T00:00:00Z',resolved_at:null};
it('only the computer owner can answer and an accepted answer refreshes session state',async()=>{
 const fetch=vi.fn(async()=>({ok:true,json:async()=>({id:'approval',status:'allow'})}));vi.stubGlobal('fetch',fetch);
 const refreshed=vi.fn();render(<ToolApprovals items={[item]} canDecide onResolved={refreshed}/>);
 expect(screen.getByText('pnpm test')).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Allow once'}));
 expect(fetch).toHaveBeenCalledWith('/v1/agent-sessions/session/tool-approvals/approval',expect.objectContaining({method:'POST',body:JSON.stringify({decision:'allow'})}));
 expect(refreshed).toHaveBeenCalledOnce();
});
it('participants see a waiting message and no permission buttons',()=>{
 render(<ToolApprovals items={[item]} canDecide={false} onResolved={()=>{}}/>);
 expect(screen.getByText(/Waiting for the computer owner/)).toBeTruthy();
 expect(screen.queryByRole('button')).toBeNull();
});
it('resolved requests cannot be approved again after remount',()=>{
 render(<ToolApprovals items={[{...item,status:'cancelled'}]} canDecide onResolved={()=>{}}/>);
 expect(screen.queryByRole('button')).toBeNull();
});
