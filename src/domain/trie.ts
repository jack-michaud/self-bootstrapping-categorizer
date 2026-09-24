import {z} from 'zod';

// Jack-owned semantics. No I/O, clocks, environment, provider clients or persistence.
export const Policy=z.object({
 maxDepth:z.number().int().min(1).max(32).default(3),
 perParentChildren:z.number().int().min(1).max(250).default(10),
 totalNodes:z.number().int().min(1).max(10000).default(100),
 maxCalls:z.number().int().min(1).max(100000).default(200),
 seedSize:z.number().int().min(1).max(1000).default(40),
 primaryLimit:z.number().int().min(1).max(10).default(10),
 specificSupport:z.number().min(0).max(1).default(0.7)
}).strict();
export type Policy=z.infer<typeof Policy>;
const text=z.string().trim().min(1).max(12000);
const reserved=['other','unclear','specificother','stopatparent','constructor','prototype','__proto__'];
export const Definition=z.object({name:text.refine(s=>!reserved.includes(s.toLowerCase()),'reserved name'),description:text}).strict();
export type Definition=z.infer<typeof Definition>;
export type Node=Readonly<Definition & {id:string;parentId:string|null;createdVersion:number}>;
export type Taxonomy=Readonly<{version:number;nodes:readonly Node[];rootsFrozen:true}>;
export type RecordInput={id:string;text:string;metadata?:Record<string,unknown>};
export function children(t:Taxonomy,parentId:string|null):Node[]{return t.nodes.filter(n=>n.parentId===parentId);}
export function pathTo(t:Taxonomy,id:string|null):Node[]{
 const path:Node[]=[]; const seen=new Set<string>();
 while(id!==null){
  if(seen.has(id))throw Error('cycle');seen.add(id);
  const node=t.nodes.find(n=>n.id===id);if(!node)throw Error('unknown parent link');
  path.unshift(node);id=node.parentId;
 }
 return path;
}
export function validateTree(t:Taxonomy,p:Policy):void{
 if(t.nodes.length>p.totalNodes)throw Error('totalNodes limit');
 if(new Set(t.nodes.map(n=>n.id)).size!==t.nodes.length)throw Error('duplicate ID');
 if(!children(t,null).length||children(t,null).length>p.primaryLimit)throw Error('primary limit');
 for(const parent of [null,...t.nodes.map(n=>n.id)]){
  const cs=children(t,parent);
  if(cs.length>p.perParentChildren)throw Error('perParentChildren limit');
  if(new Set(cs.map(n=>n.name.toLowerCase())).size!==cs.length)throw Error('duplicate sibling');
 }
 for(const n of t.nodes){Definition.parse({name:n.name,description:n.description});if(pathTo(t,n.id).length>p.maxDepth)throw Error('maxDepth limit');}
}
export function freezeRoots(raw:unknown,p:Policy):Taxonomy{
 const definitions=z.array(Definition).min(1).parse(raw);
 const t:Taxonomy={version:1,rootsFrozen:true,nodes:definitions.map((d,i)=>({...d,id:`n${i+1}`,parentId:null,createdVersion:1}))};
 validateTree(t,p);return t;
}
export function addChildren(t:Taxonomy,parentId:string|null,raw:unknown,p:Policy):Taxonomy{
 if(parentId===null)throw Error('roots frozen');pathTo(t,parentId);
 const definitions=z.array(Definition).min(1).parse(raw),version=t.version+1;
 const nodes=definitions.map((d,i)=>({...d,id:`${parentId}.${children(t,parentId).length+i+1}`,parentId,createdVersion:version}));
 const next:Taxonomy={version,rootsFrozen:true,nodes:[...t.nodes,...nodes]};validateTree(next,p);return next;
}
export type Decision={kind:'descend';id:string}|{kind:'curate'}|{kind:'terminal';reason:string};
export function depthStop(depth:number,p:Policy):Extract<Decision,{kind:'terminal'}>|undefined{
 return depth>=p.maxDepth?{kind:'terminal',reason:'maxDepth'}:undefined;
}
export type RefinementDecision={kind:'retain';reason:'noChange'}|{kind:'retry';taxonomy:Taxonomy};
export function resolveRefinement(t:Taxonomy,parent:string,definitions:Definition[],p:Policy):RefinementDecision{
 return definitions.length?{kind:'retry',taxonomy:addChildren(t,parent,definitions,p)}:{kind:'retain',reason:'noChange'};
}
export function decide(choice:string,parent:string|null,retried:boolean,depth:number,p:Policy,specificSupport=1):Decision{
 if(parent===null&&['other','unclear'].includes(choice))return {kind:'terminal',reason:choice==='other'?'rootOther':'rootUnclear'};
 if(choice==='unclear')return {kind:'terminal',reason:'childUnclear'};
 if(choice==='stopAtParent')return {kind:'terminal',reason:'stopAtParent'};
 if(choice==='specificOther'){
  if(specificSupport<p.specificSupport)return {kind:'terminal',reason:'unsupportedSpecificOther'};
  if(retried)return {kind:'terminal',reason:'stillOther'};
  if(depth>=p.maxDepth)return {kind:'terminal',reason:'maxDepth'};
  return {kind:'curate'};
 }
 return {kind:'descend',id:choice};
}
export function growthLimit(t:Taxonomy,parent:string,p:Policy):string|undefined{
 if(pathTo(t,parent).length>=p.maxDepth)return 'maxDepth';
 if(children(t,parent).length>=p.perParentChildren)return 'perParentChildren';
 if(t.nodes.length>=p.totalNodes)return 'totalNodes';
}
// Deliberately narrow resilience: strict parsing first, only meaningless add targets are cleaned.
const Action=Definition.extend({op:z.literal('add'),target:z.string(),sources:z.array(z.string()),parentId:z.string().nullable(),evidence:z.array(text).min(1),reason:text}).strict();
export const Proposal=z.object({actions:z.array(Action)}).strict();
export function cleanProposal(raw:unknown){
 const parsed=Proposal.parse(raw);
 const ignoredAddTargets=parsed.actions.flatMap((a,actionIndex)=>a.target?[{actionIndex,originalTarget:a.target}]:[]);
 return {proposal:{actions:parsed.actions.map(a=>({...a,target:''}))},ignoredAddTargets};
}
export function validateProposal(proposal:z.infer<typeof Proposal>,parent:string|null,evidenceIds:string[]):Definition[]{
 for(const a of proposal.actions){
  if(a.parentId!==parent)throw Error('invalid parent link');
  if(a.sources.length)throw Error('sources must be empty');
  if(a.evidence.some(id=>!evidenceIds.includes(id)))throw Error('unknown evidence ID');
 }
 return proposal.actions.map(({name,description})=>({name,description}));
}
