import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceInvitations } from './WorkspaceInvitations.js';
const api=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../../shared/api/request.js',()=>api);
vi.mock('../../../shared/realtime/live-updates.js',()=>({subscribeUpdates:(_scope:string,_id:string,refresh:()=>unknown)=>{void refresh();return()=>{};}}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:vi.fn().mockResolvedValue(undefined)}});});
afterEach(()=>{cleanup();vi.clearAllMocks();});
const row={id:'invite',kind:'email',email:'new@example.test',role:'member',guest_type:'none',status:'pending',delivery_status:'unavailable',expires_at:'2030-01-01T00:00:00Z',use_count:0,use_limit:1};
function setup(role='owner'){
 api.request.mockImplementation(async(path:string,body:unknown)=>path.includes('/channels')?{items:[{id:'channel',name:'general',private:false}]}:body?{invitation:row,token:'a'.repeat(43)}:{items:[row],next_cursor:null,email_available:false,role});
 render(<WorkspaceInvitations workspace="workspace" onClose={()=>{}}/>);
}
it('shows delivery unavailable honestly and creates a default member invitation',async()=>{
 setup();await screen.findByText('new@example.test');expect(screen.getByText(/Email delivery is not configured/)).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Invite by email'}));await userEvent.type(screen.getByRole('textbox',{name:'Email address'}),'new@example.test');
 await userEvent.click(screen.getByRole('button',{name:'Create invitation'}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/invitations',expect.objectContaining({email:'new@example.test',role:'member',guest_type:'none',request_id:expect.any(String)})));
 expect(screen.queryByText('Invitation sent.')).toBeNull();
});
it('requires confirmation to revoke and does not offer admin or guest roles to regular members',async()=>{
 setup('member');await screen.findByText('new@example.test');await userEvent.click(screen.getByRole('button',{name:'Revoke',exact:true}));
 expect(api.request.mock.calls.some(call=>call[3]==='DELETE')).toBe(false);
 await userEvent.click(screen.getByRole('button',{name:'Revoke invitation',exact:true}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/invitations/invite',undefined,undefined,'DELETE'));
 await userEvent.click(screen.getByRole('button',{name:'Invite by email'}));expect(screen.queryByRole('option',{name:'Admin',exact:true})).toBeNull();expect(screen.queryByRole('option',{name:'Single-channel guest'})).toBeNull();
});
it('resends with an idempotency key and exposes the rotated link for copying',async()=>{
 setup();await screen.findByText('new@example.test');await userEvent.click(screen.getByRole('button',{name:'Resend',exact:true}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/invitations/invite/resend',{request_id:expect.any(String)}));
 expect(await screen.findByRole('textbox',{name:'Invitation URL for new@example.test'})).toHaveProperty('value',expect.stringContaining('invite='));
});
