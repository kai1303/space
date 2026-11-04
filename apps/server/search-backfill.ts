import {createPool} from '@space/postgres/database';
import {SearchStore} from '@space/postgres/search';

const pool=createPool(process.env.DATABASE_URL);
try {await new SearchStore(pool).enqueueBackfill();console.log('Enqueued durable message search backfill.');}
finally {await pool.end();}
