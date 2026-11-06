import type { RichDocument, WorkspaceProfile } from '@space/contracts';

export function profileMessageDraft(profile: Extract<WorkspaceProfile, {kind:'agent'}>, draft?: RichDocument): RichDocument {
  if (draft?.ops.some(op => op.attributes?.mention?.kind === 'agent' && op.attributes.mention.id === profile.id)) return draft;
  const ops = draft?.ops ?? [];
  return {ops:[...ops, ...(ops.some(op => op.insert.trim()) ? [{insert:'\n'}] : []),
    {insert:`@${profile.display_name}`,attributes:{mention:{kind:'agent',id:profile.id,label:profile.display_name}}}, {insert:' '}]};
}
