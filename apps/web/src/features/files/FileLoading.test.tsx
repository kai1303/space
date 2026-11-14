import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { AttachFileDialog, workspaceFileSource } from './AttachFileDialog.js';
import OfficePanel from './OfficePanel.js';

const editor = vi.hoisted(() => ({ ready: () => {} }));
vi.mock('@onlyoffice/document-editor-react', () => ({
  DocumentEditor: ({config}:{config:{events:{onDocumentReady:()=>void}}}) => {
    editor.ready = config.events.onDocumentReady;
    return null;
  },
}));
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function(){this.open=true;};
  HTMLDialogElement.prototype.close = function(){this.open=false;};
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['Attach a file','Office library'])('%s keeps the current page available during pagination and drops stale results on search', async view => {
  const first = {id:'one',filename:'One.docx',channel_name:'design',preview_kind:'office'};
  let finish!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(async (url:string) => {
    const params = new URL(url,'http://localhost').searchParams;
    if (params.has('after')) return new Promise<Response>(resolve=>{finish=resolve;});
    return Response.json(params.get('q') ? {items:[],next_cursor:null} : {items:[first],next_cursor:'two'});
  }));
  if (view === 'Office library') render(<OfficePanel library id="space"/>);
  else render(<AttachFileDialog source={workspaceFileSource('space')} remaining={1} onUpload={()=>{}} onClose={()=>{}} onInsert={()=>{}}/>);
  const rowRole = view === 'Office library' ? 'link' : 'radio';
  const row = await screen.findByRole(rowRole,{name:/One.docx/});
  await userEvent.click(screen.getByRole('button',{name:'Next page'}));
  expect(screen.getByRole('button',{name:'Next page'}).getAttribute('aria-busy')).toBe('true');
  expect(row.isConnected).toBe(true);
  expect(screen.queryByText('Loading files…')).toBeNull();
  if (rowRole === 'radio') {
    await userEvent.click(row);
    expect(screen.getByRole('button',{name:'Insert'})).toHaveProperty('disabled',false);
  }
  await userEvent.type(screen.getByRole('searchbox'),'absent');
  expect(screen.queryByRole(rowRole,{name:/One.docx/})).toBeNull();
  await act(async()=>finish(Response.json({items:[first],next_cursor:null})));
  await screen.findByText(/No matching.*files/i);
  expect(screen.queryByRole(rowRole,{name:/One.docx/})).toBeNull();
});

it('keeps download available until the Office editor signals that the document is ready', async () => {
  let finish!: (response:Response) => void;
  vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{finish=resolve;})));
  render(<OfficePanel library={false} id="doc"/>);
  expect(screen.getByText('Opening document…')).toBeTruthy();
  const download = screen.getByRole('link',{name:'Download'});
  await act(async()=>finish(Response.json({documentServerUrl:'https://office.example',config:{document:{title:'Brief.docx'}},canEdit:true,revision:0})));
  const viewer = screen.getByRole('region',{name:'Office document viewer'});
  expect(screen.getByText('Loading document content…')).toBeTruthy();
  expect(viewer.getAttribute('aria-busy')).toBe('true');
  expect(download.isConnected).toBe(true);
  act(()=>editor.ready());
  await waitFor(()=>expect(viewer.getAttribute('aria-busy')).toBe('false'));
  expect(screen.queryByText('Loading document content…')).toBeNull();
});

it('can switch to Upload during insertion without attaching a late file', async () => {
  const item = {id:'one',filename:'One.txt',channel_name:'design',preview_kind:'text' as const,uploader_name:'Alex',content_type:'text/plain',byte_size:4};
  let finish!: (file:File) => void;
  const onUpload = vi.fn(), onInsert = vi.fn();
  const read = vi.fn((_item:typeof item, _signal:AbortSignal)=>new Promise<File>(resolve=>{finish=resolve;}));
  render(<AttachFileDialog source={{search:async()=>({items:[item],next_cursor:null}),read}}
    remaining={1} onUpload={onUpload} onInsert={onInsert} onClose={()=>{}}/>);
  await userEvent.click(await screen.findByRole('radio',{name:'One.txt'}));
  await userEvent.click(screen.getByRole('button',{name:'Insert'}));
  expect(screen.getByRole('searchbox')).toHaveProperty('disabled',false);
  await userEvent.click(screen.getByRole('button',{name:'Upload'}));
  expect(onUpload).toHaveBeenCalledOnce();
  expect(read.mock.calls[0]![1].aborted).toBe(true);
  await act(async()=>finish(new File(['text'],'One.txt')));
  expect(onInsert).not.toHaveBeenCalled();
  expect(screen.getByRole('button',{name:'Insert'})).toHaveProperty('disabled',false);
});
