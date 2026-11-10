import { DatabaseSync } from "node:sqlite";

import type { MessageInput } from "./template";

export function createMailbox(path: string) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS messages (key TEXT PRIMARY KEY, destination TEXT NOT NULL, text TEXT NOT NULL)");
  const insert = db.prepare("INSERT INTO messages VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING");
  const messages = db.prepare("SELECT destination, text FROM messages ORDER BY rowid");

  return {
    async postMessageV1({ key, destination, text }: MessageInput) {
      insert.run(key, destination, text);
      return { messageId: key };
    },
    list: () => messages.all(),
    close: () => db.close()
  };
}
