import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, ChatsCircle, FileText, FolderOpen, Hash, List, ListChecks, MagnifyingGlass, NotePencil, Sparkle, Star, X } from '@phosphor-icons/react';
import { LaunchAgents } from './LaunchMarquees.js';
import { LaunchConnections } from './LaunchConnections.js';
import { LaunchWorkflows } from './LaunchWorkflows.js';
import { WorkspaceDemo } from './WorkspaceDemo.js';
import { useLaunchScroll } from './useLaunchScroll.js';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { useLaunchMotion } from './useLaunchMotion.js';
import './launch.css';

const repo = 'https://github.com/kai1303/space';
const catalog = [
  [Hash, 'Channels', 'Give each project a room.'],
  [ChatsCircle, 'Threads', 'Keep replies with the original message.'],
  [Sparkle, 'Agent sessions', 'Follow a run and ask a follow-up.'],
  [FolderOpen, 'Files', 'Browse the files your team has shared.'],
  [FileText, 'Channel memory', 'Keep decisions in Markdown.'],
  [MagnifyingGlass, 'Search', 'Find a message across your workspace.'],
  [Star, 'Saved items', 'Return to a message you bookmarked.'],
  [NotePencil, 'Drafts', 'Pick up a reply you started earlier.'],
  [ListChecks, 'To-dos', 'Keep track of your next steps.'],
] as const;
const setupSteps = [
  { title: 'Get the project', body: 'Clone Space and install its dependencies.', code: 'git clone https://github.com/kai1303/space.git\ncd space\npnpm install --frozen-lockfile' },
  { title: 'Start your services', body: 'Use Docker Compose for the local services.', code: 'docker compose up -d postgres nats redis seaweedfs' },
  { title: 'Open the web app', body: 'With the API running, start the web client.', code: 'pnpm web\n\n# Open http://127.0.0.1:5173/chat' },
];
const questions = [
  ['What is Space?', 'Space is an open-source workspace for team chat, files, and AI agents. You can invite an agent into a conversation and follow its work alongside the thread.'],
  ['Where can my team use it?', 'Open your Space instance in a browser, or connect the macOS desktop app to the same workspace.'],
  ['Which agents can I connect?', 'You can pair a local Codex or Kiro runner and grant it access to a channel. The pairing guide covers provider sign-in and project access.'],
  ['How do suggested replies work?', 'With a Groq API key configured, Space uses up to the latest 50 thread messages to suggest a draft. Press Tab to accept it, edit the text, then send it yourself.'],
  ['Where do our decisions live?', 'When channel memory is enabled, you can save a message to the channel’s Markdown notes with a link back to its thread.'],
  ['Can I host my own workspace?', 'Yes. Space is MIT licensed. The setup guide covers the database, file storage, API, web client and optional agent connector.'],
];
function Brand() { const { feedback } = useLaunchMotion(); return <motion.a {...feedback} className="launch-brand" href="/" aria-label="Space home"><img src="/launch/wordmark.webp" width="123" height="32" alt="Space"/></motion.a>; }
function Navigation() {
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const { feedback, transition } = useLaunchMotion();
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 768px)');
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener('change', closeOnDesktop);
    return () => desktop.removeEventListener('change', closeOnDesktop);
  }, []);
  const links = ['Agents','Connections','Workflows','Toolkit','FAQ'].map(label =>
    <motion.a {...feedback} key={label} href={'#'+label.toLowerCase()} onClick={() => setOpen(false)}>{label}</motion.a>);
  return <header className={'launch-nav' + (open ? ' menu-open' : '')} onKeyDown={event => {
    if (event.key === 'Escape' && open) { setOpen(false); menuButton.current?.focus(); }
  }} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className="nav-inner"><Brand/>
      <nav className="launch-desktop-navigation" aria-label="Primary">{links}</nav>
      <div className="nav-actions"><motion.a {...feedback} className="launch-nav-open" href="/chat">Open Space <ArrowUpRight/></motion.a>
        <motion.button {...feedback} ref={menuButton} className="launch-menu" onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="launch-navigation" aria-label={open ? 'Close menu' : 'Open menu'}>
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={transition}>{open ? <X/> : <List/>}</motion.span>
        </motion.button>
      </div>
    </div>
    <div id="launch-navigation" className="launch-mobile-menu" inert={!open}><AnimatePresence initial={false}>{open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={transition}>
      <nav aria-label="Mobile primary">{links}</nav>
    </motion.div>}</AnimatePresence></div>
  </header>;
}
function Toolkit() {
  return <section className="launch-catalog launch-width" id="toolkit"><div><span className="launch-overline">Workspace toolkit</span><h2>Already in<br/>your workspace.</h2><p>From the first message to the final handoff, the team’s work has a place to live.</p></div>
    <ul data-scroll-example>{catalog.map(([Mark,title,body])=><li key={title}><i className="launch-tool-icon"><Mark weight="duotone"/></i><h3>{title}</h3><p>{body}</p></li>)}</ul></section>;
}
function Setup() {
  const { feedback, reveal, transition, reduced } = useLaunchMotion();
  const [current, setCurrent] = useState(0);
  return <section id="setup" className="launch-setup launch-width"><div><span className="launch-overline">Self-hosting</span><h2>A workspace<br/>of your own.</h2>
    <p>Run Space on your infrastructure. Start locally, invite the team, then connect your first agent.</p><motion.a {...feedback} className="launch-textlink" href={repo+'#quick-start'}>Read the full setup guide <ArrowUpRight/></motion.a>
    </div><div className="setup-preview" data-scroll-example><div className="setup-controls" role="group" aria-label="Setup preview">{setupSteps.map((s,i)=><motion.button {...feedback} animate={{ backgroundColor: i===current ? "#f5dfcc" : "#322735", color: i===current ? "#3c2b3c" : "#ffffff" }} aria-pressed={i===current} key={s.title} onClick={()=>setCurrent(i)}>{i+1}. {['Clone','Services','Web'][i]}</motion.button>)}</div>
      <motion.div layout={reduced ? false : 'size'} transition={transition} aria-live="polite"><motion.div key={current} {...reveal}><h3>{setupSteps[current]!.title}</h3><p>{setupSteps[current]!.body}</p><pre>{setupSteps[current]!.code}</pre></motion.div></motion.div></div></section>;
}
function FAQ() {
  const [expanded, setExpanded] = useState<number | null>(0);
  const { transition, feedback } = useLaunchMotion();
  return <div>{questions.map(([question, answer], index) => {
    const open = expanded === index;
    return <div className="launch-faq-item" key={question}>
      <motion.button {...feedback} className="launch-faq-toggle" id={'faq-question-'+index} aria-expanded={open} aria-controls={'faq-answer-'+index}
        onClick={() => setExpanded(open ? null : index)}>
        {question}<motion.span aria-hidden="true" animate={{ rotate: open ? 45 : 0 }} transition={transition}>+</motion.span>
      </motion.button>
      <motion.div id={'faq-answer-'+index} role="region" aria-labelledby={'faq-question-'+index} aria-hidden={!open} inert={!open}
        initial={false} animate={{ height: open ? 'auto' : 0, opacity: open ? 1 : 0 }} transition={transition}
        className="launch-faq-answer" onAnimationComplete={() => ScrollTrigger.refresh()}>
        <p>{answer}</p>
      </motion.div>
    </div>;
  })}</div>;
}
export function LaunchPage() {
  const root = useLaunchScroll();
  const { feedback, reduced } = useLaunchMotion();
  return <MotionConfig reducedMotion={reduced ? 'always' : 'never'}><div ref={root} className="launch"><a href="#launch-main" className="launch-skip">Skip to content</a><Navigation/>
    <main id="launch-main">
      <section className="launch-hero"><div className="launch-sky" aria-hidden="true"><div className="launch-orbits"/></div>
        <div className="launch-intro"><h1>A shared space for<br/><em>people and agents.</em></h1>
          <p>Bring your team, its files, and AI agents into the same conversation. Open source and yours to host.</p>
          <div className="launch-actions"><motion.a {...feedback} className="launch-btn primary" href="/chat">Open Space <ArrowRight/></motion.a><motion.a {...feedback} className="launch-btn secondary" href="#workspace">Watch the demo</motion.a></div></div>
        <WorkspaceDemo/>
      </section>
      <LaunchAgents/><LaunchConnections/><LaunchWorkflows/><Toolkit/><Setup/>
      <section className="launch-faq launch-width" id="faq"><div><span className="launch-overline">FAQ</span><h2>A few answers.</h2><motion.a {...feedback} className="launch-textlink" href={repo+'/issues'}>Ask on GitHub <ArrowUpRight/></motion.a></div>
        <FAQ/></section>
    </main>
    <footer id="start" className="launch-footer"><div className="launch-width"><Brand/><nav aria-label="Resources"><motion.a {...feedback} href={repo}>GitHub</motion.a><motion.a {...feedback} href={repo+'#quick-start'}>Self-hosting guide</motion.a><motion.a {...feedback} href="/chat">Open Space ↗</motion.a></nav></div></footer>
  </div></MotionConfig>;
}
