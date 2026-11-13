import { env, pipeline } from '@huggingface/transformers';

import wasmUrl from 'space-dictation-runtime/ort-wasm-simd-threaded.jsep.wasm?url';
import loaderUrl from 'space-dictation-runtime/ort-wasm-simd-threaded.jsep.mjs?url';

env.allowLocalModels = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = {
    wasm:new URL(wasmUrl,self.location.href).href,
    mjs:new URL(loaderUrl,self.location.href).href,
  };
}

export type DictationUpdate =
  | { phase: 'loading'; percent?: number }
  | { phase: 'transcribing' }
  | { phase: 'done'; text: string }
  | { phase: 'error'; message: string };

const report = (update: DictationUpdate) => self.postMessage(update);
self.onmessage = async ({data}: MessageEvent<Float32Array>) => {
  try {
    report({phase:'loading'});
    const transfers = new Map<string,{loaded:number; total:number}>();
    const transcribe = await pipeline('automatic-speech-recognition','Xenova/whisper-tiny',{
      device:'wasm', dtype:'q8', revision:'5332fcc35e32a33b86612b9a57a89be7906102b1',
      progress_callback(event) {
        if (event.status !== 'progress' || !event.total || !event.file.endsWith('.onnx')) return;
        transfers.set(event.file,event);
        let loaded=0, total=0;
        for (const item of transfers.values()) { loaded+=item.loaded; total+=item.total; }
        report({phase:'loading',percent:Math.round(loaded/total*100)});
      },
    });
    report({phase:'transcribing'});
    const locale = navigator.language.split('-')[0]?.toLowerCase() ?? 'en';
    const config = transcribe.model.generation_config;
    const supported = config && 'lang_to_id' in config && typeof config.lang_to_id==='object' && config.lang_to_id ? config.lang_to_id : {};
    const language = Object.hasOwn(supported,`<|${locale}|>`) ? locale : 'en';
    const result = await transcribe(data,{language,task:'transcribe',chunk_length_s:30,stride_length_s:5,do_sample:false});
    report({phase:'done',text:(Array.isArray(result) ? result[0]?.text : result.text)?.trim() ?? ''});
  } catch {
    report({phase:'error',message:'Couldn’t transcribe on this device. Check your connection for the speech model download and retry.'});
  }
};
