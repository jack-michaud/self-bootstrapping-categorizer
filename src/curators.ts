import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import type {Config} from './contracts.ts';
import {hash} from './store.ts';
export type CuratorConfig=Pick<Config,'curatorBackend'|'curatorProvider'|'curatorModel'|'hermesRuntimePath'|'timeoutMs'|'maxTokens'|'maxOutputBytes'>;
export interface CuratorResult {text:string;model:string;raw:unknown}
export interface CuratorBackend {identity:()=>unknown;curate:(system:string,payload:unknown)=>Promise<CuratorResult>}
export const CHAT_LIMITATION='hermes-chat unavailable: installed CLI has no supported explicit empty-toolset contract (-t empty selects defaults; unknown toolsets are not a safety API). Use hermes-native for a fresh tool-free native completion with existing Hermes auth; no CLI fallback is attempted.';
const nativeScript=fileURLToPath(new URL('./hermes_native.py',import.meta.url));
function runtimeRoot(c:CuratorConfig){return resolve(c.hermesRuntimePath??join(homedir(),'.hermes/hermes-agent'));}
function runtimeHash(root:string){
  const files:string[]=[];
  const walk=(dir:string)=>{for(const e of readdirSync(join(root,dir),{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())walk(p);else if(e.isFile()&&p.endsWith('.py'))files.push(p);}};
  for(const dir of ['agent','hermes_cli'])walk(dir);
  for(const e of readdirSync(root,{withFileTypes:true}))if(e.isFile()&&e.name.endsWith('.py'))files.push(e.name);
  return hash(files.sort().map(p=>[p,readFileSync(join(root,p),'utf8')]));
}
// Literal argv; input travels on stdin. No inherited agent/session/provider controls.
export function nativeEnvironment():NodeJS.ProcessEnv {
  const env:NodeJS.ProcessEnv={};
  for(const key of ['HOME','PATH','TMPDIR','SSL_CERT_FILE','SSL_CERT_DIR'])if(process.env[key])env[key]=process.env[key];
  // Preserve the active auth namespace only; never create or alter a profile.
  if(process.env.HERMES_HOME)env.HERMES_HOME=process.env.HERMES_HOME;
  return {...env,HERMES_SAFE_MODE:'1',HERMES_IGNORE_USER_CONFIG:'1',HERMES_IGNORE_RULES:'1',PYTHONDONTWRITEBYTECODE:'1'};
}
export async function boundedProcess(command:string,args:string[],input:string,options:{timeoutMs:number;maxBytes:number;env?:NodeJS.ProcessEnv}):Promise<string>{
  if(Buffer.byteLength(input)>2000000)throw Error('curator input exceeds byte limit');
  const cwd=mkdtempSync(join(tmpdir(),'categorizer-curator-'));
  try{return await new Promise<string>((ok,fail)=>{
    const child=spawn(command,args,{cwd,env:options.env??nativeEnvironment(),shell:false,detached:process.platform!=='win32',stdio:['pipe','pipe','pipe']});
    let size=0,failure:string|undefined;const output:Buffer[]=[];
    const kill=(reason:string)=>{failure??=reason;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
    const timer=setTimeout(()=>kill('curator timeout'),options.timeoutMs);
    const consume=(data:Buffer,stdout:boolean)=>{size+=data.length;if(size>options.maxBytes)kill('curator output exceeds byte limit');else if(stdout)output.push(data);};
    child.stdout.on('data',data=>consume(data,true));child.stderr.on('data',data=>consume(data,false));
    child.stdin.on('error',()=>{});
    child.on('error',()=>{failure??='curator process unavailable';});
    child.on('close',code=>{
      clearTimeout(timer);const text=Buffer.concat(output).toString('utf8');
      let stage='';try{const error=JSON.parse(text);if(error.error==='hermes_native_failure'&&['startup','request','auth','inference','validation'].includes(error.phase)){stage=` at ${error.phase}`;if(['AuthenticationError','PermissionDeniedError','BadRequestError','NotFoundError','RateLimitError','APIConnectionError','APITimeoutError','AttributeError','ValueError','TypeError','RuntimeError'].includes(error.category))stage+=` (${error.category})`;}}catch{}
      if(failure||code!==0)fail(Error(failure??`curator subprocess failed${stage} (native auth/model/runtime; diagnostics suppressed)`));else ok(text);
    });
    child.stdin.end(input);
  });}finally{rmSync(cwd,{recursive:true,force:true});}
}
const NativeResult=z.object({protocol:z.literal(1),text:z.string().min(1),model:z.string().min(1),modelIdentity:z.enum(['response','requested']),stopReason:z.literal('stop'),usage:z.unknown()}).strict();
export function parseNativeResult(raw:string,maxBytes:number):CuratorResult{
  const r=NativeResult.parse(JSON.parse(raw));
  if(Buffer.byteLength(r.text)>maxBytes)throw Error('curator output exceeds byte limit');
  // Workflow stores the raw result before exact JSON/schema validation; no repairs.
  return {text:r.text,model:r.model,raw:r};
}
export function curatorBackend(c:CuratorConfig):CuratorBackend {
  const base={backend:c.curatorBackend,provider:c.curatorProvider,model:c.curatorModel};
  if(c.curatorBackend==='hermes-chat')return {identity:()=>({...base,adapter:'hermes-chat-blocked-v1'}),curate:async()=>{throw Error(CHAT_LIMITATION);}};
  if(c.curatorBackend==='pi')return {identity:()=>({...base,adapter:'pi-complete-simple-v1',sdk:'0.78.1'}),async curate(system,payload){
    const [{completeSimple},{AuthStorage,ModelRegistry}]=await Promise.all([import('@earendil-works/pi-ai'),import('@earendil-works/pi-coding-agent')]);
    const auth=AuthStorage.create(),registry=ModelRegistry.inMemory(auth),model=registry.find(c.curatorProvider,c.curatorModel);
    if(!model)throw Error('Unknown Pi curator model/provider');
    const apiKey=await auth.getApiKey(c.curatorProvider,{includeFallback:false});
    if(!apiKey)throw Error('Configure curator authentication through Pi login');
    const raw=await completeSimple(model,{systemPrompt:system,messages:[{role:'user',content:JSON.stringify(payload),timestamp:Date.now()}],tools:[]},{apiKey,maxTokens:c.maxTokens,maxRetries:0,transport:'sse',reasoning:'medium',signal:AbortSignal.timeout(c.timeoutMs)});
    const text=raw.content.filter(x=>x.type==='text').map(x=>x.text).join('\n');
    if(Buffer.byteLength(text)>c.maxOutputBytes)throw Error('curator output exceeds byte limit');
    return {text,model:raw.model,raw};
  }};
  const root=runtimeRoot(c);
  return {identity:()=>({...base,adapter:'hermes-native-v1',adapterHash:hash(readFileSync(nativeScript,'utf8')),runtimeHash:runtimeHash(root),runtimePath:root}),async curate(system,payload){
    if(c.curatorProvider!=='openai-codex')throw Error('hermes-native currently supports only the verified openai-codex native client route');
    const input=JSON.stringify({provider:c.curatorProvider,model:c.curatorModel,system,payload,timeoutMs:c.timeoutMs,maxTokens:c.maxTokens,maxOutputBytes:c.maxOutputBytes});
    return parseNativeResult(await boundedProcess(join(root,'venv/bin/python'),['-I','-B',nativeScript,root],input,{timeoutMs:c.timeoutMs,maxBytes:c.maxOutputBytes*2+4096}),c.maxOutputBytes);
  }};
}
