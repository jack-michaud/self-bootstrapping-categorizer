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
      return response.json();
    },
    curatorIdentity:curator.identity,
    curate:curator.curate
  };
}
