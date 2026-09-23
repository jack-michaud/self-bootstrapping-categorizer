import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Config,Categories,records,applyProposal,Truth,type Request} from '../src/contracts.ts';
import {Store,hash,type Journal} from '../src/store.ts';
import {runWorkflow,judgmentRequest,assignment,type Snapshot} from '../src/workflow.ts';
import {evaluate,normalizationRequest,score,triplet,type EvalSnapshot,makeEvalSnapshot} from '../src/evaluation.ts';
import type {Providers} from '../src/providers.ts';
const cat=[{id:'write',name:'Writing',description:'Compose prose'}];
const inputs=[{id:'one',text:'Write a report'},{id:'two',text:'Draft an essay'}];
const truth=Truth.parse({labels:cat,items:inputs.map(i=>({id:i.id,label_id:'write',rationale:'Writes prose'}))});
function snapshot(initial:typeof cat|undefined=cat):Snapshot{return {kind:'workflow',inputs,initial,config:Config.parse({maxRounds:0,review:false}),prompts:{seed:'CUSTOM SEED',curator:'CUSTOM CURATOR',judgment:'JUDGE'},sourceHash:'fixture',inputSource:'fixture'};}
function response(req:Request,primary='write'){
  return {model:'jev-fixture-1',answers:Object.fromEntries(Object.entries(req.questions).map(([k,q])=>{
    const choice=k==='normalize'?'write':k==='primary'?primary:Object.keys(q.criteria??{})[0];
    return [k,q.type==='noul'?{type:'noul',noul:k==='gap'?0.1:0.9}:{type:'choice',choice,confidence:0.99,probabilities:Object.fromEntries(Object.keys(q.criteria!).map(c=>[c,c===choice?1:0]))}];
  }))};
}
function temp(){return mkdtempSync(join(tmpdir(),'categorizer-test-'));}
const p:Providers={jev:async r=>response(r),curate:async()=>{throw Error('curator must not run');}};
test('strict inputs, category limits and reserved Other',()=>{
  expect(()=>records('{"id":"x","text":"a","expected":"leak"}')).toThrow();
  expect(()=>records('{"id":"x","text":"a"}\n{"id":"x","text":"b"}')).toThrow();
  expect(()=>Categories.parse([{id:'other',name:'Other',description:'catchall'}])).toThrow();
});
test('proposal validation rejects evidence, conflicts, unknown IDs; merges retain target',()=>{
  const action={op:'revise',target:'write',sources:[],name:'Compose',description:'Compose prose',evidence:['one'],reason:'supported'};
  expect(applyProposal(cat,{actions:[action]},['one'],2)[0].id).toBe('write');
  expect(()=>applyProposal(cat,{actions:[action]},['bad'],2)).toThrow();
  expect(()=>applyProposal(cat,{actions:[action,action]},['one'],2)).toThrow();
  expect(()=>applyProposal(cat,{actions:[{...action,target:'bad'}]},['one'],2)).toThrow();
  const two=[...cat,{id:'draft',name:'Drafting',description:'Draft prose'}];
  expect(applyProposal(two,{actions:[{...action,op:'merge',sources:['draft']}]},['one'],2)).toEqual([{id:'write',name:'Compose',description:'Compose prose'}]);
});
test('manual initial categories bypass seed; assessment never calls curator; durable resume',async()=>{
  const base=temp();let calls=0;
  try{
    const s=snapshot();s.config.mode='assessment';s.config.maxRounds=3;
    let store=Store.create(join(base,'run'),s);
    await runWorkflow(store,{...p,jev:async r=>{calls++;return response(r);}});
    expect(store.state.data.taxonomies[0].categories).toEqual(cat);expect(calls).toBe(2);const runId=store.state.id;store.close();
    store=Store.open(join(base,'run'));await runWorkflow(store,p);expect(store.state.id).toBe(runId);expect(store.state.data.status).toBe('complete');expect(store.state.calls).toHaveLength(2);store.close();
  }finally{rmSync(base,{recursive:true});}
});
test('checkpoint resumes partial run without cross-run cache; failed attempts consume budget',async()=>{
  const base=temp();let calls=0;
  const provider:Providers={...p,jev:async r=>{calls++;if(calls===2)throw Error('injected failure');return response(r);}};
  try{
    const s=snapshot();let store=Store.create(join(base,'run'),s);
    await expect(runWorkflow(store,provider)).rejects.toThrow('injected');expect(store.state.data.assignments.one).toBeDefined();store.close();
    store=Store.open(join(base,'run'));await runWorkflow(store,provider);expect(calls).toBe(3);expect(store.state.calls).toHaveLength(3);store.close();
    const fresh=Store.create(join(base,'fresh'),s);await runWorkflow(fresh,provider);expect(calls).toBe(5);fresh.close();
  }finally{rmSync(base,{recursive:true});}
});
test('call identity includes full input/model/prompts/taxonomy; locks and durable budget',async()=>{
  const base=temp();try{
    const dir=join(base,'run'),store=Store.create(dir,{config:'frozen'});let calls=0;
    expect(()=>Store.open(dir)).toThrow();
    const call=(req:unknown)=>store.call('test',req,2,async()=>++calls);
    expect(await call({id:'x',text:'a'})).toBe(1);expect(await call({text:'a',id:'x'})).toBe(1);
    expect(await call({id:'x',text:'b'})).toBe(2);await expect(call({id:'x',text:'c'})).rejects.toThrow('budget');
    expect(JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8')).calls).toHaveLength(2);store.close();
    const req=judgmentRequest(inputs[0],cat,Config.parse({}),'p','m');
    for(const variant of [{...req,model:'m2'},{...req,state:{record:{...inputs[0],text:'different'},categories:cat}},{...req,questions:{...req.questions,gap:{type:'noul',instructions:'different'}}}])expect(hash(variant)).not.toBe(hash(req));
  }finally{rmSync(base,{recursive:true});}
});
test('custom seed reaches provider without a runtime reviewer',async()=>{
 const base=temp();try{const s=snapshot();delete s.initial;s.config.review=true;
 const store=Store.create(join(base,'run'),s);const seen:string[]=[];
 await runWorkflow(store,{jev:async req=>response(req,Object.keys(req.questions.primary.criteria!)[0]),curate:async (system,payload)=>{seen.push(system);expect((payload as any).contract.actions[0]).toMatchObject({op:'add',target:'',sources:[]});return {model:'fixture',raw:{},text:JSON.stringify({actions:[{op:'add',target:'',sources:[],name:'Write',description:'Compose prose',evidence:['one'],reason:'source'}]})};}});
 expect(seen).toHaveLength(1);expect(seen[0]).toContain('CUSTOM SEED');expect(store.state.calls.filter(c=>c.kind==='jev')).toHaveLength(2);store.close();
 }finally{rmSync(base,{recursive:true});}
});
test('low independent Noul is false, not novelty; Other is explicit unresolved',()=>{
  const s=snapshot(),req=judgmentRequest(inputs[0],cat,s.config,'prompt','m');
  const r=response(req,'other') as any;r.answers.member_0.noul=0.05;r.answers.gap.noul=0.05;
  const a=assignment(inputs[0],cat,r,1,'e');expect(a.flags).toContain('other');expect(a.flags).not.toContain('coverage_gap');expect(a.flags).not.toContain('ambiguous_membership');expect(a.maxKnownMembership).toBe(0.05);
});
test('normalization never receives expected item, text, rationale or IDs',()=>{
  const req=normalizationRequest(cat[0],truth.labels,'semantic rubric','jev');
  expect(req.state).toEqual({generated:{name:'Writing',description:'Compose prose'}});
  const text=JSON.stringify(req);expect(text).not.toContain('Write a report');expect(text).not.toContain('Writes prose');expect(text).not.toContain('label_id');expect(Object.keys(req.questions.normalize.criteria!)).toEqual(['write','no_match','ambiguous']);
});
test('denominator includes Other, ambiguous, missing, unknown mappings; synonyms normalize',()=>{
  const t=Truth.parse({labels:cat,items:['a','b','c','d','e'].map(id=>({id,label_id:'write',rationale:'fixture'}))});
  const m=score(t,{a:{primary:'synonym'},b:{primary:'other'},c:{primary:'amb'},d:{primary:'unknown'}},{synonym:'write',other:'write',amb:'ambiguous',unknown:'not-reference'});
  expect(m.total).toBe(5);expect(m.correct).toBe(1);expect(m.accuracy).toBe(0.2);expect(m.rows[4].normalized).toBeNull();
});
function evaluation(id:string,wrong=false):Journal<EvalSnapshot>{
  const s=snapshot();delete s.initial;
  const run={schema:1,id,created:'fixture',updated:'fixture',snapshot:s,snapshotHash:hash(s),calls:[],pins:{jev:'jev-fixture-1'},data:{status:'complete',taxonomies:[{version:1,categories:cat}],assignments:Object.fromEntries(inputs.map(i=>[i.id,{primary:'write',taxonomyVersion:1}]))}} as Journal<Snapshot>;
  const es=makeEvalSnapshot(run,truth,'prompt',Config.parse({}),'code');
  return {schema:1,id:'eval-'+id,created:'fixture',updated:'fixture',snapshot:es,snapshotHash:hash(es),pins:{jev:'jev-fixture-1'},calls:[],data:{status:'complete',mapping:{write:wrong?null:'write'}}};
}
test('triplet all-three, pairwise, per-run 95% gates; frozen identity and distinct runs',()=>{
  const es=[evaluation('a'),evaluation('b'),evaluation('c')];expect(triplet(es).gate.pass).toBe(true);expect(triplet(es).allThree).toBe(1);
  es[2]=evaluation('c',true);const failed=triplet(es);expect(failed.accuracy).toEqual([1,1,0]);expect(failed.allThree).toBe(0);expect(failed.gate.pass).toBe(false);expect(failed.pairwise[0].agreement).toBe(1);
  expect(()=>triplet([es[0],es[0],es[2]])).toThrow();es[2].snapshot.prompt='changed';expect(()=>triplet(es)).toThrow('frozen');
});
test('discovery rejects revisions without calling a reviewer',async()=>{
 const base=temp();try{const s=snapshot();s.config.review=true;const store=Store.create(join(base,'run'),s);let calls=0;
 await expect(runWorkflow(store,{jev:async r=>response(r,'other'),curate:async()=>{calls++;return {model:'fixture',raw:{},text:JSON.stringify({actions:[{op:'revise',target:'write',sources:[],name:'Changed',description:'Changed',evidence:['one'],reason:'fixture'}]})};}})).rejects.toThrow('add actions only');
 expect(calls).toBe(1);expect(store.state.data.taxonomies).toHaveLength(1);store.close();
 }finally{rmSync(base,{recursive:true});}
});
test('budget stops at retry checkpoint without a final sweep reservation',async()=>{
 const base=temp();try{const s=snapshot();s.config.maxCalls=2;const store=Store.create(join(base,'run'),s);
 await expect(runWorkflow(store,{jev:async r=>response(r,'other'),curate:async()=>({model:'fixture',raw:{},text:JSON.stringify({actions:[{op:'add',target:'',sources:[],name:'New',description:'New task',evidence:['one'],reason:'fixture'}]})})})).rejects.toThrow('budget');
 expect(store.state.data.taxonomies).toHaveLength(2);expect(store.state.data.progress.one.stage).toBe('retry');expect(store.state.data.assignments.two).toBeUndefined();expect(store.state.calls).toHaveLength(2);store.close();
 }finally{rmSync(base,{recursive:true});}
});
test('threshold overrides route without changing raw judgments; full taxonomy independent of domain',()=>{
  const cfg=Config.parse({thresholds:{gap:0.9,membershipYes:0.95,membershipNo:0.1}});
  const req=judgmentRequest(inputs[0],cat,cfg,'policy','model',7),raw=response(req) as any;
  raw.answers.domain.choice='other';raw.answers.gap.noul=0.8;
  const a=assignment(inputs[0],cat,raw,7,'e',cfg.thresholds);
  expect(a.flags).toContain('other_domain');expect(a.flags).not.toContain('coverage_gap');expect(a.flags).toContain('ambiguous_membership');expect(a.supportedTasks).toEqual([]);expect(a.coverageGap).toBe(0.8);expect(Object.keys(req.questions)).toContain('member_0');expect((req.state as any).taxonomyVersion).toBe(7);
});
test('partial reclassification never scores old-version assignments against revised definitions',()=>{
  const s=snapshot(),run={schema:1,id:'partial',created:'fixture',updated:'fixture',snapshot:s,snapshotHash:hash(s),calls:[],pins:{},data:{status:'blocked',taxonomies:[{version:2,categories:cat}],assignments:{one:{primary:'write',taxonomyVersion:1},two:{primary:'write',taxonomyVersion:2}}}} as Journal<Snapshot>;
  const es=makeEvalSnapshot(run,truth,'prompt',Config.parse({}),'code');
  expect(score(truth,es.assignments,{write:'write'}).accuracy).toBe(0.5);
});
test('first explicit Jev model must match in workflow and normalization; alias resolves once',async()=>{
  const base=temp();try{
    const s=snapshot();s.config.jevModel='jev-1.13.0';const store=Store.create(join(base,'workflow'),s);
    await expect(runWorkflow(store,p)).rejects.toThrow('requested model');expect(store.state.pins.jev).toBeUndefined();expect(store.state.calls).toHaveLength(1);store.close();
    const es=evaluation('model-test').snapshot;es.config.jevModel='jev-1.13.0';const judge=Store.create(join(base,'judge'),es);
    await expect(evaluate(judge,p)).rejects.toThrow('requested model');expect(judge.state.pins.jev).toBeUndefined();judge.close();
    const alias=Store.create(join(base,'alias'),snapshot());await runWorkflow(alias,p);expect(alias.state.pins.jev).toBe('jev-fixture-1');expect((alias.state.calls[1].request as Request).model).toBe('jev-fixture-1');alias.close();
  }finally{rmSync(base,{recursive:true});}
});
test('resume after curator failure records actual no-change reason and retains failure evidence',async()=>{
  const base=temp();try{
    const s=snapshot();s.config.maxRounds=1;let store=Store.create(join(base,'run'),s);
    await expect(runWorkflow(store,{...p,jev:async r=>response(r,'other'),curate:async()=>{throw Error('transient curator failure');}})).rejects.toThrow('transient');
    expect(store.state.data.stopReason).toBe('provider_or_validation_failure');store.close();
    store=Store.open(join(base,'run'));await runWorkflow(store,{...p,curate:async()=>({text:'{"actions":[]}',model:'fixture',raw:{}})});
    expect(store.state.data.status).toBe('complete');expect(store.state.data.stopReason).toBe('records_exhausted');expect(store.state.data.progress.one.outcome).toBe('no_justified_changes');expect(store.state.data.error).toBeUndefined();expect(store.state.data.remainingWork).toBeUndefined();expect(store.state.calls.some(c=>c.error==='transient curator failure')).toBe(true);store.close();
  }finally{rmSync(base,{recursive:true});}
});
test('malformed curator JSON fails without repair and retains its raw response',async()=>{
  const base=temp();try{
    const s=snapshot();delete s.initial;const store=Store.create(join(base,'run'),s);
    await expect(runWorkflow(store,{...p,curate:async()=>({text:'```json\n{}\n```',model:'fixture',raw:{}})})).rejects.toThrow();
    expect(store.state.data.status).toBe('blocked');expect((store.state.calls[0].response as any).text).toBe('```json\n{}\n```');store.close();
  }finally{rmSync(base,{recursive:true});}
});
test('curator adapter identity drift rejects before dispatch/cache reuse',async()=>{
  const base=temp();try{
    const s=snapshot();delete s.initial;s.curatorIdentity={backend:'fixture',version:1};const store=Store.create(join(base,'run'),s);
    await expect(runWorkflow(store,{...p,curatorIdentity:()=>({backend:'fixture',version:2})})).rejects.toThrow('identity changed');expect(store.state.calls).toHaveLength(0);store.close();
  }finally{rmSync(base,{recursive:true});}
});
test('real evaluation orchestration normalizes one category once and keeps evidence',async()=>{
  const base=temp();try{
    const es=evaluation('one').snapshot,store=Store.create(join(base,'eval'),es);
    await evaluate(store,p);expect(store.state.calls).toHaveLength(1);expect(store.state.data.metrics.accuracy).toBe(1);await evaluate(store,p);expect(store.state.calls).toHaveLength(1);store.close();
  }finally{rmSync(base,{recursive:true});}
});
