import { useLayoutEffect, useState } from 'react';
import { gsap } from 'gsap';
import { ArrowRight, ArrowUUpLeft, Check, CheckCircle, FileText, FolderOpen, Hash, PaperPlaneTilt, PencilSimple } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { useLaunchMotion } from './useLaunchMotion.js';
import './launch-workflows.css';

const steps = [
  { title: 'Give it a task', body: 'Mention your agent, describe the outcome, and point it to the work.', Icon: PaperPlaneTilt },
  { title: 'Follow the work', body: 'Open the agent session to see which files it reads and what it creates.', Icon: FolderOpen },
  { title: 'Review the result', body: 'Read the draft and check the file the agent produced.', Icon: FileText },
  { title: 'Ask for a revision', body: 'Give feedback in the same session. The agent picks up from there.', Icon: PencilSimple },
];
const activities = [
  ['Read file', 'docs/launch-checklist.md'],
  ['Read file', 'docs/product-updates.md'],
  ['Create file', 'docs/release-notes.md'],
];
const request = 'Turn our launch checklist and product updates into release notes. Save a draft for me to review.';

export function LaunchWorkflows() {
  const { feedback, reveal, transition } = useLaunchMotion();
  const [step, setStep] = useState(0);
  const [completedTools, setCompletedTools] = useState(0);
  const [revised, setRevised] = useState(false);

  useLayoutEffect(() => {
    const media = gsap.matchMedia();
    media.add({
      motion: '(prefers-reduced-motion: no-preference)',
      reduced: '(prefers-reduced-motion: reduce)',
    }, context => {
      if (!context.conditions?.motion) {
        setCompletedTools(activities.length);
        return;
      }
      if (step === 1) {
        setCompletedTools(0);
        const timeline = gsap.timeline();
        activities.forEach((_, index) => {
          timeline.call(() => setCompletedTools(index + 1), [], .65 + index * .75);
        });
      }
    });
    return () => media.revert();
  }, [step]);

  const working = step === 1 && completedTools < activities.length;
  function selectStep(index: number) {
    setStep(index);
    setRevised(false);
  }

  return <section id="workflows" className="launch-workflows launch-width">
    <span className="launch-overline">Working with agents</span>
    <div className="workflow-heading">
      <h2>Delegate the task.<br/>Stay in the loop.</h2>
      <p>Give your agent a clear outcome. Follow the work, review what comes back, and keep refining it together.</p>
    </div>
    <div className="delegation-walkthrough">
      <div className="delegation-steps" role="group" aria-label="Task delegation steps">
        {steps.map(({ title, body, Icon }, index) => <motion.button {...feedback} animate={{ backgroundColor: step===index ? "#eee6ef" : "#fcfaf7", borderColor: step===index ? "#dbccdf" : "#fcfaf7" }} key={title} aria-pressed={step === index}
          aria-controls="delegation-scene" onClick={() => selectStep(index)}>
          <span className="delegation-step-icon"><Icon size={20}/></span>
          <span><strong>{title}</strong><span>{body}</span></span>
        </motion.button>)}
      </div>
      <div className="delegation-preview">
        <div className="delegation-windowbar">
          <span><Hash size={16}/> product-launch</span>
          <span>Interactive demo</span>
        </div>
        <motion.div key={step} {...reveal} className="delegation-scene" id="delegation-scene" aria-label={steps[step]!.title}>
          <div className="delegation-task">
            <span className="delegation-person" aria-hidden="true">M</span>
            <div><strong>Mira <small>Product</small></strong><p><b>@Codex</b> {request}</p></div>
          </div>
          {step === 0 ? <div className="delegation-context">
            <div><FolderOpen size={18}/><span><strong>Orbit Studio</strong><small>Project folder shared with Codex</small></span><Check size={15}/></div>
            <span><FileText size={15}/>launch-checklist.md</span>
            <span><FileText size={15}/>product-updates.md</span>
          </div> : <div className="delegation-session">
            <div className="delegation-session-heading"><img src="/brand/providers/codex.svg" alt=""/><strong>Codex</strong>
              <span className={working ? 'delegation-working' : ''}>{working ? 'Working' : 'Ready for review'}</span>
            </div>
            {step === 1 ? <div className="delegation-activity" aria-live="polite">
              <p>I’ll read the project notes and put together a draft.</p>
              <ol>{activities.map(([action, file], index) => <motion.li transition={transition} animate={{ backgroundColor: completedTools > index ? "#f0f6ee" : "#fcfaff" }} key={file} data-complete={completedTools > index}>
                {completedTools > index ? <CheckCircle size={17}/> : <span className="delegation-tool-dot"/>}
                <span><strong>{action}</strong><code>{file}</code></span>
                <small>{completedTools > index ? 'Done' : completedTools === index ? 'In progress' : 'Queued'}</small>
              </motion.li>)}</ol>
              <span className="delegation-complete">{!working && <><CheckCircle size={15}/> Draft saved. Ready when you are.</>}</span>
            </div> : <>
              <p className="delegation-agent-message">{revised ? 'Shortened the introduction and kept the mobile review visible.' : 'The draft is ready. I kept the remaining checks in a separate section.'}</p>
              <motion.div key={String(revised)} {...reveal} className="delegation-document">
                <div><FileText size={15}/><span>release-notes.md</span><small>{revised ? 'Revised draft' : 'Draft'}</small></div>
                <h3>Ready for the next conversation.</h3>
                <p>{revised ? 'Team chat, files, and agents — together in Space.' : 'Space brings team conversations, shared files, and connected agents into one workspace.'}</p>
                <ul><li>Keep project discussions in threads.</li><li>Bring a local agent into the conversation.</li></ul>
                <div className="delegation-open-check"><CheckCircle size={15}/><span>Before launch · review the phone layout and test invitations.</span></div>
              </motion.div>
              {step === 3 && <div className="delegation-feedback" aria-live="polite">
                <span className="delegation-person" aria-hidden="true">M</span>
                <p>Make the introduction shorter. Keep the mobile review in the launch checks.</p>
                {revised && <Check size={18} aria-label="Revision complete"/>}
              </div>}
            </>}
          </div>}
        </motion.div>
        <div className="delegation-actions">
          <span>{step === 0 ? 'You choose the task and project.' : step === 1 ? 'Tool activity stays in the session.' : step === 2 ? 'Your review sets the next step.' : 'Keep the context. Continue the session.'}</span>
          {step < 3 ? <motion.button {...feedback} onClick={() => selectStep(step + 1)} disabled={working}>
            {step === 0 ? 'Delegate task' : step === 1 ? 'Review draft' : 'Ask for a revision'}<ArrowRight size={16}/>
          </motion.button> : revised ? <motion.button {...feedback} onClick={() => selectStep(0)}>Replay demo <ArrowUUpLeft size={16}/></motion.button>
            : <motion.button {...feedback} onClick={() => setRevised(true)}>Send feedback <PaperPlaneTilt size={16}/></motion.button>}
        </div>
      </div>
    </div>
  </section>;
}
