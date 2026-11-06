import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { gsap } from 'gsap';
import { ArrowUp, CaretDown, ChatCircleDots, CheckCircle, FileText, Hash, ListChecks, Paperclip, Pause, Play, SidebarSimple, Sparkle, Star } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { useLaunchMotion } from './useLaunchMotion.js';
import './workspace-demo.css';

const chapters = [
  ['Channel', 'Share the checklist with the team.'],
  ['Thread', 'Keep the review beside the original message.'],
  ['Agent session', 'Ask Codex what still needs work.'],
  ['Reply', 'Turn the answer into a team update.'],
];

function Message({ who, time, children }: { who: string; time: string; children: ReactNode }) {
  return <div className="demo-message"><i className={'demo-face face-' + who.toLowerCase()}>{who === 'Codex' ? <img alt="" src="/brand/providers/codex.svg"/> : who[0]}</i>
    <div><strong>{who}</strong> <small>{time}</small><div className="demo-body">{children}</div></div></div>;
}

export function WorkspaceDemo() {
  const { feedback, reveal } = useLaunchMotion();
  const [step, setStep] = useState(0);
  const [paused, setPaused] = useState(false);
  const stage = useRef<HTMLDivElement>(null);
  const clock = useRef<gsap.core.Tween | null>(null);
  const manual = useRef(false);
  const previousPoint = useRef<{x: number; y: number} | null>(null);
  useLayoutEffect(() => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const tween = gsap.to({}, {duration: 6, repeat: -1, paused: true, onRepeat: () => setStep(i => (i + 1) % chapters.length)});
      clock.current = tween;
      let inView = false;
      function sync() { tween.paused(!inView || document.hidden || manual.current); }
      const observer = new IntersectionObserver(([entry]) => { inView = !!entry?.isIntersecting; sync(); }, {threshold: .25});
      observer.observe(stage.current!);
      document.addEventListener('visibilitychange', sync);
      return () => { observer.disconnect(); document.removeEventListener('visibilitychange', sync); clock.current = null; };
    });
    return () => mm.revert();
  }, []);

  useLayoutEffect(() => {
    const mm = gsap.matchMedia();
    mm.add('(prefers-reduced-motion: no-preference)', () => {
      const scene = stage.current!;
      const target = scene.querySelector<HTMLElement>('[data-demo-target="' + step + '"]')!;
      const cursor = scene.querySelector('.demo-cursor');
      function point() {
        const start = scene.getBoundingClientRect(), end = target.getBoundingClientRect();
        return { x: end.left - start.left + Math.min(100, end.width * .65), y: end.bottom - start.top - 4 };
      }
      const end = point();
      const from = previousPoint.current ?? { x: end.x - 34, y: end.y + 20 };
      previousPoint.current = end;
      const travel = gsap.fromTo(cursor, from, { ...end, duration: .9, ease: 'power2.inOut' });
      let lastWidth = scene.clientWidth;
      const observer = new ResizeObserver(() => {
        if (scene.clientWidth === lastWidth) return;
        lastWidth = scene.clientWidth;
        travel.kill();
        previousPoint.current = point();
        gsap.set(cursor, previousPoint.current);
      });
      observer.observe(scene);
      return () => observer.disconnect();
    });
    return () => mm.revert();
  }, [step]);

  function playPause() {
    manual.current = !paused;
    setPaused(!paused);
    clock.current?.paused(!paused);
  }
  function choose(i: number) {
    manual.current = true;
    setPaused(true);
    clock.current?.pause();
    setStep(i);
  }
  return <div id="workspace" className="launch-tour launch-width" aria-label="Space workspace demo">
    <div className="launch-frame">
      <div className="demo-titlebar"><span className="demo-dots"><i/><i/><i/></span><span>Orbit Studio <b>/</b> Workspace demo</span><SidebarSimple size={15}/></div>
      <div className={'demo-stage step-' + step} ref={stage}>
        <div className="demo-sidebar"><b className="demo-studio"><span>O</span>Orbit Studio <CaretDown size={12}/></b>
          <label>Workspace</label><span><ChatCircleDots/>Threads</span><span><Star/>Saved</span><span><FileText/>Files</span>
          <label>Channels</label><span className="demo-selected"><Hash/>product-launch</span><span><Hash/>design-review</span><span><Hash/>engineering</span>
          <label>Agents</label><span><img src="/brand/providers/codex.svg" alt=""/>Codex</span><span><img src="/brand/providers/kiro.svg" alt=""/>Kiro</span>
        </div>
        <motion.div key={"channel-"+step} {...reveal} className="demo-channel"><div className="demo-pane-title"><Hash/>product-launch <Star size={13}/></div>
          <div className="demo-log"><span className="demo-date">Today</span>
          <Message who="Mira" time="9:41">The launch checklist is ready for review.
            <div className="demo-file" data-demo-target="0"><FileText weight="duotone"/><span><b>Launch checklist.md</b><small>Markdown document</small></span></div>
          </Message><Message who="June" time="9:43">The desktop preview looks good. I’ll check the phone layout.</Message>
          <span className="demo-replies"><ChatCircleDots size={14}/> {step === 3 ? '3 replies' : '2 replies'}</span></div>
          <div className="demo-input"><Paperclip size={15}/>Message #product-launch</div>
        </motion.div>
        {step === 0 && <motion.div {...reveal} className="demo-document"><div className="demo-pane-title"><FileText/>File preview</div>
          <div className="demo-sheet"><small>Orbit Studio / Product launch</small><h3>Launch checklist</h3><p>Team review</p>
            <ul><li><CheckCircle/>Review desktop preview</li><li><span/>Review phone layout</li><li><span/>Test invitation link</li></ul></div></motion.div>}
        {step > 0 && <motion.div key={step} {...reveal} className="demo-thread"><div className="demo-pane-title">{step === 2 ? <Sparkle/> : <ChatCircleDots/>}{step === 2 ? 'Agent session' : 'Launch checklist'}<small>{step === 2 ? 'Codex' : 'Thread'}</small></div>
          <div className="demo-log">
            <Message who="Mira" time="9:44"><span data-demo-target="1"><b className="demo-at">@Codex</b> What’s left before we send invitations?</span></Message>
            {step >= 2 && <Message who="Codex" time="9:44"><div data-demo-target="2"><ListChecks size={15}/> Two open items</div><ul><li>Review the phone layout.</li><li>Test the invitation link.</li></ul></Message>}
            {step === 3 && <Message who="June" time="9:46"><span data-demo-target="3">I’ll review the phone layout and post the preview here.</span></Message>}
          </div><div className="demo-input"><CheckCircle size={15}/>{step === 3 ? 'Reply shared' : 'Reply in thread'}<ArrowUp size={14}/></div>
        </motion.div>}
        <div className="demo-cursor" aria-hidden="true"><svg width="19" height="22" viewBox="0 0 20 23"><path d="M2 1l15 12-8 1-4 7z" fill="#8f524c" stroke="white" strokeWidth="1.6"/></svg></div>
      </div>
    </div>
    <div className="demo-controls"><div className="demo-chapters" role="group" aria-label="Demo chapters">{chapters.map(([label], i) =>
      <motion.button {...feedback} animate={{ backgroundColor: i===step ? "#4b3347" : "#fff9f3", color: i===step ? "#ffffff" : "#453341" }} key={label} aria-pressed={i === step} onClick={() => choose(i)}>{label}</motion.button>)}</div>
      <motion.button {...feedback} className="demo-play" onClick={playPause} aria-label={(paused ? 'Play' : 'Pause') + ' workspace demo'}>{paused ? <Play weight="fill"/> : <Pause weight="fill"/>}</motion.button></div>
    <motion.p key={step} {...reveal} className="demo-caption">{chapters[step]![1]}</motion.p>
  </div>;
}
