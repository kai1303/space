import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { AgentCapabilities } from './AgentCapabilities.js';
import './launch-marquees.css';

type Review = { name: string; role: string; quote: string };

// Fictional review copy for the launch-page design preview.
const reviews: Review[] = [
  { name: 'Mira', role: 'Product', quote: 'The discussion, the checklist, and the agent’s answer finally have one place to live. Picking up a launch thread feels easy.' },
  { name: 'Leo', role: 'Engineering', quote: 'I can ask Codex about a change right where the team is reviewing it. The answer stays with the conversation.' },
  { name: 'June', role: 'Design', quote: 'Sharing a preview and keeping the feedback beside it makes the handoff feel much calmer.' },
  { name: 'Ada', role: 'Engineering', quote: 'I like choosing the project folder my agent works in. It makes the session feel connected to the work in front of me.' },
  { name: 'Ivo', role: 'Support', quote: 'A useful answer is easy to find again when the source thread comes with it.' },
  { name: 'Noor', role: 'Product', quote: 'The suggested reply gives me a starting point. I can adjust the wording and send it when it sounds right.' },
  { name: 'June', role: 'Design', quote: 'I can open a thread on my phone and follow the same review I started at my desk.' },
  { name: 'Mira', role: 'Product', quote: 'Saving decisions into channel memory makes it easier to come back after a few days and know where we landed.' },
  { name: 'Leo', role: 'Engineering', quote: 'Being able to follow tool activity beside the agent’s response makes a session much easier to understand.' },
  { name: 'Noor', role: 'Product', quote: 'Our project channel can hold the question, the files, and the next step. That’s the kind of workspace I want to open each morning.' },
  { name: 'Ada', role: 'Engineering', quote: 'I can return to an agent session and ask a follow-up without rebuilding the conversation from scratch.' },
  { name: 'Ivo', role: 'Support', quote: 'Threads keep the little follow-ups close to the message that started them. It’s easy to see what someone is answering.' },
  { name: 'Mira', role: 'Product', quote: 'A shared workspace that we can host ourselves fits the way I want our team to work.' },
  { name: 'June', role: 'Design', quote: 'The file library gives shared previews a home beyond the moment they appear in chat.' },
  { name: 'Ivo', role: 'Support', quote: 'I can save a message now and come back to it when I have time to give it a proper reply.' },
];

function LoopTrack({ children, vertical = false, index, seconds, paused }: {
  children: ReactNode; vertical?: boolean; index: number; seconds: number; paused: boolean;
}) {
  const clip = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const sync = useRef<() => void>(undefined);
  const manualPause = useRef(paused);
  useLayoutEffect(() => {
    manualPause.current = paused;
    sync.current?.();
  }, [paused]);

  useLayoutEffect(() => {
    const media = gsap.matchMedia();
    media.add('(prefers-reduced-motion: no-preference)', () => {
      const axis = vertical ? 'yPercent' : 'xPercent';
      const reverse = index % 2 === 1;
      // Each identically sized group includes its trailing gutter, so 50% is one full copy.
      const tween = gsap.fromTo(strip.current, { [axis]: reverse ? -50 : 0 }, {
        [axis]: reverse ? 0 : -50, duration: seconds, repeat: -1, ease: 'none', paused: true,
      });
      tween.progress([0.035, 0.19, 0.10][index]!);
      let visible = false;
      const update = () => { tween.paused(manualPause.current || document.hidden || !visible); };
      sync.current = update;
      const observer = new IntersectionObserver(([entry]) => {
        visible = !!entry?.isIntersecting;
        update();
      });
      observer.observe(clip.current!);
      document.addEventListener('visibilitychange', update);
      return () => {
        sync.current = undefined;
        observer.disconnect();
        document.removeEventListener('visibilitychange', update);
      };
    });
    return () => media.revert();
  }, [index, seconds, vertical]);

  return <div className={'launch-loop ' + (vertical ? 'vertical' : 'horizontal')} ref={clip}>
    <div className="launch-loop-strip" ref={strip}>
      <div className="launch-loop-group">{children}</div>
      <div className="launch-loop-group" aria-hidden="true">{children}</div>
    </div>
  </div>;
}

function ReviewCard({ review }: { review: Review }) {
  return <article className="launch-agent-card">
    <header>
      <span className={'launch-initial initial-' + review.name} aria-hidden="true">{review.name[0]}</span>
      <div><strong>{review.name}</strong><small>{review.role}</small></div>
    </header>
    <blockquote className="launch-review-quote">“{review.quote}”</blockquote>
  </article>;
}

export function LaunchAgents() {
  const [paused, setPaused] = useState(false);
  return <section id="agents" className="launch-agent-section launch-width">
    <span className="launch-overline">Agent Sessions</span><h2>Bring an agent into the conversation.</h2>
    <p className="launch-agent-intro">Mention a connected agent in a thread. Follow its work in a session alongside the discussion.</p>
    <div className="launch-agent-wall" role="group" aria-label="Fictional reviews for the design preview. Focus to pause motion." tabIndex={0}
      onMouseEnter={() => setPaused(true)} onMouseLeave={event => setPaused(event.currentTarget === document.activeElement)}
      onFocus={() => setPaused(true)} onBlur={event => setPaused(event.currentTarget.matches(':hover'))}>
      {[64, 76, 70].map((seconds, i) => <LoopTrack vertical index={i} key={i} seconds={seconds} paused={paused}>
        {reviews.filter((_, n) => n % 3 === i).map(review => <ReviewCard key={review.quote} review={review}/>)}
      </LoopTrack>)}
    </div>
    <AgentCapabilities />
  </section>;
}

const connectionRows = [
  [
    [
      "Gmail",
      "gmail"
    ],
    [
      "Google Sheets",
      "googlesheets"
    ],
    [
      "Slack",
      "slack"
    ],
    [
      "QuickBooks",
      "quickbooks"
    ],
    [
      "Shopify",
      "shopify"
    ],
    [
      "Airtable",
      "airtable"
    ],
    [
      "ClickUp",
      "clickup"
    ],
    [
      "Zoom",
      "zoom"
    ],
    [
      "Excel",
      "excel"
    ],
    [
      "Calendly",
      "calendly"
    ],
    [
      "Zendesk",
      "zendesk"
    ],
    [
      "Facebook",
      "facebook"
    ],
    [
      "Canva",
      "canva"
    ],
    [
      "Discord",
      "discord"
    ],
    [
      "FreshBooks",
      "freshbooks"
    ],
    [
      "Zoho",
      "zoho"
    ]
  ],
  [
    [
      "Google Calendar",
      "googlecalendar"
    ],
    [
      "Google Docs",
      "googledocs"
    ],
    [
      "HubSpot",
      "hubspot"
    ],
    [
      "Xero",
      "xero"
    ],
    [
      "Square",
      "square"
    ],
    [
      "Asana",
      "asana"
    ],
    [
      "Jira",
      "jira"
    ],
    [
      "Outlook",
      "outlook"
    ],
    [
      "OneDrive",
      "one_drive"
    ],
    [
      "Mailchimp",
      "mailchimp"
    ],
    [
      "WhatsApp",
      "whatsapp"
    ],
    [
      "LinkedIn",
      "linkedin"
    ],
    [
      "Figma",
      "figma"
    ],
    [
      "Miro",
      "miro"
    ],
    [
      "Box",
      "box"
    ]
  ],
  [
    [
      "Google Drive",
      "googledrive"
    ],
    [
      "Google Meet",
      "googlemeet"
    ],
    [
      "Salesforce",
      "salesforce"
    ],
    [
      "Stripe",
      "stripe"
    ],
    [
      "Notion",
      "notion"
    ],
    [
      "Trello",
      "trello"
    ],
    [
      "Linear",
      "linear"
    ],
    [
      "Microsoft Teams",
      "microsoft_teams"
    ],
    [
      "Dropbox",
      "dropbox"
    ],
    [
      "Intercom",
      "intercom"
    ],
    [
      "Instagram",
      "instagram"
    ],
    [
      "YouTube",
      "youtube"
    ],
    [
      "GitHub",
      "github"
    ],
    [
      "Monday",
      "monday"
    ],
    [
      "Todoist",
      "todoist"
    ]
  ]
];

export function ConnectionTracks({ paused }: { paused: boolean }) {
  return <div className="launch-connection-tracks" aria-label="Example tool connections">
    {connectionRows.map((row, index) => <LoopTrack key={index} index={index} seconds={[120, 140, 130][index]!} paused={paused}>
      {[...row, ...row].map(([name, slug], item) => <div className="launch-connection-tile" key={item} aria-hidden={item >= row.length || undefined}>
        <img src={'/launch/connections/' + slug + '.svg'} width="36" height="36" alt={name} title={name}/>
      </div>)}
    </LoopTrack>)}
  </div>;
}
