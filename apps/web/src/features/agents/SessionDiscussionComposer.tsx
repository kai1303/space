import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { documentMentions, type RichDocument, type SessionMentionOption } from '@space/contracts';
import { Button, Dialog, toast } from '@space/ui/primitives';
import { Reveal } from '@space/ui/motion';
import { ConversationComposer } from '../chat/ThreadConversation.js';
import { request } from '../../shared/api/request.js';
import { invalidateUpdates } from '../../shared/realtime/live-updates.js';

type Options = { items: SessionMentionOption[]; member_count: number };

export function SessionDiscussionComposer({ primary, session, viewer, channel, recipient, writable, draft, onDraftChange, mentionRequest, onMentionOpened, post }: {
  primary?: boolean; session: string; viewer: string; channel: string; recipient: ReactNode; writable: boolean;
  draft: RichDocument | null; onDraftChange: (document: RichDocument | null) => void; mentionRequest: number;
  onMentionOpened: () => void; post: (text: string, document?: RichDocument) => Promise<void>;
}) {
  const base = '/agent-sessions/' + session + '/team';
  const find = useCallback((query: string) => request<Options>(base + '/mentions?q=' + encodeURIComponent(query),
    undefined, undefined, undefined, undefined, viewer), [base, viewer]);
  const [sent, setSent] = useState<string[]>([]);
  const [options, setOptions] = useState<SessionMentionOption[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [pending, setPending] = useState('');
  const [dismissed, setDismissed] = useState<string[]>([]);
  const activeDraft = useRef(draft);
  activeDraft.current = draft;
  const targets = sent.join(',');
  const [confirmation, setConfirmation] = useState<{document: RichDocument; people: SessionMentionOption[]}>();
  const [confirmError, setConfirmError] = useState('');
  const sessionAlive = useRef(true);
  useEffect(() => {
    sessionAlive.current = true;
    return () => { sessionAlive.current = false; };
  }, []);

  async function beforeSend(document: RichDocument) {
    const refs = documentMentions(document);
    if (!refs.length || !document.ops.every(op => op.attributes?.mention?.kind === 'user' || /^[\s,]*$/.test(op.insert))) return true;
    const ids = refs.map(ref => ref.id);
    const result = await request<Options>(base + '/mentions?ids=' + encodeURIComponent(ids.join(',')), undefined, undefined, undefined, undefined, viewer);
    if (!sessionAlive.current) return false;
    const people = ids.map(id => result.items.find(item => item.id === id));
    if (!people.every((person): person is SessionMentionOption => !!person && person.joined === false)) return true;
    if (!people.every(person => person.invite_channel) && !people.every(person => person.can_invite_reviewer)) return true;
    setConfirmError('');
    setConfirmation({document, people});
    return false;
  }

  useEffect(() => {
    setOptions([]); setError('');
    setDismissed(previous => previous.filter(id => targets.split(',').includes(id)));
    if (!targets || !writable) return;
    const controller = new AbortController();
    void request<Options>(base + '/mentions?ids=' + encodeURIComponent(targets), undefined, undefined, undefined, controller.signal, viewer)
      .then(result => { if (!controller.signal.aborted) setOptions(result.items.filter(item => item.can_invite_reviewer || item.invite_channel)); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not check who can be invited.'); });
    return () => controller.abort();
  }, [targets, base, viewer, writable, retry]);

  async function add(person: SessionMentionOption, toChannel: boolean) {
    if (toChannel) await request('/channels/' + channel + '/members', {user_id:person.id}, undefined, 'POST', undefined, viewer);
    else await request(base + '/reviewers/' + person.id, {}, undefined, 'PUT', undefined, viewer);
  }

  async function invite(person: SessionMentionOption, toChannel: boolean) {
    if (pending) return;
    setPending(person.id); setError('');
    try {
      await add(person, toChannel);
      toast.success(toChannel ? 'Added to #' + person.invite_channel : 'Reviewer invited');
      setSent(items => items.filter(id => id !== person.id));
      await invalidateUpdates('session-team', session);
    } catch { setError('Could not invite ' + person.label + '. Try again.'); }
    finally { setPending(''); }
  }

  async function confirm(choice: 'send' | 'channel' | 'reviewer') {
    if (!confirmation || pending || !writable) return;
    const {document, people} = confirmation;
    setPending(choice); setConfirmError('');
    const remaining = [...people];
    try {
      if (choice === 'send') await post(document.ops.map(op => op.insert).join('').trim(), document);
      else {
        for (const person of people) {
          await add(person, choice === 'channel');
          remaining.shift();
        }
        toast.success(choice === 'channel' ? 'Added to #' + people[0]!.invite_channel : 'Review invitation sent');
        await invalidateUpdates('session-team', session);
      }
      if (!sessionAlive.current) return;
      if (JSON.stringify(activeDraft.current) === JSON.stringify(document)) onDraftChange(null);
      setConfirmation(undefined);
    } catch {
      if (remaining.length < people.length) setConfirmation({document, people:remaining});
      setConfirmError(choice === 'send' ? 'Could not send the message. Try again.' : 'Could not finish the invitation. Try again.');
    } finally { setPending(''); }
  }

  const visible = options.filter(person => !dismissed.includes(person.id) && sent.includes(person.id));
  const people = confirmation?.people ?? [];
  const toChannel = people.length > 0 && people.every(person => person.invite_channel);
  const reviewers = people.length > 0 && people.every(person => person.can_invite_reviewer);
  const names = new Intl.ListFormat(undefined, {type:'conjunction'}).format(people.map(person => person.label));
  const destination = toChannel ? '#' + people[0]!.invite_channel : 'this review room';
  return <><ConversationComposer primary={primary} conversationKey={'session:' + channel + ':' + session + ':team'}
    channel="team discussion" placeholder="Message teammates and reviewers…" plainText
    mentionRequest={mentionRequest} onMentionOpened={onMentionOpened} outsideMentionLabel="Outside this discussion"
    controls={{attachmentsEnabled:false, formattingEnabled:false, findMentions:find}} sendDisabled={!writable} maxLength={4000}
    beforeSend={beforeSend} draftValue={draft} onDraftChange={onDraftChange} typingIndicator={<>{recipient}<Reveal open={writable && Boolean(visible.length || error)}>
      <div className="session-mention-invites" aria-label="Mention invitations">
        {visible.map(person => <div key={person.id} className="session-mention-invite">
          <span><strong>{person.label}</strong> is outside this discussion.</span>
          <div>{person.can_invite_reviewer && <Button size="sm" disabled={!!pending} title="Share the team discussion and review outputs" onClick={()=>void invite(person,false)}>Invite as reviewer</Button>}
          {person.invite_channel && <Button size="sm" disabled={!!pending} title="Grant access to the source channel and its history" onClick={()=>void invite(person,true)}>Add to #{person.invite_channel}</Button>}
          <Button size="sm" variant="ghost" disabled={!!pending} onClick={()=>setDismissed(items=>[...items,person.id])}>Dismiss</Button></div>
        </div>)}
        {error && <p role="alert">{error} <Button size="sm" onClick={()=>setRetry(n=>n+1)}>Refresh</Button></p>}
      </div>
    </Reveal></>} onSend={async (text, document) => {
      const ids = documentMentions(document).map(ref=>ref.id);
      await post(text, ids.length ? document : undefined);
      setSent(previous=>[...new Set([...ids,...previous])].slice(0,50));
      if (JSON.stringify(activeDraft.current)===JSON.stringify(document)) onDraftChange(null);
    }}/>
    {confirmation && writable && <Dialog open title={people.length === 1 ? 'Want to add this person instead?' : 'Want to add these people instead?'}
      onBeforeClose={()=>!pending} onClose={()=>setConfirmation(undefined)}>
      <div className="session-mention-confirmation">
        <p><strong>{names}</strong> {people.length === 1 ? 'isn’t' : 'aren’t'} in <strong>{destination}</strong> yet.
          {toChannel ? ' You can add them to the channel or send your message to the session.' : ' You can invite them to review shared outputs or send your message to the session.'}</p>
        {toChannel && reviewers && <button type="button" className="session-review-invite-link" disabled={!!pending} onClick={()=>void confirm('reviewer')}>Invite as reviewer instead</button>}
        {confirmError && <p role="alert">{confirmError}</p>}
        <div className="session-mention-confirm-actions">
          <Button disabled={!!pending} onClick={()=>void confirm('send')}>Send This Message</Button>
          <Button variant="primary" data-dialog-initial-focus disabled={!!pending} onClick={()=>void confirm(toChannel ? 'channel' : 'reviewer')}>{toChannel ? 'Add to Channel' : 'Invite to Review'}</Button>
        </div>
      </div>
    </Dialog>}
  </>;
}
