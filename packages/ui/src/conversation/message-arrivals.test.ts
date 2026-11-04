import { afterEach, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { useMessageArrivals } from "./message-arrivals.js";

afterEach(cleanup);
it("animates every newly received message in a batch, without replaying history", () => {
  const history = [{ id: "history", author: "You" }];
  const { result, rerender } = renderHook(
    ({ messages, context }) => useMessageArrivals(messages, context),
    { initialProps: { messages: history, context: "general" as string | null } },
  );
  expect([...result.current]).toEqual([]);
  const received = [...history, { id: "alex", author: "Alex" }, { id: "jamie", author: "Jamie" }];
  rerender({ messages: received, context: "general" });
  expect([...result.current]).toEqual(["alex", "jamie"]);
  rerender({ messages: received, context: "general" });
  expect([...result.current]).toEqual([]);
  rerender({ messages: received, context: null });
  rerender({ messages: received, context: "general" });
  expect([...result.current]).toEqual([]);
});

it("keeps channel navigation and messages received in another view still", () => {
  const { result, rerender } = renderHook(
    ({ messages, context }) => useMessageArrivals(messages, context),
    { initialProps: { messages: [{ id: "history" }], context: "general" as string | null } },
  );
  const history = [{ id: "history" }, { id: "engineering-history" }];
  rerender({ messages: history, context: "engineering" });
  expect([...result.current]).toEqual([]);
  rerender({ messages: history, context: null });
  const incoming = [...history, { id: "received-while-hidden" }];
  rerender({ messages: incoming, context: null });
  expect([...result.current]).toEqual([]);
  rerender({ messages: incoming, context: "engineering" });
  expect([...result.current]).toEqual([]);
});
