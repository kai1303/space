import { webcrypto, createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaskChanges, ResultActions } from './AgentTaskWorkspace.js';
import { patchLines } from './PatchReview.js';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('groups comments and retains the exact older patch and retry identity across a concurrent diff update', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const patch = '@@ -2 +7 @@\n-old\n+first';
  const digest = createHash('sha256').update(patch).digest('hex');
  const changed = '@@ -10 +30 @@\n-old\n+second';
  const send = vi.fn().mockRejectedValueOnce(new Error('Connection lost')).mockResolvedValue(undefined);
  const view = render(<TaskChanges changes={[{path:'a.ts',patch}]} onReview={send}/>);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button',{name:'Comment on a.ts, new line 7'}));
  await user.type(screen.getByRole('textbox'), 'Keep the validation.');
  view.rerender(<TaskChanges changes={[{path:'a.ts',patch:changed}]} onReview={send}/>);
  await user.click(screen.getByRole('button',{name:'Add to review'}));
  await user.click(screen.getByRole('button',{name:'Comment on a.ts, old line 10'}));
  await user.type(screen.getByRole('textbox'), 'Handle empty input.');
  await user.click(screen.getByRole('button',{name:'Add to review'}));
  await user.click(screen.getByRole('button',{name:'Submit review'}));
  await user.click(screen.getByRole('button',{name:'Send review'}));
  await screen.findByRole('alert');
  await user.click(screen.getByRole('button',{name:'Send review'}));
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  const [message] = send.mock.calls[0]!;
  expect(message).toContain(`a.ts · new line 7 (patch line 3, sha256:${digest})\n> +first\nKeep the validation.`);
  expect(message).toContain('a.ts · old line 10');
  expect(screen.queryByRole('region',{name:'Pending code review'})).toBeNull();
});

it('keeps distinct old and new line numbers across hunks and addresses provider patch formats by patch line', () => {
  const lines = patchLines('@@ -2,2 +8,2 @@\n same\n-old\n+new\n@@ -4,0 +20 @@\n+++literal\ntruncated');
  expect(lines.map(l => l.location)).toEqual(['patch line 1','line 8','old line 3','new line 9','patch line 5','new line 20','patch line 7']);
});

it('renders only credential-free HTTPS result actions and leaves writes to the linked host', () => {
  render(<ResultActions actions={[{label:'Create pull request',url:'https://git.example/repo/compare/main...topic'},
    {label:'Bad scheme',url:'javascript:alert(1)'},{label:'Credential leak',url:'https://x:pw@git.example/repo'}]}/>);
  const links = screen.getAllByRole('link');
  expect(links).toHaveLength(1);
  expect(links[0]?.getAttribute('href')).toBe('https://git.example/repo/compare/main...topic');
});

it('reviews a second file inline on the supplied branches and retries one comment against its original patch', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const first = {path:'first.ts',patch:'@@ -1 +1 @@\n-a\n+b'};
  const second = {path:'src/second.ts',patch:'@@ -4 +7 @@\n-old\n+++literal'};
  const send = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(undefined);
  const view = render(<TaskChanges changes={[first, second]} baseBranch="release" headBranch="topic" onReview={send}/>);
  expect(screen.getByTitle('Base branch release')).toBeTruthy();
  expect(screen.getByTitle('Head branch topic')).toBeTruthy();
  await userEvent.click(within(screen.getByRole('navigation',{name:'Changed files'})).getByRole('button',{name:'src/second.ts'}));
  const file = screen.getByRole('region',{name:'Changes in src/second.ts'});
  expect(within(file).getByText('+1')).toBeTruthy();
  await userEvent.click(within(file).getByRole('button',{name:'Comment on src/second.ts, new line 7'}));
  await userEvent.type(within(file).getByRole('textbox'), 'Use a named constant.');
  await userEvent.click(screen.getByRole('button',{name:'Send comment'}));
  expect(send).not.toHaveBeenCalled();
  await userEvent.type(screen.getByRole('textbox',{name:'Review message'}), ' Please.');
  await userEvent.click(screen.getByRole('button',{name:'Send review'}));
  await screen.findByRole('alert');
  view.rerender(<TaskChanges changes={[first]} onReview={send}/>);
  expect(screen.getByRole('textbox')).toHaveProperty('value','Use a named constant. Please.');
  await userEvent.click(screen.getByRole('button',{name:'Send review'}));
  expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  expect(send.mock.calls[1]![0]).toContain('src/second.ts · new line 7');
  expect(screen.queryByRole('textbox')).toBeNull();
});
