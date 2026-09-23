import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Config,Truth,type Request} from '../src/contracts.ts';
import {Store} from '../src/store.ts';
import {runWorkflow,type Snapshot} from '../src/workflow.ts';
import {makeEvalSnapshot,score} from '../src/evaluation.ts';
const cat={id:'known',name:'Known',description:'Existing task'};
const addition={op:'add',target:'',sources:[],name:'New',description:'Novel task',evidence:['b'],reason:'source'};
function snapshot():Snapshot{return {kind:'workflow',initial:[cat],inputs:['a','b','c'].map(id=>({id,text:id})),config:Config.parse({maxRounds:0,review:true}),prompts:{seed:'seed',curator:'curator',judgment:'judge'},sourceHash:'fixture',inputSource:'fixture'};}
function answer(req:Request,choice:string){return {model:'jev-fixture',answers:Object.fromEntries(Object.entries(req.questions).map(([id,q])=>{const win=id==='primary'?choice:Object.keys(q.criteria!)[0];return [id,q.type==='noul'?{type:'noul',noul:0.1}:{type:'choice',choice:win,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria!).map(k=>[k,k===win?1:0]))}];}))};}
test('immediate Other, immutable earlier assignment, mixed-version evaluation, Unclear unchanged',async()=>{
 const base=mkdtempSync(join(tmpdir(),'roll-forward-')),s=snapshot(),store=Store.create(join(base,'run'),s),events:string[]=[];
 try{await runWorkflow(store,{jev:async req=>{const {record,taxonomyVersion:v}=req.state as any;events.push(record.id+v);return answer(req,record.id==='b'?(v===1?'other':'task-v2-1'):record.id==='c'?'unclear':'known');},curate:async(_system,payload)=>{events.push('curator');expect((payload as any).examples.map((e:any)=>e.record.id)).toEqual(['b']);expect((payload as any).taxonomy).toEqual([cat]);return {text:JSON.stringify({actions:[addition]}),model:'fixture',raw:{}};}});
 expect(events).toEqual(['a1','b1','curator','b2','c2']);expect(store.state.data.taxonomies[1].categories[0]).toEqual(cat);expect(store.state.data.assignments.a.taxonomyVersion).toBe(1);expect(store.state.data.assignments.c.primary).toBe('unclear');
 const truth=Truth.parse({labels:[cat],items:s.inputs.map(r=>({id:r.id,label_id:'known',rationale:'fixture'}))});
 const es=makeEvalSnapshot(store.state,truth,'normalize',s.config,'fixture');expect(Object.keys(es.assignments)).toEqual(['a','b','c']);expect(score(truth,es.assignments,{known:'known','task-v2-1':'known'}).correct).toBe(2);
 store.state.data.assignments.a.primary='task-v2-1';expect(makeEvalSnapshot(store.state,truth,'normalize',s.config,'fixture').assignments.a).toBeUndefined();
 store.state.data.assignments.a.primary='known';store.state.data.taxonomies[1].categories[0]={...cat,description:'Revised'};expect(makeEvalSnapshot(store.state,truth,'normalize',s.config,'fixture').assignments.a).toBeUndefined();
 }finally{store.close();rmSync(base,{recursive:true});}
});
test('still Other after retry advances rather than looping',async()=>{
 const base=mkdtempSync(join(tmpdir(),'roll-forward-')),s=snapshot(),store=Store.create(join(base,'run'),s);let proposals=0;
 try{await runWorkflow(store,{jev:async req=>answer(req,(req.state as any).record.id==='b'?'other':'known'),curate:async()=>{proposals++;return {text:JSON.stringify({actions:[addition]}),model:'fixture',raw:{}};}});expect(proposals).toBe(1);expect(store.state.data.progress.b.outcome).toBe('other_after_retry');expect(store.state.data.progress.c.stage).toBe('done');expect(store.state.calls).toHaveLength(5);
 }finally{store.close();rmSync(base,{recursive:true});}
});
for(const boundary of ['proposal-response','taxonomy-checkpoint','retry-response'])test(`resume ${boundary} failure: no duplicate completed calls or additions`,async()=>{
 const base=mkdtempSync(join(tmpdir(),'roll-forward-')),s=snapshot();let store=Store.create(join(base,'run'),s);let proposals=0,jevCalls=0,injected=false;
 const provider={jev:async(req:Request)=>{jevCalls++;const q=req.state as any;return answer(req,q.record.id==='b'?(q.taxonomyVersion===1?'other':'task-v2-1'):'known');},curate:async()=>{proposals++;return {text:JSON.stringify({actions:[addition]}),model:'fixture',raw:{}};}};
 const save=store.save.bind(store);
 store.save=()=>{save();const d=store.state.data,c=store.state.calls.at(-1);const hit=boundary==='proposal-response'?c?.kind.startsWith('record-')&&c.response!==undefined:boundary==='taxonomy-checkpoint'?d.progress?.b?.stage==='retry':c?.kind==='jev'&&(c.request as any).state.record.id==='b'&&(c.request as any).state.taxonomyVersion===2&&c.response!==undefined;if(hit&&!injected){injected=true;throw Error('injected checkpoint failure');}};
 try{await expect(runWorkflow(store,provider)).rejects.toThrow('injected');store.close();store=Store.open(join(base,'run'));await runWorkflow(store,provider);expect(store.state.data.status).toBe('complete');expect(proposals).toBe(1);expect(jevCalls).toBe(4);expect(store.state.data.taxonomies).toHaveLength(2);expect(store.state.data.decisions).toHaveLength(1);expect(store.state.calls).toHaveLength(5);expect(JSON.parse(readFileSync(join(base,'run/manifest.json'),'utf8')).data.progress.c.stage).toBe('done');
 }finally{store.close();rmSync(base,{recursive:true});}
});
