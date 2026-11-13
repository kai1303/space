import { useState } from 'react';
import { ArrowLeft, ArrowUpRight } from '@phosphor-icons/react';
import { motion } from 'motion/react';
import { useLaunchMotion } from './useLaunchMotion.js';
import './workspace-demo.css';

export function WorkspaceDemo() {
  const [sourceOpen, setSourceOpen] = useState(false);
  const { feedback, reveal } = useLaunchMotion();
  const view = sourceOpen ? 'source' : 'thread';
  const action = sourceOpen ? 'Back to thread' : 'Open original message';
  const description = sourceOpen
    ? 'Original message from June Park. Invite the design partners on Tuesday, then open the public beta once they have tested invitations.'
    : 'Mira asks Codex about the rollout in #product-launch. Codex answers that design partners go first on Tuesday and links to June’s decision.';

  return <section id="workspace" className="launch-tour" aria-labelledby="launch-tour-heading">
    <div className="launch-tour-inner">
      <div className="launch-tour-heading">
        <h2 id="launch-tour-heading">Follow a decision back to its source.</h2>
        <motion.button type="button" {...feedback} aria-controls="launch-workspace-capture"
          onClick={() => setSourceOpen(!sourceOpen)}>
          {sourceOpen && <ArrowLeft aria-hidden="true"/>}{action}{!sourceOpen && <ArrowUpRight aria-hidden="true"/>}
        </motion.button>
      </div>
      <div id="launch-workspace-capture" className="launch-workspace-capture">
        <motion.picture key={view} {...reveal}>
          <source media="(max-width: 700px)" srcSet={'/launch/rollout-mobile-' + view + '.webp'} width="630" height="840"/>
          <img src={'/launch/rollout-desktop-' + view + '.webp'} width="1890" height="915" alt={description}/>
        </motion.picture>
        <button type="button" className={'launch-capture-target ' + view} aria-label={action + ' in workspace preview'}
          onClick={() => setSourceOpen(!sourceOpen)} />
      </div>
      <span className="sp-sr-only" role="status">{sourceOpen ? description : 'Showing the rollout thread.'}</span>
    </div>
  </section>;
}
