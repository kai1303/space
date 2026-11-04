export type HubView = 'spacebot' | 'files' | 'todos' | 'agents' | 'threads' | 'huddles' | 'drafts' | 'saved' | 'directories';
export const homeShortcuts = new Set<HubView>(['threads', 'huddles', 'drafts', 'saved', 'directories']);
