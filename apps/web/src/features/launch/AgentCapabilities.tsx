import { useRef, type ReactNode } from 'react';
import { motion, useInView } from 'motion/react';
import { Check, FileText, ArrowUpRight } from '@phosphor-icons/react';
import { useLaunchMotion } from './useLaunchMotion.js';
import './agent-capabilities.css';

function Illustration({ children }: { children: ReactNode }) {
  return <div className="agent-capability-art" aria-hidden="true">
    <svg viewBox="0 0 300 174" fill="none">{children}</svg>
  </div>;
}

// Geometry and tool arrangement from the selected Plyxl “Every tool” illustration.
function ContextIllustration() {
  const art = useRef<HTMLDivElement>(null);
  const visible = useInView(art);
  const { reduced } = useLaunchMotion();
  return <div ref={art} className="agent-capability-art every-tool-art" aria-hidden="true">
    <svg viewBox="0 0 220 136" fill="none">
      {['M110 70 L36 34', 'M110 70 L184 34', 'M110 70 L36 106', 'M110 70 L184 106', 'M110 70 L110 16'].map((d, index) => <g key={d}>
        <path className="tool-link" d={d}/>
        <motion.path className="tool-link tool-link-flow" d={d}
          animate={{ strokeDashoffset: visible && !reduced ? [0, -24] : 0 }}
          transition={{ duration: 1.6, ease: 'linear', repeat: visible && !reduced ? Infinity : 0, delay: -index * .3 }}/>
      </g>)}
      {[
        { name: 'gmail', x: 21, y: 19 }, { name: 'quickbooks', x: 169, y: 19 },
        { name: 'slack', x: 21, y: 91 }, { name: 'stripe', x: 169, y: 91 },
      ].map(({ name, x, y }) => <g key={name}>
        <rect className="tool-node" x={x} y={y} width="30" height="30" rx="8.4"/>
        <image href={'/launch/connections/'+name+'.svg'} x={x+6.9} y={y+6.9} width="16.2" height="16.2"/>
      </g>)}
      <rect x="96" y="2" width="28" height="28" rx="8" fill="#87b376"/>
      <image href="/launch/tools/board.svg" x="101" y="7" width="18" height="18"/>
      <circle className="tool-node" cx="110" cy="70" r="24"/>
      <image href="/brand/space-icon.svg" x="95" y="55" width="30" height="30"/>
      <text x="110" y="128" textAnchor="middle">+ any MCP server or API</text>
    </svg>
  </div>;
}

function AccessIllustration() {
  return <Illustration>
    <rect x="31" y="17" width="238" height="146" rx="15" className="cap-paper"/>
    <circle cx="54" cy="40" r="9" fill="#e6dff4"/>
    <path d="M50 40l3 3 5-6" stroke="#6252a1" strokeWidth="1.5" strokeLinecap="round"/>
    <text x="70" y="44" className="cap-bold">Choose the project folder</text>
    <text x="47" y="71" className="cap-muted">Local runner</text>
    <text x="253" y="71" textAnchor="end">Codex</text>
    <text x="47" y="94" className="cap-muted">Project</text>
    <text x="253" y="94" textAnchor="end">~/orbit-studio</text>
    <rect x="47" y="116" width="100" height="28" rx="9" fill="#211d3d"/>
    <text x="97" y="134" textAnchor="middle" fill="white">Use folder</text>
    <rect x="156" y="116" width="94" height="28" rx="9" className="cap-paper"/>
    <text x="203" y="134" textAnchor="middle" className="cap-muted">Cancel</text>
    <path d="M128 133l19 15-10 1-4 9z" fill="#fcfbff" stroke="#25203f" strokeWidth="2" strokeLinejoin="round"/>
  </Illustration>;
}

function WorkIllustration() {
  const art = useRef<HTMLDivElement>(null);
  const visible = useInView(art, { once: true, amount: .5 });
  const { reduced, transition } = useLaunchMotion();
  const activity = ['Read the launch checklist', 'Reviewed the open items', 'Saved a summary'];
  return <div ref={art} className="agent-capability-art work-session-art" aria-hidden="true">
    <div className="work-session-stage"><div className="work-session-preview">
      <div className="work-session-header">
        <img src="/brand/providers/codex.svg" alt=""/><strong>Codex</strong><span>Session</span>
      </div>
      <ol className="work-session-activity">{activity.map((label, index) => <motion.li key={label}
        initial={false} animate={{ opacity: visible || reduced ? 1 : 0, y: visible || reduced ? 0 : 5 }}
        transition={{ ...transition, delay: reduced ? 0 : index * .16 }}>
        <Check weight="bold"/><span>{label}</span>
      </motion.li>)}</ol>
      <motion.div className="work-session-result" initial={false}
        animate={{ opacity: visible || reduced ? 1 : 0, y: visible || reduced ? 0 : 5 }}
        transition={{ ...transition, delay: reduced ? 0 : .5 }}>
        <FileText weight="duotone"/><div><strong>launch-summary.md</strong><span>Ready for your review</span></div><ArrowUpRight/>
      </motion.div>
    </div></div>
  </div>;
}

function MemoryIllustration() {
  return <Illustration>
    <path d="M35 28Q93 14 150 30Q207 14 265 28V154Q207 140 150 156Q93 140 35 154z" className="cap-paper"/>
    <path d="M150 30V156" stroke="#c9c4dd" strokeWidth="1.3"/>
    {[58, 82, 106, 130].map(y => <g key={y} stroke="#d9d5e6" strokeWidth="1.5">
      <path d={'M47 '+y+'Q92 '+(y-9)+' 138 '+y}/>
      <path d={'M162 '+y+'Q207 '+(y-9)+' 253 '+y}/>
    </g>)}
    <path d="M232 23h14v43l-7-6-7 6z" fill="#6251ac"/>
    <g fontSize="14">
      <text x="47" y="52">Launch notes</text>
      <text x="47" y="76" className="cap-muted">Review mobile</text>
      <text x="47" y="100" className="cap-muted">before invites.</text>
      <text x="162" y="52">Next steps</text>
      <text x="162" y="76" className="cap-muted">Share preview.</text>
      <text x="162" y="100">Source thread</text>
      <text x="162" y="124" className="cap-muted"># product</text>
    </g>
  </Illustration>;
}

function ThreadIllustration() {
  return <Illustration>
    <rect x="26" y="22" width="248" height="131" rx="15" className="cap-paper"/>
    <path d="M26 57h248" stroke="#ded9e9"/>
    <circle cx="45" cy="40" r="5" fill="#a99bcf"/>
    <text x="58" y="44" className="cap-bold">Launch checklist</text>
    <rect x="43" y="72" width="26" height="26" rx="7" fill="#e4d9f3"/>
    <image href="/brand/providers/codex.svg" x="47" y="76" width="18" height="18"/>
    <text x="79" y="81" className="cap-bold">Codex</text>
    <text x="79" y="98" className="cap-muted">Two checks left before launch.</text>
    <rect x="43" y="114" width="213" height="25" rx="6" fill="#f1eef9" stroke="#ddd7eb"/>
    <text x="53" y="131" className="cap-faint">Ask a follow-up…</text>
    <path d="M242 132v-10m-4 4 4-4 4 4" stroke="#71619b" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
  </Illustration>;
}

const capabilities = [
  { title: 'Every tool', body: 'It works in everything you’ve connected, and your apps.', Art: ContextIllustration },
  { title: 'You choose access', body: 'Pick the local folder your agent can read and work in.', Art: AccessIllustration },
  { title: 'Follow the work', body: 'See the tools it uses and the results, together in the agent session.', Art: WorkIllustration },
  { title: 'Remembers', body: 'Keep decisions in channel notes, with a link back to the conversation.', Art: MemoryIllustration },
  { title: 'Pick up the thread', body: 'Reopen a session and continue from the last answer.', Art: ThreadIllustration },
];

export function AgentCapabilities() {
  return <div className="agent-capabilities" aria-label="Working with agents in Space">
    {capabilities.map(({ title, body, Art }) => <article key={title} className={Art === ContextIllustration ? 'every-tool-card' : undefined}>
      <Art/><h3>{title}</h3><p>{body}</p>
    </article>)}
  </div>;
}
