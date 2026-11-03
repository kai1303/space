import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RichComposer } from "@space/ui";
import { Conversation } from "./Conversation.js";

afterEach(cleanup);
// JSDOM has no layout; Quill queries these browser Range geometry methods during focus.
beforeAll(() => {
  Object.defineProperties(Range.prototype, {
    getBoundingClientRect: { configurable: true, value: () => new DOMRect() },
    getClientRects: { configurable: true, value: () => [] },
  });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new Event('close')); };
});
afterAll(() => {
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  Reflect.deleteProperty(Range.prototype, "getClientRects");
});
it("uses a plain-text composer when the transport cannot retain formatting or uploads", async () => {
  const onSend = vi.fn();
  render(<RichComposer channel="general" plainText onSend={onSend} />);
  const editor = await screen.findByRole("textbox", { name: "Message general" });
  expect(screen.queryByRole("toolbar", { name: "Message formatting" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Attach files" })).toBeNull();
  await userEvent.type(editor, "A real message");
  await userEvent.click(screen.getByRole("button", { name: "Send now", exact: true }));
  expect(onSend.mock.calls[0]?.[0]).toBe("A real message");
});
it("keeps a document with excessive formatting in the editor instead of submitting it", async () => {
  const onSend = vi.fn();
  const document = { ops: Array.from({ length: 300 }, (_, index) => ({ insert: "x", attributes: { link: "https://example.test/" + index + "a".repeat(150) } })) };
  render(<RichComposer channel="general" defaultValue={document} attachmentsEnabled={false} onSend={onSend} />);
  await screen.findByRole("textbox", { name: "Message general" });
  expect((screen.getByRole("button", { name: "File uploads unavailable" }) as HTMLButtonElement).disabled).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "Send now", exact: true }));
  expect(screen.getByRole("alert").textContent).toContain("too much formatting");
  expect(onSend).not.toHaveBeenCalled();
});
it("does not clear a newer draft when an unmounted composer's send settles", async () => {
  let finish!: () => void;
  const submitted = new Promise<void>((resolve) => { finish = resolve; });
  const onDraftChange = vi.fn();
  const first = render(<RichComposer channel="design" onDraftChange={onDraftChange} onSend={() => submitted} />);
  await userEvent.type(await screen.findByRole("textbox", { name: "Message design" }), "Submitted draft");
  await userEvent.click(screen.getByRole("button", { name: "Send now", exact: true }));
  first.unmount();
  render(<RichComposer channel="design" onDraftChange={onDraftChange} onSend={() => {}} />);
  await userEvent.type(await screen.findByRole("textbox", { name: "Message design" }), "New draft");
  onDraftChange.mockClear();
  await act(async () => { finish(); await submitted; });
  expect(onDraftChange).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox", { name: "Message design" }).textContent).toContain("New draft");
});
it("does not send one channel’s draft to a newly selected channel", async () => {
  render(<Conversation />);
  const editor = await screen.findByRole("textbox", { name: "Message design-system" });
  expect(editor.getAttribute("contenteditable")).toBe("true");
  await userEvent.type(
    editor,
    "Only for design",
  );
  await userEvent.click(
    screen.getByRole("button", { name: "engineering 3 unread" }),
  );
  expect((await screen.findByRole("textbox", { name: "Message engineering" })).textContent?.trim()).toBe("");
  expect(
    (screen.getByRole("button", { name: "Send now" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  await userEvent.click(screen.getByRole("button", { name: "design-system" }));
  expect((await screen.findByRole("textbox", { name: "Message design-system" })).textContent).toContain("Only for design");
});

it("sends formatted rich text from the gallery composer", async () => {
  render(<Conversation />);
  const editor = await screen.findByRole("textbox", { name: "Message design-system" });
  await userEvent.click(screen.getByRole("button", { name: "Bold", exact: true }));
  await userEvent.type(editor, "Formatted message");
  await userEvent.click(screen.getByRole("button", { name: "Send now", exact: true }));
  expect((await screen.findByText("Formatted message", { exact: true })).tagName).toBe("STRONG");
});
it("closes the origin thread when switching channels", async () => {
  render(<Conversation />);
  await userEvent.click(
    screen.getByRole("button", { name: "2 replies View thread" }),
  );
  expect(screen.getByRole("button", { name: "Close thread" })).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: "engineering 3 unread" }),
  );
  expect(screen.queryByRole("button", { name: "Close thread" })).toBeNull();
});

it("retains selected File bytes and blocks sending while a controlled attachment uploads or fails", async () => {
  const change = vi.fn(), retry = vi.fn(), send = vi.fn();
  const file = new File(["real bytes"], "report.txt", { type: "text/plain" });
  const view = render(<RichComposer channel="general" attachments={[]} onAttachmentsChange={change} onRetryAttachment={retry} onSend={send} />);
  await screen.findByRole("textbox", { name: "Message general" });
  fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [file] } });
  const selected = change.mock.calls.at(-1)![0][0];
  expect(selected.file).toBe(file);
  expect(selected.status).toBe('uploading');
  view.rerender(<RichComposer channel="general" attachments={[{ ...selected, progress: 42 }]} onAttachmentsChange={change} onRetryAttachment={retry} onSend={send} />);
  expect(screen.getByRole('progressbar', { name: 'Uploading report.txt' }).getAttribute('value')).toBe('42');
  expect((screen.getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Message general' }), { key: 'Enter' });
  expect(send).not.toHaveBeenCalled();
  view.rerender(<RichComposer channel="general" attachments={[{ ...selected, status: 'error', error: 'Upload failed' }]} onAttachmentsChange={change} onRetryAttachment={retry} onSend={send} />);
  await userEvent.click(screen.getByRole('button', { name: 'Retry upload report.txt' }));
  expect(retry).toHaveBeenCalledWith(selected.id);
  expect(screen.getByRole('alert').textContent).toContain('Upload failed');
  view.rerender(<RichComposer channel="general" attachments={[{ id: 'asset', name: file.name, size: file.size, type: file.type, status: 'ready' }]} onAttachmentsChange={change} onRetryAttachment={retry} onSend={send} />);
  await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
  expect(send.mock.calls[0][2][0].id).toBe('asset');
  expect(change.mock.calls.at(-1)![0]).toEqual([]);
});
it('rejects empty and oversized files without retaining them', async () => {
  const change = vi.fn();
  const view = render(<RichComposer channel="general" onAttachmentsChange={change} onSend={() => {}} />);
  await screen.findByRole('textbox', { name: 'Message general' });
  const input = view.container.querySelector('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [new File([], 'empty.txt')] } });
  expect(screen.getByRole('alert').textContent).toContain('between 1 byte and 25 MB');
  const huge = new File(['x'], 'large.txt');
  Object.defineProperty(huge, 'size', { value: 25 * 1024 * 1024 + 1 });
  fireEvent.change(input, { target: { files: [huge] } });
  expect(screen.getByRole('alert').textContent).toContain('between 1 byte and 25 MB');
  fireEvent.change(input, { target: { files: Array.from({ length: 6 }, (_, index) => new File(['x'], `file-${index}.txt`)) } });
  expect(screen.getByRole('alert').textContent).toContain('up to five');
  expect(change.mock.calls.every(call => call[0].length === 0)).toBe(true);
});

it('does not replay an old acknowledgment against a newly mounted identical draft', async () => {
  const document = { ops: [{ insert: 'A deliberate new message\n' }] };
  render(<RichComposer channel="general" defaultValue={document} acknowledgedDocument={document} onSend={() => {}} />);
  expect((await screen.findByRole('textbox', { name: 'Message general' })).textContent).toContain('A deliberate new message');
  expect((screen.getByRole('button', { name: 'Send now' }) as HTMLButtonElement).disabled).toBe(false);
});

it('retains the selected range after dismissing the link dialog and formats only the selected text', async () => {
  const { default: Quill } = await import('quill');
  const send = vi.fn();
  render(<RichComposer channel="selection" defaultValue={{ ops: [{ insert: 'Review this text\n' }] }} onSend={send} />);
  const editor = await screen.findByRole('textbox', { name: 'Message selection' });
  const quill = Quill.find(editor.parentElement!) as InstanceType<typeof Quill>;
  act(() => quill.setSelection(0, 6));
  await userEvent.click(screen.getByRole('button', { name: 'Add link', exact: true }));
  const dialog = screen.getByRole('dialog', { name: 'Add link' });
  expect((within(dialog).getByRole('textbox', { name: 'Text', exact: true }) as HTMLInputElement).value).toBe('Review');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel', exact: true }));
  await waitFor(() => expect(document.activeElement).toBe(editor));
  expect(quill.getSelection()).toEqual({ index: 0, length: 6 });
  await userEvent.click(screen.getByRole('button', { name: 'Bold', exact: true }));
  expect(editor.querySelector('strong')?.textContent).toBe('Review');
  expect(editor.textContent).toBe('Review this text');
  await userEvent.click(screen.getByRole('button', { name: 'Send now' }));
  expect(send.mock.calls[0][1].ops).toContainEqual({ insert: 'Review', attributes: { bold: true } });
});

it('edits the existing selected link and rejects unsafe link URLs without replacing the draft', async () => {
  const { default: Quill } = await import('quill');
  render(<RichComposer channel="links" defaultValue={{ ops: [{ insert: 'Project guide', attributes: { link: 'https://example.test/old' } }, { insert: '\n' }] }} onSend={() => {}} />);
  const editor = await screen.findByRole('textbox', { name: 'Message links' });
  const quill = Quill.find(editor.parentElement!) as InstanceType<typeof Quill>;
  act(() => quill.setSelection(0, 13));
  await userEvent.click(screen.getByRole('button', { name: 'Add link', exact: true }));
  const dialog = screen.getByRole('dialog', { name: 'Add link' });
  const link = within(dialog).getByRole('textbox', { name: 'Link', exact: true });
  expect((link as HTMLInputElement).value).toBe('https://example.test/old');
  await userEvent.clear(link); await userEvent.type(link, 'javascript:alert(1)');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save', exact: true }));
  expect(within(dialog).getByRole('textbox', { name: 'Link', exact: true }).getAttribute('aria-invalid')).toBe('true');
  expect(editor.querySelector('a')?.getAttribute('href')).toBe('https://example.test/old');
  await userEvent.clear(link); await userEvent.type(link, 'https://example.test/new');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save', exact: true }));
  await waitFor(() => expect(editor.querySelector('a')?.getAttribute('href')).toBe('https://example.test/new'));
});

it('sends known emoji shortcodes as matching Unicode text and rich document, preserving code', async () => {
  const send = vi.fn();
  render(<RichComposer channel="emoji" defaultValue={{ops:[{insert:':tada: '},{insert:':tada:',attributes:{code:true}},{insert:'\n'}]}} onSend={send} />);
  await screen.findByRole('textbox', {name:'Message emoji'});
  await userEvent.click(screen.getByRole('button',{name:'Send now',exact:true}));
  expect(send).toHaveBeenCalledWith('🎉 :tada:', expect.objectContaining({ops:expect.arrayContaining([{insert:'🎉 '},{insert:':tada:',attributes:{code:true}}])}), []);
});
it('completes emoji shortcodes with Enter before sending the message', async () => {
  const send = vi.fn();
  render(<RichComposer channel="emoji" onSend={send} />);
  const editor = await screen.findByRole('textbox',{name:'Message emoji'});
  await userEvent.type(editor, 'Hello :rocke');
  await screen.findByRole('listbox',{name:'Emoji suggestions'});
  await userEvent.keyboard('{Enter}');
  expect(send).not.toHaveBeenCalled();
  expect(editor.textContent).toContain('Hello 🚀');
  await userEvent.keyboard('{Enter}');
  expect(send).toHaveBeenCalledWith('Hello 🚀', expect.anything(), []);
});
it('inserts a searched emoji at the saved selection and returns focus to the editor', async () => {
  render(<RichComposer channel="emoji" onSend={() => {}} />);
  const editor = await screen.findByRole('textbox',{name:'Message emoji'});
  await userEvent.type(editor, 'Hello ');
  await userEvent.click(screen.getByRole('button',{name:'Choose emoji'}));
  await userEvent.type(screen.getByRole('searchbox',{name:'Search emoji'}),'rocket');
  await userEvent.click(screen.getByRole('button',{name:'🚀 :rocket:'}));
  expect(editor.textContent).toContain('Hello 🚀');
  expect(document.activeElement).toBe(editor);
});

it('selects a person with Enter before send and keeps their stable mention ID',async()=>{
 const onSend=vi.fn(), person={kind:'user' as const,id:'00000000-0000-4000-8000-000000000001',label:'Kai Nguyen',detail:'Engineer'};
 render(<RichComposer channel="mentions" findMentions={async()=>({items:[person],member_count:2})} onSend={onSend}/>);
 const editor=await screen.findByRole('textbox',{name:'Message mentions'});
 await userEvent.type(editor,'Hi @Kai');
 await screen.findByRole('option',{name:/Kai Nguyen/});
 await userEvent.keyboard('{Enter}');expect(onSend).not.toHaveBeenCalled();
 expect(editor.textContent).toContain('Hi @Kai Nguyen ');
 await userEvent.keyboard('hello{Enter}');
 expect(onSend).toHaveBeenCalledWith('Hi @Kai Nguyen hello',expect.objectContaining({ops:expect.arrayContaining([{insert:'@Kai Nguyen',attributes:{mention:{kind:'user',id:person.id,label:person.label}}}])}),[]);
});
it('confirms a broadcast to six or more members before sending',async()=>{
 const onSend=vi.fn();
 render(<RichComposer channel="broadcast" findMentions={async()=>({items:[{kind:'broadcast',id:'channel',label:'channel',detail:'Everyone'}],member_count:6})} onSend={onSend}/>);
 const editor=await screen.findByRole('textbox',{name:'Message broadcast'});
 await userEvent.type(editor,'@cha');await screen.findByRole('option',{name:/channel/});
 await userEvent.keyboard('{Enter}');await userEvent.keyboard('hello{Enter}');
 expect(onSend).not.toHaveBeenCalled();
 const dialog=await screen.findByRole('dialog',{name:'Notify the channel?'});
 await userEvent.click(within(dialog).getByRole('button',{name:'Send and notify'}));
 expect(onSend).toHaveBeenCalledWith('@channel hello',expect.anything(),[],{broadcast_confirmed:true});
});
it('dismisses mentions with Escape, ignores addresses and code, and deletes a selected identity as one token',async()=>{
 const find=vi.fn(async()=>({items:[{kind:'user' as const,id:'00000000-0000-4000-8000-000000000001',label:'Kai',detail:'Member'}],member_count:2}));
 render(<RichComposer channel="mentions" findMentions={find} onSend={()=>{}}/>);
 const editor=await screen.findByRole('textbox',{name:'Message mentions'});
 await userEvent.type(editor,'@Ka');await screen.findByRole('option',{name:/Kai/});await userEvent.keyboard('{Escape}');
 expect(screen.queryByRole('listbox',{name:'Mention suggestions'})).toBeNull();
 await userEvent.keyboard('{Control>}a{/Control}');
 // Use the mention button to exercise selection restoration, then choose with Tab.
 await userEvent.click(screen.getByRole('button',{name:'Mention someone'}));
 await screen.findByRole('option',{name:/Kai/});await userEvent.keyboard('{Tab}');
 expect(editor.querySelector('[data-mention]')).toBeTruthy();
 await userEvent.keyboard('{Backspace}{Backspace}');expect(editor.querySelector('[data-mention]')).toBeNull();
});
it('does not search for mentions inside an email address or formatted code',async()=>{
 const find=vi.fn(async()=>({items:[],member_count:0}));
 render(<RichComposer channel="literal" findMentions={find} onSend={()=>{}}/>);
 const editor=await screen.findByRole('textbox',{name:'Message literal'});
 await userEvent.type(editor,'person@example.test');
 expect(find).not.toHaveBeenCalled();
 await userEvent.keyboard('{Enter}');
 await userEvent.click(screen.getByRole('button',{name:'Code',exact:true}));
 await userEvent.type(editor,'@Kai');
 expect(find).not.toHaveBeenCalled();
 expect(screen.queryByRole('listbox',{name:'Mention suggestions'})).toBeNull();
});
it('keeps mention completion working when the same composer changes channels',async()=>{
 const find=async()=>({items:[{kind:'user' as const,id:'00000000-0000-4000-8000-000000000001',label:'Kai',detail:'Member'}],member_count:2});
 const view=render(<RichComposer channel="one" findMentions={find} onSend={()=>{}}/>);
 await screen.findByRole('textbox',{name:'Message one'});
 view.rerender(<RichComposer channel="two" findMentions={find} onSend={()=>{}}/>);
 const editor=await screen.findByRole('textbox',{name:'Message two'});await userEvent.type(editor,'@Ka');
 expect(await screen.findByRole('option',{name:/Kai/})).toBeTruthy();
});
