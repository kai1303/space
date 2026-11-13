import { useEffect, useId, useRef, useState } from 'react';
import { Button, Dialog } from '@space/ui/primitives';
import { File, Files, FilePdf, ImageSquare, FileText, MusicNote, VideoCamera, MagnifyingGlass, UploadSimple } from '@phosphor-icons/react';
import type { HubFile, Page } from '@space/contracts';
import { request } from '../../shared/api/request.js';
import { sessionFetch } from '../../shared/api/session-fetch.js';
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
  const [page,setPage] = useState<Page<PickerFile>>();
  const [selected,setSelected] = useState<PickerFile>();
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [retry,setRetry] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  // Native dialog focus is assigned after the content mounts.
  useEffect(()=>{ const frame=requestAnimationFrame(()=>searchInput.current?.focus());return ()=>cancelAnimationFrame(frame); },[]);
  const transfer = useRef<AbortController | null>(null);
  useEffect(()=>()=>transfer.current?.abort(),[]);
  useEffect(()=>{
    const controller = new AbortController();
    setPage(undefined);setSelected(undefined);setError('');
    const params = new URLSearchParams({q:query.trim(),ownership,kind,sort,limit:'30'});
    if (cursor) params.set('after',cursor);
    const debounce = setTimeout(()=>{
      void source.search(params,controller.signal).then(result=>{
        if (!controller.signal.aborted) setPage(result);
      }).catch(()=>{if (!controller.signal.aborted) setError('Couldn’t load files.');});
    },query ? 150 : 0);
    return ()=>{clearTimeout(debounce);controller.abort();};
  },[source,query,ownership,kind,sort,cursor,retry]);
  async function insert() {
    if (transfer.current || !selected || remaining<1) return;
    const controller = new AbortController();
    transfer.current=controller;setBusy(true);setError('');
    try {
      const file = await source.read(selected,controller.signal);
      if (!controller.signal.aborted) onInsert([file]);
    } catch {
      if (!controller.signal.aborted) setError('Couldn’t attach the selected files. Try again.');
    } finally {
      transfer.current=null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function cancel() { transfer.current?.abort(); onClose(); }
  return <Dialog open title="Attach a file" onClose={cancel}>
    <div className="attach-file-dialog">
      <div className="attach-file-types" role="group" aria-label="Filter by file type">
        {fileTypes.map(({key,label,Icon})=><button type="button" key={key} disabled={busy} aria-pressed={key===kind}
          onClick={()=>{setKind(key);setCursor('');}}><Icon size={18}/>{label}</button>)}
      </div>
      <div className="attach-file-body">
        <label className="attach-file-search"><MagnifyingGlass size={18}/><input ref={searchInput} type="search" aria-label="Search files" placeholder="Search files" value={query} maxLength={255} disabled={busy}
          onChange={e=>{setQuery(e.target.value);setCursor('');}}/></label>
        <div className="attach-file-filters" role="group" aria-label="Filter files">
          {Object.entries({all:'All',shared:'Shared with you',created:'Created by you'}).map(([value,label])=><button type="button" key={value} disabled={busy} aria-pressed={ownership===value}
            onClick={()=>{setOwnership(value);setCursor('');}}>{label}</button>)}
        </div>
        <div className="attach-file-sort"><strong>{query.trim() ? 'Search results' : sort==='recent' ? 'Recently viewed' : 'Newest uploads'}</strong>
          <select aria-label="Sort files" value={sort} disabled={busy} onChange={e=>{setSort(e.target.value);setCursor('');}}>
            <option value="recent">Recently viewed</option><option value="newest">Newest uploads</option>
          </select>
        </div>
        {error && <p role="alert">{error} {!page && <Button size="sm" onClick={()=>setRetry(n=>n+1)}>Retry</Button>}</p>}
        {!page && !error && <p role="status">Loading files…</p>}
        {page && <><div className="attach-file-results" role="radiogroup" aria-label="Files">{page.items.map(item=>
          <label key={item.id}>
            <input type="radio" name={group} aria-label={item.filename} checked={selected?.id===item.id} disabled={busy || remaining<1} onChange={()=>setSelected(item)}/>
            {item.preview_kind==='image' ? <img src={`/v1/assets/${item.id}/thumbnail`} loading="lazy" alt=""/> : <File size={23}/>}
            <span>{item.filename}<small>{item.uploader_name} · {item.channel_name}</small></span>
          </label>)}{!page.items.length && <p>No matching files.</p>}</div>
          {(cursor || page.next_cursor) && <div>{cursor && <Button size="sm" disabled={busy} onClick={()=>setCursor('')}>First page</Button>} {page.next_cursor && <Button size="sm" disabled={busy} onClick={()=>setCursor(page.next_cursor!)}>Next page</Button>}</div>}
        </>}
      </div>
      <div className="attach-file-footer">
        <Button disabled={busy || remaining<1} onClick={onUpload}><UploadSimple/>Upload</Button>
        <small>A copy will be attached.</small>
        <Button onClick={cancel}>Cancel</Button>
        <Button variant="primary" disabled={busy || !selected || remaining<1} onClick={()=>void insert()}>{busy?'Inserting…':'Insert'}</Button>
      </div>
    </div>
  </Dialog>;
}
