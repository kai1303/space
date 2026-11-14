import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Select, Button, Dialog, ListRowSkeleton } from '@space/ui/primitives';
import { File, Files, FilePdf, ImageSquare, FileText, MusicNote, VideoCamera, MagnifyingGlass, UploadSimple } from '@phosphor-icons/react';
import type { HubFile, Page } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { sessionFetch } from '../../shared/api/session-fetch.js';
import { useFilePickerPage } from './useFilePickerPage.js';
import './attach-file-dialog.css';

export type PickerFile = Pick<HubFile,'id'|'filename'|'content_type'|'byte_size'|'channel_name'|'preview_kind'|'uploader_name'>;
export interface FilePickerSource {
  search: (query: URLSearchParams, signal: AbortSignal) => Promise<Page<PickerFile>>;
  read: (item: PickerFile, signal: AbortSignal) => Promise<globalThis.File>;
}

export function workspaceFileSource(workspace: string): FilePickerSource {
  return {
    search: (params,signal) => request(`/workspaces/${workspace}/hub/files?${params}`,undefined,undefined,undefined,signal),
    async read(item,signal) {
      const response = await sessionFetch(`/v1/assets/${item.id}/download?original=1`, {credentials:'same-origin',signal});
      if (!response.ok) throw new Error('Could not read this file.');
      const blob = await response.blob();
      if (blob.size !== item.byte_size) throw new Error('File size changed.');
      return new globalThis.File([blob],item.filename,{type:item.content_type});
    },
  };
}

const fileTypes = [
  {key:'all', label:'All files', Icon:Files}, {key:'pdf', label:'PDFs', Icon:FilePdf},
  {key:'text', label:'Text files', Icon:FileText}, {key:'image', label:'Images', Icon:ImageSquare},
  {key:'audio', label:'Audio', Icon:MusicNote}, {key:'video', label:'Videos', Icon:VideoCamera},
  {key:'other', label:'Other files', Icon:File},
];
export function AttachFileDialog({source, remaining, onInsert, onClose, onUpload}: {
  source: FilePickerSource; remaining:number; onInsert:(files:globalThis.File[])=>void; onClose:()=>void; onUpload:()=>void;
}) {
  const [query,setQuery] = useState('');
  const [ownership,setOwnership] = useState('all');
  const [kind,setKind] = useState('all');
  const [sort,setSort] = useState('recent');
  const group = useId();
  const [cursor,setCursor] = useState('');
  const search = useCallback((params: URLSearchParams, signal: AbortSignal) => source.search(params,signal), [source]);
  const filters = new URLSearchParams({q:query.trim(),ownership,kind,sort,limit:'30'}).toString();
  const {page, displayedCursor, changingPage, error: listError, retry} = useFilePickerPage(search, filters, cursor, query.trim() ? 150 : 0);
  const [selected,setSelected] = useState<PickerFile>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const choice = page?.items.find(item => item === selected);
  const searchInput = useRef<HTMLInputElement>(null);
  // Native dialog focus is assigned after the content mounts.
  useEffect(()=>{ const frame=requestAnimationFrame(()=>searchInput.current?.focus());return ()=>cancelAnimationFrame(frame); },[]);
  const transfer = useRef<AbortController | null>(null);
  useEffect(()=>()=>transfer.current?.abort(),[]);
  async function insert() {
    if (transfer.current || !choice || remaining<1) return;
    const controller = new AbortController();
    transfer.current=controller;setBusy(true);setError('');
    try {
      const file = await source.read(choice,controller.signal);
      if (!controller.signal.aborted) onInsert([file]);
    } catch {
      if (!controller.signal.aborted) setError('Couldn’t attach the selected files. Try again.');
    } finally {
      if (transfer.current === controller) {
        transfer.current = null;
        if (!controller.signal.aborted) setBusy(false);
      }
    }
  }
  function cancelTransfer() {
    transfer.current?.abort();
    transfer.current = null;
    setBusy(false);
  }
  function cancel() { cancelTransfer(); onClose(); }
  return <Dialog open title="Attach a file" onClose={cancel}>
    <div className="attach-file-dialog">
      <div className="attach-file-types" role="group" aria-label="Filter by file type">
        {fileTypes.map(({key,label,Icon})=><button type="button" key={key} aria-pressed={key===kind}
          onClick={()=>{setKind(key);setCursor('');}}><Icon size={18}/>{label}</button>)}
      </div>
      <div className="attach-file-body">
        <label className="attach-file-search"><MagnifyingGlass size={18}/><input ref={searchInput} type="search" aria-label="Search files" placeholder="Search files" value={query} maxLength={255}
          onChange={e=>{setQuery(e.target.value);setCursor('');}}/></label>
        <div className="attach-file-filters" role="group" aria-label="Filter files">
          {Object.entries({all:'All',shared:'Shared with you',created:'Created by you'}).map(([value,label])=><button type="button" key={value} aria-pressed={ownership===value}
            onClick={()=>{setOwnership(value);setCursor('');}}>{label}</button>)}
        </div>
        <div className="attach-file-sort"><strong>{query.trim() ? 'Search results' : sort==='recent' ? 'Recently viewed' : 'Newest uploads'}</strong>
          <Select aria-label="Sort files" value={sort} onChange={e=>{setSort(e.target.value);setCursor('');}}>
            <option value="recent">Recently viewed</option><option value="newest">Newest uploads</option>
          </Select>
        </div>
        {error && <p role="alert">{error}</p>}
        {listError && <p role="alert">{listError} <Button size="sm" onClick={retry}>Retry</Button></p>}
        {!page && !listError && <ListRowSkeleton label="Loading files…"/>}
        {page && <div className="attach-file-results" role="radiogroup" aria-label="Files">{page.items.map(item=>
          <label key={item.id}>
            <input type="radio" name={group} aria-label={item.filename} checked={choice===item} disabled={busy || remaining<1} onChange={()=>setSelected(item)}/>
            {item.preview_kind==='image' ? <img src={`/v1/assets/${item.id}/thumbnail`} loading="lazy" alt=""/> : <File size={23}/>}
            <span>{item.filename}<small>{item.uploader_name} · {item.channel_name}</small></span>
          </label>)}{!page.items.length && <p>No matching files.</p>}</div>}
        {(displayedCursor || cursor || page?.next_cursor) && <div>
          {(displayedCursor || cursor) && <Button size="sm" loading={changingPage && !cursor}
            onClick={()=>!cursor && listError ? retry() : setCursor('')}>First page</Button>}
          {page?.next_cursor && <Button size="sm" loading={changingPage && !!cursor}
            onClick={()=>cursor === page.next_cursor && listError ? retry() : setCursor(page.next_cursor!)}>Next page</Button>}
        </div>}
      </div>
      <div className="attach-file-footer">
        <Button disabled={remaining<1} onClick={()=>{cancelTransfer(); onUpload();}}><UploadSimple/>Upload</Button>
        <small>A copy will be attached.</small>
        <Button onClick={cancel}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!choice || remaining<1} onClick={()=>void insert()}>{busy?'Inserting…':'Insert'}</Button>
      </div>
    </div>
  </Dialog>;
}
