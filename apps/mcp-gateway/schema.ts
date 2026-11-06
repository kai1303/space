import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { AppError } from '@space/contracts';
const ajvPath = createRequire(import.meta.url).resolve('ajv');
// Untrusted schemas and regexes run outside the event loop with a CPU/memory deadline.
export async function validateArguments(
  schema: Record<string, unknown>,
  args: unknown,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const worker = new Worker(
      `const {parentPort,workerData}=require('node:worker_threads');try{const Ajv=require(workerData.path);const validate=new Ajv({strict:false,validateFormats:false,allErrors:false}).compile(workerData.schema);parentPort.postMessage(validate(workerData.args));}catch{parentPort.postMessage(false);}`,
      {
        eval: true,
        workerData: { path: ajvPath, schema, args },
        resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
      },
    );
    let settled = false;
    const finish = (valid: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      void worker.terminate();
      valid ? resolve() : reject(new AppError(400, 'invalid_tool_arguments'));
    };
    const abort = () => finish(false),
      timer = setTimeout(abort, 1500);
    signal.addEventListener('abort', abort, { once: true });
    worker.once('message', (value) => finish(value === true));
    worker.once('error', abort);
    worker.once('exit', () => {
      if (!settled) finish(false);
    });
  });
}
