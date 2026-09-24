import {curatorBackend,type CuratorBackend,type CuratorResult} from './curators.ts';
import type { Config,Request } from './contracts.ts';
export interface Providers {jev(req:Request):Promise<unknown>;curate(system:string,payload:unknown):Promise<CuratorResult>;curatorIdentity?:()=>unknown}
export function providers(config:Config,adapter?:CuratorBackend):Providers {
  const curator=adapter??curatorBackend(config);
  return {
    async jev(req) {
      const key=process.env.TYPESAFE_API_KEY;if(!key) throw Error('TYPESAFE_API_KEY required');
      const response=await fetch(config.jevUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify(req)});
      if(!response.ok) throw Error(`Jev HTTP ${response.status}`);
      if(!response.body)throw Error('Jev empty response');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
      try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;
        if(bytes>config.maxOutputBytes){await reader.cancel();throw Error('Jev output limit');}chunks.push(value);
      }}finally{reader.releaseLock();}
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    },
    curatorIdentity:curator.identity,
    curate:curator.curate
  };
}
