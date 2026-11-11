import { useEffect, useState } from "react";
import { useAnimate, useReducedMotion } from "motion/react";
import { Avatar, Badge, Button, Dialog, IconButton, Menu, Skeleton, Select, Switch, Tabs, TextField, toast } from '@space/ui/primitives';
import { Message, type Reaction } from '@space/ui/conversation';
import { RichComposer } from '@space/ui/composer';
import { RichContent, documentText, type RichDocument } from '@space/ui/rich-text';
import { motionTransition } from '@space/ui/motion';
import {
  ArrowRight,
  Bell,
  Check,
  Copy,
  Gear,
  Hash,
  Plus,
  Sparkle,
  Star,
  Trash,
} from "@phosphor-icons/react";
import { SectionHeading } from "./Foundations.js";

export function Components({ notify }: { notify: (text: string) => void }) {
  const [notifications, setNotifications] = useState(true);
  const [suggestions, setSuggestions] = useState(false);
  const [sort, setSort] = useState("newest");
  const [zone, setZone] = useState("Asia/Saigon");
  const [tab, setTab] = useState("messages");
  const [tabPanel, animateTabPanel] = useAnimate<HTMLDivElement>();
  const reduced = useReducedMotion();
  useEffect(() => {
    if (!tabPanel.current || reduced) return;
    const animation = animateTabPanel(tabPanel.current, { opacity: [0, 1] }, motionTransition(reduced));
    return () => animation.stop();
  }, [tab, reduced, tabPanel, animateTabPanel]);
  const [dialog, setDialog] = useState(false);
  const [name, setName] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [createdChannels, setCreatedChannels] = useState<string[]>([]);
  const [exampleArchived, setExampleArchived] = useState(false);
  const [received, setReceived] = useState(0);
  const [arrivalStyle, setArrivalStyle] = useState<"fade" | "glide">("glide");
  const [messageReactions, setMessageReactions] = useState<Reaction[]>([]);
  const [actionDocument, setActionDocument] = useState<RichDocument>({ ops: [{ insert: 'Review the message actions. Select text in the composer below to format it.\n' }] });
  const valid = /^[a-z0-9][a-z0-9-]{0,79}$/.test(name);
  return (
    <section id="components" className="ds-section">
      <SectionHeading
        number="02"
        title="Components"
        description="Familiar pieces. Predictable interactions. Ready to compose."
      />
      <div className="component-grid">
        <Sample
          id="buttons"
          title="Buttons"
          detail="Clear intent, at every size"
          count="01"
        >
          <div className="sample-row">
            <Button
              variant="primary"
              onClick={() => notify("Primary action selected")}
            >
              <Plus size={16} />
              Create channel
            </Button>
            <Button onClick={() => notify("Secondary action selected")}>
              View details
            </Button>
            <IconButton
              label="Save example"
              onClick={() => notify("Example saved")}
            >
              <Star size={19} />
            </IconButton>
          </div>
          <div className="sample-row">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => notify("Ghost action selected")}
            >
              Explore components
              <ArrowRight size={14} />
            </Button>
            <Button size="sm" disabled>
              Unavailable
            </Button>
            <Button size="sm" loading>
              Saving
            </Button>
          </div>
          <div className="sample-footer">
            <code>primary</code>
            <code>secondary</code>
            <code>ghost</code>
            <code>disabled</code>
          </div>
        </Sample>
        <Sample
          id="inputs"
          title="Inputs & selection"
          detail="Honest feedback, built in"
          count="02"
        >
          <TextField
            label="Channel name"
            placeholder="e.g. design-system"
            hint="Keep it short, specific, and easy to find."
          />
          <label className="sp-field">Sort files
            <Select aria-label="Sort files" value={sort} onChange={event => setSort(event.target.value)}>
              <option value="newest">Newest shared</option><option value="oldest">Oldest shared</option>
            </Select>
          </label>
          <label className="sp-field">Time zone
            <Select searchable aria-label="Time zone" value={zone} onChange={event => setZone(event.target.value)}>
              {Intl.supportedValuesOf('timeZone').map(zone => <option key={zone}>{zone}</option>)}
            </Select>
          </label>
          <div className="sample-switches">
            <Switch
              label="Desktop notifications"
              checked={notifications}
              onChange={setNotifications}
            />
            <Switch
              label="Agent suggestions"
              checked={suggestions}
              onChange={setSuggestions}
            />
          </div>
        </Sample>
        <Sample
          id="avatars"
          title="Avatars & presence"
          detail="People and agents, together"
          count="03"
        >
          <div className="sample-avatars">
            <Avatar
              name="Alex Morgan"
              initials="AM"
              size="lg"
              presence="online"
            />
            <Avatar
              name="Jamie Chen"
              initials="JC"
              tone="orange"
              presence="away"
            />
            <Avatar
              name="Sam Rivera"
              initials="SR"
              tone="blue"
              presence="offline"
            />
            <Avatar name="Robin Lee" initials="RL" tone="green" size="sm" />
            <span className="agent-avatar">
              <Sparkle size={23} weight="fill" />
            </span>
          </div>
          <div className="sample-row presence-legend">
            <span>
              <i className="legend-dot online" />
              Online
            </span>
            <span>
              <i className="legend-dot away" />
              Away
            </span>
            <span>
              <i className="legend-dot offline" />
              Offline
            </span>
            <span>
              <Badge>Agent</Badge>Agent
            </span>
          </div>
        </Sample>
        <Sample
          id="badges"
          title="Status & feedback"
          detail="Meaning beyond color"
          count="04"
        >
          <div className="sample-row badge-examples">
            <Badge tone="success" dot>
              Connected
            </Badge>
            <Badge tone="warning" dot>
              Needs approval
            </Badge>
            <Badge tone="info" dot>
              In progress
            </Badge>
            <Badge tone="danger" dot>
              Failed
            </Badge>
            <Badge tone="accent">Agent</Badge>
            <Badge>Draft</Badge>
          </div>
          <div className="inline-notice">
            <Check size={17} />
            <div>
              <strong>You're all caught up.</strong>
              <span>All changes have been saved.</span>
            </div>
          </div>
        </Sample>
        <Sample
          id="navigation"
          title="Navigation"
          detail="A clear sense of place"
          count="05"
        >
          <Tabs
            label="Example channel views"
            value={tab}
            onChange={setTab}
            items={[
              {
                id: "messages",
                label: "Messages",
                panelId: "sample-tab-panel",
              },
              { id: "files", label: "Files", panelId: "sample-tab-panel" },
              { id: "about", label: "About", panelId: "sample-tab-panel" },
            ]}
          />
          <div
            ref={tabPanel}
            id="sample-tab-panel"
            role="tabpanel"
            aria-label={tab}
            tabIndex={0}
            className="sample-tab-panel"
          >
            {tab === "messages" ? (
              <>
                <Hash size={18} />
                <span>A conversation worth having.</span>
                <Badge>12</Badge>
              </>
            ) : tab === "files" ? (
              <>
                <Copy size={18} />
                <span>Brand guidelines.pdf</span>
                <Badge>PDF</Badge>
              </>
            ) : (
              <>
                <Bell size={18} />
                <span>A shared home for the design team.</span>
              </>
            )}
          </div>
          <span className="ds-muted">Use ← → to move between tabs.</span>
        </Sample>
        <Sample
          id="overlays"
          title="Menus & dialogs"
          detail="The right action, close at hand"
          count="06"
        >
          <div className="sample-row">
            <Button
              onClick={() => {
                setDialog(true);
                setSubmitted(false);
              }}
            >
              <Plus size={16} />
              Open dialog
            </Button>
            <Menu
              label="More actions"
              items={[
                {
                  label: "Channel settings",
                  icon: <Gear size={16} />,
                  onSelect: () => notify("Settings action selected"),
                },
                {
                  label: "Copy channel name",
                  icon: <Copy size={16} />,
                  onSelect: () => {
                    void navigator.clipboard
                      .writeText("design-system")
                      .then(() => notify("Channel name copied"))
                      .catch(() => notify("Clipboard unavailable"));
                  },
                },
                {
                  label: "Archive example",
                  icon: <Trash size={16} />,
                  danger: true,
                  onSelect: () => notify("Demo archive action selected"),
                },
              ]}
            />
          </div>
          {createdChannels.length > 0 && (
            <div className="sample-row" aria-label="Created demo channels">
              {createdChannels.map((channel) => (
                <Badge key={channel} tone="info">
                  #{channel}
                </Badge>
              ))}
            </div>
          )}
          <div
            className="skeleton-example"
            role="status"
            aria-label="Loading preview"
          >
            <Skeleton width={30} height={30} />
            <div>
              <Skeleton width="60%" />
              <Skeleton width="90%" height={10} />
            </div>
            <span>Loading state</span>
          </div>
          <span className="ds-muted">
            Keyboard accessible. Escape to dismiss.
          </span>
        </Sample>
        <Sample
          id="message-motion"
          title="Message arrivals"
          detail="Choose an entrance and replay it"
          count="07"
        >
          <div className="sample-row">
            <Select aria-label="Message arrival motion" value={arrivalStyle} onChange={event => {
              setArrivalStyle(event.target.value === "glide" ? "glide" : "fade");
              setReceived(count => count + 1);
            }}>
              <option value="glide">Glide in</option>
              <option value="fade">Fade in</option>
            </Select>
            <Button onClick={() => setReceived(count => count + 1)}>Receive a message</Button>
          </div>
          <Message
            key={received}
            author="Jamie Chen"
            initials="JC"
            tone="orange"
            time={received ? "Just now" : "10:44 AM"}
            arrival={received > 0 && arrivalStyle}
          >
            {received
              ? ["The latest updates look good!", "Ready when you are.", "Thanks for the update 🙌"][(received - 1) % 3]
              : "Click above to preview an incoming message."}
          </Message>
          <span className="ds-muted">Local preview · respects reduced motion.</span>
        </Sample>
        <Sample id="message-actions" title="Message actions" detail="Captured from Slack: hover toolbar and More menu" count="08">
          <Message author="Kai" initials="KA" time="Just now" reactions={messageReactions}
            onReact={emoji => setMessageReactions(previous => {
              const current = previous.find(item => item.emoji === emoji);
              return current ? previous.map(item => item.emoji === emoji ? { ...item, active: !item.active, count: item.active ? 0 : 1 } : item).filter(item => item.count > 0) : [...previous, { emoji, count: 1, active: true }];
            })}
            onReply={() => notify('Preview: reply in thread selected')}
            actions={{
              forward: () => notify('Preview: forward message selected'),
              addTodo: () => {},
              askAgent: () => notify('Preview: ask an agent selected'),
              edit: () => notify('Preview: edit message selected'),
              markUnread: () => notify('Preview: mark unread selected'),
              save: () => {},
              remind: () => notify('Preview: add a reminder selected'),
              toggleReplyNotifications: () => notify('Preview: reply notifications selected'),
              copyLink: () => navigator.clipboard.writeText(`${location.origin}/design-system#message-actions`),
              copyMessage: () => navigator.clipboard.writeText(documentText(actionDocument).trimEnd()),
              pin: () => notify('Preview: pin to channel selected'),
              connectApp: () => notify('Preview: connect to apps selected'),
              delete: () => notify('Preview: delete message selected'),
            }}>
            <RichContent document={actionDocument} />
          </Message>
          <RichComposer channel="message-actions" defaultValue={actionDocument} attachmentsEnabled={false} onSend={(_text, document) => setActionDocument(document)} />
          <span className="ds-muted">Interactive component preview. Application actions are supplied by the caller.</span>
        </Sample>
        <Sample id="toasts" title="Toasts" detail="Preview feedback for an action" count="09">
          <div className="sample-row">
            <Button onClick={() => toast.warning('Your connection is offline', { description: 'Reconnect to send messages.' })}>Preview warning</Button>
            <Button onClick={() => toast.loading('Uploading example file…', {
              progress: 0,
              action: { label: 'Advance', onClick: () => ({
                progress: 0.5, meta: '50%',
                action: { label: 'Finish', onClick: () => ({
                  type: 'success', title: 'Example file uploaded', progress: null, meta: null,
                }) },
              }) },
            })}>Preview upload</Button>
            <Button onClick={() => {
              if (exampleArchived) {
                setExampleArchived(false);
                toast.success('Example restored');
                return;
              }
              setExampleArchived(true);
              toast.success('Example archived', { action: {
                label: 'Undo',
                onClick: () => {
                  setExampleArchived(false);
                  return { type: 'success', title: 'Example restored' };
                },
              } });
            }}>{exampleArchived ? 'Restore example' : 'Archive example'}</Button>
          </div>
        </Sample>
      </div>
      <Dialog
        open={dialog}
        onClose={() => setDialog(false)}
        title="Create a channel"
        description="Channels bring the right people and conversations together."
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (valid) {
              setCreatedChannels((previous) =>
                previous.includes(name) ? previous : [...previous, name],
              );
              notify(`Demo channel #${name} created`);
              setName("");
              setDialog(false);
            }
          }}
          noValidate
        >
          <TextField
            label="Channel name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. design-system"
            hint="Lowercase letters, numbers, and hyphens. Up to 80 characters."
            error={
              submitted && !valid
                ? "Start with a letter or number. Use only lowercase letters, numbers, and hyphens (up to 80 characters)."
                : undefined
            }
          />
          <div className="dialog-note">
            <Hash size={16} />
            <span>
              This creates a gallery demonstration, visible only here.
            </span>
          </div>
          <div className="dialog-actions">
            <Button onClick={() => setDialog(false)}>Cancel</Button>
            <Button type="submit" variant="primary">
              Create channel
            </Button>
          </div>
        </form>
      </Dialog>
    </section>
  );
}
export function Sample({
  id,
  title,
  detail,
  count,
  children,
}: {
  id: string;
  title: string;
  detail: string;
  count: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ds-card component-card" id={id}>
      <div className="sample-heading">
        <div>
          <h3>{title}</h3>
          <p>{detail}</p>
        </div>
        <span>{count}</span>
      </div>
      <div className="sample-content">{children}</div>
    </div>
  );
}
