import {z} from 'zod';
import {Definition, type Node, type Policy, type Taxonomy} from './schema.ts';

export function children(t: Taxonomy, parentId: string | null): Node[] {
  return t.nodes.filter(node => node.parentId === parentId);
}

export function pathTo(t: Taxonomy, id: string | null): Node[] {
  const path: Node[] = [];
  const seen = new Set<string>();
  while (id !== null) {
    if (seen.has(id)) throw Error('cycle');
    seen.add(id);
    const node = t.nodes.find(candidate => candidate.id === id);
    if (!node) throw Error('unknown parent link');
    path.unshift(node);
    id = node.parentId;
  }
  return path;
}

export function validateTree(t: Taxonomy, policy: Policy): void {
  if (t.nodes.length > policy.totalNodes) throw Error('totalNodes limit');
  if (new Set(t.nodes.map(node => node.id)).size !== t.nodes.length) throw Error('duplicate ID');

  const roots = children(t, null);
  if (!roots.length || roots.length > policy.primaryLimit) throw Error('primary limit');

  for (const parent of [null, ...t.nodes.map(node => node.id)]) {
    const siblings = children(t, parent);
    if (siblings.length > policy.perParentChildren) throw Error('perParentChildren limit');
    if (new Set(siblings.map(node => node.name.toLowerCase())).size !== siblings.length) {
      throw Error('duplicate sibling');
    }
  }

  for (const node of t.nodes) {
    Definition.parse({name: node.name, description: node.description});
    if (pathTo(t, node.id).length > policy.maxDepth) throw Error('maxDepth limit');
  }
}

export function freezeRoots(raw: unknown, policy: Policy): Taxonomy {
  const definitions = z.array(Definition).min(1).parse(raw);
  const taxonomy: Taxonomy = {
    version: 1,
    rootsFrozen: true,
    nodes: definitions.map((definition, index) => ({
      ...definition,
      id: `n${index + 1}`,
      parentId: null,
      createdVersion: 1,
    })),
  };
  validateTree(taxonomy, policy);
  return taxonomy;
}

export function addChildren(t: Taxonomy, parentId: string | null, raw: unknown, policy: Policy): Taxonomy {
  if (parentId === null) throw Error('roots frozen');
  pathTo(t, parentId);
  const definitions = z.array(Definition).min(1).parse(raw);
  const version = t.version + 1;
  const firstChildNumber = children(t, parentId).length + 1;
  const nodes = definitions.map((definition, index) => ({
    ...definition,
    id: `${parentId}.${firstChildNumber + index}`,
    parentId,
    createdVersion: version,
  }));
  const next: Taxonomy = {version, rootsFrozen: true, nodes: [...t.nodes, ...nodes]};
  validateTree(next, policy);
  return next;
}
