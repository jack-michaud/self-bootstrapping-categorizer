import {Category,Choice,Truth,Config,type Request} from './contracts.ts';
import {Store,hash,type Journal} from './store.ts';
import {askJev,type Snapshot,type Assignment} from './workflow.ts';
import type {Providers} from './providers.ts';
export interface EvalSnapshot {kind:'evaluation';runId:string;runHash:string;workflowSnapshotHash:string;workflowConfigHash:string;workflowSourceHash:string;runStatus:string;condition:'bootstrap'|'manual'|'assessment';truth:Truth;categories:Category[];assignments:Record<string,Assignment>;prompt:string;config:Config;sourceHash:string;normalizerHash:string}
export function normalizationRequest(category:Category,labels:Category[],prompt:string,model:string):Request {
  return {model,state:{generated:{name:category.name,description:category.description}},questions:{normalize:{type:'choice',instructions:prompt,criteria:{...Object.fromEntries(labels.map(l=>[l.id,{name:l.name,description:l.description}])),no_match:'No semantically equivalent reference task',ambiguous:'Multiple plausible references or a broad category spanning distinct tasks'}}}};
}
export const NORMALIZATION_POLICY='winning-probability-abstention-v1';
export function normalizationDecision(answer:ReturnType<typeof Choice.parse>,labels:Category[],minimum:number) {
  const winningProbability=answer.probabilities[answer.choice];
  const reference=labels.some(l=>l.id===answer.choice);
  const accepted=reference && Number.isFinite(winningProbability) && winningProbability>=minimum;
  return {normalized:accepted?answer.choice:null,winningProbability,minimum,
    reason:!reference?'non_reference_choice':accepted?'accepted':'below_minimum_winning_probability'};
}
export interface Row {id:string;expected:string;raw:string|null;normalized:string|null;correct:boolean}
export function score(truth:Truth,assignments:Record<string,Pick<Assignment,'primary'>>,mapping:Record<string,string|null>) {
  const rows:Row[]=truth.items.map(i=>{
    const raw=assignments[i.id]?.primary??null;
    const n=raw && !['other','unclear'].includes(raw)?mapping[raw]??null:null;
    const normalized=truth.labels.some(l=>l.id===n)?n:null;
    return {id:i.id,expected:i.label_id,raw,normalized,correct:normalized===i.label_id};
  });
  const correct=rows.filter(r=>r.correct).length;
  const withinGroup=truth.labels.map(l=>{
    const group=rows.filter(r=>r.expected===l.id);let pairs=0,agree=0;
    for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++){pairs++;if(group[i].normalized!==null && group[i].normalized===group[j].normalized)agree++;}
    return {label:l.id,size:group.length,pairs,agree,agreement:pairs?agree/pairs:null};
  });
  return {total:rows.length,correct,accuracy:correct/rows.length,rows,withinGroup};
}
export async function evaluate(store:Store<EvalSnapshot>,p:Providers) {
  const s=store.state.snapshot,d=store.state.data;
  if(d.status==='complete')return;
  d.status='running';delete d.error;d.mapping??={};store.save();
  for(const category of s.categories){
    if(Object.hasOwn(d.mapping,category.id))continue;
    const req=normalizationRequest(category,s.truth.labels,s.prompt,s.config.jevModel);
    let result;
    try {result=await askJev(store,p,req,s.config.maxCalls);}
    catch(e){d.status='blocked';d.error=e instanceof Error?e.message:'judge failed';d.metrics=score(s.truth,s.assignments,d.mapping);store.save();throw e;}
    const answer=Choice.parse(result.answers.normalize);
    const decision=normalizationDecision(answer,s.truth.labels,s.config.normalizationMinWinningProbability);
    d.mapping[category.id]=decision.normalized;
    d.normalizationDecisions??={};d.normalizationDecisions[category.id]=decision;
    d.judgments??={};d.judgments[category.id]=answer;store.save();
  }
  d.metrics=score(s.truth,s.assignments,d.mapping);d.status='complete';store.save();
}
export function makeEvalSnapshot(run:Journal<Snapshot>,truth:Truth,prompt:string,config:Config,sourceHash:string):EvalSnapshot {
  const inputIds=run.snapshot.inputs.map(r=>r.id).sort(),truthIds=truth.items.map(r=>r.id).sort();
  if(hash(inputIds)!==hash(truthIds))throw Error('truth and run input IDs must match exactly');
  const finalTaxonomy=run.data.taxonomies?.at(-1);
  const categories=(finalTaxonomy?.categories??[]) as Category[];
  // Mixed versions are valid only when the chosen definition is unchanged and
  // actually existed in the recorded taxonomy. Missing/revised definitions fail closed.
  const assignments=Object.fromEntries(Object.entries(run.data.assignments??{}).filter(([,raw])=>{
    const a=raw as Assignment;
    const recorded=run.data.taxonomies?.find((t:any)=>t.version===a.taxonomyVersion);
    if(!Number.isInteger(a.taxonomyVersion)||a.taxonomyVersion<1||!recorded)return false;
    if(['other','unclear'].includes(a.primary))return true;
    const definition=recorded.categories.find((c:Category)=>c.id===a.primary);
    const final=categories.find(c=>c.id===a.primary);
    return definition!==undefined&&final!==undefined&&hash(definition)===hash(final);
  })) as Record<string,Assignment>;
  return {kind:'evaluation',runId:run.id,runHash:hash(run),workflowSnapshotHash:run.snapshotHash,workflowConfigHash:hash({config:run.snapshot.config,prompts:run.snapshot.prompts,inputs:run.snapshot.inputs,initial:run.snapshot.initial,pins:run.pins}),workflowSourceHash:run.snapshot.sourceHash,runStatus:run.data.status,condition:run.snapshot.config.mode==='assessment'?'assessment':run.snapshot.initial?'manual':'bootstrap',truth,categories,assignments,prompt,config,sourceHash,normalizerHash:hash({policy:NORMALIZATION_POLICY,minimum:config.normalizationMinWinningProbability,prompt,labels:truth.labels,model:config.jevModel,sourceHash})};
}
export function triplet(evals:Journal<EvalSnapshot>[]) {
  if(evals.length!==3 || new Set(evals.map(e=>e.snapshot.runId)).size!==3)throw Error('exactly three distinct runs required');
  const first=evals[0].snapshot;
  for(const e of evals){
    if(e.snapshot.kind!=='evaluation'||e.data.status!=='complete')throw Error('evaluation incomplete');
    if(hash(e.snapshot.truth)!==hash(first.truth) || e.snapshot.workflowConfigHash!==first.workflowConfigHash || e.snapshot.workflowSourceHash!==first.workflowSourceHash || e.snapshot.sourceHash!==first.sourceHash || e.snapshot.normalizerHash!==first.normalizerHash || e.snapshot.prompt!==first.prompt || hash(e.snapshot.config)!==hash(first.config) || hash(e.pins)!==hash(evals[0].pins))throw Error('triplet not frozen: truth/config/model/prompts/source differ');
  }
  const metrics=evals.map(e=>score(e.snapshot.truth,e.snapshot.assignments,e.data.mapping));
  const rows=first.truth.items.map(i=>({id:i.id,normalized:metrics.map(m=>m.rows.find(r=>r.id===i.id)!.normalized)}));
  const allThreeCount=rows.filter(r=>r.normalized[0]!==null && new Set(r.normalized).size===1).length;
  const pairwise=[[0,1],[0,2],[1,2]].map(([a,b])=>({runs:[evals[a].snapshot.runId,evals[b].snapshot.runId],agreement:rows.filter(r=>r.normalized[a]!==null&&r.normalized[a]===r.normalized[b]).length/rows.length}));
  const allThree=allThreeCount/rows.length;
  const validCondition=evals.every(e=>e.snapshot.condition==='bootstrap'&&e.snapshot.runStatus==='complete');
  return {created:new Date().toISOString(),truthHash:hash(first.truth),sourceHash:first.workflowSourceHash,condition:first.condition,runIds:evals.map(e=>e.snapshot.runId),total:rows.length,accuracy:metrics.map(m=>m.accuracy),allThreeCount,allThree,pairwise,withinGroup:metrics.map(m=>m.withinGroup),normalized:rows,rawTaxonomies:evals.map(e=>e.snapshot.categories),gate:{accuracyThreshold:0.95,consistencyThreshold:0.95,interpretation:'Operational all-three consistency threshold; invalid/unassigned labels never earn agreement',pass:validCondition&&metrics.every(m=>m.accuracy>=0.95)&&allThree>=0.95},note:'Same-model normalization is not independent human validation. This report does not authorize a full-corpus run.'};
}
