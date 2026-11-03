import { AnimatePresence } from 'motion/react';
import { useState } from "react";
import {
  SidePanel,
  Avatar,
  Badge,
  ChannelItem,
  RichComposer,
  RichContent,
  IconButton,
  Message,
  Tabs,
  type Reaction,
  type RichDocument,
  type Attachment,
} from "@space/ui";
import {
  CaretDown,
  ChatCircle,
  Hash,
  Lock,
  Sparkle,
  Users,
  X,
} from "@phosphor-icons/react";
import { SectionHeading } from "./Foundations.js";

export function Conversation() {
  const [channel, setChannel] = useState("design-system");
  const [view, setView] = useState("messages");
  const [thread, setThread] = useState(false);
  const [messages, setMessages] = useState<{ id: string; channel: string; document: RichDocument; attachments: Attachment[] }[]>(
    [],
  );
  const [replies, setReplies] = useState<{ id: string; document: RichDocument; attachments: Attachment[] }[]>([]);
  const [drafts, setDrafts] = useState<Record<string, RichDocument>>({});
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, Attachment[]>>({});
  const [reactions, setReactions] = useState<Reaction[]>([
    { emoji: "🙌", count: 4 },
    { emoji: "💜", count: 2, active: true },
  ]);
  function selectChannel(next: string) {
    setChannel(next);
    setView("messages");
    setThread(false);
  }
  const react = (emoji: string) =>
    setReactions((previous) =>
      previous.map((r) =>
        r.emoji === emoji
          ? { ...r, count: r.count + (r.active ? -1 : 1), active: !r.active }
          : r,
      ),
    );
  return (
    <section id="patterns" className="ds-section">
      <SectionHeading
        number="03"
        title="Better together"
        description="A few building blocks. One familiar conversation."
      />
      <div className="pattern-label">
        <span>
          <span className="live-dot" />
          INTERACTIVE PATTERN
        </span>
        <span>Try a reaction, send a message, or open a thread.</span>
      </div>
      <div
        className={`workspace-preview ${thread ? "workspace-preview--thread" : ""}`}
      >
        <aside className="preview-sidebar">
          <div className="preview-workspace-name">
            Space studio
            <CaretDown size={14} />
          </div>
          <div className="preview-sidebar-label">Channels</div>
          <ChannelItem
            name="general"
            selected={channel === "general"}
            icon={<Hash size={16} />}
            onClick={() => selectChannel("general")}
          />
          <ChannelItem
            name="design-system"
            selected={channel === "design-system"}
            icon={<Hash size={16} />}
            onClick={() => selectChannel("design-system")}
          />
          <ChannelItem
            name="engineering"
            selected={channel === "engineering"}
            unread={3}
            icon={<Hash size={16} />}
            onClick={() => selectChannel("engineering")}
          />
          <ChannelItem
            name="team-private"
            selected={channel === "team-private"}
            icon={<Lock size={14} />}
            onClick={() => selectChannel("team-private")}
          />
          <div className="preview-sidebar-label">Direct messages</div>
          <ChannelItem
            name="Alex Morgan"
            selected={channel === "alex-morgan"}
            icon={<span className="live-dot" />}
            onClick={() => selectChannel("alex-morgan")}
          />
          <ChannelItem
            name="Space assistant"
            selected={channel === "space-assistant"}
            icon={<Sparkle size={15} />}
            onClick={() => selectChannel("space-assistant")}
          />
          <div className="preview-demo-note">
            A little preview.
            <br />A lot of possibilities.
          </div>
        </aside>
        <div className="preview-conversation">
          <div className="preview-channel-header">
            <div>
              <Hash size={20} />
              <strong>{channel}</strong>
            </div>
            <div className="preview-member">
              <Avatar name="Alex Morgan" initials="AM" size="sm" />
              <Avatar name="Jamie Chen" initials="JC" size="sm" tone="orange" />
              <span>8</span>
            </div>
          </div>
          <Tabs
            label="Preview channel views"
            value={view}
            onChange={setView}
            items={[
              {
                id: "messages",
                label: "Messages",
                icon: <ChatCircle size={14} />,
                panelId: "conversation-panel",
              },
              {
                id: "about",
                label: "About",
                icon: <Users size={14} />,
                panelId: "conversation-panel",
              },
            ]}
          />
          <div
            id="conversation-panel"
            role="tabpanel"
            aria-label={view}
            className="preview-history"
            tabIndex={0}
          >
            {view === "about" ? (
              <div className="preview-about">
                <Hash size={28} />
                <h3>#{channel}</h3>
                <p>A shared space to make progress, together.</p>
                <Badge tone="accent">Demo channel</Badge>
              </div>
            ) : (
              <>
                <div className="date-divider">
                  <span>Tuesday, November 3</span>
                </div>
                {channel === "design-system" ? (
                  <>
                    <Message
                      author="Alex Morgan"
                      initials="AM"
                      time="10:42 AM"
                      reactions={reactions}
                      onReact={react}
                      onReply={() => setThread(true)}
                      replyCount={2 + replies.length}
                    >
                      A little consistency goes a long way.
                      <br />
                      Here's the first look at our shared design language. What
                      do you think?
                    </Message>
                    <Message
                      author="Jamie Chen"
                      initials="JC"
                      tone="orange"
                      time="10:44 AM"
                    >
                      Feels like home already. Love the attention to the small
                      details.
                    </Message>
                    <Message
                      author="Space assistant"
                      initials="S"
                      tone="green"
                      agent
                      time="10:45 AM"
                    >
                      <span>Foundations are ready to explore.</span>
                      <div className="agent-result">
                        <CheckMark />
                        <span>
                          Colors, typography, and components are all in sync.
                        </span>
                      </div>
                    </Message>
                  </>
                ) : (
                  <Message author="Alex Morgan" initials="AM" time="10:42 AM">
                    Welcome to {channel}. This is a local demo—try sending a
                    message below.
                  </Message>
                )}
                {messages
                  .filter((m) => m.channel === channel)
                  .map((message) => (
                    <Message
                      key={message.id}
                      author="You"
                      initials="YO"
                      tone="blue"
                      time="Just now"
                    >
                      <RichContent document={message.document} />
                      {message.attachments.map((file) => <div key={file.id} className="preview-attachment">{file.name}</div>)}
                    </Message>
                  ))}
              </>
            )}
          </div>
          {view === "messages" && (
            <div id="chat-composer" className="preview-rich-composer"><RichComposer
              key={channel}
              channel={channel}
              defaultValue={drafts[channel]}
              defaultAttachments={attachmentDrafts[channel]}
              onDraftChange={(document) => setDrafts((old) => ({ ...old, [channel]: document }))}
              onAttachmentsChange={(attachments) => setAttachmentDrafts((old) => ({ ...old, [channel]: attachments }))}
              mentions={["Alex Morgan", "Jamie Chen", "Sam Rivera", "Space assistant"]}
              onSend={(_text, document, attachments) =>
                setMessages((previous) => [...previous, { id: crypto.randomUUID(), channel, document, attachments }])
              }
            /></div>
          )}
        </div>
        <AnimatePresence>{thread && (
          <SidePanel key="thread" className="preview-thread">
            <div className="preview-thread-header">
              <strong>Thread</strong>
              <IconButton label="Close thread" onClick={() => setThread(false)}>
                <X size={18} />
              </IconButton>
            </div>
            <div className="thread-history">
              <Message author="Alex Morgan" initials="AM" time="10:42 AM">
                A little consistency goes a long way.
              </Message>
              <div className="thread-divider">{2 + replies.length} replies</div>
              <Message
                author="Jamie Chen"
                initials="JC"
                tone="orange"
                time="10:44 AM"
              >
                The details really make it.
              </Message>
              <Message
                author="Sam Rivera"
                initials="SR"
                tone="blue"
                time="10:46 AM"
              >
                Ready to build with this.
              </Message>
              {replies.map((reply) => (
                <Message key={reply.id} author="You" initials="YO" time="Just now">
                  <RichContent document={reply.document} />
                  {reply.attachments.map((file) => <div key={file.id} className="preview-attachment">{file.name}</div>)}
                </Message>
              ))}
            </div>
            <div className="preview-rich-composer"><RichComposer
              key={`thread:${channel}`}
              channel="thread"
              defaultValue={drafts[`thread:${channel}`]}
              defaultAttachments={attachmentDrafts[`thread:${channel}`]}
              onDraftChange={(document) => setDrafts((old) => ({ ...old, [`thread:${channel}`]: document }))}
              onAttachmentsChange={(attachments) => setAttachmentDrafts((old) => ({ ...old, [`thread:${channel}`]: attachments }))}
              mentions={["Alex Morgan", "Jamie Chen", "Sam Rivera"]}
              onSend={(_text, document, attachments) => setReplies((previous) => [...previous, { id: crypto.randomUUID(), document, attachments }])}
            /></div>
          </SidePanel>
        )}</AnimatePresence>
      </div>
      <div className="pattern-caption">
        <span>
          <Lock size={12} />
          Local demo · synthetic content
        </span>
        <span>ChannelItem + Message + Avatar + RichComposer</span>
      </div>
    </section>
  );
}
function CheckMark() {
  return <span className="result-check">✓</span>;
}
