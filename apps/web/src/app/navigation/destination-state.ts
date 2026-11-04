import type { Snapshot } from '../../shared/ui/view-state.js';
import type { ActivityView } from '../../features/notifications/view-state.js';
import type { DirectView } from '../../features/direct-messages/view-state.js';
import type { ConversationView } from '../../features/chat/view-state.js';
import type { SpacebotView } from '../../features/workspace/collections/view-state.js';
export function createWorkspaceViewState() {
  return {
    activity: {current:{kind:'',unread:false,before:'',scroll:0}} as Snapshot<ActivityView>,
    direct: {current:{query:'',unreads:false,after:'',scroll:0}} as Snapshot<DirectView>,
    spacebot: {current:{agent:'',channel:''}} as Snapshot<SpacebotView>,
    rooms: new Map<string, Snapshot<ConversationView>>(),
  };
}
export function conversationView(rooms: Map<string,Snapshot<ConversationView>>, id: string) {
  const view=rooms.get(id)??{current:{sessionOpen:false}};
  rooms.delete(id);rooms.set(id,view);
  if(rooms.size>32)rooms.delete(rooms.keys().next().value!);
  return view;
}
