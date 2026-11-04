import { parseArgs } from 'node:util';
import { createNavigatorProviders } from '@space/core/navigator-providers';
import { evaluateNavigator } from './navigator.js';
import { navigatorEvaluationCases, navigatorCorpusVersion } from './navigator-fixtures.js';

const help = `Navigator decision replay (never dispatches work)
  pnpm navigator:eval                         Offline rules baseline
  pnpm navigator:eval --mode level1 --limit 1  One live Level 1 call
  pnpm navigator:eval --mode level1           Live labeled corpus
Options:
  --case ID                    Run one named case
  --limit N                    Maximum cases, 1–100 (default: all 36)
  --max-reserved-tokens N       Conservative request budget (default: 100000)
  --input-usd-per-million N     Optional operator-supplied input price
  --output-usd-per-million N    Optional operator-supplied output price
  --require-perfect            Exit 1 on incorrect decisions as well as incomplete runs
Private project .env is loaded; shell variables take precedence.
Level 1 mode requires explicit NAVIGATOR_L1_* configuration (Jev: provider=jev and TYPESAFE_API_KEY).
Reports go to stdout as JSON; redirect to a private file to keep a result.
Accuracy is descriptive; this small synthetic corpus does not establish production quality.`;

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, mode: { type: 'string', default: 'rules' }, case: { type: 'string' }, limit: { type: 'string' },
    'max-reserved-tokens': { type: 'string' }, 'input-usd-per-million': { type: 'string' }, 'output-usd-per-million': { type: 'string' }, 'require-perfect': { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  if (values.mode !== 'rules' && values.mode !== 'level1') throw Error('Use --mode rules or --mode level1');
  const number = (value: string | undefined) => value === undefined ? undefined : Number(value);
  const limit = number(values.limit) ?? navigatorEvaluationCases.length;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw Error('Limit must be 1–100');
  const cases = navigatorEvaluationCases.filter(item => values.case === undefined || item.id === values.case).slice(0, limit);
  if (!cases.length) throw Error('Unknown evaluation case');
  // Do not initialize or validate unrelated Level 2 credentials during a Level 1 replay.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key === 'TYPESAFE_API_KEY' || key.startsWith('NAVIGATOR_L1_')));
  let provider;
  try { provider = values.mode === 'level1' ? createNavigatorProviders(env).level1 : undefined; }
  catch { throw Error('Invalid Level 1 configuration; check private .env provider, endpoint, model and key'); }
  const report = await evaluateNavigator(cases, {
    mode: values.mode, provider, maxReservedTokens: number(values['max-reserved-tokens']),
    inputUsdPerMillion: number(values['input-usd-per-million']), outputUsdPerMillion: number(values['output-usd-per-million']),
  });
  console.log(JSON.stringify({ corpus: navigatorCorpusVersion, generatedAt: new Date().toISOString(), ...report }, null, 2));
  if (report.summary.errors || report.summary.skipped || (values['require-perfect'] && report.summary.correct !== report.summary.total)) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Navigator evaluation failed'); process.exitCode = 1; });
