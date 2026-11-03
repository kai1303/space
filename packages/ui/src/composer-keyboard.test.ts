import { expect, it } from "vitest";
import { isDefaultComposerSendKey } from "./composer-keyboard.js";
const enter = { key: "Enter", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13 };
it("sends Enter and Command+Enter in the default channel mode", () => {
  expect(isDefaultComposerSendKey(enter)).toBe(true);
  expect(isDefaultComposerSendKey({ ...enter, metaKey: true })).toBe(true);
});
it.each([{ shiftKey: true }, { altKey: true }, { ctrlKey: true }, { isComposing: true }, { keyCode: 229 }, { key: "Tab" }])("keeps newline, composition and non-send keys in the editor (%j)", (override) => {
  expect(isDefaultComposerSendKey({ ...enter, ...override })).toBe(false);
});
