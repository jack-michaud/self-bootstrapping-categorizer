import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Config,applyProposal,boundedCategories,type Request} from '../src/contracts.ts';
import {Store} from '../src/store.ts';
import {runWorkflow,judgmentRequest,type Snapshot} from '../src/workflow.ts';
import type {Providers} from '../src/providers.ts';
const categories=(n:number)=>Array.from({length:n},(_,i)=>({id:`c${i}`,name:`Category ${i}`,description:`Task ${i}`}));
const actions=(n:number)=>categories(n).map(c=>({op:'add',target:'',sources:[],name:c.name,description:c.description,evidence:['r'],reason:'fixture evidence'}));
function snapshot(config:unknown={}):Snapshot{return {kind:'workflow',inputs:[{id:'r',text:'Fixture record'}],config:Config.parse({maxRounds:0,...config as object}),prompts:{seed:'seed',curator:'curator',reviewer:'review',judgment:'judgment'},sourceHash:'fixture',inputSource:'fixture'};}
function jev(req:Request){return Promise.resolve({model:'jev-fixture',answers:Object.fromEntries(Object.entries(req.questions).map(([id,q])=>{const keys=Object.keys(q.criteria??{}),choice=keys[0];return [id,q.type==='noul'?{type:'noul',noul:id==='gap'?0.1:0.9}:{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?1:0]))}];}))});}
function fixture(s:Snapshot){const base=mkdtempSync(join(tmpdir(),'category-limits-'));const store=Store.create(join(base,'run'),s);return {store,close(){store.close();rmSync(base,{recursive:true});}};}
test('configured total defaults to 100, validates integer 1..253, and applies to resulting count',()=>{
  expect(Config.parse({}).maxCategories).toBe(100);
  for(const value of [0,254,1.5,'100',NaN,Infinity])expect(()=>Config.parse({maxCategories:value})).toThrow();
  expect(boundedCategories(categories(100))).toHaveLength(100);
  expect(()=>boundedCategories(categories(101))).toThrow('limit 100');
  expect(boundedCategories(categories(253),253)).toHaveLength(253);
  expect(()=>boundedCategories(categories(254),253)).toThrow();
  expect(applyProposal([], {actions:actions(100)}, ['r'],2)).toHaveLength(100);
  expect(()=>applyProposal([], {actions:actions(101)}, ['r'],2)).toThrow('limit 100');
  expect(applyProposal([], {actions:actions(101)}, ['r'],2,101)).toHaveLength(101);
  // Validate the final result, not transient count or action count: add then merge at capacity.
  const merge={...actions(1)[0],op:'merge',target:'c0',sources:['c1'],name:'Merged'};
  expect(applyProposal(categories(100),{actions:[{...actions(1)[0],name:'New'},merge]},['r'],2)).toHaveLength(100);
  expect(()=>judgmentRequest({id:'r',text:'fixture'},categories(101),Config.parse({}),'p','m')).toThrow('limit 100');
});
for(const [count,cap,accepted] of [[11,100,false],[10,100,true],[6,5,false],[5,5,true]] as const){
  test(`seed ${count}, total cap ${cap}: ${accepted?'accepted':'rejected before review/dispatch'}`,async()=>{
    const f=fixture(snapshot({maxCategories:cap}));const seen:any[]=[];
    const p:Providers={jev,curate:async(_system,payload)=>{seen.push(payload);return {model:'fixture',raw:{},text:JSON.stringify(seen.length===1?{actions:actions(count)}:{accept:true,reason:'fixture'})};}};
    try{
      if(accepted){await runWorkflow(f.store,p);expect(f.store.state.data.taxonomies[0].categories).toHaveLength(count);expect(seen).toHaveLength(1);}
      else {await expect(runWorkflow(f.store,p)).rejects.toThrow(`limit ${Math.min(10,cap)}`);expect(seen).toHaveLength(1);expect(f.store.state.calls).toHaveLength(1);expect(f.store.state.data.taxonomies).toBeUndefined();}
      expect(seen[0].limits).toMatchObject({phase:'seed',seedMaxCategories:Math.min(10,cap),maxCategories:cap,effectiveMaxCategories:Math.min(10,cap)});
      expect(seen[0].limits.policy).toContain('ceilings, not quotas');
      expect((f.store.state.calls[0].request as any).payload.limits).toEqual(seen[0].limits);
    }finally{f.close();}
  });
}
test('self-bootstrap accepts >40 additions on immediate Other and retries only the trigger',async()=>{
 const s=snapshot({maxRounds:0,review:true});s.inputs.push({id:'s',text:'Second fixture'});const f=fixture(s);const seen:any[]=[];let j=0;
 try{await runWorkflow(f.store,{jev:async req=>{const r=await jev(req);if(++j===1){const a=r.answers.primary as any;a.choice='other';for(const k of Object.keys(a.probabilities))a.probabilities[k]=k==='other'?1:0;}return r;},curate:async(_system,payload)=>{const q=payload as any;seen.push(q);return {model:'fixture',raw:{},text:JSON.stringify({actions:q.limits.phase==='seed'?actions(10):actions(41).map((a,i)=>({...a,name:`New ${i}`}))})};}});
 expect(seen).toHaveLength(2);expect(seen[1].examples.map((x:any)=>x.record.id)).toEqual(['r']);expect(f.store.state.data.taxonomies.map((t:any)=>t.categories.length)).toEqual([10,51]);expect(j).toBe(3);
 }finally{f.close();}
});
test('category ceiling records outcome without dispatching curator',async()=>{
 const s=snapshot();s.initial=categories(100);const f=fixture(s);
 try{await runWorkflow(f.store,{jev:async req=>{const r=await jev(req);const a=r.answers.primary as any;a.choice='other';for(const k of Object.keys(a.probabilities))a.probabilities[k]=k==='other'?1:0;return r;},curate:async()=>{throw Error('must not dispatch');}});
 expect(f.store.state.data.stopReason).toBe('category_limit');expect(f.store.state.data.progress.r.outcome).toBe('category_limit');expect(f.store.state.data.taxonomies).toHaveLength(1);
 }finally{f.close();}
});
for(const [count,cap,accepted] of [[11,100,true],[100,100,true],[101,100,false],[101,101,true],[6,5,false]] as const){
  test(`manual taxonomy ${count} with cap ${cap} honors intent: ${accepted}`,async()=>{
    const s=snapshot({mode:'assessment',maxCategories:cap});s.initial=categories(count);const f=fixture(s);let calls=0;
    const p:Providers={jev:async req=>{calls++;return jev(req);},curate:async()=>{throw Error('manual seed must not curate');}};
    try{if(accepted){await runWorkflow(f.store,p);expect(f.store.state.data.taxonomies[0].categories).toEqual(s.initial);expect(calls).toBe(1);}else{await expect(runWorkflow(f.store,p)).rejects.toThrow(`limit ${cap}`);expect(calls).toBe(0);expect(f.store.state.calls).toHaveLength(0);}}finally{f.close();}
  });
}
const cli=new URL('../src/cli.ts',import.meta.url).pathname;
async function command(args:string[]){const p=Bun.spawn([process.execPath,cli,...args],{env:{...process.env,TYPESAFE_API_KEY:'fixture-only'},stdout:'pipe',stderr:'pipe'});const [stdout,stderr,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited]);return {stdout,stderr,code};}
test('CLI rejects malformed/missing/out-of-range limit and unsupported seed-limit flag without dispatch',async()=>{
  for(const value of ['0','254','-1','1.5','1e2','NaN','Infinity','100x','',' 10']){const result=await command(['run','--max-categories='+value,'--allow-external']);expect(result.code).toBe(1);expect(result.stderr).toContain('--max-categories');}
  expect((await command(['run','--max-categories'])).code).toBe(1);
  expect((await command(['run','--seed-max-categories','10','--allow-external'])).code).toBe(1);
  expect((await command(['resume','--max-categories','100','--allow-external'])).code).toBe(1);
},30000);
test('actual CLI caps manual file/inline seeds and snapshots CLI override of config using loopback only',async()=>{
  const base=mkdtempSync(join(tmpdir(),'category-limit-cli-'));let calls=0;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(r){calls++;return Response.json(await jev(await r.json() as Request));}});
  try{
    const input=join(base,'input.jsonl'),config=join(base,'config.json'),file=join(base,'categories.json');writeFileSync(input,JSON.stringify({id:'r',text:'Fixture'}));writeFileSync(config,JSON.stringify({mode:'assessment',maxCategories:100,jevUrl:`http://127.0.0.1:${server.port}`}));writeFileSync(file,JSON.stringify(categories(101)));
    for(const option of [['--categories',file],['--categories-json',JSON.stringify(categories(101))]]){
      const dir=join(base,option[0].slice(2));const args=['run','--input',input,'--run-dir',dir,'--config',config,...option,'--allow-external'];
      const rejected=await command(args);expect(rejected.code).toBe(1);expect(rejected.stderr).toContain('limit 100');expect(existsSync(dir)).toBe(false);
      const before=calls;expect((await command([...args,'--max-categories','101'])).code).toBe(0);expect(calls).toBe(before+1);
      const saved=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));expect(saved.snapshot.config.maxCategories).toBe(101);expect(saved.data.taxonomies[0].categories).toHaveLength(101);
    }
    expect(calls).toBe(2);
  }finally{server.stop(true);rmSync(base,{recursive:true});}
},30000);
