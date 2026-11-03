// Default channel mode; snippet creation and Enter-to-newline preferences are separate capabilities.
export function isDefaultComposerSendKey(event: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey" | "isComposing" | "keyCode">) {
  return event.key === "Enter" && !event.isComposing && event.keyCode !== 229 &&
    !event.shiftKey && (event.metaKey || (!event.ctrlKey && !event.altKey));
}
