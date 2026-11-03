import { open, unlink } from 'node:fs/promises';
import { createPool, database } from '@space/postgres/database';
import { provisionUser } from '@space/postgres/provisioning';
import { parseProfileInput } from '@space/contracts';

const profile = parseProfileInput({ display_name: process.env.USER_DISPLAY_NAME });
const path = process.env.USER_ENV_FILE ?? '.env.user';
const pool = createPool(process.env.DATABASE_URL);
let file;
try {
  file = await open(path, 'wx', 0o600);
  const user = await database(pool).transaction(async tx => {
    const user = await provisionUser(tx, profile);
    await file!.writeFile(`USER_ID=${user.id}\nUSER_TOKEN=${user.token}\n`);
    await file!.sync();
    return user;
  });
  console.log(`User ${user.id} created. Development credential saved to ${path}; keep it private.`);
} catch {
  if (file) {
    await file.close();
    file = undefined;
    await unlink(path).catch(() => {});
  }
  console.error('User creation failed. Check database access, display name and an unused credential-file path.');
  process.exitCode = 1;
} finally {
  await file?.close();
  await pool.end();
}
