// Test-only transport injection. Never a public runtime backend or model-quality claim.
import {mock} from 'bun:test';
import {Store} from '../../src/store.ts';
import type {Request} from '../../src/contracts.ts';
const mode=process.env.TRIE_FIXTURE_MODE;
mock.module('../../src/providers.ts',()=>({providers:()=>({
 curatorIdentity:()=>({backend:'synthetic-offline-fixture'}),
 async jev(req:Request){
  const state=req.state as {record:{id:string};path:{id:string}[];siblings:{id:string}[]};
  const choice=state.path.length===0?(state.record.id==='edit'?'n2':'n1'):state.record.id==='edit'?'stopAtParent':state.siblings.length?state.siblings[0]!.id:'specificOther';
  if(mode==='provider-failure')throw Error('fixture failure, no network');
  return {model:'jev-fixture',answers:Object.fromEntries(Object.entries(req.questions).map(([id,q])=>[id,q.type==='choice'?{type:'choice',choice,confidence:0.9,probabilities:Object.fromEntries(Object.keys(q.criteria!).map(k=>[k,k===choice?1:0]))}:{type:'noul',noul:0.95}]))};
 },
 async curate(_system:string,payload:any){
  const parentId=payload.path.at(-1)?.id??null;
  const actions=parentId===null?[{name:'Interprets code',description:'Understands code, edits not required.'},{name:'Edits code',description:'Changes code.'}]:[{name:'For code review',description:'Assesses code without requiring edits.'}];
  return {model:'fixture-curator',raw:{stopReason:'stop'},text:JSON.stringify({actions:actions.map(a=>({...a,op:'add',parentId,target:'non-authoritative target',sources:[],evidence:[mode==='invalid-evidence'?'missing':payload.records[0].id],reason:'Synthetic fixture evidence'}))})};
 }
})}));
const save=Store.prototype.save;
Store.prototype.save=function(){
 save.call(this);
 if(mode==='crash-after-retry'&&(this.state.data.trie as any)?.progress.some((p:any)=>p.stage==='retry'))process.exit(77);
 if(mode==='crash-after-cleanup'&&(this.state.data.trie as any)?.ignoredAddTargets.length)process.exit(79);
 if(mode==='crash-after-response'&&this.state.calls.some(c=>c.kind==='trie:jev'&&c.response!==undefined))process.exit(78);
};
const {main}=await import('../../src/cli.ts');
try{await main(process.argv.slice(2));}catch(e){console.error(String(e));process.exitCode=1;}
