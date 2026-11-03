import type { NavigatorProvider } from '@space/contracts';
import { CompatibleNavigatorProvider } from './navigator-provider.js';
import { JevNavigatorProvider } from './jev-navigator.js';

export function createNavigatorProviders(env:Record<string,string|undefined>):{level1?:NavigatorProvider;level2?:NavigatorProvider}{
 const result:{level1?:NavigatorProvider;level2?:NavigatorProvider}={};
 for(const level of [1,2] as const){
  const prefix=`NAVIGATOR_L${level}`,kind=env[`${prefix}_PROVIDER`]||'compatible';
  const endpoint=env[`${prefix}_URL`]||undefined,model=env[`${prefix}_MODEL`]||undefined,apiKey=env[`${prefix}_API_KEY`]||undefined;
  if(kind==='jev'){
   if(level!==1)throw new Error('Jev is supported only as the Level 1 decision provider');
   result.level1=new JevNavigatorProvider({endpoint,model,apiKey:apiKey??env.TYPESAFE_API_KEY??'',yesThreshold:env[`${prefix}_YES_THRESHOLD`]===undefined?undefined:Number(env[`${prefix}_YES_THRESHOLD`]),noThreshold:env[`${prefix}_NO_THRESHOLD`]===undefined?undefined:Number(env[`${prefix}_NO_THRESHOLD`])});
  }else if(kind==='compatible'){
   if(!endpoint&&!model)continue;
   if(!endpoint||!model)throw new Error(`${prefix}_URL and MODEL must be configured together`);
   result[level===1?'level1':'level2']=new CompatibleNavigatorProvider({endpoint,model,apiKey,name:prefix,maxOutputTokens:level===1?512:1024});
  }else throw new Error(`Unknown ${prefix}_PROVIDER`);
 }
 return result;
}
