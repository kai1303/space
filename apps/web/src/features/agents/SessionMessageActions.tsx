import { useEffect, useState } from 'react';
import { SessionAgentHandoff } from './SessionAgentHandoff.js';
import { subscribeUpdates } from '../../shared/realtime/live-updates.js';
import { copySessionResponse } from './SessionTranscript.js';
import { Button, Dialog, ListRowSkeleton, Select, toast } from '@space/ui/primitives';
import {
  sessionMessagePath,
  type AgentSessionTurn,
  type AgentSessionSummary,
  type ChatMessage,
  type ChannelSummary,
  type SessionMessagePart,
  type SessionMessageReply,
  type RichDocument,
} from '@space/contracts';
import { request } from '../../shared/api/request.js';

type Target = {
  task: string;
  part: SessionMessagePart;
  text: string;
  author: string;
  expected: string | null;
  path: string;
  link: string;
};
type Mode = 'reply' | 'edit' | 'delete' | 'forward' | 'remind' | 'ask' | 'apps';
type Active = { target: Target; mode: Mode; key: string };
type Options = {
  channel: string;
  canHandoff: boolean;
  session: AgentSessionSummary;
  viewer: string;
  archived: boolean;
  refresh: (task: string) => Promise<void>;
  ask: (text: string, key: string) => Promise<unknown>;
};

export function useSessionMessageActions({
  channel,
  canHandoff,
  session,
  viewer,
  archived,
  refresh,
  ask,
}: Options) {
  const [active, setActive] = useState<Active>();
  function forMessage(turn: AgentSessionTurn, part: SessionMessagePart, message: ChatMessage) {
    const state = turn.message_states?.[part];
    const responseText = turn.response?.messages.map((m) => m.text).join('\n\n');
    const text = part === 'response' ? responseText || message.text : message.text;
    const path = '/agent-sessions/' + session.id + '/turns/' + turn.task.id + '/messages/' + part;
    const link = new URL(sessionMessagePath(session.id, turn.task.id, part) ?? location.pathname, location.origin)
      .href;
    const target: Target = {
      task: turn.task.id,
      part,
      text,
      author: message.author.name,
      expected: state?.edited_text ?? null,
      path,
      link,
    };
    const open = (mode: Mode) => setActive({ mode, target, key: crypto.randomUUID() });
    async function change(action: string, extra: object = {}) {
      await request(path, { action, ...extra }, undefined, 'POST', undefined, viewer);
      await refresh(turn.task.id);
    }
    const own = part === 'request' && turn.task.requester_id === viewer;
    if (state?.deleted_at) return {};
    return {
      onReply: () => {
        open('reply');
        if (state?.unread)
          void change('unread', { active: false }).catch(() => toast.error('Could not mark this thread read'));
      },
      onReact: archived
        ? undefined
        : (emoji: string) => {
            const mine = state?.reactions.find((r) => r.emoji === emoji)?.user_ids.includes(viewer);
            void change('react', { emoji, active: !mine }).catch(() => toast.error('Could not update reaction'));
          },
      actions: {
        forward: () => open('forward'),
        addTodo: () => createTodo(session, viewer, target, crypto.randomUUID()),
        connectApp: canHandoff ? () => open('apps') : undefined,
        askAgent: session.managed && session.state === 'active' && !archived ? () => open('ask') : undefined,
        edit: own && !archived ? () => open('edit') : undefined,
        delete: own ? () => open('delete') : undefined,
        ...(state?.saved
          ? { unsave: () => change('save', { active: false }) }
          : { save: () => change('save', { active: true }) }),
        ...(state?.unread
          ? { markRead: () => change('unread', { active: false }) }
          : { markUnread: () => change('unread', { active: true }) }),
        remind: () => open('remind'),
        ...(state?.following === false
          ? { followReplies: () => change('follow', { active: true }) }
          : { muteReplies: () => change('follow', { active: false }) }),
        copyLink: () => navigator.clipboard.writeText(link),
        copyMessage: () =>
          part === 'response' && turn.transcript_version
            ? copySessionResponse(
                '/agent-sessions/' + session.id + '/turns/' + turn.task.id + '/transcript',
                viewer,
                turn.response,
                text,
              )
            : navigator.clipboard.writeText(text),
        ...(!archived &&
          (state?.pinned
            ? { unpin: () => change('pin', { active: false }) }
            : { pinSession: () => change('pin', { active: true }) })),
      },
    };
  }
  return {
    forMessage,
    dialog:
      active?.mode === 'apps' ? (
        <Dialog open title="Connect to apps" onClose={() => setActive(undefined)}>
          <SessionAgentHandoff
            session={session}
            channel={channel}
            viewer={viewer}
            writable
            turns={[]}
            related={[]}
            initialContext={active.target.text.slice(0, 1800)}
            refresh={() => refresh(active.target.task)}
            onFinish={() => setActive(undefined)}
          />
        </Dialog>
      ) : (
        active && (
          <ActionDialog
            key={active.key}
            active={active}
            session={session}
            viewer={viewer}
            archived={archived}
            ask={ask}
            refresh={refresh}
            onClose={() => setActive(undefined)}
          />
        )
      ),
  };
}

async function createTodo(
  session: AgentSessionSummary,
  viewer: string,
  target: Target,
  id: string,
  date?: string,
) {
  const document: RichDocument = {
    ops: [
      { insert: target.text.slice(0, 3000) + '\n' },
      { insert: 'Open message in Agent Sessions', attributes: { link: target.link } },
    ],
  };
  await request(
    '/workspaces/' + session.workspace_id + '/hub/todos/' + id,
    {
      create_only: true,
      title: target.text.trim().slice(0, 500) || 'Agent Session message',
      document,
      ...(date ? { remind_at: date } : {}),
    },
    undefined,
    'POST',
    undefined,
    viewer,
  );
}

const titles = {
  reply: 'Thread',
  edit: 'Edit message',
  delete: 'Delete message?',
  forward: 'Forward message',
  remind: 'Add a reminder',
  ask: 'Ask an agent',
  apps: 'Connect to apps',
};
function ActionDialog({
  active,
  session,
  viewer,
  archived,
  refresh,
  ask,
  onClose,
}: Omit<Options, 'channel' | 'canHandoff'> & { active: Active; onClose: () => void }) {
  const { key, mode, target } = active;
  const [value, setValue] = useState(mode === 'edit' ? target.text : '');
  const [channels, setChannels] = useState<ChannelSummary[]>([]),
    [destination, setDestination] = useState('');
  const [destinationType, setDestinationType] = useState<'channels' | 'direct-messages'>('channels');
  const [nextChannel, setNextChannel] = useState<string | null>(null);
  const [replies, setReplies] = useState<SessionMessageReply[]>([]),
    [before, setBefore] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const report = (reason: unknown) =>
    setError(reason instanceof Error ? reason.message.replaceAll('_', ' ') : 'Please try again.');
  async function read(after?: string, signal?: AbortSignal) {
    setError('');
    setLoading(true);
    try {
      if (mode === 'forward') {
        const page = await request<{ items: ChannelSummary[]; next_cursor: string | null }>(
          '/workspaces/' +
            session.workspace_id +
            '/' +
            destinationType +
            '?limit=50' +
            (after ? '&after=' + encodeURIComponent(after) : ''),
          undefined,
          undefined,
          undefined,
          signal,
          viewer,
        );
        if (!signal?.aborted) {
          setChannels((old) => [
            ...(after ? old : []),
            ...page.items.filter((c) => c.joined && !c.archived_at && !c.encrypted_since),
          ]);
          setNextChannel(page.next_cursor);
        }
      } else if (mode === 'reply') {
        const page = await request<{ items: SessionMessageReply[]; next: string | null }>(
          target.path + '/replies' + (after ? '?before=' + after : ''),
          undefined,
          undefined,
          undefined,
          signal,
          viewer,
        );
        if (!signal?.aborted) {
          setReplies((old) => [...page.items, ...(after ? old : [])]);
          setBefore(page.next);
        }
      }
    } catch (reason) {
      if (!signal?.aborted) report(reason);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    const ctl = new AbortController();
    const load = () => read(undefined, ctl.signal);
    const stop =
      mode === 'reply' ? subscribeUpdates('thread', session.origin_thread_id, load, onClose) : undefined;
    if (!stop) void load();
    return () => {
      ctl.abort();
      stop?.();
    };
  }, [attempt, destinationType]);
  const [replyKey, setReplyKey] = useState(key);
  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (mode === 'remind') await createTodo(session, viewer, target, key, new Date(value).toISOString());
      else if (mode === 'forward')
        await request(
          '/channels/' + destination + '/messages',
          {
            client_message_id: key,
            text: [value.trim(), target.author + ' wrote:\n' + target.text.slice(0, 9000), target.link]
              .filter(Boolean)
              .join('\n\n'),
          },
          undefined,
          'POST',
          undefined,
          viewer,
        );
      else if (mode === 'ask')
        await ask(
          value.trim() +
            '\n\n' +
            target.author +
            ' wrote:\n' +
            target.text.slice(0, Math.max(0, 3850 - value.length)),
          key,
        );
      else {
        await request(
          target.path,
          {
            action: mode,
            ...(mode === 'edit'
              ? { text: value, expected: target.expected }
              : mode === 'reply'
                ? { text: value, id: replyKey }
                : {}),
          },
          undefined,
          'POST',
          undefined,
          viewer,
        );
        if (mode === 'reply') {
          setValue('');
          setReplyKey(crypto.randomUUID());
          await read();
        }
        await refresh(target.task);
      }
      if (mode !== 'reply') onClose();
    } catch (reason) {
      report(reason);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open title={titles[mode]} onClose={onClose} onBeforeClose={() => !busy}>
      <form
        className="session-message-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {mode !== 'edit' && (
          <blockquote>
            <strong>{target.author}</strong>
            <p>{target.text}</p>
          </blockquote>
        )}
        {mode === 'reply' && (
          <>
            <div className="session-replies" aria-label="Replies">
              {before && (
                <Button type="button" disabled={loading} onClick={() => void read(before)}>
                  Earlier replies
                </Button>
              )}
              {replies.map((r) => (
                <p key={r.id}>
                  <strong>{r.author}</strong>
                  <br />
                  {r.body}
                </p>
              ))}
            </div>
          </>
        )}
        {mode === 'forward' && (
          <>
            <label>
              Conversation type
              <Select
                aria-label="Conversation type"
                value={destinationType}
                onChange={(e) => {
                  setChannels([]);
                  setDestination('');
                  setNextChannel(null);
                  setDestinationType(e.target.value as typeof destinationType);
                }}
              >
                <option value="channels">Channels</option>
                <option value="direct-messages">Direct messages</option>
              </Select>
            </label>
            <label>
              Forward to
              <Select
                aria-label="Forward to"
                required
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
              >
                <option value="">Choose a conversation</option>
                {channels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </label>
            {nextChannel && (
              <Button type="button" disabled={loading} onClick={() => void read(nextChannel)}>
                More conversations
              </Button>
            )}
          </>
        )}
        {mode === 'remind' ? (
          <label>
            Remind me at
            <input type="datetime-local" required value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
        ) : (
          mode !== 'delete' &&
          !(mode === 'reply' && archived) && (
            <label>
              {mode === 'reply'
                ? 'Reply'
                : mode === 'ask'
                  ? 'Question'
                  : mode === 'forward'
                    ? 'Add a note (optional)'
                    : 'Message'}
              <textarea
                autoFocus
                required={mode !== 'forward'}
                maxLength={mode === 'ask' ? 2000 : 4000}
                value={value}
                onChange={(e) => setValue(e.target.value)}
              />
            </label>
          )
        )}
        {error && (
          <p role="alert">
            {error}{' '}
            {['forward', 'reply'].includes(mode) && (
              <button type="button" onClick={() => setAttempt((n) => n + 1)}>
                Reload
              </button>
            )}
          </p>
        )}
        <div>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            {mode === 'reply' ? 'Close' : 'Cancel'}
          </Button>
          {!(mode === 'reply' && archived) && (
            <Button
              type="submit"
              disabled={busy || (mode === 'forward' ? !destination : mode === 'delete' ? false : !value.trim())}
            >
              {mode === 'edit'
                ? 'Save changes'
                : mode === 'delete'
                  ? 'Delete'
                  : mode === 'reply'
                    ? 'Reply'
                    : mode === 'ask'
                      ? 'Ask'
                      : mode === 'forward'
                        ? 'Forward'
                        : 'Set reminder'}
            </Button>
          )}
        </div>
      </form>
    </Dialog>
  );
}

export function SessionPins({
  session,
  viewer,
  onClose,
  onOpen,
}: {
  session: AgentSessionSummary;
  viewer: string;
  onClose: () => void;
  onOpen: (task: string, part: SessionMessagePart) => void;
}) {
  type Pin = { id: string; task_id: string; part: SessionMessagePart; excerpt: string };
  const [items, setItems] = useState<Pin[]>([]),
    [next, setNext] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [loadedDepth, setLoadedDepth] = useState(0);
  const [depth, setDepth] = useState(1),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setLoading(true);
      setError('');
      try {
        const pins: Pin[] = [];
        let cursor: string | null = null;
        for (let i = 0; i < depth; i++) {
          const page: { items: Pin[]; next: string | null } = await request(
            '/agent-sessions/' + session.id + '/message-pins' + (cursor ? '?after=' + cursor : ''),
            undefined,
            undefined,
            undefined,
            controller.signal,
            viewer,
          );
          pins.push(...page.items);
          cursor = page.next;
          if (!cursor) break;
        }
        if (!controller.signal.aborted) {
          setLoadedDepth(depth);
          setItems(pins);
          setNext(cursor);
          setError('');
        }
      } catch {
        if (!controller.signal.aborted) setError('Could not load pinned messages.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    const stop = subscribeUpdates('thread', session.origin_thread_id, load, onClose);
    return () => {
      controller.abort();
      stop();
    };
  }, [session.id, session.origin_thread_id, viewer, depth, attempt]);
  return (
    <Dialog open title="Pinned messages" onClose={onClose}>
      <div className="session-message-dialog">
        {items.map((pin) => (
          <button className="session-pin" type="button" key={pin.id} onClick={() => onOpen(pin.task_id, pin.part)}>
            {pin.excerpt}
          </button>
        ))}
        {error ? (
          <p role="alert">
            {error} <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
          </p>
        ) : !loadedDepth ? (
          <ListRowSkeleton label="Loading pins…"/>
        ) : items.length === 0 ? (
          <p>No pinned messages in this session.</p>
        ) : null}
        {next && (
          <Button loading={loading && depth > loadedDepth} disabled={loading || !!error} onClick={() => setDepth((n) => n + 1)}>
            More pinned messages
          </Button>
        )}
      </div>
    </Dialog>
  );
}
