import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { workspacePreferenceDefaults } from '@space/contracts';
import { WorkspaceSettings } from './WorkspaceSettings.js';
const api=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../../shared/api/request.js',()=>api);
vi.mock('../../../shared/realtime/live-updates.js',()=>({subscribeUpdates:(_scope:string,_id:string,refresh:()=>unknown)=>{void refresh();return()=>{};}}));
beforeAll(()=>{HTMLDialogElement.prototype.showModal=function(){this.open=true;};HTMLDialogElement.prototype.close=function(){this.open=false;};});
afterEach(()=>{cleanup();vi.resetAllMocks();});
const settings={...workspacePreferenceDefaults,workspace_id:'space',name:'Design',role:'owner',created_at:'2026-01-01T00:00:00.000Z'};
function setup(role='owner') {
 api.request.mockImplementation(async(_path:string,body?:object)=>({...settings,role,...body}));
}
it('requires confirmation for finite retention and cancellation keeps the unsaved settings',async()=>{
 setup();render(<WorkspaceSettings workspace="space" open onClose={()=>{}} onRenamed={()=>{}}/>);
 await userEvent.click(await screen.findByLabelText('Keep messages')); await userEvent.click(await screen.findByRole('option', { name: 'For a set number of days', exact: true }));
 await userEvent.type(screen.getByLabelText('Workspace description'),'Unsaved');
 api.request.mockClear();
 await userEvent.click(screen.getByRole('button',{name:'Save settings'}));
 expect(screen.getByRole('dialog',{name:'Apply retention policy?'})).toBeTruthy();
 expect(screen.getByText(/Deleted content and files cannot be recovered/)).toBeTruthy();
 expect(api.request).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'Cancel'}));
 expect(screen.queryByRole('dialog',{name:'Apply retention policy?'})).toBeNull();
 expect(screen.getByLabelText('Retention days')).toHaveProperty('value','90');
 expect(screen.getByLabelText('Workspace description')).toHaveProperty('value','Unsaved');
 expect(api.request).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'Save settings'}));
 await userEvent.click(screen.getByRole('button',{name:'Apply retention policy'}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/space/settings',expect.objectContaining({revision:'0',retention_days:90,description:'Unsaved'}),undefined,'PATCH'));
});
it('confirms a shorter existing retention period while preserving the loaded revision',async()=>{
 setup();api.request.mockResolvedValueOnce({...settings,revision:'7',retention_days:180});
 render(<WorkspaceSettings workspace="space" open onClose={()=>{}} onRenamed={()=>{}}/>);
 await userEvent.clear(await screen.findByLabelText('Retention days'));await userEvent.type(screen.getByLabelText('Retention days'),'30');
 api.request.mockClear();await userEvent.click(screen.getByRole('button',{name:'Save settings'}));
 expect(api.request).not.toHaveBeenCalled();
 await userEvent.click(screen.getByRole('button',{name:'Apply retention policy'}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/space/settings',expect.objectContaining({revision:'7',retention_days:30}),undefined,'PATCH'));
});
it('saves a longer retention period without a destructive confirmation',async()=>{
 setup();api.request.mockResolvedValueOnce({...settings,revision:'8',retention_days:30});
 render(<WorkspaceSettings workspace="space" open onClose={()=>{}} onRenamed={()=>{}}/>);
 await userEvent.click(await screen.findByLabelText('Keep messages')); await userEvent.click(await screen.findByRole('option', { name: 'Forever', exact: true }));
 await userEvent.click(screen.getByRole('button',{name:'Save settings'}));
 expect(screen.queryByRole('dialog',{name:'Apply retention policy?'})).toBeNull();
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/space/settings',expect.objectContaining({revision:'8',retention_days:null}),undefined,'PATCH'));
});
it('expands the name editor, saves without closing settings, and explains permissions',async()=>{
 setup();const renamed=vi.fn(),close=vi.fn();
 render(<WorkspaceSettings workspace="space" open onClose={close} onRenamed={renamed}/>);
 await userEvent.click(await screen.findByRole('button',{name:'Edit workspace name'}));
 await userEvent.clear(screen.getByLabelText('Workspace name'));await userEvent.type(screen.getByLabelText('Workspace name'),'Engineering');
 await userEvent.click(screen.getByRole('button',{name:'Save changes'}));
 await waitFor(()=>expect(renamed).toHaveBeenCalledWith('Engineering'));expect(close).not.toHaveBeenCalled();
 expect(api.request).toHaveBeenCalledWith('/workspaces/space/settings',{revision:'0',name:'Engineering'},undefined,'PATCH');
 await userEvent.click(screen.getByRole('tab',{name:'Permissions'}));expect(screen.getByText('Workspace Owners')).toBeTruthy();
});
it('makes settings readable but not editable to ordinary members',async()=>{
 setup('member');render(<WorkspaceSettings workspace="space" open onClose={()=>{}} onRenamed={()=>{}}/>);
 await screen.findByText('Design');expect(screen.queryByRole('button',{name:'Edit workspace name'})).toBeNull();
 expect(screen.getByLabelText('Workspace description').closest('fieldset')?.disabled).toBe(true);
 expect(screen.queryByRole('button',{name:'Save settings'})).toBeNull();
});
it('persists settings across tabs',async()=>{
 setup();render(<WorkspaceSettings workspace="space" open onClose={()=>{}} onRenamed={()=>{}}/>);
 await userEvent.type(await screen.findByLabelText('Workspace description'),'Design together');
 expect(screen.queryByRole('heading',{name:'Default channels'})).toBeNull();
 await userEvent.click(screen.getByRole('tab',{name:'Permissions'}));
 await userEvent.click(screen.getByLabelText('Who can invite people?')); await userEvent.click(await screen.findByRole('option', { name: 'All members', exact: true }));
 await userEvent.type(screen.getByLabelText('Domains allowed to join'),'example.com, company.org');
 await userEvent.click(screen.getByRole('button',{name:'Save settings'}));
 await waitFor(()=>expect(api.request).toHaveBeenCalledWith('/workspaces/space/settings',expect.objectContaining({revision:'0',description:'Design together',invite_permission:'members',approved_email_domains:['example.com','company.org']}),undefined,'PATCH'));
 expect(await screen.findByRole('status')).toHaveProperty('textContent','Workspace settings saved.');
});
it('keeps an unsaved edit when the server rejects a stale revision and allows reload',async()=>{
 setup();render(<WorkspaceSettings workspace="space" open onClose={()=>{}} onRenamed={()=>{}}/>);
 await userEvent.type(await screen.findByLabelText('Workspace description'),'My draft');
 api.request.mockRejectedValueOnce(new Error('settings_changed_reload'));
 await userEvent.click(screen.getByRole('button',{name:'Save settings'}));
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('settings changed reload'));
 expect(screen.getByLabelText('Workspace description')).toHaveProperty('value','My draft');
 await userEvent.click(screen.getByRole('button',{name:'Reload settings'}));
 await waitFor(()=>expect(screen.getByLabelText('Workspace description')).toHaveProperty('value',''));
});
it('sends only editable preference fields when the server includes membership and retention metadata',async()=>{
 setup();api.request.mockResolvedValueOnce({...settings,guest_type:'none',retention_version:'0',default_channel_ids:['general']});
 render(<WorkspaceSettings workspace="space" open onClose={()=>{}} onRenamed={()=>{}}/>);
 await userEvent.type(await screen.findByLabelText('Workspace description'),'Saved through the API');
 await userEvent.click(screen.getByRole('button',{name:'Save settings'}));
 const patch=api.request.mock.calls.find(call=>call[3]==='PATCH')?.[1];
 expect(patch).toBeTruthy();expect(patch).not.toHaveProperty('default_channel_ids');expect(patch).not.toHaveProperty('guest_type');expect(patch).not.toHaveProperty('retention_version');
 const {parseWorkspaceSettingsUpdate}=await import('@space/contracts');expect(()=>parseWorkspaceSettingsUpdate(patch)).not.toThrow();
});
