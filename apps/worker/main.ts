import { NavigatorStore } from '@space/postgres/navigator';
import { createNavigatorProviders } from '@space/core/navigator-providers';
import { setTimeout } from 'node:timers/promises';
import { createPool } from '@space/postgres/database';
import { PostgresStore } from '@space/postgres/store';
import { MockConnector } from '@space/mock/connector';
import { deliverOne } from '@space/core/worker';
import { AgUiConnector } from '@space/core/ag-ui';
const pool = createPool(process.env.DATABASE_URL);
const store = new PostgresStore(pool);
const connectors = [new MockConnector(), ...(process.env.AG_UI_URL ? [new AgUiConnector({ url: process.env.AG_UI_URL, token: process.env.AG_UI_TOKEN })] : [])];
const navigator=new NavigatorStore(pool,createNavigatorProviders(process.env));
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });
async function loop(work:()=>Promise<boolean>) {
 while(!stopping){try{if(!await work())await setTimeout(250);}catch{console.error('worker_operation_failed');await setTimeout(1000);}}
}
try {await Promise.all([loop(()=>navigator.processOne()),loop(()=>deliverOne(store,connectors))]);}
finally {await pool.end();}
