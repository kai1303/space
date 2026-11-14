import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { parseSessionGoal, type SessionGoal } from '@space/contracts';

// Older Claude Code versions write evaluator verdicts to the native transcript only.
export async function claudeGoalTranscript(configDir: string, cwd: string, sessionId: string) {
  // Claude Code normalizes the absolute project path and hashes paths longer than 200 characters.
  const project = await realpath(cwd);
  let folder = project.replace(/[^a-zA-Z0-9]/g, '-');
  if (folder.length > 200) {
    let hash = 0;
    for (let i = 0; i < project.length; i++) hash = (Math.imul(hash, 31) + project.charCodeAt(i)) | 0;
    folder = folder.slice(0, 200) + '-' + Math.abs(hash).toString(36);
  }
  const projects = join(await realpath(configDir), 'projects');
  const parent = join(projects, folder);
  const path = join(parent, sessionId + '.jsonl');
  async function openTranscript() {
    if (await realpath(parent).catch(() => undefined) !== parent) return;
    return open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined);
  }
  let offset = 0;
  const initial = await openTranscript();
  if (initial) {
    try { offset = (await initial.stat()).size; } finally { await initial.close(); }
  }
  return {
    async read(objective: string): Promise<SessionGoal | undefined> {
      const file = await openTranscript();
      if (!file) return;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.size <= offset) return;
        const start = Math.max(offset, info.size - 512 * 1024);
        const bytes = Buffer.alloc(info.size - start);
        const {bytesRead} = await file.read(bytes, 0, bytes.length, start);
        const data = bytes.subarray(0, bytesRead);
        const end = data.lastIndexOf(10) + 1;
        if (!end) return;
        offset = start + end;
        let goal: SessionGoal | undefined;
        for (const line of data.toString('utf8', 0, end).split('\n')) {
          if (!line.includes('"goal_status"')) continue;
          let row;
          try { row = JSON.parse(line); } catch { continue; }
          const verdict = row.attachment;
          if (row.sessionId !== sessionId || row.type !== 'attachment' || verdict?.type !== 'goal_status' || verdict.condition !== objective) continue;
          goal = parseSessionGoal({objective, status:verdict.met === true ? 'complete' : verdict.impossible === true ? 'blocked' : 'active',
            ...(typeof verdict.reason === 'string' && verdict.reason.trim() ? {reason:verdict.reason.slice(0,4000)} : {})})!;
        }
        return goal;
      } finally { await file.close(); }
    },
  };
}
