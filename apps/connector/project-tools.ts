import { createRequire } from 'node:module';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const projectToolNames = ['read_text_file', 'read_multiple_files', 'list_directory', 'search_files', 'get_file_info', 'write_file', 'edit_file', 'create_directory'];
export const projectServer = 'space_project';
export async function resolveProject(input?: string) {
  if (input === undefined) return undefined;
  if (!isAbsolute(input)) throw new Error('Use an absolute --project folder path.');
  const project = await realpath(input);
  if (!(await stat(project)).isDirectory()) throw new Error('The selected project must be a directory.');
  return project;
}
export function projectMcp(project: string) {
  const require = createRequire(import.meta.url);
  return { command: process.execPath, args: [require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js'), project] };
}
