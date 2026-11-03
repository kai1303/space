// Both protocols share transport limits and credential handling, not request/response schemas.
export function navigatorEndpoint(endpoint:string,suffix:string):string {
 let url:URL;try{url=new URL(endpoint);}catch{throw new Error('navigator_provider_failed');}
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 if((url.protocol!=='https:'&&!(url.protocol==='http:'&&local))||url.username||url.password||url.search||url.hash||!url.pathname.endsWith(suffix))throw new Error('navigator_provider_failed');
 return url.toString();
}
export async function postNavigatorJson(options:{endpoint:string;apiKey?:string;body:string;signal:AbortSignal;timeoutMs:number;fetcher:typeof globalThis.fetch}):Promise<any> {
 const {endpoint,apiKey,body,signal,timeoutMs,fetcher}=options;
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000||signal.aborted||Buffer.byteLength(body)>32768)throw new Error('navigator_provider_failed');
 const controller=new AbortController();let reader:ReadableStreamDefaultReader<Uint8Array>|undefined,timer:ReturnType<typeof setTimeout>|undefined,stop:(()=>void)|undefined;
 const abort=()=>controller.abort();
 try{
  signal.addEventListener('abort',abort,{once:true});
  const cancelled=new Promise<never>((_,reject)=>{stop=()=>{void reader?.cancel().catch(()=>{});reject(new Error('navigator_provider_failed'));};controller.signal.addEventListener('abort',stop,{once:true});});
  timer=setTimeout(abort,timeoutMs);
  const operation=async()=>{
   const headers:Record<string,string>={'Content-Type':'application/json',Accept:'application/json'};if(apiKey)headers.Authorization=`Bearer ${apiKey}`;
   const response=await fetcher(endpoint,{method:'POST',headers,body,signal:controller.signal,redirect:'error'});
   if(controller.signal.aborted||!response.ok||!response.body||Number(response.headers.get('content-length'))>65536){void response.body?.cancel().catch(()=>{});throw new Error('navigator_provider_failed');}
   reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
   try{while(true){const chunk=await reader.read();if(chunk.done)break;size+=chunk.value.byteLength;if(size>65536){await reader.cancel();throw new Error('navigator_provider_failed');}chunks.push(chunk.value);}}
   finally{reader.releaseLock();reader=undefined;}
   return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
  return await Promise.race([operation(),cancelled]);
 }catch{throw new Error('navigator_provider_failed');}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);if(stop)controller.signal.removeEventListener('abort',stop);}
}
