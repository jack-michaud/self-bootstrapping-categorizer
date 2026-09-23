import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Config,applyProposal,type Request} from '../src/contracts.ts';
import {Store} from '../src/store.ts';
import {runWorkflow,type Snapshot} from '../src/workflow.ts';
import fixture from './fixtures/add-target.json';
function answer(req:Request){return {model:'jev-fixture',answers:Object.fromEntries(Object.entries(req.questions).map(([id,q])=>{const win=id==='primary'?'other':Object.keys(q.criteria!)[0];return [id,q.type==='noul'?{type:'noul',noul:0.1}:{type:'choice',choice:win,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria!).map(k=>[k,k===win?1:0]))}];}))};}
async function exercise(mutate:(p:any)=>void=()=>{},cap=100,seed=false){
 const base=mkdtempSync(join(tmpdir(),'add-target-'));
 const proposal=JSON.parse(fixture.response.text);mutate(proposal);
 const response={...structuredClone(fixture.response),text:JSON.stringify(proposal)};
 const s:Snapshot={kind:'workflow',inputs:[fixture.payload.examples[0].record],...(seed?{}:{initial:fixture.payload.taxonomy}),config:Config.parse({maxCategories:cap}),prompts:{seed:'seed',curator:'curator',judgment:'judge'},sourceHash:'fixture',inputSource:'fixture'};
 const store=Store.create(join(base,'run'),s);
 if(!seed){store.state.data.taxonomies=[{version:7,categories:fixture.payload.taxonomy}];store.save();}
 let error:unknown;
 try{await runWorkflow(store,{jev:async req=>answer(req),curate:async()=>response});}catch(e){error=e;}
 const state=structuredClone(store.state);store.close();rmSync(base,{recursive:true});return {state,error,response};
}
test('synthetic nonempty add target: journal index, preserve response and existing definitions',async()=>{
 const {state,error,response}=await exercise();expect(error).toBeUndefined();
 expect(state.data.taxonomies.at(-1).categories).toEqual([...fixture.payload.taxonomy,{id:'task-v8-1',name:JSON.parse(response.text).actions[0].name,description:JSON.parse(response.text).actions[0].description}]);
 expect(state.calls.find(c=>c.kind===fixture.phase)?.response).toEqual(fixture.response);
 expect(state.data.ignoredAddTargets).toEqual([{phase:fixture.phase,version:8,actionIndex:0,originalTarget:'task-v8-1'}]);
 expect(state.data.decisions[0].proposal.actions[0].target).toBe('');
 expect(state.data.progress[fixture.payload.examples[0].record.id].stage).toBe('done');
 expect(()=>applyProposal(fixture.payload.taxonomy,JSON.parse(response.text),[sId],8)).toThrow('add cannot target');
});
const sId=fixture.payload.examples[0].record.id;
for(const [name,mutate] of [
 ['sources',(p:any)=>{p.actions[0].sources=['task-v1-1'];}],
 ['evidence',(p:any)=>{p.actions[0].evidence=['unknown'];}],
 ['duplicate name',(p:any)=>{p.actions[0].name=fixture.payload.taxonomy[0].name;}],
 ['reserved name',(p:any)=>{p.actions[0].name='Other';}],
 ['revise',(p:any)=>{p.actions[0].op='revise';}],
 ['merge',(p:any)=>{p.actions[0].op='merge';}],
 ['non-string target',(p:any)=>{p.actions[0].target=123;}],
 ['missing target',(p:any)=>{delete p.actions[0].target;}],
 ['unknown field',(p:any)=>{p.actions[0].extra=true;}],
 ['blank definition',(p:any)=>{p.actions[0].description=' ';}],
] as const)test(`cleanup preserves rejection: ${name}`,async()=>{const {state,error}=await exercise(mutate);expect(error).toBeDefined();expect(state.data.status).toBe('blocked');expect(state.data.taxonomies).toHaveLength(1);if(['non-string target','missing target','unknown field','blank definition','revise','merge'].includes(name))expect(state.data.ignoredAddTargets).toBeUndefined();});
test('cleanup preserves resulting cap and seed cap',async()=>{
 for(const [cap,seed,count] of [[17,false,2],[100,true,11]] as const){const {error,state}=await exercise(p=>{p.actions=Array.from({length:count},(_,i)=>({...p.actions[0],name:'New '+i}));},cap,seed);expect(error).toBeDefined();expect(state.data.status).toBe('blocked');expect(state.data.ignoredAddTargets).toHaveLength(count);}
});
test('empty add target needs no cleanup journal',async()=>{const {error,state}=await exercise(p=>{p.actions[0].target='';});expect(error).toBeUndefined();expect(state.data.ignoredAddTargets).toBeUndefined();});
