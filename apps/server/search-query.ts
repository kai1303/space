import { AppError } from '@space/contracts';

export type SearchQuery = {text:string;channel?:string;from?:string;hasLink?:boolean;threadsOnly?:boolean;before?:number;after?:number};
export function parseSearchQuery(input: unknown): SearchQuery {
  const invalid = () => new AppError(400, 'invalid_search');
  if(typeof input !== 'string' || !input.trim() || input.length > 500 || /[\u0000-\u001f]/.test(input) || (input.match(/"/g)?.length ?? 0) % 2) throw invalid();
  const result:SearchQuery = {text:''}, terms:string[] = [];
  for(const token of input.match(/(?:[^\s"]|"[^"]*")+/g) ?? []) {
    const colon = token.indexOf(':');
    if(colon <= 0 || /^https?:\/\//i.test(token) || token.startsWith('"')) { terms.push(token); continue; }
    const key = token.slice(0,colon).toLowerCase(), value = token.slice(colon+1).replace(/^"|"$/g,'');
    if(!value) throw invalid();
    if(key === 'in') result.channel = value.replace(/^#/,'').toLowerCase();
    else if(key === 'from') result.from = value.replace(/^@/,'').toLowerCase();
    else if(key === 'has' && value === 'link') result.hasLink = true;
    else if(key === 'is' && value === 'thread') result.threadsOnly = true;
    else if(key === 'before' || key === 'after') {
      const date = Date.parse(value+'T00:00:00Z');
      if(!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date) || new Date(date).toISOString().slice(0,10)!==value) throw invalid();
      result[key] = date;
    } else throw invalid();
  }
  if(result.channel === '' || result.from === '') throw invalid();
  result.text = terms.join(' ') || '*';
  return result;
}
