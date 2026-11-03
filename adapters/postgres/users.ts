import type { Pool } from 'pg';
import { eq } from 'drizzle-orm';
import { AppError, parseProfileUpdate, uuid, visibleStatus } from '@space/contracts';
import { database } from './database.js';
import { users } from './schema.js';

export class UserStore {
  readonly db;
  constructor(pool: Pool) { this.db = database(pool); }
  async profile(actor: string) {
    const [user] = await this.db.select().from(users).where(eq(users.id, uuid(actor)));
    if (!user) throw new AppError(404, 'not_found');
    return { ...user, status: visibleStatus(user.status) };
  }
  async updateProfile(actor: string, input: unknown) {
    const [user] = await this.db.update(users).set({ ...parseProfileUpdate(input), updated_at: new Date() }).where(eq(users.id, uuid(actor))).returning();
    if (!user) throw new AppError(404, 'not_found');
    return { ...user, status: visibleStatus(user.status) };
  }
}
