import { useEffect, useState } from 'react';
import { AgentResponse } from '@space/ui/agents';
import { Message } from '@space/ui/conversation';
import { Button } from '@space/ui/primitives';

const chunks = [
  'I found the cause of the missing notifications. ',
  'The channel was muted, so replies arrived quietly ',
  'even while you were watching the thread.',
  '\n\n**What changed**\n\n',
  'Mentions now appear in Activity as soon as they arrive. ',
  'Opening a mention takes you directly to the reply ',
  'and keeps the surrounding conversation in view.',
];

type Phase = 'final_answer' | 'commentary';

function Playback({ phase }: { phase: Phase }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timers = Array.from({ length: chunks.length + 1 }, (_, index) =>
      window.setTimeout(() => setStep(index + 1), 350 + index * 800));
    return () => timers.forEach(timer => window.clearTimeout(timer));
  }, []);

  const streaming = step <= chunks.length;
  return <Message author="Space agent" initials="SA" time="Just now" agent tone="green">
    <AgentResponse newArrival streaming={streaming} showActivity={false} response={{
      messages: [{ id: 'reply', phase, status: streaming ? 'streaming' : 'complete', text: chunks.slice(0, step).join('') }],
      tools: [], components: [],
    }} />
  </Message>;
}

export function AgentResponsePreview({ phase }: { phase: Phase }) {
  const [run, setRun] = useState(0);
  return <section style={{ width: '100%', maxWidth: 640, margin: '32px auto' }}>
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
      <Button variant="secondary" size="sm" onClick={() => setRun(run => run + 1)}>Replay response</Button>
    </div>
    <Playback key={run} phase={phase} />
  </section>;
}
