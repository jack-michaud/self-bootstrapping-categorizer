import {Proposal, type Definition, type ParsedProposal} from './schema.ts';

export function cleanProposal(raw: unknown) {
  const parsed = Proposal.parse(raw);
  const ignoredAddTargets = parsed.actions.flatMap((action, actionIndex) =>
    action.target ? [{actionIndex, originalTarget: action.target}] : [],
  );
  return {
    proposal: {actions: parsed.actions.map(action => ({...action, target: ''}))},
    ignoredAddTargets,
  };
}

export function validateProposal(
  proposal: ParsedProposal,
  parent: string | null,
  evidenceIds: string[],
): Definition[] {
  for (const action of proposal.actions) {
    if (action.parentId !== parent) throw Error('invalid parent link');
    if (action.sources.length) throw Error('sources must be empty');
    if (action.evidence.some(id => !evidenceIds.includes(id))) throw Error('unknown evidence ID');
  }
  return proposal.actions.map(({name, description}) => ({name, description}));
}
