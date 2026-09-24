import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {hash} from '../src/store.ts';
const cli=join(import.meta.dir,'helpers/trie-cli-fixture.ts');
function fixture(fn:(dir:string,run:(args:string[],mode?:string)=>ReturnType<typeof spawnSync>)=>void){
 const dir=mkdtempSync(join(tmpdir(),'trie-cli-'));
 writeFileSync(join(dir,'input.jsonl'),'{"id":"review","text":"Review the architecture without editing.","metadata":{"source":"synthetic"}}\n{"id":"edit","text":"Edit the implementation."}\n');
 writeFileSync(join(dir,'config.json'),JSON.stringify({policy:{maxDepth:2},provider:{jevModel:'jev-fixture',curatorModel:'fixture-curator'}}));
 writeFileSync(join(dir,'primary.json'),JSON.stringify([{name:'Interprets code',description:'Understands code, edits not required.'},{name:'Edits code',description:'Changes code.'}]));
 const invoke=(args:string[],mode='')=>spawnSync(process.execPath,[cli,'trie',...args],{encoding:'utf8',env:{...process.env,TYPESAFE_API_KEY:'',TRIE_FIXTURE_MODE:mode},timeout:30000});
 try{fn(dir,invoke);}finally{rmSync(dir,{recursive:true,force:true});}
}
const runArgs=(dir:string,manual=true)=>['run','--input',join(dir,'input.jsonl'),'--run-dir',join(dir,'run'),'--config',join(dir,'config.json'),...(manual?['--categories',join(dir,'primary.json')]:[]),'--allow-external'];
function manifest(dir:string){return JSON.parse(readFileSync(join(dir,'run/manifest.json'),'utf8'));}
for(const manual of [true,false])test(`actual CLI ${manual?'manual':'seeded'} run inspect export completed resume`,()=>fixture((dir,run)=>{
 const result=run(runArgs(dir,manual));expect(result.stderr?.toString()).toBe('');expect(result.status).toBe(0);
 const m=manifest(dir);expect(m.data.trie.status).toBe('complete');expect(m.data.trie.cursor).toBe(2);expect(m.data.trie.taxonomies.length).toBe(2);
 expect(m.calls.map((c:any)=>c.kind)).toEqual([...(manual?[]:['trie:seed']),'trie:jev','trie:jev','trie:child','trie:jev','trie:jev','trie:jev']);
 const before=readFileSync(join(dir,'run/manifest.json'),'utf8');
 expect(run(['resume','--run-dir',join(dir,'run'),'--allow-external']).status).toBe(0);
 expect(readFileSync(join(dir,'run/manifest.json'),'utf8')).toBe(before);
 expect(run(['inspect','--run-dir',join(dir,'run')]).status).toBe(0);
 expect(run(['export','--run-dir',join(dir,'run'),'--out',join(dir,'export')]).status).toBe(0);
 const assignments=JSON.parse(readFileSync(join(dir,'export/assignments.json'),'utf8'));
 expect(assignments[0].path.map((x:any)=>x.name)).toEqual(['Interprets code','For code review']);
 expect(assignments[0].steps.map((x:any)=>x.taxonomyVersion)).toEqual([1,1,2]);
 expect(assignments[0].metadata).toEqual({source:'synthetic'});
 expect(assignments[1].path.map((x:any)=>x.name)).toEqual(['Edits code']);expect(assignments[1].terminalReason).toBe('stopAtParent');
}));
for(const mode of ['crash-after-retry','crash-after-response','crash-after-cleanup'])test(`process interruption ${mode}: durable checkpoint and idempotent resume`,()=>fixture((dir,run)=>{
 const first=run(runArgs(dir),mode);expect(first.status).toBe(mode==='crash-after-retry'?77:mode==='crash-after-response'?78:79);
 const before=manifest(dir);
 if(mode==='crash-after-retry'){expect(before.data.trie.taxonomies.length).toBe(2);expect(before.data.trie.progress[0].stage).toBe('retry');}
 // spawnSync proved this test-owned owner exited; reconcile its deliberately stale lock.
 unlinkSync(join(dir,'run/.lock'));
 const resumed=run(['resume','--run-dir',join(dir,'run'),'--allow-external']);expect(resumed.stderr?.toString()).toBe('');expect(resumed.status).toBe(0);
 const after=manifest(dir);expect(after.data.trie.taxonomies.length).toBe(2);expect(after.calls.length).toBe(6);expect(after.data.trie.cursor).toBe(2);
 expect(after.calls.filter((c:any)=>c.kind==='trie:child').length).toBe(1);expect(after.data.trie.ignoredAddTargets.length).toBe(1);
}));
test('policy mismatch rejects resume; frozen inspect/export remain available',()=>fixture((dir,run)=>{
 expect(run(runArgs(dir)).status).toBe(0);
 const m=manifest(dir);m.snapshot.policySource['src/domain/trie.ts']+='\n// historical policy';
 m.snapshot.policyHash=hash({source:m.snapshot.policySource,policy:m.snapshot.policy,prompts:m.snapshot.prompts});m.snapshotHash=hash(m.snapshot);
 writeFileSync(join(dir,'run/manifest.json'),JSON.stringify(m));
 const r=run(['resume','--run-dir',join(dir,'run'),'--allow-external']);expect(r.status).toBe(1);expect(r.stderr?.toString()).toContain('policy/source changed');
 expect(run(['inspect','--run-dir',join(dir,'run')]).status).toBe(0);
 expect(run(['export','--run-dir',join(dir,'run'),'--out',join(dir,'export')]).status).toBe(0);
}));
for(const mode of ['invalid-evidence','provider-failure'])test(`CLI ${mode} blocked evidence survives restart`,()=>fixture((dir,run)=>{
 expect(run(runArgs(dir),mode).status).toBe(2);const m=manifest(dir);expect(m.data.trie.status).toBe('blocked');expect(m.calls.length).toBeGreaterThan(0);
 if(mode==='invalid-evidence'){expect(m.data.trie.ignoredAddTargets.length).toBe(1);expect(m.calls.at(-1).response.text).toContain('non-authoritative target');}
 else expect(m.calls[0].error).toContain('fixture failure');
 expect(run(['resume','--run-dir',join(dir,'run'),'--allow-external']).status).toBe(2);expect(manifest(dir).calls.length).toBe(m.calls.length);
}));
test('CLI call budget preserves accepted addition and retry intent without excess calls',()=>fixture((dir,run)=>{
 const config=JSON.parse(readFileSync(join(dir,'config.json'),'utf8'));config.policy.maxCalls=3;writeFileSync(join(dir,'config.json'),JSON.stringify(config));
 expect(run(runArgs(dir)).status).toBe(2);const m=manifest(dir);
 expect(m.calls.length).toBe(3);expect(m.data.trie.status).toBe('limited');expect(m.data.trie.taxonomies.length).toBe(2);
 expect(m.data.trie.progress[0].stage).toBe('retry');expect(m.data.trie.progress[0].path.length).toBe(1);expect(m.data.trie.progress[0].terminalReason).toBe('call_limit');
 expect(run(['resume','--run-dir',join(dir,'run'),'--allow-external']).status).toBe(2);expect(manifest(dir).calls.length).toBe(3);
}));
test('CLI enforces consent before any provider operation',()=>fixture((dir,run)=>{
 const args=runArgs(dir).filter(x=>x!=='--allow-external');expect(run(args).status).toBe(1);
}));
