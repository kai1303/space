import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OfficeAgent } from './OfficeAgent.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('keeps the reviewed draft when edit access is lost before apply', async () => {
  const ask = vi.fn().mockResolvedValue({ message: 'Draft ready.', replacement: 'Revised passage' });
  const checkEditAccess = vi.fn().mockRejectedValue(new Error('Editing access changed.'));
  vi.stubGlobal('spaceOffice', { ask, checkEditAccess });
  vi.stubGlobal('CSS', { escape: (value: string) => value });
  const { container } = render(<>
    <div data-office-editor="editor"><iframe title="Editor" /></div>
    <OfficeAgent title="Notes.odt" editorId="editor" sessionKey="doc-key" serverUrl="https://office.example" />
  </>);
  const port = {
    onmessage: (_event: {data: unknown}) => {},
    postMessage: vi.fn(({id}: {id: string}) => port.onmessage({data: {id, status: 'selected', text: 'Original passage'}})),
    close: vi.fn(),
  };
  fireEvent(window, new MessageEvent('message', {
    origin: 'https://office.example', data: {type:'space-office-selection-ready'},
    source: {parent: container.querySelector('iframe')!.contentWindow} as Window,
    ports: [port as unknown as MessagePort],
  }));
  fireEvent.click(screen.getByRole('button', {name:'Ask Space AI'}));
  fireEvent.change(screen.getByRole('textbox', {name:'Ask Space AI about the selection'}), {target:{value:'Rewrite'}});
  fireEvent.click(screen.getByRole('button', {name:'Send'}));
  const apply = await screen.findByRole('button', {name:'Apply edit'});
  expect(checkEditAccess).not.toHaveBeenCalled();
  expect(port.postMessage).toHaveBeenCalledTimes(1);
  fireEvent.click(apply);
  await screen.findByText(/Could not verify editing access/);
  expect(checkEditAccess).toHaveBeenCalledWith('doc-key');
  expect(port.postMessage).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Revised passage')).toBeTruthy();
  expect(screen.queryByRole('button', {name:'Apply edit'})).toBeNull();
});
