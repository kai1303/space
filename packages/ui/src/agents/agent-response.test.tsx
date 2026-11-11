import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentResponse as Response } from '@space/contracts';
import { AgentMarkdown, AgentResponse } from './agent-response.js';

afterEach(cleanup);

it('keeps the saved text visible when a backend finishes without structured content', () => {
  render(<AgentResponse response={{ messages: [], tools: [], components: [] }} fallback="Agent run completed." />);
  expect(screen.getByText('Agent run completed.')).toBeTruthy();
});
const response: Response = {
  messages: [{ id: 'm', text: '## Results\n\nHello **Kai**.\n\n```ts\nconst answer = 42;\n```', status: 'complete' }],
  tools: [{ id: 't', name: 'Search records', arguments: '{"query":"churn"}', result: 'Found 3 records', status: 'completed' }],
  components: [{ id: 'c', type: 'card', title: 'Churn', body: 'Down 2%' }, { id: 'table', type: 'table', title: 'Customers', columns: ['Plan', 'Count'], rows: [['Pro', '3']] }],
};
it('renders Markdown, Space code blocks, tool results and registered cards/tables', async () => {
  render(<AgentResponse response={response} />);
  expect(screen.getByRole('heading', { name: 'Results' })).toBeTruthy();
  expect(screen.getByText('Kai').tagName).toBe('STRONG');
  expect(screen.getByRole('group', { name: /code block/i })).toBeTruthy();
  expect(screen.getByRole('table', { name: 'Customers' })).toBeTruthy();
  expect(screen.getByText('Down 2%')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Expand timeline' }));
  expect(screen.getByText('Found 3 records')).toBeTruthy();
});
it('never mounts agent HTML, executable links or remote images', () => {
  const { container } = render(<AgentResponse response={{ ...response, messages: [{ id: 'm', status: 'complete', text: '<script>alert(1)</script>\n\n[click](javascript:alert)\n\n![tracking](https://example.com/pixel.png)' }] }} />);
  expect(container.querySelector('script, iframe, img, a[href^="javascript:"]')).toBeNull();
});
it('preserves workspace profile citations while dropping other relative links', () => {
  const href = '/w/hBRc483YT8KupyFKN8gHEQ?profile=user:560b316c-16f7-4149-86b6-33fb137bf1d2';
  render(<AgentMarkdown text={`[kai · Space profile](${href}) [@kai](${href}) [Other](/settings) [Remote](//example.com)`} />);
  const mentions = screen.getAllByRole('link', { name: '@kai' });
  expect(mentions).toHaveLength(2);
  for (const mention of mentions) {
    expect(mention.getAttribute('href')).toBe(href);
    expect(mention.classList.contains('sp-mention-token')).toBe(true);
  }
  expect(screen.getAllByRole('link')).toHaveLength(2);
});
it.each(['/c/WKg-kkvDSN66pfa8v7JNFA/message/YoTtlDdtRiusFXmjIRoVTw', '/v1/assets/58a83e92-4bc3-48de-baa5-f6bcbfb24d14/download'])('opens the canonical citation %s and drops malformed paths', (path) => {
  render(<AgentMarkdown text={`[Original message](${path}) [other](${path}?redirect=1) [invalid](${path}/more)`} />);
  expect(screen.getAllByRole('link')).toHaveLength(1);
  const link = screen.getByRole('link', { name: 'Original message' });
  expect(link.getAttribute('href')).toBe(path);
  expect(link.getAttribute('target')).toBe('_blank');
  expect(link.getAttribute('rel')).toContain('noopener');
});
it('renders canonical channel citations as same-tab channel mentions', () => {
  const href = '/c/hBRc483YT8KupyFKN8gHEQ';
  render(<AgentMarkdown text={`[#general](${href}) #plain [bad](/c/invalid) [redirect](${href}?next=offsite)`} />);
  const [tag] = screen.getAllByRole('link');
  expect(screen.getAllByRole('link')).toHaveLength(1);
  expect(tag?.textContent).toBe('#general');
  expect(tag?.getAttribute('href')).toBe(href);
  expect(tag?.getAttribute('target')).toBeNull();
  expect(tag?.getAttribute('data-mention-kind')).toBe('channel');
  expect(tag?.classList.contains('sp-mention-token')).toBe(true);
});
it('updates streamed text in place and shows interrupted tool state on failure', () => {
  const partial: Response = { messages: [{ id: 'm', text: 'Hel', status: 'streaming' }], tools: [], components: [], step: 'Looking up records' };
  const { rerender } = render(<AgentResponse response={partial} streaming />);
  expect(screen.getByRole('status').textContent).toContain('Looking up records');
  rerender(<AgentResponse response={{ ...partial, messages: [{ id: 'm', text: 'Hello Kai', status: 'complete' }], tools: [{ ...response.tools[0]!, status: 'interrupted', result: undefined }] }} />);
  expect(screen.getAllByText('Hello Kai')).toHaveLength(1);
  expect(screen.getByText(/Interrupted/)).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});


it('uses observed agent activity instead of claiming every streamed turn is responding',()=>{
 const {rerender}=render(<AgentResponse response={{messages:[],tools:[],components:[],activity:'thinking'}} streaming/>);
 expect(screen.getByRole('status').textContent).toBe('Thinking…');
 rerender(<AgentResponse response={{messages:[],tools:[],components:[],activity:'using_tools'}} streaming/>);
 expect(screen.getByRole('status').textContent).toBe('Using tools…');
});


it('keeps text and expanded tools stable in chronological streaming order',async()=>{
 const before={id:'before',text:'Before first read.',status:'streaming' as const};
 const base:Response={messages:[before],tools:[],components:[],activity:'responding',items:[{type:'message',id:'before'}]};
 const {rerender,container}=render(<AgentResponse response={base} streaming/>);
 const first=screen.getByText('Before first read.');
 rerender(<AgentResponse response={{...base,tools:[{id:'read',name:'read_text_file',arguments:'{"path":"README.md"}',status:'running'}],activity:'using_tools',items:[{type:'message',id:'before'},{type:'tool',id:'read'}]}} streaming/>);
 expect(screen.getByText('Before first read.')).toBe(first);
 const tool=screen.getByText('read_text_file · Running');
 expect(first.compareDocumentPosition(tool)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 await userEvent.click(screen.getByRole('button',{name:'Expand timeline'}));
 rerender(<AgentResponse response={{...base,messages:[{...before,status:'complete'},{id:'final',text:'Final answer.',status:'complete'}],tools:[{id:'read',name:'read_text_file',arguments:'{"path":"README.md"}',status:'completed',result:'Read result.'}],activity:undefined,items:[{type:'message',id:'before'},{type:'tool',id:'read'},{type:'message',id:'final'}]}}/>);
 const final = container.querySelectorAll('.sp-agent-markdown')[1]!;
 await waitFor(() => expect(final.textContent).toBe('Final answer.'));
 expect(screen.getByText('Before first read.')).toBe(first);
 expect(screen.getByRole('button',{name:'Collapse timeline'})).toBeTruthy();expect(screen.getByText('Read result.')).toBeTruthy();
 expect(screen.getByText('read_text_file · Completed').compareDocumentPosition(final)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
 expect(container.querySelector('[aria-busy="true"]')).toBeNull();
});

it('groups only adjacent tools and keeps their expansion when another tool is added',async()=>{
 const tools:Response['tools']=[{id:'first',name:'First read',arguments:'{}',status:'completed'}];
 const first:Response={messages:[{id:'before',text:'Before.',status:'complete'}],tools,components:[],items:[{type:'message',id:'before'},{type:'tool',id:'first'}]};
 const {rerender}=render(<AgentResponse response={first} streaming/>);
 await userEvent.click(screen.getByRole('button',{name:'Expand timeline'}));
 rerender(<AgentResponse response={{...first,tools:[...tools,{id:'second',name:'Second read',arguments:'{}',status:'running'}],items:[...first.items!,{type:'tool',id:'second'}]}} streaming/>);
 expect(screen.getByRole('button',{name:'Collapse timeline'})).toBeTruthy();expect(screen.getByText('Second read · Running')).toBeTruthy();
 expect(screen.getByText('Before.').compareDocumentPosition(screen.getByText('First read · Completed'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('keeps completed code blocks, links and tables mounted when more text streams in', () => {
  const prefix = '```ts\nconst answer = 42;\n```\n\n[Documentation](https://example.com)\n\n| Name | Value |\n| --- | --- |\n| Answer | 42 |\n\n';
  const view = render(<AgentMarkdown text={prefix + 'First'} />);
  const code = view.container.querySelector('.sp-code-block')!;
  const link = screen.getByRole('link', { name: 'Documentation' });
  const table = screen.getByRole('table');
  const copy = screen.getByRole('button', { name: 'Copy', exact: true });
  copy.focus();
  view.rerender(<AgentMarkdown text={prefix + 'First second third'} />);
  expect(view.container.querySelector('.sp-code-block')).toBe(code);
  expect(screen.getByRole('link', { name: 'Documentation' })).toBe(link);
  expect(screen.getByRole('table')).toBe(table);
  expect(document.activeElement).toBe(copy);
});

it('shows write content with a filename while raw arguments stay in Details',async()=>{
 const input=JSON.stringify({path:'/project/src/hello.ts',content:'export const greeting = "hello";'});
 const {container}=render(<AgentResponse response={{messages:[],components:[],tools:[{id:'write',name:'write_file',arguments:input,status:'completed',result:'Successfully wrote to /project/src/hello.ts'}]}}/>);
 await userEvent.click(screen.getByRole('button',{name:'Expand timeline'}));
 expect(screen.getByText('hello.ts')).toBeTruthy();expect(screen.getByText('Content sent')).toBeTruthy();
 expect(container.querySelector('.sp-agent-file-tool details')?.hasAttribute('open')).toBe(false);
 await userEvent.click(screen.getByText('Details'));expect(screen.getByRole('group',{name:'JSON code block'}).querySelector('code')?.textContent).toBe(input);
});

it('shows returned edit diffs and labels dry runs without claiming a write',async()=>{
 render(<AgentResponse response={{messages:[],components:[],tools:[{id:'edit',name:'edit_file',arguments:JSON.stringify({path:'/project/README.md',dryRun:true,edits:[{oldText:'Before',newText:'After'}]}),status:'completed',result:'```diff\n--- README.md\n+++ README.md\n@@ -1 +1 @@\n-Before\n+After\n```'}]}}/>);
 await userEvent.click(screen.getByRole('button',{name:'Expand timeline'}));
 expect(screen.getByText('README.md')).toBeTruthy();expect(screen.getByText('Preview only')).toBeTruthy();expect(screen.getByText('Changes returned')).toBeTruthy();
 expect(screen.getByRole('group',{name:'diff code block'}).textContent).toContain('-Before');
});

it('keeps malformed file inputs readable and shows failed edit output beside requested edits',async()=>{
 const {rerender}=render(<AgentResponse response={{messages:[],components:[],tools:[{id:'edit',name:'edit_file',arguments:'{"path":"/truncated',status:'interrupted',result:'Tool failed.'}]}}/>);
 await userEvent.click(screen.getByRole('button',{name:'Expand timeline'}));await userEvent.click(screen.getByText('Details'));expect(screen.getByRole('group',{name:'JSON code block'}).querySelector('code')?.textContent).toBe('{"path":"/truncated');
 rerender(<AgentResponse response={{messages:[],components:[],tools:[{id:'edit',name:'edit_file',arguments:JSON.stringify({path:'a.txt',edits:[{oldText:'old',newText:'new'}]}),status:'interrupted',result:'Tool failed.'}]}}/>);
 expect(screen.getByText('Requested edits')).toBeTruthy();expect(screen.getByText('Tool failed.')).toBeTruthy();
});

it.each(['commentary', 'final_answer', undefined] as const)('paces %s text, preserves visible words, and flushes on completion', phase => {
  vi.useFakeTimers();
  const show = (text: string, status: 'streaming' | 'complete' = 'streaming') =>
    <AgentResponse streaming response={{ messages: [{ id: 'answer', text, status, phase }], tools: [], components: [] }} />;
  try {
    const view = render(show('Start.'));
    const body = view.container.querySelector('.sp-agent-markdown')!;
    const burst = ' More words to reveal smoothly.'.repeat(8);
    view.rerender(show('Start.' + burst));
    expect(body.textContent).toBe('Start.');
    act(() => vi.advanceTimersByTime(100));
    expect(body.textContent!.length).toBeGreaterThan(6);
    expect(body.textContent!.length).toBeLessThan(6 + burst.length);
    const word = body.querySelector('.sp-agent-word');
    expect(word).toBeTruthy();
    act(() => vi.advanceTimersByTime(100));
    expect(body.querySelector('.sp-agent-word')).toBe(word);
    view.rerender(show('Start.' + burst, 'complete'));
    expect(body.textContent).toBe('Start.' + burst);
    expect(body.querySelector('.sp-agent-word')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('replaces corrected text immediately even with a queued burst', () => {
  const show = (text: string, phase: 'commentary' | 'final_answer') =>
    <AgentResponse streaming response={{ messages: [{ id: 'm', text, phase, status: 'streaming' }], tools: [], components: [] }} />;
  const view = render(show('Checking', 'commentary'));
  view.rerender(show('Checking the files', 'commentary'));
  expect(view.container.querySelector('.sp-agent-markdown')?.textContent).toBe('Checking');
  view.rerender(show('Revised answer', 'final_answer'));
  expect(screen.getByText('Revised answer')).toBeTruthy();
});

it('animates a new live row while keeping a large single burst bounded', () => {
  vi.useFakeTimers();
  try {
    const text = 'A small word. '.repeat(1100).trim();
    const view = render(<AgentMarkdown text={text} streaming newArrival />);
    expect(view.container.textContent).toBe('');
    act(() => vi.advanceTimersByTime(1500));
    expect(view.container.textContent).toBe(text);
    expect(view.container.querySelectorAll('.sp-agent-word').length).toBeLessThan(512);
    view.unmount();
    const restored = render(<AgentMarkdown text={text} streaming />);
    expect(restored.container.textContent).toBe(text);
    expect(restored.container.querySelector('.sp-agent-word')).toBeNull();
  } finally { vi.useRealTimers(); }
});

it('reveals a completed live arrival once and renders restored history immediately', () => {
  vi.useFakeTimers();
  try {
    const text = 'A reply delivered in a single update.';
    const view = render(<AgentMarkdown text={text} newArrival />);
    expect(view.container.textContent).toBe('');
    view.rerender(<AgentMarkdown text={text} />);
    act(() => vi.advanceTimersByTime(80));
    expect(view.container.querySelector('.sp-agent-word')).toBeTruthy();
    expect(view.container.textContent!.length).toBeLessThan(text.length);
    act(() => vi.advanceTimersByTime(500));
    expect(view.container.textContent).toBe(text);
    act(() => vi.advanceTimersByTime(700));
    expect(view.container.querySelector('.sp-agent-word')).toBeNull();
    view.unmount();
    const history = render(<AgentMarkdown text={text} />);
    expect(history.container.textContent).toBe(text);
    expect(history.container.querySelector('.sp-agent-word')).toBeNull();
  } finally { vi.useRealTimers(); }
});
