import {test,expect} from 'bun:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Config} from '../src/contracts.ts';
import {curatorBackend,boundedProcess,parseNativeResult,nativeEnvironment,CHAT_LIMITATION} from '../src/curators.ts';
import {providers} from '../src/providers.ts';
import {hash} from '../src/store.ts';
const cfg=Config.parse({});
test('explicit backend selection, lazy Pi imports and unavailable chat fail closed',async()=>{
  expect(cfg.curatorBackend).toBe('hermes-native');
  expect(()=>Config.parse({curatorBackend:'shell'})).toThrow();
  expect(curatorBackend({...cfg,curatorBackend:'pi'}).identity()).toMatchObject({backend:'pi',adapter:'pi-agent-session-v1',sdk:'0.78.1'});
  expect(()=>providers({...cfg,hermesRuntimePath:'/missing-runtime',mode:'assessment'})).not.toThrow();
  await expect(curatorBackend({...cfg,curatorBackend:'hermes-chat'}).curate('x',{})).rejects.toThrow(CHAT_LIMITATION);
  const source=readFileSync(new URL('../src/providers.ts',import.meta.url),'utf8');
  expect(source).not.toContain('pi-ai');expect(source).not.toContain('pi-coding-agent');
});
test('provider adapter forwards Pi session IDs and returns the updated session',async()=>{
  let receivedSessionId:string|undefined;
  const adapter={
    identity:()=>({adapter:'fixture'}),
    async curate(_system:string,_payload:unknown,sessionId?:string){
      receivedSessionId=sessionId;
      return {text:'{}',model:cfg.curatorModel,raw:{},sessionId:'pi-session-next'};
    },
  };
  const provider=providers({...cfg,curatorBackend:'pi'},adapter);
  const result=await provider.curate('SYSTEM',{fixture:true},'pi-session-prior');
  expect(receivedSessionId).toBe('pi-session-prior');
  expect(result.sessionId).toBe('pi-session-next');
});
test('strict response envelope rejects banners/unknown fields/stops and retains model text for validation',()=>{
  const valid={protocol:1,text:'{"actions":[]}',model:'fixture',modelIdentity:'response',stopReason:'stop',usage:null};
  expect(parseNativeResult(JSON.stringify(valid),1024).text).toBe(valid.text);
  expect(parseNativeResult(JSON.stringify({...valid,text:'```json\n{}\n```'}),1024).text).toBe('```json\n{}\n```');
  for(const bad of ['banner\n'+JSON.stringify(valid),JSON.stringify({...valid,extra:true}),JSON.stringify({...valid,stopReason:'length'}),JSON.stringify(valid)+'\n{}'])expect(()=>parseNativeResult(bad,1024)).toThrow();
  expect(()=>parseNativeResult(JSON.stringify(valid),2)).toThrow();
});
test('argv/stdin stay literal, timeout/output/nonzero/missing executable are bounded',async()=>{
  const opt={timeoutMs:1000,maxBytes:1024};
  const text='$(touch NOPE) `id` \"quoted\" 雪';
  const out=await boundedProcess(process.execPath,['-e','process.stdin.pipe(process.stdout)'],text,opt);
  expect(out).toBe(text);
  await expect(boundedProcess(process.execPath,['-e','setInterval(()=>{},1000)'],'',{...opt,timeoutMs:80})).rejects.toThrow('timeout');
  await expect(boundedProcess(process.execPath,['-e','process.stdout.write("x".repeat(5000))'],'',opt)).rejects.toThrow('byte limit');
  await expect(boundedProcess(process.execPath,['-e','process.stderr.write("sensitive detail");process.exit(4)'],'',opt)).rejects.toThrow('diagnostics suppressed');
  await expect(boundedProcess('/nonexistent/executable',[],'',opt)).rejects.toThrow('unavailable');
});
test('child environment drops inherited sessions, tools, prompts and evaluation key',()=>{
  const keys=['HERMES_KANBAN_TASK','HERMES_YOLO_MODE','HERMES_SESSION_ID','TYPESAFE_API_KEY','PYTHONPATH'];
  const old=keys.map(k=>process.env[k]);
  try{keys.forEach(k=>process.env[k]='sentinel');const e=nativeEnvironment();keys.forEach(k=>expect(e[k]).toBeUndefined());expect(e.HERMES_SAFE_MODE).toBe('1');}finally{keys.forEach((k,i)=>{if(old[i]===undefined)delete process.env[k];else process.env[k]=old[i];});}
});
test('native subprocess fixture sees exact fresh messages, no tools, no repository cwd',async()=>{
  const root=mkdtempSync(join(tmpdir(),'categorizer-native-fixture-'));
  try{
    mkdirSync(join(root,'agent'));mkdirSync(join(root,'hermes_cli'));mkdirSync(join(root,'venv/bin'),{recursive:true});
    symlinkSync('/usr/bin/python3',join(root,'venv/bin/python'));
    writeFileSync(join(root,'agent/__init__.py'),'');
    writeFileSync(join(root,'agent/auxiliary_client.py'),`import os,json
from types import SimpleNamespace as S
class Event(S):
 def model_dump_json(self): return '{}'
class Stream(list):
 def close(self): pass
def resolve_provider_client(provider, model=None, raw_codex=False):
 assert provider == 'openai-codex' and raw_codex
 assert 'HERMES_SESSION_ID' not in os.environ
 def create(**kw):
  assert kw['tools'] == [] and kw['store'] == False
  assert len(kw['input']) == 1 and kw['input'][0]['role'] == 'user'
  assert not os.path.exists('evals')
  payload=json.loads(kw['input'][0]['content'])
  text=json.dumps({'system':kw['instructions'],'payload':payload})
  item=Event(type='response.output_item.done',item=S(type='message',status='completed',content=[S(type='output_text',text=text)]))
  done=Event(type='response.completed',response=S(status='completed',model=model,usage=None))
  if payload.get('bad') == 'incomplete': done.type='response.incomplete'
  if payload.get('bad') == 'tool': item.item.type='function_call'
  return Stream([item] if payload.get('bad') == 'missing-terminal' else [item,done])
 client=S(responses=S(create=create),close=lambda:None)
 def options(**kw):
  assert kw['max_retries'] == 0
  return client
 client.with_options=options
 return client,model
`);
    const backend=curatorBackend({...cfg,hermesRuntimePath:root});const identity=backend.identity();
    expect(await backend.curate('SEED',{text:'synthetic'})).toMatchObject({model:cfg.curatorModel});
    const review=await backend.curate('REVIEW',{candidate:'only explicit evidence'});
    expect(JSON.parse(review.text)).toEqual({system:'REVIEW',payload:{candidate:'only explicit evidence'}});
    for(const bad of ['tool','incomplete','missing-terminal'])await expect(backend.curate('REVIEW',{bad})).rejects.toThrow('subprocess failed');
    writeFileSync(join(root,'agent/drift.py'),'# change');expect(hash(backend.identity())).not.toBe(hash(identity));
    expect(existsSync(join(root,'agent/__pycache__'))).toBe(false);
  }finally{rmSync(root,{recursive:true,force:true});}
});
