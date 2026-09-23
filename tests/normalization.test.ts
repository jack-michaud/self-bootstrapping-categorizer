import {test,expect} from 'bun:test';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Config,Truth} from '../src/contracts.ts';
import {evaluate,makeEvalSnapshot,normalizationDecision,triplet} from '../src/evaluation.ts';
import {Store,hash,type Journal} from '../src/store.ts';
import type {Snapshot} from '../src/workflow.ts';

const labels=[{id:'compose',name:'Compose',description:'Create original prose'}];
const truth=Truth.parse({labels,items:['a','b'].map(id=>({id,label_id:'compose',rationale:'fixture'}))});
const answer=(probability:number,confidence=1,choice='compose')=>({type:'choice' as const,choice,confidence,probabilities:{[choice]:probability,...Object.fromEntries(['compose','no_match','ambiguous'].filter(k=>k!==choice).map((k,i)=>[k,i===0?1-probability:0]))}});
function snapshot(id='run',minimum=0.95,prompt='rubric',source='normalizer-source'){
  const config=Config.parse({normalizationMinWinningProbability:minimum});
  const s:Snapshot={kind:'workflow',inputs:truth.items.map(i=>({id:i.id,text:'Compose prose'})),config,prompts:{seed:'fixture',curator:'fixture',judgment:'fixture'},sourceHash:'workflow-source',inputSource:'fixture'};
  const run={schema:1,id,created:'fixture',updated:'fixture',snapshot:s,snapshotHash:hash(s),calls:[],pins:{},data:{status:'complete',taxonomies:[{version:1,categories:labels}],assignments:Object.fromEntries(truth.items.map(i=>[i.id,{primary:'compose',taxonomyVersion:1}]))}} as Journal<Snapshot>;
  return makeEvalSnapshot(run,truth,prompt,config,source);
}
test('normalization threshold validates config and uses selected probability, not confidence',()=>{
  expect(Config.parse({}).normalizationMinWinningProbability).toBe(0.95);
  for(const value of [-0.01,1.01,'0.95',null])expect(()=>Config.parse({normalizationMinWinningProbability:value})).toThrow();
  for(const value of [0,0.949999,0.95,0.950001,1]){
    const d=normalizationDecision(answer(value,value<0.95?1:0),labels,0.95);
    expect(d.normalized).toBe(value>=0.95?'compose':null);
    expect(d.winningProbability).toBe(value);
    expect(d.reason).toBe(value>=0.95?'accepted':'below_minimum_winning_probability');
  }
  expect(normalizationDecision(answer(0.9),labels,0.8).normalized).toBe('compose');
  for(const choice of ['no_match','ambiguous'])expect(normalizationDecision(answer(1,1,choice),labels,0.95).normalized).toBeNull();
});
test('abstention persists untouched raw choice, probability and confidence; no retry on resume',async()=>{
  const base=mkdtempSync(join(tmpdir(),'normalization-'));let store:Store<ReturnType<typeof snapshot>>|undefined;
  try{
    store=Store.create(join(base,'eval'),snapshot());const raw=answer(0.9);let calls=0;
    const provider={jev:async()=>{calls++;return {model:'fixture',answers:{normalize:raw}};},curate:async()=>{throw Error('no curator');}};
    await evaluate(store,provider);
    expect(store.state.data.mapping.compose).toBeNull();
    expect(store.state.data.judgments.compose).toEqual(raw);
    expect(store.state.data.normalizationDecisions.compose.reason).toBe('below_minimum_winning_probability');
    expect(store.state.data.metrics).toMatchObject({total:2,correct:0,accuracy:0});
    expect(store.state.data.metrics.withinGroup[0]).toMatchObject({pairs:1,agree:0,agreement:0});
    const disk=JSON.parse(readFileSync(join(base,'eval','manifest.json'),'utf8'));
    expect(disk.calls[0].response.answers.normalize).toEqual(raw);
    store.close();store=Store.open(join(base,'eval'));await evaluate(store,provider);expect(calls).toBe(1);
  }finally{store?.close();rmSync(base,{recursive:true});}
});
test('normalizer identity binds threshold, rubric, source and config; invalid labels never agree',()=>{
  const s=snapshot(),low=snapshot('run',0.9);
  expect(s.normalizerHash).not.toBe(low.normalizerHash);
  expect(s.normalizerHash).not.toBe(snapshot('run',0.95,'changed rubric').normalizerHash);
  expect(s.normalizerHash).not.toBe(snapshot('run',0.95,'rubric','changed source').normalizerHash);
  expect(hash(s.config)).not.toBe(hash(low.config));expect(hash(s)).not.toBe(hash(low));
  const es=['a','b','c'].map(id=>({schema:1,id:'eval-'+id,created:'fixture',updated:'fixture',snapshot:snapshot(id),snapshotHash:hash(snapshot(id)),calls:[],pins:{},data:{status:'complete',mapping:{compose:null}}} as Journal<ReturnType<typeof snapshot>>));
  const result=triplet(es);expect(result.accuracy).toEqual([0,0,0]);expect(result.allThree).toBe(0);expect(result.pairwise.map(p=>p.agreement)).toEqual([0,0,0]);expect(result.gate.pass).toBe(false);
  es[2].snapshot.normalizerHash='changed';expect(()=>triplet(es)).toThrow('frozen');
});
