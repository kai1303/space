import {afterEach, beforeAll, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {WebVault} from './WebVault.js';
import {request} from '../../shared/api/request.js';

vi.mock('../../shared/api/request.js', () => ({request: vi.fn()}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const mac = {id:'mac', name:'Kai Mac Codex', online:true};
const item = {title:'Linear', kind:'token', site:'https://linear.app'};

it('unlocks the only Mac on demand, lists every page, filters, and locks again', async () => {
  vi.mocked(request).mockResolvedValueOnce([mac])
    .mockResolvedValueOnce({status:'listed',items:[item],more:true,cursor:'next'})
    .mockResolvedValueOnce({status:'listed',items:[{title:'GitHub',kind:'login',site:'https://github.com'}],more:false});
  render(<WebVault actor="kai" close={() => {}}/>);
  const unlock = await screen.findByRole('button', {name:'Unlock Vault'});
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  await userEvent.click(unlock);
  expect(await screen.findByText('GitHub')).toBeTruthy();
  expect(screen.getByText('linear.app')).toBeTruthy();
  expect(request).toHaveBeenLastCalledWith('/me/vault/macs/mac/request', {action:'list',cursor:'next'}, undefined, 'POST', expect.any(AbortSignal), 'kai');
  await userEvent.click(screen.getByRole('tab', {name:'API tokens (1)'}));
  expect(screen.queryByText('GitHub')).toBeNull();
  await userEvent.click(screen.getByRole('button', {name:'Lock Vault'}));
  expect(screen.queryByText('Linear')).toBeNull();
  expect(screen.getByRole('button', {name:'Unlock Vault'})).toBeTruthy();
});

it('targets the selected Mac, stays locked on cancellation, and clears the list on switch', async () => {
  vi.mocked(request).mockResolvedValueOnce([mac,{...mac,id:'b',name:'Other Mac'}])
    .mockResolvedValueOnce({status:'cancelled'}).mockResolvedValueOnce({status:'listed',items:[item],more:false});
  render(<WebVault actor="kai" close={() => {}}/>);
  const picker = await screen.findByRole('combobox', {name:'Paired Mac'});
  await userEvent.click(picker);
  await userEvent.click(screen.getByRole('option', {name:'Other Mac'}));
  await userEvent.click(screen.getByRole('button', {name:'Unlock Vault'}));
  expect(await screen.findByText('The request was cancelled on your Mac.')).toBeTruthy();
  expect(request).toHaveBeenLastCalledWith('/me/vault/macs/b/request', {action:'list'}, undefined, 'POST', expect.any(AbortSignal), 'kai');
  expect(screen.queryByRole('region', {name:'Vault items'})).toBeNull();
  await userEvent.click(screen.getByRole('button', {name:'Unlock Vault'}));
  await screen.findByText('Linear');
  await userEvent.click(picker);
  await userEvent.click(screen.getByRole('option', {name:mac.name}));
  expect(screen.queryByText('Linear')).toBeNull();
  expect(screen.getByRole('button', {name:'Unlock Vault'})).toBeTruthy();
});

it('offers recovery for a single offline Mac without a picker', async () => {
  vi.mocked(request).mockResolvedValueOnce([{...mac,online:false}]).mockResolvedValueOnce([mac]);
  render(<WebVault actor="kai" close={() => {}}/>);
  expect(await screen.findByText(/Kai Mac Codex is offline/)).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', {name:'Unlock Vault'})).toBeNull();
  await userEvent.click(screen.getByRole('button', {name:'Refresh Macs'}));
  expect(await screen.findByRole('button', {name:'Unlock Vault'})).toBeTruthy();
});
