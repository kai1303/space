import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspaceAdministration } from './WorkspaceAdministration.js';
const api = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./chat-client.js', () => api);
vi.mock('./WorkspaceMembers.js', () => ({ WorkspaceMembers: () => <div>Agent connections</div> }));
vi.mock('./live-updates.js', () => ({ subscribeUpdates: (_scope: string, _id: string, refresh: () => unknown) => { void refresh(); return () => {}; } }));
beforeAll(() => { HTMLDialogElement.prototype.showModal = function () { this.open = true; }; HTMLDialogElement.prototype.close = function () { this.open = false; }; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const member = { user_id: 'anna', display_name: 'Anna', email: 'anna@example.test', role: 'member', active: true, joined_at: '2026-01-01T00:00:00Z' };
const props = { workspace: 'workspace', viewer: 'kai', open: true, onClose: vi.fn() };
function mock(role = 'owner', active = true) {
 api.request.mockImplementation(async (path: string) => path.includes('/directory') ? { items: [{...member, active}], next_cursor: null, role } : { name: 'Space', role });
}
it('confirms role changes before submitting and refreshes the member table', async () => {
 mock(); render(<WorkspaceAdministration {...props}/>);
 await screen.findByText('Anna');
 await userEvent.click(screen.getByRole('button', {name: 'Actions for Anna'}));
 await userEvent.click(screen.getByRole('menuitem', {name: 'Change account type'}));
 await userEvent.selectOptions(screen.getByRole('combobox',{name:'Account type',exact:true}), 'admin');
 expect(api.request.mock.calls.some(call => call[3] === 'PATCH')).toBe(false);
 await userEvent.click(screen.getByRole('button', {name: 'Save account type'}));
 await waitFor(() => expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/members/anna', {role:'admin'}, undefined, 'PATCH'));
});
it('hides management actions for members and filters through the bounded directory API', async () => {
 mock('member'); render(<WorkspaceAdministration {...props}/>); await screen.findByText('Anna');
 expect(screen.queryByRole('button',{name:'Add people'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Actions for Anna'})).toBeNull();
 await userEvent.type(screen.getByRole('searchbox'), 'Anna');
 await waitFor(() => expect(api.request.mock.calls.some(call => call[0].includes('q=Anna'))).toBe(true));
});
it('reactivates an inactive person as a regular member only after confirmation', async () => {
 mock('owner',false); render(<WorkspaceAdministration {...props}/>); await screen.findByText('Anna');
 await userEvent.click(screen.getByRole('button',{name:'Actions for Anna'}));
 await userEvent.click(screen.getByRole('menuitem',{name:'Reactivate account'}));
 expect(api.request.mock.calls.some(call => call[1]?.user_id)).toBe(false);
 await userEvent.click(screen.getByRole('button',{name:'Reactivate'}));
 await waitFor(() => expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/members',{user_id:'anna',role:'member'}));
});

it('explains failed deactivation without closing its confirmation',async()=>{
 mock();render(<WorkspaceAdministration {...props}/>);await screen.findByText('Anna');
 await userEvent.click(screen.getByRole('button',{name:'Actions for Anna'}));await userEvent.click(screen.getByRole('menuitem',{name:'Deactivate account'}));
 api.request.mockImplementation(async (path:string,_body:unknown,_key:unknown,method:string)=>{if(method==='DELETE')throw new Error('last_owner');return {items:[member],next_cursor:null,role:'owner'};});
 await userEvent.click(screen.getByRole('button',{name:'Deactivate',exact:true}));
 await waitFor(()=>expect(screen.getAllByRole('alert').some(item=>item.textContent?.includes('must have an owner'))).toBe(true));
 expect(screen.getByRole('button',{name:'Cancel',exact:true})).toBeTruthy();
});
it('adds an existing Space account by email without claiming an invitation was sent',async()=>{
 mock();render(<WorkspaceAdministration {...props}/>);await screen.findByText('Anna');
 await userEvent.click(screen.getByRole('button',{name:'Add people'}));await userEvent.type(screen.getByRole('textbox',{name:'Email address'}),'new@example.test');
 await userEvent.click(screen.getByRole('button',{name:'Add person',exact:true}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/members',{email:'new@example.test',role:'member'}));
 expect(await screen.findByText('Person added to the workspace.')).toBeTruthy();
});
it('does not let a late response from another workspace replace the current directory',async()=>{
 let resolveOld!:(value:unknown)=>void;
 api.request.mockImplementation((path:string)=>path.includes('/workspace/')?new Promise(resolve=>{resolveOld=resolve;}):Promise.resolve({items:[{...member,display_name:'New Workspace Person'}],role:'owner',next_cursor:null}));
 const view=render(<WorkspaceAdministration {...props}/>);view.rerender(<WorkspaceAdministration {...props} workspace="other"/>);
 await screen.findByText('New Workspace Person');resolveOld({items:[member],role:'owner',next_cursor:null});
 await waitFor(()=>expect(screen.queryByText('Anna')).toBeNull());
});
it('only the primary owner can transfer ownership and requires confirmation',async()=>{
 api.request.mockResolvedValue({items:[member,{...member,user_id:'kai',display_name:'Kai',role:'owner'}],next_cursor:null,role:'owner',primary_owner_id:'kai'});
 render(<WorkspaceAdministration {...props}/>);await screen.findByText('Anna');
 expect(screen.queryByRole('button',{name:'Actions for Kai'})).toBeNull();
 await userEvent.click(screen.getByRole('button',{name:'Actions for Anna'}));await userEvent.click(screen.getByRole('menuitem',{name:'Transfer primary ownership'}));
 expect(api.request.mock.calls.some(call=>call[0].endsWith('/transfer-ownership'))).toBe(false);
 await userEvent.click(screen.getByRole('button',{name:'Cancel'}));
 expect(api.request.mock.calls.some(call=>call[0].endsWith('/transfer-ownership'))).toBe(false);
 await userEvent.click(screen.getByRole('button',{name:'Actions for Anna'}));await userEvent.click(screen.getByRole('menuitem',{name:'Transfer primary ownership'}));
 await userEvent.click(screen.getByRole('button',{name:'Transfer ownership',exact:true}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/workspace/transfer-ownership',{user_id:'anna'}));
});
it('applies sorting and guest filters through the directory API',async()=>{
 mock();render(<WorkspaceAdministration {...props}/>);await screen.findByText('Anna');
 await userEvent.selectOptions(screen.getByRole('combobox',{name:'Sort members'}),'joined');
 await userEvent.selectOptions(screen.getByRole('combobox',{name:'Filter guest access'}),'single');
 await waitFor(()=>expect(api.request.mock.calls.some(call=>call[0].includes('sort=joined')&&call[0].includes('guest=single'))).toBe(true));
});
