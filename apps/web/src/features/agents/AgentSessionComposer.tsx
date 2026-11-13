import { AgentDictation } from './AgentDictation.js';
import { CodexEffortSlider } from './CodexEffortSlider.js';
import { useRef, useState, type ComponentProps } from 'react';
import { CaretDown, CaretRight, Check, Flag, Pause, PencilSimple, Play, X } from '@phosphor-icons/react';
import { ComposerSendError } from '@space/ui/composer';
import { Button, Dialog, IconButton, Popover } from '@space/ui/primitives';
import { ConversationComposer } from '../chat/ThreadConversation.js';
import './agent-session-composer.css';

const examples = {
  'codex.run': ['GPT-6.1 Sol', 'GPT-6 Astra'],
  'claude.run': ['Claude Sonnet', 'Claude Opus'],
};

type Props = ComponentProps<typeof ConversationComposer> & {
  skill: string;
  previewConfig?: { model: string; effort: string };
};

export function AgentSessionComposer({ skill, previewConfig, ...props }: Props) {
  const models = skill === 'codex.run' || skill === 'claude.run' ? examples[skill] : undefined;
  const [model, setModel] = useState(previewConfig?.model ?? 'Default');
  const [effort, setEffort] = useState(previewConfig?.effort ?? 'Medium');
  const [picker, setPicker] = useState<'effort'|'model'>('effort');
  const [goal, setGoal] = useState('');
  const [paused, setPaused] = useState(false);
  const [composingGoal, setComposingGoal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dictating, setDictating] = useState(false);
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
  const withGoal = (submit:Props['onSend']):Props['onSend'] => (text, document, attachments, options) => {
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
    return submit(text, document, attachments, options);
  };

  const pickerLabel = `Select model and effort, ${model}, ${effort}`;
  const pickerTrigger = <span className="agent-effort-trigger" onPointerDown={skill === 'claude.run' ? ()=>setPicker('effort') : undefined}>
    <span className="agent-trigger-model">{model}</span>
    <span className="agent-trigger-effort">{effort}</span><CaretDown/>
  </span>;
  return <div ref={region}>
    {goal && <div className="agent-session-goal" aria-label="Session goal preview">
      <Flag size={16}/><div><small>{paused ? 'Paused goal' : 'Pursuing goal'} · Preview</small><strong>{goal}</strong></div>
      <IconButton size="sm" label="Edit goal" onClick={()=>{setDraft(goal);setEditing(true);}}><PencilSimple/></IconButton>
      <IconButton size="sm" label={paused ? 'Resume goal' : 'Pause goal'} onClick={()=>setPaused(!paused)}>{paused ? <Play/> : <Pause/>}</IconButton>
      <IconButton size="sm" label="Clear goal" onClick={()=>saveGoal('')}><X/></IconButton>
    </div>}
    <ConversationComposer {...props} sendDisabled={props.sendDisabled || dictating} placeholder={composingGoal ? 'Describe your goal and how to tell when it’s done' : props.placeholder}
      submitLabel={composingGoal ? 'Set goal' : props.submitLabel} onSend={withGoal(props.onSend)} onAlternateSend={props.onAlternateSend && withGoal(props.onAlternateSend)}
      submitIcon={composingGoal ? undefined : props.submitIcon} submitAccessory={composingGoal ? undefined : props.submitAccessory}
      renderExtraActions={(insert, disabled) => <div className="agent-composer-tools">
    {models && (skill === 'codex.run' ? <Popover {...popover} panelClassName="agent-composer-popover agent-model-popover" label={pickerLabel}
      trigger={pickerTrigger}>
      {()=> <CodexModelPicker models={models} model={model} effort={effort} selectModel={setModel} selectEffort={setEffort}/>}
    </Popover> : (<Popover {...popover} label={pickerLabel} trigger={pickerTrigger}>
      {close => <><strong>{picker === 'model' ? 'Select model' : 'Select effort'}</strong>
        <div className="agent-picker-options">
          {(picker === 'model' ? ['Default', ...models] : ['Low','Medium','High']).map(value=>
            <button key={value} type="button" aria-pressed={value === (picker === 'model' ? model : effort)} onClick={()=>{
              if (picker === 'model') { setModel(value); setPicker('effort'); }
              else { setEffort(value); close(); }
            }}>{value}{value === (picker === 'model' ? model : effort) && <Check size={15}/>}</button>)}
        </div>
        <button type="button" className="agent-picker-switch" onClick={()=>setPicker(picker === 'model' ? 'effort' : 'model')}>
          {picker === 'model' ? 'Select effort' : 'Select model'}<span>{picker === 'model' ? effort : model} <CaretRight size={12}/></span></button>
        <small>Preview options</small></>}
    </Popover>))}
    {models && !goal && <IconButton size="sm" label={composingGoal ? 'Cancel goal mode' : 'Set session goal'} aria-pressed={composingGoal}
      onClick={()=>{if(composingGoal){setComposingGoal(false);focusInput();}else startGoal();}}><Flag weight={composingGoal ? 'fill' : 'regular'}/>{composingGoal ? 'Goal ×' : 'Goal'}</IconButton>}
    <AgentDictation insert={insert} disabled={disabled} onBusy={setDictating}/>
  </div>}/>
    {editing && <Dialog open title="Edit goal" onClose={()=>setEditing(false)}>
      <form className="agent-goal-editor" onSubmit={event=>{event.preventDefault();if (draft.trim()) saveGoal(draft);}}>
        <label>Goal<textarea autoFocus value={draft} onChange={event=>setDraft(event.target.value)}/></label>
        <div className="agent-composer-buttons"><Button type="button" onClick={()=>setEditing(false)}>Cancel</Button><Button type="submit" disabled={!draft.trim()}>Save</Button></div>
      </form>
    </Dialog>}
  </div>;
}

function CodexModelPicker({models, model, effort, selectModel, selectEffort}: {
  models:string[]; model:string; effort:string; selectModel:(value:string)=>void; selectEffort:(value:string)=>void;
}) {
  const [listing,setListing]=useState(false);
  const modelButton=useRef<HTMLButtonElement>(null);
  const selectedOption=useRef<HTMLButtonElement>(null);
  function toggleList(open:boolean) {
    setListing(open);
    requestAnimationFrame(()=>{(open ? selectedOption : modelButton).current?.focus();});
  }
  if (listing) return <><strong>Select model</strong><div className="agent-picker-options">
    {['Default',...models].map(value=><button type="button" key={value} aria-pressed={model===value}
      ref={model===value ? selectedOption : undefined} onClick={()=>{selectModel(value);toggleList(false);}}>
      {value}{model===value && <Check size={15}/>}
    </button>)}
  </div></>;
  return <>
    <button ref={modelButton} type="button" className="agent-picker-switch agent-current-model" aria-label={`Select model, ${model}`}
      onClick={()=>toggleList(true)}>{model}<CaretRight size={14}/></button>
    <CodexEffortSlider value={effort} onChange={selectEffort}/>
    <small>Preview options</small>
  </>;
}
