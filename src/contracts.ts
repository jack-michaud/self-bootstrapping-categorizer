import { z } from 'zod';
export const Id = z.string().min(1).max(200).refine(s => !['__proto__','constructor','prototype','other','unclear','no_match','ambiguous'].includes(s.toLowerCase()), 'reserved ID');
const Text = z.string().trim().min(1).max(12000);
export const Category = z.object({ id: Id, name: Text.refine(s=>!['other','unclear','ambiguous','no match','no_match'].includes(s.toLowerCase()),'reserved category name'), description: Text }).strict();
export type Category = z.infer<typeof Category>;
export const MAX_CATEGORIES = 253;
export const SEED_MAX_CATEGORIES = 10;
export const CategoryLimit = z.number().int().min(1).max(MAX_CATEGORIES).default(100);
export const Categories = z.array(Category).min(1).max(MAX_CATEGORIES).superRefine((cs, ctx) => {
  if (new Set(cs.map(c=>c.id)).size !== cs.length || new Set(cs.map(c=>c.name.toLowerCase())).size !== cs.length) ctx.addIssue({code:'custom',message:'duplicate category IDs/names'});
});
export function boundedCategories(raw:unknown,maxCategories=100):Category[] {
  const limit=CategoryLimit.parse(maxCategories), categories=Categories.parse(raw);
  if(categories.length>limit)throw Error(`category count ${categories.length} exceeds limit ${limit}`);
  return categories;
}
export const RecordSchema = z.object({id:Id,text:Text,metadata:z.record(z.string(),z.unknown()).optional()}).strict();
export type InputRecord = z.infer<typeof RecordSchema>;
export function records(raw:string):InputRecord[] {
  const rows=raw.split('\n').filter(l=>l.trim()).map(l=>RecordSchema.parse(JSON.parse(l)));
  if (!rows.length || new Set(rows.map(r=>r.id)).size!==rows.length) throw Error('empty inputs or duplicate IDs');
  return rows;
}
export const Action = z.object({op:z.enum(['add','revise','merge']),target:z.string(),sources:z.array(Id),name:Text,description:Text,evidence:z.array(Id).min(1),reason:Text}).strict();
export const Proposal = z.object({actions:z.array(Action)}).strict();
export type Proposal = z.infer<typeof Proposal>;
export const proposalContract = {actions:[{op:'add | revise | merge',target:'empty for add; existing ID otherwise',sources:['merge source IDs excluding target; empty otherwise'],name:'category name',description:'definition and exclusions',evidence:['supplied record IDs'],reason:'evidence-backed justification'}]};
export function applyProposal(current:Category[], raw:unknown, evidenceIds:string[], version:number, maxCategories=100):Category[] {
  const p=Proposal.parse(raw), valid=new Set(evidenceIds), touched=new Set<string>();
  let next=structuredClone(current);
  for (const [i,a] of p.actions.entries()) {
    if (a.evidence.some(id=>!valid.has(id))) throw Error('unknown evidence ID');
    if (a.op==='add') {
      if(a.target || a.sources.length) throw Error('add cannot target existing categories');
      next.push({id:`task-v${version}-${i+1}`,name:a.name,description:a.description});
    } else {
      if(!current.some(c=>c.id===a.target)) throw Error('unknown target');
      const affected=[a.target,...a.sources];
      if(new Set(affected).size!==affected.length || affected.some(id=>touched.has(id))) throw Error('conflicting actions');
      affected.forEach(id=>touched.add(id));
      if(a.op==='revise' && a.sources.length) throw Error('revise sources must be empty');
      if(a.op==='merge' && (!a.sources.length || a.sources.some(id=>!current.some(c=>c.id===id)))) throw Error('invalid merge sources');
      next=next.filter(c=>!a.sources.includes(c.id)).map(c=>c.id===a.target?{id:c.id,name:a.name,description:a.description}:c);
    }
  }
  return boundedCategories(next,maxCategories);
}
export const ProviderConfig=z.object({curatorBackend:z.enum(['pi','hermes-chat','hermes-native']).default('hermes-native'),hermesRuntimePath:z.string().min(1).optional(),maxOutputBytes:z.number().int().min(1024).max(2000000).default(262144),jevModel:z.string().min(1).default('jev-latest'),jevUrl:z.url().default('https://api.typesafe.ai/v1/systemone'),curatorProvider:z.string().default('openai-codex'),curatorModel:z.string().default('gpt-5.4'),timeoutMs:z.number().int().min(100).max(600000).default(120000),maxTokens:z.number().int().min(100).max(32000).default(8000)}).strict();
// maxRounds/review are legacy, parsed for config compatibility but ignored.
export const Config=ProviderConfig.extend({maxCategories:CategoryLimit,normalizationMinWinningProbability:z.number().min(0).max(1).default(0.95),mode:z.enum(['discovery','assessment']).default('discovery'),maxRounds:z.number().int().min(0).max(20).default(3),maxCalls:z.number().int().min(1).max(100000).default(200),sampleSize:z.number().int().min(1).max(1000).default(40),review:z.boolean().default(false),thresholds:z.object({gap:z.number().min(0).max(1).default(0.7),membershipYes:z.number().min(0).max(1).default(0.7),membershipNo:z.number().min(0).max(1).default(0.3),primaryMembershipMin:z.number().min(0).max(1).default(0.5),choiceConfidence:z.number().min(0).max(1).default(0.5)}).strict().default({gap:0.7,membershipYes:0.7,membershipNo:0.3,primaryMembershipMin:0.5,choiceConfidence:0.5}).refine(t=>t.membershipNo<t.membershipYes,'membershipNo must be below membershipYes'),domains:Categories.default([{id:'technology',name:'Technology',description:'Computing and engineering'},{id:'business',name:'Business',description:'Organizations and commercial operations'},{id:'science',name:'Science',description:'Research and scientific work'},{id:'creative',name:'Creative',description:'Art and media'},{id:'personal',name:'Personal',description:'Personal activities and daily life'}])}).strict();
export type Config=z.infer<typeof Config>;
export type Question={type:'choice'|'noul';instructions:unknown;criteria?:Record<string,unknown>};
export type Request={model:string;state:unknown;questions:Record<string,Question>};
export const Choice=z.object({type:z.literal('choice'),choice:z.string(),probabilities:z.record(z.string(),z.number().min(0).max(1)),confidence:z.number().min(0).max(1)});
export const Noul=z.object({type:z.literal('noul'),noul:z.number().min(0).max(1)});
export const JevResult=z.object({model:z.string().min(1),answers:z.record(z.string(),z.union([Choice,Noul])),usage:z.unknown().optional()});
export type JevResult=z.infer<typeof JevResult>;
export function validateJev(raw:unknown,req:Request):JevResult {
  const r=JevResult.parse(raw);
  for(const [id,q] of Object.entries(req.questions)) {
    const a=r.answers[id]; if(!a || a.type!==q.type) throw Error(`missing/wrong answer ${id}`);
    if(a.type==='choice') {
      const keys=Object.keys(q.criteria!);
      if(!keys.includes(a.choice)|| keys.length!==Object.keys(a.probabilities).length || keys.some(k=>a.probabilities[k]===undefined) || Math.abs(Object.values(a.probabilities).reduce((s,p)=>s+p,0)-1)>0.02) throw Error('invalid Choice distribution');
    }
  }
  return r;
}
export const Truth=z.object({labels:Categories,items:z.array(z.object({id:Id,label_id:Id,rationale:Text}).strict()).min(1)}).strict().superRefine((t,ctx)=>{
  if(new Set(t.items.map(i=>i.id)).size!==t.items.length || t.items.some(i=>!t.labels.some(l=>l.id===i.label_id))) ctx.addIssue({code:'custom',message:'duplicate item or unknown truth label'});
});
export type Truth=z.infer<typeof Truth>;
