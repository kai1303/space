import { AppError, record, text, uuid } from './validation.js';
import { isUnicodeEmoji } from './emoji.js';

export interface SidebarSection {
  id: string;
  name: string;
  collapsed: boolean;
  emoji?: string;
}

export interface SidebarSectionAssignment {
  channel_id: string;
  section_id: string;
  name: string;
  kind: 'channel' | 'direct';
  private: boolean;
}

export interface SidebarSectionsSnapshot {
  sections: SidebarSection[];
  assignments: SidebarSectionAssignment[];
}

export type CreateSidebarSection = { id: string; name: string; emoji?: string; channel_id?: string };
export type UpdateSidebarSection = Partial<Pick<SidebarSection, 'name' | 'collapsed'>> & { emoji?: string | null };

function sectionEmoji(value: unknown): string {
  if (!isUnicodeEmoji(value)) throw new AppError(400, 'invalid_emoji');
  return value;
}

export function parseCreateSidebarSection(input: unknown): CreateSidebarSection {
  const value = record(input, ['id', 'name', 'channel_id', 'emoji']);
  const section: CreateSidebarSection = { id: uuid(value.id), name: text(value.name, 80).trim() };
  if ('emoji' in value) section.emoji = sectionEmoji(value.emoji);
  if ('channel_id' in value) section.channel_id = uuid(value.channel_id);
  return section;
}

export function parseUpdateSidebarSection(input: unknown): UpdateSidebarSection {
  const value = record(input, ['name', 'collapsed', 'emoji']);
  const update: UpdateSidebarSection = {};
  if ('name' in value) update.name = text(value.name, 80).trim();
  if ('emoji' in value) update.emoji = value.emoji === null ? null : sectionEmoji(value.emoji);
  if ('collapsed' in value) {
    if (typeof value.collapsed !== 'boolean') throw new AppError(400, 'invalid_collapsed');
    update.collapsed = value.collapsed;
  }
  if (!Object.keys(update).length) throw new AppError(400, 'empty_section_update');
  return update;
}

export function parseSidebarAssignment(input: unknown): string | null {
  const value = record(input, ['section_id']);
  return value.section_id === null ? null : uuid(value.section_id);
}
