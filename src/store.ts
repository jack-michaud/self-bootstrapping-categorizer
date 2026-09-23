import {createHash,randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,renameSync,openSync,fsyncSync,closeSync,unlinkSync} from 'node:fs';
import {join,dirname} from 'node:path';
export function canonical(v:unknown):string {
  if(Array.isArray(v)) return '['+v.map(canonical).join(',')+']';
  if(v && typeof v==='object') return '{'+Object.entries(v).filter(([,x])=>x!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>JSON.stringify(k)+':'+canonical(x)).join(',')+'}';
  return JSON.stringify(v);
}
export const hash=(v:unknown)=>createHash('sha256').update(canonical(v)).digest('hex');
export interface CallEvidence {key:string;kind:string;request:unknown;started:string;response?:unknown;error?:string;finished?:string}
export interface Journal<T> {schema:1;id:string;created:string;updated:string;snapshot:T;snapshotHash:string;calls:CallEvidence[];pins:Record<string,string>;data:Record<string,any>}
export class Store<T> {
  private lockFd:number;
  constructor(readonly dir:string,readonly state:Journal<T>) {
    this.lockFd=openSync(join(dir,'.lock'),'wx',0o600);
    writeFileSync(this.lockFd,JSON.stringify({pid:process.pid,started:new Date().toISOString()}));
  }
  static create<T>(dir:string,snapshot:T):Store<T> {
    mkdirSync(dirname(dir),{recursive:true,mode:0o700});
    mkdirSync(dir,{mode:0o700});
    const now=new Date().toISOString();
    const s=new Store(dir,{schema:1,id:randomUUID(),created:now,updated:now,snapshot,snapshotHash:hash(snapshot),calls:[],pins:{},data:{}});
    const content=snapshot as Record<string,unknown>;
    s.state.data.identities={inputHash:hash(content.inputs??null),configHash:hash(content.config??null),promptHashes:Object.fromEntries(Object.entries((content.prompts??{normalization:content.prompt??''}) as Record<string,unknown>).map(([name,text])=>[name,hash(text)]))};s.save();return s;
  }
  static open<T>(dir:string):Store<T> {
    const state=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8')) as Journal<T>;
    if(state.schema!==1 || hash(state.snapshot)!==state.snapshotHash) throw Error('snapshot integrity mismatch');
    return new Store(dir,state);
  }
  save() {
    this.state.updated=new Date().toISOString();
    const path=join(this.dir,'manifest.json'),temp=path+'.tmp';
    const fd=openSync(temp,'w',0o600);
    try{writeFileSync(fd,JSON.stringify(this.state,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
    renameSync(temp,path); const d=openSync(this.dir,'r');try{fsyncSync(d);}finally{closeSync(d);}
  }
  close(){closeSync(this.lockFd);unlinkSync(join(this.dir,'.lock'));}
  async call<R>(kind:string,request:unknown,maxCalls:number,fn:()=>Promise<R>):Promise<R> {
    const key=hash({run:this.state.id,snapshot:this.state.snapshotHash,kind,request});
    const hit=this.state.calls.find(c=>c.key===key && c.response!==undefined);if(hit) return hit.response as R;
    if(this.state.calls.length>=maxCalls) throw Error('call budget exhausted');
    const entry:CallEvidence={key,kind,request,started:new Date().toISOString()};this.state.calls.push(entry);this.save();
    try {const result=await fn();entry.response=result;entry.finished=new Date().toISOString();this.save();return result;}
    catch(e){entry.error=e instanceof Error?e.message:'provider failure';entry.finished=new Date().toISOString();this.save();throw e;}
  }
}
