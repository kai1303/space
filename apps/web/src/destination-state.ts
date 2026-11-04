export type Snapshot<T> = { current: T };
export type ActivityView = { kind: string; unread: boolean; before: string; scroll: number };
export type DirectView = { query: string; unreads: boolean; after: string; scroll: number };
export type ConversationView = { thread?: string; sessionView?: {thread:string;selected:string}; sessionOpen: boolean };
export type SpacebotView = { agent: string; channel: string };
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
