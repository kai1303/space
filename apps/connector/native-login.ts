import { spawn } from 'node:child_process';

export interface LoginCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv & { HOME: string };
}

export async function runNativeLogin({ command, args, env }: LoginCommand, signal: AbortSignal, name: string) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { cwd: env.HOME, env, stdio: 'inherit', signal });
    child.once('error', () => reject(new Error(`Could not start ${name} authentication.`)));
    child.once('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${name} sign-in or sign-out did not complete.`));
    });
  });
}
