import { useRef, useState, type ComponentProps } from 'react';
import { CaretDown, CaretRight, Check, Flag, Microphone, Pause, PencilSimple, Play, X } from '@phosphor-icons/react';
import { ComposerSendError } from '@space/ui/composer';
import { Button, Dialog, IconButton, Popover } from '@space/ui/primitives';
import { ConversationComposer } from '../chat/ThreadConversation.js';
import './agent-session-composer.css';

const examples = {
  'codex.run': ['GPT-6.1 Sol', 'GPT-6 Astra'],
  'claude.run': ['Claude Sonnet', 'Claude Opus'],
};

type Props = ComponentProps<typeof ConversationComposer> & { skill: string };

export function AgentSessionComposer({ skill, ...props }: Props) {
  const models = skill === 'codex.run' || skill === 'claude.run' ? examples[skill] : undefined;
  const [model, setModel] = useState('Default');
  const [effort, setEffort] = useState('Medium');
  const [picker, setPicker] = useState<'effort'|'model'>('effort');
  const [goal, setGoal] = useState('');
  const [paused, setPaused] = useState(false);
  const [composingGoal, setComposingGoal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [voice, setVoice] = useState<'dictation' | 'conversation'>('dictation');
  const region = useRef<HTMLDivElement>(null);
  const popover = { floating: true, align: 'start' as const, triggerClassName: 'agent-composer-trigger', panelClassName: 'agent-composer-popover' };
  const focusInput = () => region.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
  function startGoal() {
    setComposingGoal(true);
    focusInput();
  }
  function saveGoal(value: string) {
    setGoal(value.trim());
    setPaused(false);
    setComposingGoal(false);
    setEditing(false);
  }
  const send: Props['onSend'] = (text, document, attachments, options) => {
    if (attachments.length && (composingGoal || (models && /^\/goal(?:\s|$)/.test(text)))) {
      throw new ComposerSendError('Send attachments in a message or remove them to set a goal.');
    }
    if (composingGoal) { saveGoal(text); return; }
    if (models && /^\/goal(?:\s|$)/.test(text)) {
      const objective = text.slice(5).trim();
      if (objective === 'pause' && goal) setPaused(true);
      else if (objective === 'resume' && goal) setPaused(false);
      else if (objective === 'clear') saveGoal('');
      else if (goal && (!objective || objective === 'edit')) { setDraft(goal); setEditing(true); }
      else if (objective && goal) { setDraft(objective); setEditing(true); }
      else if (objective) saveGoal(objective);
      else startGoal();
      return;
    }
    return props.onSend(text, document, attachments, options);
  };

  return <div ref={region}>
    {goal && <div className="agent-session-goal" aria-label="Session goal preview">
      <Flag size={16}/><div><small>{paused ? 'Paused goal' : 'Pursuing goal'} · Preview</small><strong>{goal}</strong></div>
      <IconButton size="sm" label="Edit goal" onClick={()=>{setDraft(goal);setEditing(true);}}><PencilSimple/></IconButton>
      <IconButton size="sm" label={paused ? 'Resume goal' : 'Pause goal'} onClick={()=>setPaused(!paused)}>{paused ? <Play/> : <Pause/>}</IconButton>
      <IconButton size="sm" label="Clear goal" onClick={()=>saveGoal('')}><X/></IconButton>
    </div>}
    <ConversationComposer {...props} placeholder={composingGoal ? 'Describe your goal and how to tell when it’s done' : props.placeholder}
      submitLabel={composingGoal ? 'Set goal' : props.submitLabel} onSend={send}
      renderExtraActions={models && ((insert, disabled) => <div className="agent-composer-tools">
    <Popover {...popover} label="Select model and effort" trigger={<span className="agent-effort-trigger" onPointerDown={()=>setPicker('effort')}>{model} · {effort} <CaretDown/></span>}>
      {close => <><strong>{picker === 'model' ? 'Select model' : 'Select effort'}</strong>
        <div className="agent-picker-options">
          {(picker === 'model' ? ['Default', ...models] : (skill === 'codex.run' ? ['Light','Medium','High','Extra High'] : ['Low','Medium','High'])).map(value=>
            <button key={value} type="button" aria-pressed={value === (picker === 'model' ? model : effort)} onClick={()=>{
              if (picker === 'model') { setModel(value); setPicker('effort'); }
              else { setEffort(value); close(); }
            }}>{value}{value === (picker === 'model' ? model : effort) && <Check size={15}/>}</button>)}
        </div>
        <button type="button" className="agent-picker-switch" onClick={()=>setPicker(picker === 'model' ? 'effort' : 'model')}>
          {picker === 'model' ? 'Select effort' : 'Select model'}<span>{picker === 'model' ? effort : model} <CaretRight size={12}/></span></button>
        <small>Preview options</small></>}
    </Popover>
    {!goal && <IconButton size="sm" label={composingGoal ? 'Cancel goal mode' : 'Set session goal'} aria-pressed={composingGoal}
      onClick={()=>{if(composingGoal){setComposingGoal(false);focusInput();}else startGoal();}}><Flag weight={composingGoal ? 'fill' : 'regular'}/>{composingGoal ? 'Goal ×' : 'Goal'}</IconButton>}
    <Popover {...popover} label="Voice preview" disabled={disabled} trigger={<Microphone/>}>
      {close => <><strong>Voice preview</strong><small>Sample transcript · Microphone off</small>
        <label>Mode<select aria-label="Voice mode" value={voice} onChange={e=>setVoice(e.target.value === 'conversation' ? 'conversation' : 'dictation')}><option value="dictation">Dictation</option><option value="conversation">Conversation</option></select></label>
        <p>{voice==='dictation' ? 'Show upload progress beside the filename.' : 'You: How far did the upload get?'}{voice==='conversation' && <><br/>Agent: The sample upload is halfway done.</>}</p>
        {voice==='dictation' ? <Button size="sm" onClick={()=>{close(false);insert('Show upload progress beside the filename.');}}>Insert sample into draft</Button> : <Button size="sm" onClick={()=>close()}>Done</Button>}
      </>}
    </Popover>
  </div>)}/>
    {editing && <Dialog open title="Edit goal" onClose={()=>setEditing(false)}>
      <form className="agent-goal-editor" onSubmit={event=>{event.preventDefault();if (draft.trim()) saveGoal(draft);}}>
        <label>Goal<textarea autoFocus value={draft} onChange={event=>setDraft(event.target.value)}/></label>
        <div className="agent-composer-buttons"><Button type="button" onClick={()=>setEditing(false)}>Cancel</Button><Button type="submit" disabled={!draft.trim()}>Save</Button></div>
      </form>
    </Dialog>}
  </div>;
}
