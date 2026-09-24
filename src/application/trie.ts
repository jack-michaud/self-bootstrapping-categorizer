import {children,decide,depthStop,resolveRefinement,growthLimit,pathTo,freezeRoots,cleanProposal,validateProposal,type Policy,type Taxonomy,type Node,type RecordInput,type Definition} from '../domain/trie.ts';
import {judgmentRequest,curatorPayload,type Prompts} from '../domain/prompts.ts';
import {Choice,Noul,type Request,type JevResult} from '../contracts.ts';

export interface Snapshot {kind:'trie';inputs:RecordInput[];initial?:Definition[];policy:Policy;prompts:Prompts;policySource:Record<string,string>;policyHash:string;inputSource:string;config:unknown;curatorIdentity?:unknown}
export interface Step {parentId:string|null;taxonomyVersion:number;path:Node[];choice:string;judgment:JevResult}
export interface Progress {recordId:string;parentId:string|null;stage:'judge'|'curate'|'retry'|'done';path:Node[];steps:Step[];attemptedParents:string[];terminalReason?:string}
export interface CleanupAudit {actionIndex:number;originalTarget:string;phase:string;parentId:string|null;taxonomyVersion:number;recordIds:string[]}
export interface State {status:'running'|'complete'|'limited'|'blocked';error?:string;stopReason?:string;cursor:number;taxonomies:Taxonomy[];progress:Progress[];decisions:unknown[];ignoredAddTargets:CleanupAudit[];limited:boolean}
// Small application ports; implementations own caching, evidence admission, model identity and durability.
export interface Ports {save():void;judge(request:Request,maxCalls:number):Promise<JevResult>;curate(phase:'seed'|'child',system:string,payload:unknown,maxCalls:number):Promise<string>}
export const initialState=():State=>({status:'running',cursor:0,taxonomies:[],progress:[],decisions:[],ignoredAddTargets:[],limited:false});
export async function runTrie(s:Snapshot,d:State,ports:Ports,model:string):Promise<void>{
 if(d.status==='complete'||d.status==='limited'&&d.cursor===s.inputs.length)return;
 // Semantic/provider failures are not automatically retried on resume. Evidence remains authoritative.
 if(d.status==='blocked')return;
 d.status='running';delete d.error;delete d.stopReason;
 const finish=(p:Progress,reason:string)=>{p.stage='done';p.terminalReason=reason;d.cursor++;ports.save();};
 const proposal=async(phase:'seed'|'child',t:Taxonomy|undefined,parent:string|null,records:RecordInput[],judgment?:unknown)=>{
  const raw=await ports.curate(phase,s.prompts[phase==='seed'?'seed':'curator'],curatorPayload(t,parent,records,s.policy,judgment),s.policy.maxCalls);
  const cleaned=cleanProposal(JSON.parse(raw));
  const recordIds=records.map(r=>r.id);
  for(const x of cleaned.ignoredAddTargets){
   const audit={...x,phase,parentId:parent,taxonomyVersion:t?.version??0,recordIds};
   if(!d.ignoredAddTargets.some(previous=>JSON.stringify(previous)===JSON.stringify(audit)))d.ignoredAddTargets.push(audit);
  }
  ports.save(); // preserve cleanup even when subsequent validation fails
  const definitions=validateProposal(cleaned.proposal,parent,records.map(r=>r.id));
  d.decisions.push({phase,parentId:parent,taxonomyVersion:t?.version??0,proposal:cleaned.proposal});
  return definitions;
 };
 try{
  if(!d.taxonomies.length){
   const definitions=s.initial??await proposal('seed',undefined,null,s.inputs.slice(0,s.policy.seedSize));
   d.taxonomies.push(freezeRoots(definitions,s.policy));ports.save();
  }
  while(d.cursor<s.inputs.length){
   const record=s.inputs[d.cursor]!;
   let p=d.progress[d.cursor];
   if(!p){p={recordId:record.id,parentId:null,stage:'judge',path:[],steps:[],attemptedParents:[]};d.progress.push(p);ports.save();}
   const t=d.taxonomies.at(-1)!;
   if(p.stage==='done')throw Error('cursor/progress invariant');
   const depthDecision=depthStop(p.path.length,s.policy);
   if(depthDecision){finish(p,depthDecision.reason);continue;}
   if(p.stage==='curate'){
    const parent=p.parentId;if(parent===null)throw Error('frozen roots');
    const limit=growthLimit(t,parent,s.policy);
    if(limit){d.limited=true;finish(p,limit);continue;}
    const additions=await proposal('child',t,parent,[record],p.steps.at(-1)?.judgment);
    const refinement=resolveRefinement(t,parent,additions,s.policy);
    if(refinement.kind==='retain'){finish(p,refinement.reason);continue;}
    d.taxonomies.push(refinement.taxonomy);p.stage='retry';
    // One durable publication: taxonomy addition AND current-record retry intent.
    ports.save();continue;
   }
   const request=judgmentRequest(t,p.parentId,record,model,s.prompts.judgment);
   const result=await ports.judge(request,s.policy.maxCalls);
   const choice=Choice.parse(result.answers.branch).choice;
   const chosen=children(t,p.parentId).find(n=>n.id===choice);
   p.steps.push({parentId:p.parentId,taxonomyVersion:t.version,path:pathTo(t,chosen?.id??p.parentId),choice,judgment:result});
   const support=p.parentId!==null?Noul.parse(result.answers.feasible).noul:1;
   const decision=decide(choice,p.parentId,p.stage==='retry',p.path.length,s.policy,support);
   if(decision.kind==='descend'){
    const node=children(t,p.parentId).find(n=>n.id===decision.id);if(!node)throw Error('not a sibling');
    p.path=[...p.path,node];p.parentId=node.id;p.stage='judge';ports.save();continue;
   }
   if(decision.kind==='terminal'){finish(p,decision.reason);continue;}
   if(p.parentId===null||p.attemptedParents.includes(p.parentId))throw Error('proposal attempt invariant');
   p.attemptedParents.push(p.parentId);p.stage='curate';ports.save();
  }
  d.status=d.limited?'limited':'complete';d.stopReason=d.limited?'category_limit':'inputs_exhausted';ports.save();
 }catch(e){
  d.error=e instanceof Error?e.message:String(e);
  d.status=d.error==='call budget exhausted'?'limited':'blocked';d.stopReason=d.status==='limited'?'call_limit':'failure';
  const current=d.progress[d.cursor];if(current)current.terminalReason=d.stopReason;
  ports.save();
 }
}
