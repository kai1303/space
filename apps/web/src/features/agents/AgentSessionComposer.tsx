import { isLocalAgentSkill, effortLabel, type AgentModel, type ReasoningEffort, goalLabels, type SessionGoal, type GoalAction, type CodexSettings } from '@space/contracts';
import { AgentDictation } from './AgentDictation.js';
import { CodexEffortSlider } from './CodexEffortSlider.js';
import { useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react';
import { ArrowLeft, CaretDown, CaretRight, Check, Flag, Pause, PencilSimple, Play, X } from '@phosphor-icons/react';
import { motionTransition } from '@space/ui/motion';
import { ComposerSendError } from '@space/ui/composer';
import { Button, Dialog, IconButton, Popover } from '@space/ui/primitives';
import { ConversationComposer } from '../chat/ThreadConversation.js';
import './agent-session-composer.css';

const MotionButton = motion.create(Button);

function GoalModeIndicator({disabled, onExit}: {disabled: boolean; onExit: () => void}) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const hidden = {opacity:0, scale:reduced ? 1 : 0.94};
  return <MotionButton variant="ghost" size="sm" className="agent-goal-indicator" aria-label="Exit goal mode" title="Exit goal mode"
    initial={reduced ? false : hidden} animate={{opacity:1, scale:1}} exit={hidden}
    transition={motionTransition(reduced)}
    aria-hidden={!present || undefined} inert={!present} disabled={disabled} onClick={onExit}>
    <Flag size={14} aria-hidden="true"/><X size={14} aria-hidden="true"/>Goal
  </MotionButton>;
}

type ComposerProps = ComponentProps<typeof ConversationComposer>;
type Submit = (text: string, document: Parameters<ComposerProps['onSend']>[1], files: Parameters<ComposerProps['onSend']>[2],
  options?: {broadcast_confirmed?: boolean; codex_settings?: CodexSettings}) => void | Promise<void>;
type Props = Omit<ComposerProps,'onSend'|'onAlternateSend'> & {
  onSend: Submit;
  onAlternateSend?: Submit;
  initialSettings?: CodexSettings | null;
  sessionGoal?: SessionGoal | null;
  startingGoal?: string;
  onGoalAction?: (action: GoalAction, settings?: CodexSettings) => Promise<void>;
  skill: string;
  preview?: boolean;
  models: AgentModel[];
};

export function AgentSessionComposer({ skill, models, preview, initialSettings, sessionGoal, startingGoal, onGoalAction, controls, ...props }: Props) {
  const supportsGoals = skill === 'codex.run' || skill === 'claude.run';
  const supportsModels = isLocalAgentSkill(skill);
  const [selection,setSelection] = useState(initialSettings);
  const selected = models.find(item => item.id === selection?.model) ?? models.find(item => item.isDefault);
  const effort = selected && selection?.effort && (!selection.model || selection.model === selected.id) && selected.efforts.includes(selection.effort)
    ? selection.effort : selected?.defaultEffort;
  const modelLabel = selected?.label ?? 'Default';
  const currentEffortLabel = effort && effortLabel(effort);
  const [previewGoal, setPreviewGoal] = useState<SessionGoal | null>(null);
  const goal = preview ? previewGoal : sessionGoal;
  const canManageGoal = Boolean(supportsGoals && (onGoalAction || preview));
  const goalPending = useRef(false);
  const [saving, setSaving] = useState(false);
  const [goalError, setGoalError] = useState('');
  const [composingGoal, setComposingGoal] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [dictating, setDictating] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  const popover = { floating: true, align: 'start' as const, triggerClassName: 'agent-composer-trigger', panelClassName: 'agent-composer-popover' };
  const focusInput = () => region.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
  function setGoalMode(active: boolean) {
    setComposingGoal(active);
    focusInput();
  }
  function selectedSettings(): CodexSettings | undefined {
    if (selected) return {model:selected.id,...(effort ? {effort} : {})};
  }
  async function applyGoal(action: GoalAction) {
    if (goalPending.current) throw new ComposerSendError('A goal change is already being sent.');
    if (action.kind === 'pause' || action.kind === 'resume') {
      if (skill !== 'codex.run') throw new ComposerSendError('Claude supports setting and clearing a goal.');
      if (!goal) throw new ComposerSendError('Set a goal first.');
    }
    if (action.kind === 'set' && skill === 'claude.run' && /^(clear|stop|off|reset|none|cancel)$/i.test(action.objective)) {
      throw new ComposerSendError('Claude uses that word to clear its goal. Describe a completion condition.');
    }
    goalPending.current = true;
    setSaving(true);
    setGoalError('');
    try {
      if (onGoalAction) await onGoalAction(action, selectedSettings());
      else if (preview) setPreviewGoal(current => {
        if (action.kind === 'clear') return null;
        if (action.kind === 'set') return {objective:action.objective, status:'active'};
        return current && {...current, status:action.kind === 'pause' ? 'paused' : 'active'};
      });
      setComposingGoal(false);
      setEditing(false);
    } finally {
      goalPending.current = false;
      setSaving(false);
    }
  }
  function control(action: GoalAction) {
    void applyGoal(action).catch(error => setGoalError(error instanceof Error ? error.message : 'Could not update goal.'));
  }
  const withGoal = (submit:Submit):ComposerProps['onSend'] => (text, document, attachments, options) => {
    const command = Boolean(supportsGoals && /^\/goal(?:\s|$)/.test(text));
    if (composingGoal || command) {
      if (!canManageGoal) throw new ComposerSendError('Only the local agent owner can change this goal.');
      if (attachments.length) throw new ComposerSendError('Send attachments in a message or remove them to set a goal.');
      const objective = (command ? text.slice(5) : text).trim();
      if (command && skill === 'claude.run' && /^(stop|off|reset|none|cancel)$/i.test(objective)) return applyGoal({kind:'clear'});
      if (command && (objective === 'pause' || objective === 'resume' || objective === 'clear')) return applyGoal({kind:objective});
      if (goal && command) { setDraft(!objective || objective === 'edit' ? goal.objective : objective); setEditing(true); return; }
      if (!objective) { setGoalMode(true); return; }
      return applyGoal({kind:'set',objective});
    }
    const settings = selectedSettings();
    if (settings) return submit(text, document, attachments, {...options,codex_settings:settings});
    return submit(text, document, attachments, options);
  };

  const pickerLabel = [selected?.efforts.length ? 'Select model and effort' : 'Choose model',modelLabel,currentEffortLabel].filter(Boolean).join(', ');
  const pickerTrigger = <span className="agent-effort-trigger">
    <span className="agent-trigger-model">{modelLabel}</span>
    {currentEffortLabel && <span className="agent-trigger-effort">{currentEffortLabel}</span>}<CaretDown/>
  </span>;
  return <div ref={region}>
    {!goal && startingGoal && <div className="agent-session-goal" role="status">
      <Flag size={16}/><div><small>Starting goal…</small><strong>{startingGoal}</strong></div>
    </div>}
    {goal && <div className="agent-session-goal" aria-label="Session goal">
      <Flag size={16}/><div><small role="status">{goalLabels[goal.status]}{preview && ' · Preview'}</small><strong>{goal.objective}</strong>{goal.reason && <small>{goal.reason}</small>}</div>
      {canManageGoal && <>
        <IconButton size="sm" label="Edit goal" disabled={saving} onClick={()=>{setDraft(goal.objective);setEditing(true);}}><PencilSimple/></IconButton>
        {skill === 'codex.run' && goal.status !== 'complete' && <IconButton size="sm" disabled={saving} label={goal.status === 'active' ? 'Pause goal' : 'Resume goal'} onClick={()=>control({kind:goal.status === 'active' ? 'pause' : 'resume'})}>{goal.status === 'active' ? <Pause/> : <Play/>}</IconButton>}
        <IconButton size="sm" label="Clear goal" disabled={saving} onClick={()=>control({kind:'clear'})}><X/></IconButton>
      </>}
    </div>}
    {goalError && <p role="alert">{goalError}</p>}
    <ConversationComposer {...props} sendDisabled={props.sendDisabled || dictating || saving} placeholder={composingGoal ? 'Describe your goal and how to tell when it’s done' : props.placeholder}
      submitLabel={composingGoal ? undefined : props.submitLabel} onSend={withGoal(props.onSend)} onAlternateSend={props.onAlternateSend && withGoal(props.onAlternateSend)}
      submitIcon={composingGoal ? undefined : props.submitIcon} controls={{
        ...controls,
        submitAccessory: composingGoal ? undefined : controls.submitAccessory,
        renderAddMenuItems: canManageGoal && !goal && !startingGoal ? close =>
          <button type="button" role="menuitem" onClick={() => {
            close(false);
            setGoalMode(!composingGoal);
          }}><Flag size={17}/>{composingGoal ? 'Cancel goal mode' : 'Set goal'}</button> : undefined,
        renderBeforeSend: (insert, disabled) => <AgentDictation insert={insert} disabled={disabled} onBusy={setDictating}/>,
        renderExtraActions: (_, disabled) => supportsModels && <div className="agent-composer-tools">
          <Popover {...popover} label={pickerLabel} panelClassName="agent-composer-popover agent-model-popover" trigger={pickerTrigger}>
            {() => models.length ? <AgentModelPicker models={models} selected={selected} effort={effort}
              selectModel={id => setSelection({model:id})} selectEffort={value => setSelection({model:selected?.id, effort:value})}/>
              : <small>The connector hasn’t reported any models. Messages use its default.</small>}
          </Popover>
          <AnimatePresence initial={false}>
            {composingGoal && <GoalModeIndicator key="goal" disabled={disabled || saving} onExit={() => setGoalMode(false)}/>}
          </AnimatePresence>
        </div>,
      }}/>
    {editing && <Dialog open title="Edit goal" onClose={()=>setEditing(false)}>
      <form className="agent-goal-editor" onSubmit={event=>{event.preventDefault();if (draft.trim()) control({kind:'set',objective:draft.trim()});}}>
        <label>Goal<textarea maxLength={4000} autoFocus value={draft} onChange={event=>setDraft(event.target.value)}/></label>
        <div className="agent-composer-buttons"><Button type="button" onClick={()=>setEditing(false)}>Cancel</Button><Button type="submit" disabled={!draft.trim() || saving}>Save</Button></div>
      </form>
    </Dialog>}
  </div>;
}

function ModelPickerPage({listing, children}: {listing:boolean; children:ReactNode}) {
  const present = useIsPresent();
  const reduced = useReducedMotion();
  const offset = listing ? 8 : -8;
  return <motion.div className="agent-model-page" inert={!present} aria-hidden={!present || undefined}
    style={{position:present ? 'relative' : 'absolute', inset:present ? undefined : '0 0 auto'}}
    initial={reduced ? false : {opacity:0, x:offset}} animate={{opacity:1, x:0}}
    exit={{opacity:0, x:reduced ? 0 : offset}} transition={motionTransition(reduced)}>
    {children}
  </motion.div>;
}

function AgentModelPicker({models, selected, effort, selectModel, selectEffort}: {
  models:AgentModel[]; selected?:AgentModel; effort?:ReasoningEffort; selectModel:(id:string)=>void; selectEffort:(value?:ReasoningEffort)=>void;
}) {
  const levels = selected?.efforts ?? [];
  const options = selected?.defaultEffort ? levels : ['', ...levels];
  const model = selected?.label ?? 'Default';
  const [listing,setListing]=useState(false);
  const modelButton=useRef<HTMLButtonElement>(null);
  const selectedOption=useRef<HTMLButtonElement>(null);
  function toggleList(open:boolean) {
    setListing(open);
    requestAnimationFrame(()=>{(open ? selectedOption : modelButton).current?.focus();});
  }
  return <div className="agent-model-pages"><AnimatePresence initial={false}>
    <ModelPickerPage key={listing ? 'models' : 'effort'} listing={listing}>
    {listing ? <><div className="agent-model-list-heading">
      <IconButton size="sm" label="Back to model and effort" onClick={()=>toggleList(false)}><ArrowLeft size={16}/></IconButton>
      <strong>Select model</strong>
    </div><div className="agent-picker-options">
    {models.map((item,index)=><button type="button" key={item.id} aria-pressed={selected?.id===item.id}
      ref={(selected ? selected.id===item.id : index===0) ? selectedOption : undefined} onClick={()=>{selectModel(item.id);toggleList(false);}}>
      {item.label}{selected?.id===item.id && <Check size={15}/>}
    </button>)}
  </div></> : <>
    <button ref={modelButton} autoFocus={!levels.length || options.length===1} type="button" className="agent-picker-switch agent-current-model" aria-label={`Select model, ${model}`}
      onClick={()=>toggleList(true)}>{model}<CaretRight size={14}/></button>
    {levels.length > 0 && (options.length > 1
      ? <CodexEffortSlider key={selected?.id} levels={options} value={effort ?? ''} onChange={value=>selectEffort(value || undefined)}/>
      : <div className="agent-power-label">Reasoning effort <strong>{effortLabel(options[0]!)}</strong></div>)}
  </>}
    </ModelPickerPage>
  </AnimatePresence></div>;
}
