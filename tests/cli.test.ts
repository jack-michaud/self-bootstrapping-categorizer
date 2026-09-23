import {test,expect} from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const cli=new URL('../src/cli.ts',import.meta.url).pathname;
async function command(args:string[]){
  const proc=Bun.spawn([process.execPath,cli,...args],{env:{...process.env,TYPESAFE_API_KEY:'test-only'},stdout:'pipe',stderr:'pipe'});
  const [stdout,stderr,code]=await Promise.all([new Response(proc.stdout).text(),new Response(proc.stderr).text(),proc.exited]);return {stdout,stderr,code};
}
test('actual CLI: consent, HTTP adapter, frozen resume, export, evaluation and malformed response evidence',async()=>{
  const base=mkdtempSync(join(tmpdir(),'categorizer-cli-'));let calls=0,malformed=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(r){
    const req=await r.json() as any;calls++;
    if(malformed)return Response.json({model:'jev-test-v1',answers:{}});
    const answers=Object.fromEntries(Object.entries(req.questions).map(([id,q]:[string,any])=>{
      const choice=Object.keys(q.criteria??{})[0];return [id,q.type==='noul'?{type:'noul',noul:id==='gap'?0.1:0.9}:{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}];
    }));return Response.json({model:'jev-test-v1',answers});
  }});
  try{
    const input=join(base,'input.jsonl'),config=join(base,'config.json'),truth=join(base,'truth.json'),run=join(base,'run'),ev=join(base,'eval');
    writeFileSync(input,JSON.stringify({id:'r',text:'Draft an essay'}));writeFileSync(config,JSON.stringify({mode:'assessment',jevUrl:`http://127.0.0.1:${server.port}/v1/systemone`}));
    const categories=[{id:'write',name:'Write prose',description:'Compose prose documents'}];
    writeFileSync(truth,JSON.stringify({labels:categories,items:[{id:'r',label_id:'write',rationale:'writes'}]}));
    const args=['run','--input',input,'--run-dir',run,'--config',config,'--categories-json',JSON.stringify(categories)];
    expect((await command(args)).code).toBe(1);expect(existsSync(run)).toBe(false);expect(calls).toBe(0);
    const started=await command([...args,'--allow-external']);expect(started.code).toBe(0);expect(calls).toBe(1);
    expect((await command(['resume','--run-dir',run,'--allow-external'])).code).toBe(0);expect(calls).toBe(1);
    expect((await command(['export','--run-dir',run,'--out',join(base,'export')])).code).toBe(0);expect(JSON.parse(readFileSync(join(base,'export','assignments.json'),'utf8'))).toHaveLength(1);
    const evaluated=await command(['eval','--run-dir',run,'--truth',truth,'--eval-dir',ev,'--config',config,'--allow-external']);expect(evaluated.code).toBe(0);expect(JSON.parse(evaluated.stdout).accuracy).toBe(1);expect(calls).toBe(2);
    malformed=true;
    const badArgs=[...args];badArgs[badArgs.indexOf(run)]=join(base,'bad');
    expect((await command([...badArgs,'--allow-external'])).code).toBe(1);
    const bad=JSON.parse(readFileSync(join(base,'bad','manifest.json'),'utf8'));expect(bad.data.status).toBe('blocked');expect(bad.calls[0].response.answers).toEqual({});
  }finally{server.stop(true);rmSync(base,{recursive:true});}
},30000);
