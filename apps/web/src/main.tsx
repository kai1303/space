import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/lato/400.css";
import "@fontsource/lato/700.css";
import "@fontsource/lato/900.css";
import "@space/ui/styles.css";
import "./gallery.css";
import { App } from "./App.js";
import { Chat } from "./Chat.js";
import { Workspace } from "./Workspace.js";
import { MotionConfig } from "motion/react";
import { motionTransition } from "@space/ui";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user" transition={motionTransition(false)}>
      {location.pathname.startsWith("/w/") || location.pathname === "/chat" || (location.pathname === "/" && (!location.hash || location.hash === "#chat-messages")) ? <Chat /> : location.pathname === "/workspace" ? <Workspace /> : <App />}
    </MotionConfig>
  </React.StrictMode>,
);
