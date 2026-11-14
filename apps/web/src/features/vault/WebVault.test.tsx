import {webcrypto} from 'node:crypto';
import {CompactEncrypt, compactDecrypt, exportSPKI, generateKeyPair, importSPKI} from 'jose';
import {beforeEach, afterEach, expect, it, vi} from 'vitest';
import {cleanup, render, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {WebVault} from './WebVault.js';
import {request} from '../../shared/api/request.js';

vi.mock('../../shared/api/request.js', () => ({request: vi.fn()}));
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Uint8Array', Object.getPrototypeOf(Buffer));
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
function encryptedResponse(body:unknown, cursor?:string) {
  return async (_path:string, input?:object) => {
    const key = await importSPKI((input as {publicKey:string}).publicKey, 'ECDH-ES');
    const sealed = await new CompactEncrypt(new TextEncoder().encode(JSON.stringify(body)))
      .setProtectedHeader({alg:'ECDH-ES', enc:'A256GCM'}).encrypt(key);
    return {status:'encrypted', sealed, cursor};
  };
}
const mac = {id:'mac', name:'Kai Mac Codex', online:true};
const item = {id:'027c0d36-1347-4ee4-953c-974bfd5ac101',version:'027c0d36-1347-4ee4-953c-974bfd5ac102',title:'Linear', kind:'token', site:'https://linear.app'};

it('unlocks the only Mac on demand, lists every page, filters, and locks again', async () => {
  vi.mocked(request).mockResolvedValueOnce([mac])
    .mockImplementationOnce(encryptedResponse({status:'listed',items:[item],more:true,cursor:'next'}, 'next'))
    .mockImplementationOnce(encryptedResponse({status:'listed',items:[{...item,id:'other',title:'GitHub',kind:'login',site:'https://github.com'}],more:false}));
  render(<WebVault actor="kai"/>);
  const unlock = await screen.findByRole('button', {name:'Unlock Vault'});
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(request).toHaveBeenCalledTimes(1);
  await userEvent.click(unlock);
  expect(await screen.findByText('GitHub')).toBeTruthy();
  expect(screen.getByText('linear.app')).toBeTruthy();
  expect(request).toHaveBeenLastCalledWith('/me/vault/macs/mac/request', {action:'list-items',publicKey:expect.any(String),cursor:'next'}, undefined, 'POST', expect.any(AbortSignal), 'kai');
  await userEvent.click(screen.getByRole('tab', {name:'API tokens (1)'}));
  expect(screen.queryByText('GitHub')).toBeNull();
  await userEvent.click(screen.getByRole('button', {name:'Lock Vault'}));
  expect(screen.queryByText('Linear')).toBeNull();
  expect(screen.getByRole('button', {name:'Unlock Vault'})).toBeTruthy();
  expect(screen.queryByRole('button', {name:'Add item'})).toBeNull();
});

it('targets the selected Mac, stays locked on cancellation, and clears the list on switch', async () => {
  vi.mocked(request).mockResolvedValueOnce([mac,{...mac,id:'b',name:'Other Mac'}])
    .mockResolvedValueOnce({status:'cancelled'}).mockImplementationOnce(encryptedResponse({status:'listed',items:[item],more:false}));
  render(<WebVault actor="kai"/>);
  const picker = await screen.findByRole('combobox', {name:'Paired Mac'});
  await userEvent.click(picker);
  await userEvent.click(screen.getByRole('option', {name:'Other Mac'}));
  await userEvent.click(screen.getByRole('button', {name:'Unlock Vault'}));
  expect(await screen.findByText('The request was cancelled on your Mac.')).toBeTruthy();
  expect(request).toHaveBeenLastCalledWith('/me/vault/macs/b/request', {action:'list-items',publicKey:expect.any(String)}, undefined, 'POST', expect.any(AbortSignal), 'kai');
  expect(screen.queryByRole('region', {name:'Vault items'})).toBeNull();
  expect(screen.queryByRole('button', {name:'Add item'})).toBeNull();
  await userEvent.click(screen.getByRole('button', {name:'Unlock Vault'}));
  await screen.findByText('Linear');
  await userEvent.click(picker);
  await userEvent.click(screen.getByRole('option', {name:mac.name}));
  expect(screen.queryByText('Linear')).toBeNull();
  expect(screen.getByRole('button', {name:'Unlock Vault'})).toBeTruthy();
  expect(screen.queryByRole('button', {name:'Add item'})).toBeNull();
});

it('offers recovery for a single offline Mac without a picker', async () => {
  vi.mocked(request).mockResolvedValueOnce([{...mac,online:false}]).mockResolvedValueOnce([mac]);
  render(<WebVault actor="kai"/>);
  expect(await screen.findByText(/Kai Mac Codex is offline/)).toBeTruthy();
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('button', {name:'Unlock Vault'})).toBeNull();
  await userEvent.click(screen.getByRole('button', {name:'Refresh Macs'}));
  expect(await screen.findByRole('button', {name:'Unlock Vault'})).toBeTruthy();
});

it('shows the same unlocked controls and items on web and desktop', async () => {
  const result = {status:'listed', items:[item], more:false};
  const renderList = async () => {
    vi.mocked(request).mockResolvedValueOnce([mac]).mockImplementationOnce(encryptedResponse(result));
    const view = render(<WebVault actor="kai"/>);
    await screen.findByText(mac.name);
    await userEvent.click(await screen.findByRole('button', {name:'Unlock Vault'}));
    await screen.findByText('Linear');
    expect(screen.getByRole('button', {name:'Add item'})).toBeTruthy();
    const labels = Array.from(view.container.querySelectorAll('h1, button, input, li'), element =>
      element.getAttribute('aria-label') ?? element.textContent);
    view.unmount();
    return labels;
  };
  const browser = await renderList();
  vi.stubGlobal('spaceDesktop', {listVaultItems: vi.fn()});
  try { expect(await renderList()).toEqual(browser); }
  finally { vi.unstubAllGlobals(); }
});

it('lets desktop select a second paired Mac and use its Vault', async () => {
  vi.stubGlobal('spaceDesktop', {listVaultItems: vi.fn()});
  try {
    vi.mocked(request).mockResolvedValueOnce([mac,{...mac,id:'other',name:'Other Mac'}])
      .mockImplementationOnce(encryptedResponse({status:'listed',items:[item],more:false}));
    render(<WebVault actor="kai"/>);
    await userEvent.click(await screen.findByRole('combobox', {name:'Paired Mac'}));
    await userEvent.click(screen.getByRole('option', {name:'Other Mac'}));
    await userEvent.click(screen.getByRole('button', {name:'Unlock Vault'}));
    await screen.findByText('Linear');
    expect(request).toHaveBeenLastCalledWith('/me/vault/macs/other/request', {action:'list-items',publicKey:expect.any(String)}, undefined, 'POST', expect.any(AbortSignal), 'kai');
  } finally { vi.unstubAllGlobals(); }
});

it('opens the local Keychain on desktop when no Macs are paired', async () => {
  const listVaultItems = vi.fn().mockResolvedValue({status:'listed',items:[item],more:false});
  vi.stubGlobal('spaceDesktop', {listVaultItems, vaultItemRequest:listVaultItems});
  try {
    vi.mocked(request).mockResolvedValueOnce([]);
    render(<WebVault actor="kai"/>);
    await userEvent.click(await screen.findByRole('button', {name:'Unlock Vault'}));
    await screen.findByText('Linear');
    expect(listVaultItems).toHaveBeenCalledWith('kai', undefined);
  } finally { vi.unstubAllGlobals(); }
});

it('creates a token after unlock and opens its details without exposing the secret to the relay', async () => {
  const {publicKey, privateKey} = await generateKeyPair('ECDH-ES', {crv:'P-256'});
  const transfer = '27cf1505-4792-47cd-8da6-bb9936515ebe';
  let received;
  vi.mocked(request).mockResolvedValueOnce([mac])
    .mockImplementationOnce(encryptedResponse({status:'listed', items:[], more:false}))
    .mockResolvedValueOnce({status:'ready', transfer, publicKey:await exportSPKI(publicKey)})
    .mockImplementationOnce(async (path, body) => {
      expect(JSON.stringify(body)).not.toContain('fixture-only');
      const {plaintext} = await compactDecrypt((body as {sealed:string}).sealed, privateKey);
      const payload = JSON.parse(new TextDecoder().decode(plaintext));
      received = payload.change;
      return encryptedResponse({status:'saved',item})(path,payload);
    });
  render(<WebVault actor="kai"/>);
  const unlock = await screen.findByRole('button', {name:'Unlock Vault'});
  expect(screen.queryByRole('button', {name:'Add item'})).toBeNull();
  await userEvent.click(unlock);
  await userEvent.click(await screen.findByRole('button', {name:'Add item'}));
  await userEvent.click(screen.getByRole('button', {name:'API token'}));
  await userEvent.click(screen.getByRole('button', {name:'Use Linear settings'}));
  await userEvent.type(screen.getByLabelText('API token'), 'fixture-only');
  await userEvent.click(screen.getByRole('button', {name:'Save'}));
  await screen.findByRole('heading', {name:'Linear'});
  expect(received).toMatchObject({operation:'create',kind:'token',title:'Linear',site:item.site,endpoint:'https://mcp.linear.app/mcp',secret:'fixture-only'});
});

it('edits a selected login and removes it only after confirming deletion on the Mac', async () => {
  const login = {...item, title:'Work', kind:'login', username:'tester'};
  const updated = {...login,title:'Personal',version:'changed'};
  const local = vi.fn().mockResolvedValueOnce({status:'listed',items:[login],more:false})
    .mockResolvedValueOnce({status:'saved',item:updated}).mockResolvedValueOnce({status:'cancelled'}).mockResolvedValueOnce({status:'deleted'});
  vi.stubGlobal('spaceDesktop',{listVaultItems:vi.fn(), vaultItemRequest:local});
  vi.mocked(request).mockResolvedValueOnce([]);
  render(<WebVault actor="kai"/>);
  const click = async (name:string | RegExp) => userEvent.click(await screen.findByRole('button',{name}));
  await click('Unlock Vault'); await click(/Work/); await click('Edit');
  await userEvent.clear(screen.getByLabelText('Title')); await userEvent.type(screen.getByLabelText('Title'),'Personal');
  await click('Save'); await screen.findByRole('heading',{name:'Personal'});
  expect(local.mock.calls[1][1]).toMatchObject({operation:'edit',id:login.id,version:login.version,username:'tester',secret:''});
  await click('Delete…'); await click('Cancel'); expect(local).toHaveBeenCalledTimes(2);
  await click('Delete…'); await click('Delete item'); await screen.findByText('The request was cancelled on your Mac.');
  await click('Delete item'); await screen.findByText('Your Vault is empty');
  expect(local.mock.calls[3][1]).toMatchObject({operation:'delete',id:login.id,version:updated.version});
});
