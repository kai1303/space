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
  const [messages, setMessages] = useState<{text:string;files:string[]}[]>([]);
  return <main className="agent-composer-example">
    <ConversationHeader title="Local Codex" status="Composer preview"/>
    <div className="agent-composer-example-history">
      <Message author="Kai" initials="K" tone="blue" time="10:24"><p>Can we show progress while a file uploads?</p></Message>
      <Message author="Local Codex" initials="LC" tone="green" time="10:25" agent><p>We can show the percentage beside the filename in the message composer.</p></Message>
      {messages.map(({text,files},index)=><Message key={index} author="Kai" initials="K" tone="blue" time="Now"><p>{text}</p>{files.map((file,i)=><div key={i}>{file}</div>)}</Message>)}
    </div>
    <AgentSessionComposer filePickerSource={previewSource} skill="codex.run" channel="agent session" placeholder="Message Local Codex" maxLength={4000}
      showUnavailableActions={false} attachmentsEnabled mentions={['Kai']} onSend={(text,_document,files)=>setMessages(list=>[...list,{text,files:files.map(file=>file.name)}])}/>
  </main>;
}
