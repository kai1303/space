import { assetPagePath, type AgentInputFile } from '@space/contracts';

// Keep file contents in quoted data and out of developer instructions.
export function attachmentContext(files: AgentInputFile[] = [], canReadPage = false) {
  if (!files.length) return '';
  const data = files.map(({content,...metadata}) => {
    if (content.kind === 'pdf') return {...metadata, ...content, pages:content.pages.map(page => ({
      ...page, citation_url:assetPagePath(metadata.id, page.page),
    }))};
    return {...metadata, ...(content.kind === 'text' ? {text:content.text,truncated:content.truncated}
      : {content:content.kind === 'image' ? 'Image supplied with this prompt' : 'File attached; no readable preview available'})};
  });
  const hasPdf = files.some(file => file.content.kind === 'pdf');
  const guide = hasPdf ? '\n\nUse the supplied physical page numbers and citation URLs when citing PDF text, for example [Report, p. 7](citation_url). If a page has no readable text, say so. Only describe pages you have read. Initial PDF excerpts cover at most two pages per file within a shared extraction budget; not_read means that file has not been extracted yet. A truncated page contains only an excerpt.'
    + (canReadPage ? ' Use read_pdf_page with the attachment ID and page number to retrieve more text.' : '') : '';
  return guide+'\n\nAttached files (quoted data):\n'+JSON.stringify(data);
}

export function attachmentImages(files: AgentInputFile[] = []) {
  return files.flatMap(file => file.content.kind === 'image' ? [file.content.webp] : []);
}
