import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { SidebarSectionDialog, type SectionEdit } from './SidebarSectionDialog.js';
import { useSidebarSections } from './useSidebarSections.js';

type SectionControls = ReturnType<typeof useSidebarSections> & {
  createSection: (channel?: string) => void;
  manageSection: (id: string, action: 'rename' | 'delete') => void;
};
const SectionsContext = createContext<SectionControls | null>(null);

export function usePersonalSections() {
  const sections = useContext(SectionsContext);
  if (!sections) throw new Error('SidebarSectionsProvider is required');
  return sections;
}

export function SidebarSectionsProvider({ workspace, viewer, children }: { workspace: string; viewer: string; children: ReactNode }) {
  const personal = useSidebarSections(workspace, viewer);
  const [dialog, setDialog] = useState<{ workspace: string; viewer: string; edit: SectionEdit }>();
  const edit = dialog?.workspace === workspace && dialog.viewer === viewer ? dialog.edit : undefined;
  useEffect(() => {
    setDialog(current => current?.workspace === workspace && current.viewer === viewer ? current : undefined);
  }, [workspace, viewer]);
  function setEdit(edit: SectionEdit) { setDialog({ workspace, viewer, edit }); }
  function createSection(channel?: string) {
    setEdit({ action: 'create', id: crypto.randomUUID(), channel });
  }
  function manageSection(id: string, action: 'rename' | 'delete') {
    const section = personal.sections.find(item => item.id === id);
    if (section) setEdit({ action, id, name: section.name, emoji: section.emoji });
  }
  return <SectionsContext.Provider value={{ ...personal, createSection, manageSection }}>
    {children}
    {edit && <SidebarSectionDialog key={edit.id} edit={edit}
      onClose={() => setDialog(current => current?.edit === edit ? undefined : current)}
      onSave={(name, emoji) => edit.action === 'create'
        ? personal.create({ id: edit.id, name, emoji, channel_id: edit.channel })
        : edit.action === 'rename' ? personal.update(edit.id, { name, emoji: emoji ?? null }) : personal.remove(edit.id)}/>}
  </SectionsContext.Provider>;
}
