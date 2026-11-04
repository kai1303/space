import { useState } from 'react';
import { AgentResponse } from '@space/ui/agents';
import { Message } from '@space/ui/conversation';
import { Switch } from '@space/ui/primitives';
import { Sample } from './Components.js';

export function AgUiExample() {
  const [streaming, setStreaming] = useState(false);
  return <Sample id="agent-response" title="Rich agent response" detail="Markdown, tool activity, and structured results" count="14">
    <Message author="Research agent" initials="RA" agent tone="green" time="Just now">
      <AgentResponse streaming={streaming} response={{
        messages: [{ id: 'summary', text: streaming ? 'I’m checking the **customer report**…' : '### Customer report\n\nChurn fell **2%** this month. The Pro plan has the strongest retention.\n\n```sql\nSELECT plan, retention\nFROM customer_report;\n```', status: streaming ? 'streaming' : 'complete' }],
        tools: [{ id: 'report', name: 'Read customer report', arguments: '{"month":"October"}', status: streaming ? 'running' : 'completed', ...(streaming ? {} : { result: 'Reviewed 240 customers across two plans.' }) }],
        components: streaming ? [] : [
          { id: 'summary', type: 'card', title: 'Retention improved', body: 'Pro customers returned more often this month.' },
          { id: 'plans', type: 'table', title: 'Retention by plan', columns: ['Plan', 'Customers', 'Retention'], rows: [['Pro', '180', '98%'], ['Starter', '60', '94%']] },
        ],
        ...(streaming ? { step: 'Reading customer report…' } : {}),
      }} />
    </Message>
    <Switch label="Show response streaming" checked={streaming} onChange={setStreaming} />
  </Sample>;
}
