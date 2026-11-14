import { useEffect, useRef, useState } from 'react';
import { FolderOpen } from '@phosphor-icons/react';
import { Button } from '@space/ui/primitives';
import { request } from '../../shared/api/request.js';
import { errorText } from '../../shared/api/error-text.js';

export type SessionProject = { session: string; installation: string; name: string; project_token: string };

export function SessionProjectPicker({installation, viewer, project, disabled, onChange, onBusy}: {
  installation: string; viewer: string; project?: SessionProject; disabled: boolean;
  onChange: (value?: SessionProject) => void; onBusy: (busy: boolean) => void;
}) {
  const pending = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => () => { pending.current?.abort(); onBusy(false); }, [onBusy]);
  async function choose() {
    if (pending.current) return;
    const controller = pending.current = new AbortController();
    const session = crypto.randomUUID();
    setBusy(true); onBusy(true); setError('');
    try {
      const {selection} = await request<{selection: Pick<SessionProject, 'name' | 'project_token'> | null}>(
        `/agents/connections/${installation}/project-picker`, {session_id: session}, undefined, 'POST', controller.signal, viewer);
      if (selection && !controller.signal.aborted) onChange({...selection, session, installation});
    } catch (cause) { if (!controller.signal.aborted) setError(errorText(cause)); }
    finally {
      pending.current = null;
      if (!controller.signal.aborted) { setBusy(false); onBusy(false); }
    }
  }
  return <div role="group" aria-label="Project folder">
    <Button variant="ghost" type="button" disabled={disabled || busy} onClick={choose}>
      <FolderOpen size={16}/>{project ? project.name : 'Choose project folder…'}
    </Button>
    {project && <Button variant="ghost" type="button" disabled={disabled || busy} onClick={() => onChange()}>Clear folder</Button>}
    {busy && <small role="status">Choose a folder on the computer running this agent.</small>}
    {error && <small role="alert">{error}</small>}
  </div>;
}
