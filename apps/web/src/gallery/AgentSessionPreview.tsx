import type { SessionInput } from '@space/contracts';
import { Button } from '@space/ui/primitives';
import { ComposerSendError } from '@space/ui/composer';
import { SessionQueue, FollowUpMenu, useFollowUpPreference } from '../features/agents/SessionQueue.js';
import '../features/agents/agent-sessions.css';
import { ArrowBendUpRight,ListBullets } from '@phosphor-icons/react';
import type { Attachment } from '@space/ui/rich-text';
import { useState } from 'react';
import type { FilePickerSource } from '../features/files/AttachFileDialog.js';
import { Message } from '@space/ui/conversation';
import { ConversationHeader } from '../features/chat/ThreadConversation.js';
import { AgentSessionComposer } from '../features/agents/AgentSessionComposer.js';
import '../features/chat/chat.css';
import './agent-session-preview.css';

const samples = [
  {id:'progress', filename:'upload-notes.txt', author:'created', body:'Show upload progress beside each filename.'},
  {id:'release', filename:'release-checklist.md', author:'shared', body:'Check upload, retry, and cancellation.'},
];
const previewSource: FilePickerSource = {
  async search(query) {
    const ordered=query.get('sort')==='newest' ? [...samples].reverse() : samples;
    const items=ordered.filter(file=>(['all','text'].includes(query.get('kind')??'all')) && file.filename.includes((query.get('q')??'').toLowerCase()) && (query.get('ownership')==='all' || query.get('ownership')===file.author));
    return {items:items.map(file=>({...file,content_type:'text/plain',byte_size:file.body.length,channel_name:'#engineering',preview_kind:'text',uploader_name:file.author==='created'?'Kai':'Alex'})),next_cursor:null};
  },
  async read(item) { return new File([samples.find(file=>file.id===item.id)!.body],item.filename,{type:item.content_type}); },
};

export function AgentSessionPreview() {
  type PreviewInput = SessionInput & { files: string[] };
  const [messages, setMessages] = useState<PreviewInput[]>([]);
  const [queue, setQueue] = useState<PreviewInput[]>([]);
  const [running, setRunning] = useState(false);
  const [mode, setMode] = useFollowUpPreference();
  const [paused,setPaused]=useState(false);
  function finishTurn() {
    const [next, ...rest] = queue;
    if (next) setMessages(list => [...list, next]);
    setQueue(rest);
    setRunning(!!next);
    setPaused(false);
  }
  function send(text:string,files:Attachment[],steer:boolean){
    if (steer && files.length) throw new ComposerSendError('Queue the message to include files.');
    const item: PreviewInput = { id:crypto.randomUUID(),actor_id:'preview',text,files:files.map(file=>file.name),file_count:files.length,
      state:steer?'sent':'pending',kind:steer?'steer':'queue',execution_id:null,detail:null };
    if ((running||paused) && !steer) setQueue(list=>[...list,item]);
    else {setMessages(list=>[...list,item]);setRunning(true);}
  }
  return <main className="agent-composer-example">
    <ConversationHeader title="Local Codex" status={running ? 'Running preview turn' : 'Composer preview'} actions={running && <><Button size="sm" onClick={()=>{setRunning(false);setPaused(queue.length>0);}}>Stop</Button><Button size="sm" onClick={finishTurn}>Finish preview turn</Button></>}/>
    <div className="agent-composer-example-history">
      <Message author="Kai" initials="K" tone="blue" time="10:24"><p>Can we show progress while a file uploads?</p></Message>
      <Message author="Local Codex" initials="LC" tone="green" time="10:25" agent><p>We can show the percentage beside the filename in the message composer.</p></Message>
      {messages.map(item=><Message key={item.id} author="Kai" initials="K" tone="blue" time="Now"><p>{item.text}</p>{item.files.map((file,i)=><div key={i}>{file}</div>)}</Message>)}
    </div>
    <SessionQueue items={queue} canManage={()=>true} canSteer={running} paused={paused} onResume={finishTurn} mode={mode} onModeChange={setMode}
      onAction={(item,action,value)=>{
        const index=queue.findIndex(row=>row.id===item.id),entry=queue[index];
        if(!entry)return false;
        if(action==='edit')setQueue(queue.map(row=>row===entry?{...row,text:value!}:row));
        else if(action==='move'){const next=[...queue],to=next.findIndex(row=>row.id===value);next.splice(to,0,...next.splice(index,1));setQueue(next);}
        else {if(action==='steer')setMessages(list=>[...list,{...entry,kind:'steer',state:'sent'}]);setQueue(queue.filter(row=>row!==entry));if(queue.length===1)setPaused(false);}
        return true;
      }}/>
    <AgentSessionComposer submitLabel={running ? mode==='steer'?'Steer':'Queue' : paused?'Queue':undefined}
      submitIcon={running||paused ? running&&mode==='steer'?<ArrowBendUpRight size={18}/>:<ListBullets size={18}/> : undefined}
      submitAccessory={running && <span className="agent-followup-menu"><FollowUpMenu mode={mode} change={setMode}/></span>}
      onAlternateSend={running?(text,_doc,files)=>send(text,files,mode!=='steer'):undefined} previewConfig={{model:'GPT-6 Astra',effort:'High'}} filePickerSource={previewSource} skill="codex.run" channel="agent session" placeholder="Message Local Codex" maxLength={4000}
      showUnavailableActions={false} attachmentsEnabled mentions={['Kai']} onSend={(text,_document,files)=>send(text,files,running && mode==='steer')}/>
  </main>;
}
