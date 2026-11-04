import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentResponse as Response } from '@space/contracts';
import { AgentResponse } from './agent-response.js';

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
 expect(screen.getByText('Before first read.')).toBe(first);expect(screen.getByText('Final answer.')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Collapse timeline'})).toBeTruthy();expect(screen.getByText('Read result.')).toBeTruthy();
 expect(screen.getByText('read_text_file · Completed').compareDocumentPosition(screen.getByText('Final answer.'))&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
