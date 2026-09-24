import {type Definition, type Policy, type Taxonomy} from './schema.ts';
import {addChildren, children, pathTo} from './tree.ts';

export type Decision =
  | {kind: 'descend'; id: string}
  | {kind: 'curate'}
  | {kind: 'terminal'; reason: string};

export function depthStop(depth: number, policy: Policy): Extract<Decision, {kind: 'terminal'}> | undefined {
  return depth >= policy.maxDepth ? {kind: 'terminal', reason: 'maxDepth'} : undefined;
}

export type RefinementDecision =
  | {kind: 'retain'; reason: 'noChange'}
  | {kind: 'retry'; taxonomy: Taxonomy};

export function resolveRefinement(
  taxonomy: Taxonomy,
  parent: string,
  definitions: Definition[],
  policy: Policy,
): RefinementDecision {
  return definitions.length
    ? {kind: 'retry', taxonomy: addChildren(taxonomy, parent, definitions, policy)}
    : {kind: 'retain', reason: 'noChange'};
}

export function decide(
  choice: string,
  parent: string | null,
  retried: boolean,
  depth: number,
  policy: Policy,
  specificSupport = 1,
): Decision {
  if (parent === null && ['other', 'unclear'].includes(choice)) {
    return {kind: 'terminal', reason: choice === 'other' ? 'rootOther' : 'rootUnclear'};
  }
  if (choice === 'unclear') return {kind: 'terminal', reason: 'childUnclear'};
  if (choice === 'stopAtParent') return {kind: 'terminal', reason: 'stopAtParent'};
  if (choice === 'specificOther') {
    if (specificSupport < policy.specificSupport) {
      return {kind: 'terminal', reason: 'unsupportedSpecificOther'};
    }
    if (retried) return {kind: 'terminal', reason: 'stillOther'};
    if (depth >= policy.maxDepth) return {kind: 'terminal', reason: 'maxDepth'};
    return {kind: 'curate'};
  }
  return {kind: 'descend', id: choice};
}

export function growthLimit(taxonomy: Taxonomy, parent: string, policy: Policy): string | undefined {
  if (pathTo(taxonomy, parent).length >= policy.maxDepth) return 'maxDepth';
  if (children(taxonomy, parent).length >= policy.perParentChildren) return 'perParentChildren';
  if (taxonomy.nodes.length >= policy.totalNodes) return 'totalNodes';
}
