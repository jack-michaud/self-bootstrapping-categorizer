import {expect,test} from 'bun:test';
import {Policy,cleanProposal,validateProposal,freezeRoots,addChildren,validateTree,decide,type Taxonomy} from '../src/domain/trie.ts';
import {prompts} from '../src/domain/prompts.ts';
import {runTrie,initialState,type Snapshot,type Ports} from '../src/application/trie.ts';
import {validateJev,type Request} from '../src/contracts.ts';

export function answer(req:Request,choice:string,support=0.95){
 return validateJev({model:'jev-test',answers:Object.fromEntries(Object.entries(req.questions).map(([id,q])=>[id,q.type==='choice'?{type:'choice',choice,confidence:0.9,probabilities:Object.fromEntries(Object.keys(q.criteria!).map(k=>[k,k===choice?1:0]))}:{type:'noul',noul:support}]))},req);
}
const root=[{name:'Interprets code',description:'Understands without requiring edits.'}];
function snapshot(policy:unknown={}):Snapshot{return {kind:'trie',inputs:[{id:'one',text:'Review module',metadata:{source:'synthetic'}},{id:'two',text:'Review other module'}],initial:root,policy:Policy.parse(policy),prompts,policySource:{},policyHash:'fixture',inputSource:'synthetic',config:{}};}
function action(parentId:string|null='n1'){return {op:'add',target:'irrelevant model ID',sources:[],parentId,name:'For review',description:'Assesses code without changing it.',evidence:['one'],reason:'Explicit review request'};}
async function run(choices:string[],proposal:unknown={actions:[action()]},policy:unknown={maxDepth:2},support=0.95){
 const s=snapshot(policy),d=initialState(),requests:Request[]=[],curations:unknown[]=[];
 const ports:Ports={save(){},async judge(req){requests.push(req);return answer(req,choices.shift()!,support);},async curate(phase,system,payload){curations.push({phase,system,payload});return JSON.stringify(proposal);}};
 await runTrie(s,d,ports,'jev-test');return {s,d,ports,requests,curations};
}
test('add retries only current record, independent memberships and immutable assignments',async()=>{
 const {s,d,ports,requests,curations}=await run(['n1','specificOther','n1.1','n1','n1.1']);
 expect(d.status).toBe('complete');expect(curations.length).toBe(1);expect(requests.length).toBe(5);
 expect(d.taxonomies.map(t=>t.nodes.length)).toEqual([1,2]);
 expect(d.progress[0]!.steps.map(x=>x.taxonomyVersion)).toEqual([1,1,2]);
 expect(d.progress[1]!.steps.map(x=>x.taxonomyVersion)).toEqual([2,2]);
 expect(d.progress[0]!.path.map(x=>x.name)).toEqual(['Interprets code','For review']);
 expect(d.ignoredAddTargets).toEqual([{actionIndex:0,originalTarget:'irrelevant model ID',phase:'child',parentId:'n1',taxonomyVersion:1,recordIds:['one']}]);
 const before=JSON.stringify(d);await runTrie(s,d,ports,'jev-test');expect(JSON.stringify(d)).toBe(before);expect(requests.length).toBe(5);
 expect(JSON.stringify(curations)).not.toContain('Review other module');
 expect(Object.keys(requests[2]!.questions)).toContain('membership:n1.1');
});
for(const [branch,reason] of [['stopAtParent','stopAtParent'],['unclear','childUnclear']] as const)test(`parent retention ${branch}`,async()=>{
 const {d,curations}=await run(['n1',branch,'other']);expect(d.progress[0]!.path.length).toBe(1);expect(d.progress[0]!.terminalReason).toBe(reason);expect(curations.length).toBe(0);
});
test('root Other and Unclear do not grow frozen roots',async()=>{
 const {d,curations}=await run(['other','unclear']);expect(curations.length).toBe(0);expect(d.progress.map(p=>p.terminalReason)).toEqual(['rootOther','rootUnclear']);
});
test('no change and still Other retain parent, no second proposal',async()=>{
 const no=await run(['n1','specificOther','unclear'],{actions:[]});expect(no.d.progress[0]!.terminalReason).toBe('noChange');expect(no.d.progress[0]!.path.length).toBe(1);
 const still=await run(['n1','specificOther','specificOther','other']);expect(still.d.progress[0]!.terminalReason).toBe('stillOther');expect(still.curations.length).toBe(1);
});
test('unsupported specific outcome is not proof of novelty',async()=>{
 const {d,curations}=await run(['n1','specificOther','other'],undefined,undefined,0.2);expect(d.progress[0]!.terminalReason).toBe('unsupportedSpecificOther');expect(curations.length).toBe(0);
});
test('invalid evidence remains blocked with cleanup audit, no semantic retry on resume',async()=>{
 const {s,d,ports,requests,curations}=await run(['n1','specificOther'],{actions:[{...action(),evidence:['two']}]});
 expect(d.status).toBe('blocked');expect(d.error).toContain('evidence');expect(d.progress[0]!.path.length).toBe(1);expect(d.ignoredAddTargets.length).toBe(1);
 await runTrie(s,d,ports,'jev-test');expect(requests.length).toBe(2);expect(curations.length).toBe(1);
});
test('node cap retains parent and does not dispatch curator',async()=>{
 const {d,curations}=await run(['n1','specificOther','other'],undefined,{totalNodes:1});expect(d.status).toBe('limited');expect(d.progress[0]!.terminalReason).toBe('totalNodes');expect(curations.length).toBe(0);
});
test('call budget and provider failure do not complete input',async()=>{
 for(const error of ['call budget exhausted','fixture provider failed']){
  const s=snapshot(),d=initialState();let calls=0;
  await runTrie(s,d,{save(){},async judge(req){if(calls++)throw Error(error);return answer(req,'n1');},async curate(){throw Error('unexpected');}},'jev-test');
  expect(d.status).toBe(error.startsWith('call')?'limited':'blocked');expect(d.cursor).toBe(0);expect(d.progress[0]!.path.length).toBe(1);
 }
});
test('strict proposal boundaries: fields, evidence, links, sources, ops',()=>{
 for(const bad of [{...action(),extra:1},{...action(),op:'revise'},{...action(),target:42}])expect(()=>cleanProposal({actions:[bad]})).toThrow();
 for(const bad of [{...action(),parentId:'n2'},{...action(),sources:['n1']},{...action(),evidence:['unknown']}])expect(()=>validateProposal(cleanProposal({actions:[bad]}).proposal,'n1',['one'])).toThrow();
});
test('cycles, sibling uniqueness, depth and child caps are enforced',()=>{
 const p=Policy.parse({perParentChildren:1,maxDepth:2});const t=freezeRoots(root,p);
 const child=addChildren(t,'n1',[{name:'Review',description:'Review'}],p);
 expect(()=>addChildren(child,'n1',[{name:'Another',description:'Another'}],p)).toThrow('perParentChildren');
 expect(()=>addChildren(child,'n1.1',[{name:'Deeper',description:'Deeper'}],p)).toThrow('maxDepth');
 expect(()=>validateTree({version:1,rootsFrozen:true,nodes:[...t.nodes,{id:'cycle',parentId:'cycle',name:'Cycle',description:'Invalid',createdVersion:1}]} as Taxonomy,p)).toThrow('cycle');
 expect(decide('specificOther','n1',false,2,p).kind).toBe('terminal');
});
test('optional deeper path refines at most once per visited parent',async()=>{
 const s=snapshot({maxDepth:3});s.inputs=s.inputs.slice(0,1);const d=initialState();
 const choices=['n1','specificOther','n1.1','specificOther','n1.1.1'];const parents:string[]=[];
 await runTrie(s,d,{save(){},async judge(req){return answer(req,choices.shift()!);},async curate(_phase,_system,payload){
  const parent=(payload as {path:{id:string}[]}).path.at(-1)!.id;parents.push(parent);
  return JSON.stringify({actions:[{...action(parent),name:parent==='n1'?'For code review':'To simplify architecture'}]});
 }},'jev-test');
 expect(d.status).toBe('complete');expect(parents).toEqual(['n1','n1.1']);expect(d.progress[0]!.terminalReason).toBe('maxDepth');
 expect(d.progress[0]!.path.map(n=>n.name)).toEqual(['Interprets code','For code review','To simplify architecture']);
 expect(d.progress[0]!.steps.at(-1)!.path.length).toBe(3);expect(d.progress[0]!.steps.at(-1)!.taxonomyVersion).toBe(3);
});
test('curator-seeded roots finalized before classification',async()=>{
 const s=snapshot();delete s.initial;const d=initialState();let seed=0;
 await runTrie(s,d,{save(){},async curate(phase){expect(phase).toBe('seed');seed++;return JSON.stringify({actions:[action(null)]});},async judge(req){expect(d.taxonomies.length).toBe(1);return answer(req,'other');}},'jev-test');
 expect(d.status).toBe('complete');expect(seed).toBe(1);expect(d.taxonomies[0]!.rootsFrozen).toBe(true);
});
