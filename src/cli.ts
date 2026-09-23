#!/usr/bin/env bun
import {parseArgs} from 'node:util';
import {readFileSync,readdirSync,writeFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {boundedCategories,Config,Truth,records} from './contracts.ts';
import {Store,hash,type Journal} from './store.ts';
import {providers} from './providers.ts';
import {runWorkflow,type Snapshot} from './workflow.ts';
import {evaluate,makeEvalSnapshot,triplet,type EvalSnapshot} from './evaluation.ts';
const root=fileURLToPath(new URL('../',import.meta.url));
export function sourceHash(){
  const files=['package.json','bun.lock',...readdirSync(join(root,'src')).filter(p=>p.endsWith('.ts')||p.endsWith('.py')).map(p=>'src/'+p),...readdirSync(join(root,'prompts')).map(p=>'prompts/'+p)].sort();
  return hash(files.map(p=>[p,readFileSync(join(root,p),'utf8')]));
}
const help=`Bootstrap Categorizer (Bun)
run --input records.jsonl|- --run-dir runs/new [--config config.json]
    [--categories categories.json | --categories-json '[{"id":"x","name":"...","description":"..."}]']
    [--seed-prompt file] [--curator-prompt file] [--reviewer-prompt file] [--judgment-prompt file]
    [--mode discovery|assessment] [--max-categories 100 (integer 1..253)] --allow-external
resume --run-dir runs/existing --allow-external
inspect --run-dir runs/existing
export --run-dir runs/existing --out new-directory
eval --run-dir runs/existing --truth truth.json --eval-dir runs/evaluation
     [--config judge-config.json] [--normalization-prompt file] --allow-external
eval-resume --eval-dir runs/evaluation --allow-external
triplet --eval-dirs eval-a,eval-b,eval-c [--out report.json]
Discovery is add-only roll-forward: no reviewer or final pass. maxRounds, review
and --reviewer-prompt are deprecated, accepted but ignored (including review:true).
No automatic acceptance trials or full-corpus expansion. Inputs leave this machine
only when --allow-external is supplied; auth comes from environment/selected backend.
`;
function load(path:string){return JSON.parse(readFileSync(path,'utf8'));}
function manifest<T>(dir:string):Journal<T>{const m=load(join(dir,'manifest.json'));if(m.schema!==1||hash(m.snapshot)!==m.snapshotHash)throw Error('invalid snapshot');return m;}
export async function main(args=process.argv.slice(2)) {
  const command=args[0];if(!command||['help','--help','-h'].includes(command)){console.log(help);return;}
  const {values:v}=parseArgs({args:args.slice(1),strict:true,options:{input:{type:'string'},'run-dir':{type:'string'},'eval-dir':{type:'string'},'eval-dirs':{type:'string'},config:{type:'string'},categories:{type:'string'},'categories-json':{type:'string'},'seed-prompt':{type:'string'},'curator-prompt':{type:'string'},'reviewer-prompt':{type:'string'},'judgment-prompt':{type:'string'},'normalization-prompt':{type:'string'},mode:{type:'string'},'max-categories':{type:'string'},truth:{type:'string'},out:{type:'string'},'allow-external':{type:'boolean'}}});
  const req=(k:keyof typeof v)=>{const x=v[k];if(typeof x!=='string'||!x)throw Error(`--${k} required`);return x;};
  const consent=()=>{if(!v['allow-external'])throw Error('--allow-external required: inputs/prompts are sent to external providers');};
  const prompt=(name:string,override?:string)=>readFileSync(override??join(root,'prompts',name+'.md'),'utf8');
  if(v['max-categories']!==undefined && (command!=='run'||!/^\d+$/.test(v['max-categories'])||Number(v['max-categories'])<1||Number(v['max-categories'])>253))throw Error('--max-categories requires an integer 1..253 and is only valid for run');
  if(command==='run'){
    consent();
    const config=Config.parse({...v.config?load(v.config):{},...v.mode?{mode:v.mode}:{},...v['max-categories']!==undefined?{maxCategories:Number(v['max-categories'])}:{}});
    if(config.mode==='discovery')console.error('Discovery: maxRounds, review and reviewer-prompt are deprecated and ignored; no runtime reviewer or final pass.');
    if(v.categories&&v['categories-json'])throw Error('choose one manual categories option');
    const initial=v.categories?boundedCategories(load(v.categories),config.maxCategories):v['categories-json']?boundedCategories(JSON.parse(v['categories-json']),config.maxCategories):undefined;
    if(config.mode==='assessment'&&!initial)throw Error('assessment requires manual categories');
    const path=req('input'),text=path==='-'?await Bun.stdin.text():readFileSync(path,'utf8');
    const snapshot:Snapshot={kind:'workflow',inputs:records(text),initial,config,prompts:{seed:prompt('seed',v['seed-prompt']),curator:prompt('curator',v['curator-prompt']),reviewer:prompt('reviewer',v['reviewer-prompt']),judgment:prompt('judgment',v['judgment-prompt'])},sourceHash:sourceHash(),inputSource:path==='-'?'stdin':resolve(path)};
    const provider=providers(config);
    if(config.mode==='discovery')snapshot.curatorIdentity=provider.curatorIdentity?.();
    const store=Store.create(req('run-dir'),snapshot);
    try{await runWorkflow(store,provider);console.log(JSON.stringify({runId:store.state.id,status:store.state.data.status,stopReason:store.state.data.stopReason,calls:store.state.calls.length}));if(store.state.data.status!=='complete')process.exitCode=2;}finally{store.close();}
  } else if(command==='resume'||command==='eval-resume'){
    consent();const store=Store.open<Snapshot|EvalSnapshot>(req(command==='resume'?'run-dir':'eval-dir'));
    try{
      const s=store.state.snapshot;
      if(s.sourceHash!==sourceHash())throw Error('source changed since snapshot; restore frozen source before resume');
      if(command==='resume'&&s.kind==='workflow')await runWorkflow(store as Store<Snapshot>,providers(s.config));
      else if(command==='eval-resume'&&s.kind==='evaluation')await evaluate(store as Store<EvalSnapshot>,providers(s.config));
      else throw Error('wrong manifest kind');
      console.log(JSON.stringify({status:store.state.data.status,calls:store.state.calls.length}));if(store.state.data.status!=='complete')process.exitCode=2;
    }finally{store.close();}
  } else if(command==='inspect'){
    const m=manifest<Snapshot|EvalSnapshot>(req('run-dir'));console.log(JSON.stringify({id:m.id,kind:m.snapshot.kind,snapshotHash:m.snapshotHash,pins:m.pins,calls:m.calls.length,status:m.data.status,stopReason:m.data.stopReason,error:m.data.error,metrics:m.data.metrics},null,2));
  } else if(command==='export'){
    const m=manifest<Snapshot>(req('run-dir'));if(m.snapshot.kind!=='workflow')throw Error('workflow required');
    const out=req('out');mkdirSync(out,{mode:0o700});
    for(const [name,data] of Object.entries({manifest:m,taxonomies:m.data.taxonomies??[],assessments:m.data.assessments??[],assignments:Object.values(m.data.assignments??{}),unresolved:m.data.unresolved??[],decisions:m.data.decisions??[]}))writeFileSync(join(out,name+'.json'),JSON.stringify(data,null,2)+'\n',{mode:0o600});
    console.log(out);
  } else if(command==='eval'){
    consent();const run=manifest<Snapshot>(req('run-dir'));if(run.snapshot.kind!=='workflow')throw Error('workflow required');
    const truth=Truth.parse(load(req('truth'))),config=Config.parse(v.config?load(v.config):{jevModel:run.pins.jev??run.snapshot.config.jevModel});
    const snapshot=makeEvalSnapshot(run,truth,prompt('normalization',v['normalization-prompt']),config,sourceHash());
    const store=Store.create(req('eval-dir'),snapshot);
    try{await evaluate(store,providers(config));console.log(JSON.stringify(store.state.data.metrics,null,2));}finally{store.close();}
  } else if(command==='triplet'){
    const result=triplet(req('eval-dirs').split(',').map(d=>manifest<EvalSnapshot>(d)));
    if(v.out)writeFileSync(v.out,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify(result,null,2));if(!result.gate.pass)process.exitCode=2;
  } else throw Error('unknown command; use help');
}
if(import.meta.main)main().catch(e=>{console.error(e instanceof Error?e.message:'command failed');process.exitCode=1;});
