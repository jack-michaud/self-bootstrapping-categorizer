import {expect,test} from 'bun:test';
import {Policy,freezeRoots,addChildren,resolveRefinement,depthStop,decide,children,pathTo} from '../src/domain/trie.ts';
import {judgmentRequest} from '../src/domain/prompts.ts';
const policy=Policy.parse({});
const roots=[{name:'Interprets code',description:'Understands code; does not require edits.'},{name:'Edits code',description:'Changes code.'}];
const tree=()=>freezeRoots(roots,policy);
test('roots and children have generated path IDs; immutable versions',()=>{
 const t=tree(),p=t.nodes[0]!.id;
 expect(resolveRefinement(t,p,[],policy)).toEqual({kind:'retain',reason:'noChange'});
 expect(resolveRefinement(t,p,[{name:'Review',description:'Review'}],policy).kind).toBe('retry');
 expect(depthStop(policy.maxDepth,policy)).toEqual({kind:'terminal',reason:'maxDepth'});
 const n=addChildren(t,p,[{name:'For review',description:'Examines code for review.'}],policy);
 expect(t.nodes.length).toBe(2);expect(n.version).toBe(2);
 expect(pathTo(n,children(n,p)[0]!.id).map(x=>x.name)).toEqual(['Interprets code','For review']);
 expect(()=>addChildren(n,null,roots,policy)).toThrow('frozen');
 expect(()=>addChildren(n,p,[{name:'for review',description:'duplicate'}],policy)).toThrow();
});
test('retains parent on uncertain/no finer/retry Other; never grows roots',()=>{
 expect(decide('other',null,false,0,policy)).toEqual({kind:'terminal',reason:'rootOther'});
 expect(decide('unclear',null,false,0,policy).kind).toBe('terminal');
 expect(decide('stopAtParent','p',false,1,policy)).toEqual({kind:'terminal',reason:'stopAtParent'});
 expect(decide('specificOther','p',true,1,policy)).toEqual({kind:'terminal',reason:'stillOther'});
 expect(decide('specificOther','p',false,1,policy)).toEqual({kind:'curate'});
});
test('prompts only siblings with full ancestor path; zero children feasibility',()=>{
 const t=tree(),p=t.nodes[0]!.id;
 const q=judgmentRequest(t,p,{id:'r',text:'Review this module'},'jev-test');
 expect(q.questions.branch!.type).toBe('choice');
 expect(Object.keys(q.questions.branch!.criteria!)).toEqual(['specificOther','stopAtParent','unclear']);
 expect(JSON.stringify(q)).not.toContain('Edits code');
 expect(JSON.stringify(q)).toContain('Interprets code');
 expect(q.questions.coverage).toBeUndefined();
 expect(q.questions.feasible!.type).toBe('noul');
});
