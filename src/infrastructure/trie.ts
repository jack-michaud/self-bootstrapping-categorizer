import {readFileSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {z} from 'zod';
import {Config,ProviderConfig,records,validateJev,type Request} from '../contracts.ts';
import {Store,hash,type Journal} from '../store.ts';
import {providers,type Providers} from '../providers.ts';
import {Policy,Definition} from '../domain/trie.ts';
import {prompts} from '../domain/prompts.ts';
import {initialState,runTrie,type Snapshot,type State,type Ports} from '../application/trie.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
const Settings=z.object({policy:Policy.default(Policy.parse({})),provider:ProviderConfig.default(ProviderConfig.parse({})),prompts:z.object({seed:z.string().min(1),curator:z.string().min(1),judgment:z.string().min(1)}).strict().partial().default({})}).strict();
export function policySource(){
 const paths=['package.json','bun.lock','src/contracts.ts','src/cli.ts','src/application/trie.ts','src/infrastructure/trie.ts','src/providers.ts','src/curators.ts','src/hermes_native.py','src/store.ts',...readdirSync(join(root,'src/domain')).filter(n=>n.endsWith('.ts')).map(n=>'src/domain/'+n)];
 return Object.fromEntries(paths.sort().map(p=>[p,readFileSync(join(root,p),'utf8')]));
}
function checkSnapshot(m:Journal<Snapshot>){
 if(m.schema!==1||m.snapshot.kind!=='trie'||hash(m.snapshot)!==m.snapshotHash)throw Error('invalid trie snapshot');
 if(hash({source:m.snapshot.policySource,policy:m.snapshot.policy,prompts:m.snapshot.prompts})!==m.snapshot.policyHash)throw Error('policy snapshot integrity mismatch');
}
export function readTrie(dir:string):Journal<Snapshot>{const m=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));checkSnapshot(m);return m;}
export function triePorts(store:Store<Snapshot>,provider:Providers):Ports{
 const cfg=Config.parse(store.state.snapshot.config);
 return {save:()=>store.save(),async judge(request,maxCalls){
  const req={...request,model:store.state.pins.jev??request.model};
  const raw=await store.call('trie:jev',req,maxCalls,()=>provider.jev(req));
  const r=validateJev(raw,req);
  if((req.model!=='jev-latest'&&r.model!==req.model)||r.model.endsWith('latest'))throw Error('Jev model identity mismatch');
  if(!store.state.pins.jev){
   store.state.pins.jev=r.model;
   const call=store.state.calls.at(-1)!;
   call.key=hash({run:store.state.id,snapshot:store.state.snapshotHash,kind:'trie:jev',request:{...req,model:r.model}});store.save();
  }
  return r;
 },async curate(phase,system,payload,maxCalls){
  if(hash(provider.curatorIdentity?.()??null)!==hash(store.state.snapshot.curatorIdentity??null))throw Error('curator runtime identity changed');
  const response=await store.call('trie:'+phase,{system,payload},maxCalls,()=>provider.curate(system,payload));
  if(response.model!==cfg.curatorModel)throw Error('curator model identity mismatch');
  const stopReason=(response.raw as {stopReason?:string})?.stopReason;
  if(stopReason&&stopReason!=='stop')throw Error('curator did not finish');
  if(typeof response.text!=='string'||Buffer.byteLength(response.text)>cfg.maxOutputBytes)throw Error('curator output limit');
  store.state.pins.curator=response.model;store.save();return response.text;
 }};
}
export const trieHelp=`Trie categorizer (separate from legacy flat mode)
trie run --input records.jsonl|- --run-dir runs/new [--config config.json]
         [--categories primary-definitions.json] --allow-external
trie resume --run-dir runs/existing --allow-external
trie inspect --run-dir runs/existing
trie export --run-dir runs/existing --out new-directory
Config: {policy: {...}, provider: {...}, prompts: {seed?,curator?,judgment?}}.
Manual primary definitions: [{name,description}], no IDs; code creates path IDs.
No external calls without consent. Blocked semantic/provider failures remain blocked;
resume continues interrupted work, not failed judgments. Create a fresh run after repair.
`;
export async function trieMain(args:string[],factory:(config:Config)=>Providers=providers){
 const command=args[0];if(!command||['help','--help','-h'].includes(command)){console.log(trieHelp);return;}
 const {values:v}=parseArgs({args:args.slice(1),strict:true,options:{input:{type:'string'},'run-dir':{type:'string'},config:{type:'string'},categories:{type:'string'},out:{type:'string'},'allow-external':{type:'boolean'}}});
 const required=(key:'run-dir'|'input'|'out')=>{const value=v[key];if(!value)throw Error(`--${key} required`);return value;};
 const load=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
 const dir=required('run-dir');
 if(command==='inspect'||command==='export'){
  const m=readTrie(dir),d=m.data.trie as State;
  if(command==='inspect')console.log(JSON.stringify({id:m.id,status:d?.status,stopReason:d?.stopReason,error:d?.error,calls:m.calls.length,completed:d?.cursor,policyHash:m.snapshot.policyHash},null,2));
  else{
   const out=required('out');mkdirSync(out,{mode:0o700});
   for(const [name,value] of Object.entries({manifest:m,taxonomies:d.taxonomies,assignments:d.progress.map(p=>({...p,metadata:m.snapshot.inputs.find(r=>r.id===p.recordId)?.metadata})),decisions:d.decisions}))writeFileSync(join(out,name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600,flag:'wx'});
   console.log(out);
  }return;
 }
 if(!['run','resume'].includes(command))throw Error('unknown trie command');
 if(!v['allow-external'])throw Error('--allow-external required: inputs/prompts sent to external providers');
 let store:Store<Snapshot>;let provider:Providers;
 if(command==='run'){
  const settings=Settings.parse(v.config?load(v.config):{}),config=Config.parse(settings.provider);
  const input=required('input'),raw=input==='-'?await Bun.stdin.text():readFileSync(input,'utf8');
  const source=policySource(),frozenPrompts={...prompts,...settings.prompts};
  const snapshot:Snapshot={kind:'trie',inputs:records(raw),initial:v.categories?z.array(Definition).min(1).parse(load(v.categories)):undefined,policy:settings.policy,prompts:frozenPrompts,policySource:source,policyHash:hash({source,policy:settings.policy,prompts:frozenPrompts}),inputSource:input==='-'?'stdin':resolve(input),config};
  provider=factory(config);snapshot.curatorIdentity=provider.curatorIdentity?.();
  store=Store.create(dir,snapshot);store.state.data.trie=initialState();store.save();
 }else{
  // Check compatibility before acquiring lock or constructing/authenticating providers.
  if(v.config||v.categories||v.input)throw Error('resume uses frozen configuration and inputs');
  const m=readTrie(dir);
  if(hash(m.snapshot.policySource)!==hash(policySource()))throw Error('policy/source changed; restore frozen source or create a new run');
  provider=factory(Config.parse(m.snapshot.config));store=Store.open<Snapshot>(dir);
 }
 try{
  const d=store.state.data.trie as State;
  await runTrie(store.state.snapshot,d,triePorts(store,provider),Config.parse(store.state.snapshot.config).jevModel);
  console.log(JSON.stringify({status:d.status,stopReason:d.stopReason,error:d.error,completed:d.cursor,calls:store.state.calls.length}));
  if(d.status!=='complete')process.exitCode=2;
 }finally{store.close();}
}
