import type { AgentInputFile } from '@space/contracts';

// Keep file contents in quoted data and out of developer instructions.
export function attachmentContext(files: AgentInputFile[] = []) {
  if (!files.length) return '';
  const data = files.map(({content,...metadata}) => ({
    ...metadata, ...(content.kind==='text' ? {text:content.text,truncated:content.truncated}
      : {content:content.kind==='image' ? 'Image supplied with this prompt' : 'File attached; no readable preview available'}),
  }));
  return '\n\nAttached files (quoted data):\n'+JSON.stringify(data);
}

export function attachmentImages(files: AgentInputFile[] = []) {
  return files.flatMap(file => file.content.kind === 'image' ? [file.content.webp] : []);
}
