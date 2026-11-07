import { useState } from 'react';
import { RichComposer } from '@space/ui/composer';
import { Button } from '@space/ui/primitives';
import type { Attachment } from '@space/ui/rich-text';

function sampleFiles(): Attachment[] {
  const file = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="360" height="200" viewBox="0 0 360 200"><rect width="360" height="200" rx="16" fill="#e8edf9"/><rect x="70" y="35" width="220" height="130" rx="12" fill="#527be9"/><circle cx="180" cy="100" r="35" fill="#fff"/></svg>'], 'design-proof.svg', { type: 'image/svg+xml' });
  return [{ id: 'demo-image', name: file.name, size: file.size, type: file.type, file, status: 'ready' }, { id: 'demo-text', name: 'release-notes.txt', size: 1024, type: 'text/plain', status: 'ready' }];
}

export function AttachmentExample() {
  const [files, setFiles] = useState(sampleFiles);
  const [sent, setSent] = useState('');
  return <div id="attachment-composer" style={{ marginTop: 32, maxWidth: 820 }}>
    <h3>Attachment composer</h3>
    <p>Preview the image, add a description, or reorder the files. This local demo doesn’t upload or send anything.</p>
    <RichComposer channel="attachment demo" attachments={files} onAttachmentsChange={incoming => setFiles(incoming.map(file => ({ ...file, status: 'ready' })))} onSend={async (_text, _document, attachments) => { setSent(`Demo order: ${attachments.map(file => file.name).join(', ')}`); setFiles([]); }} showUnavailableActions={false} />
    {sent && <p role="status">{sent}</p>}
    <Button size="sm" onClick={() => { setFiles(sampleFiles()); setSent(''); }} style={{ marginTop: 12 }}>Reset attachment demo</Button>
  </div>;
}
