import { useState } from 'react';
import { Button, Dialog } from '@space/ui/primitives';
import { MAX_ASSET_DESCRIPTION_LENGTH, type AssetDetails } from '@space/contracts';
import { sessionFetch } from '../../shared/api/session-fetch.js';

export function FileDetailsForm({ details, altOnly = false, onSaved, onClose }: {
  altOnly?: boolean;
  details: AssetDetails; onSaved: (details: AssetDetails) => void; onClose: () => void;
}) {
  const [original] = useState(details);
  const [name, setName] = useState(details.name);
  const [description, setDescription] = useState(details.description);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (saving) return;
    setSaving(true); setError('');
    try {
      const response = await sessionFetch(`/v1/assets/${original.id}/details`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, description, previous_name: original.name, previous_description: original.description }),
      });
      if (!response.ok) throw new Error(response.status === 409 ? 'The file details changed. Close and reopen this form to edit the latest version.' :
        response.status === 400 ? 'Enter a valid filename.' : 'Could not save file details.');
      onSaved(await response.json()); onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save file details.'); }
    finally { setSaving(false); }
  }
  return <Dialog open title={altOnly ? 'Image description' : 'Edit file details'} onClose={onClose}>
    <form className="asset-details-form" onSubmit={e => { e.preventDefault(); void save(); }}>
      {!altOnly && <label>File name<input autoFocus required maxLength={255} value={name} onChange={e => setName(e.target.value)} /></label>}
      <label>{altOnly ? 'Alt text' : 'Description'}<textarea autoFocus={altOnly} maxLength={MAX_ASSET_DESCRIPTION_LENGTH} value={description} onChange={e => setDescription(e.target.value)} /></label>
      {error && <p role="alert">{error}</p>}
      <div><Button onClick={onClose}>Cancel</Button><Button type="submit" variant="primary" disabled={saving || !name.trim()}>Save</Button></div>
    </form>
  </Dialog>;
}
