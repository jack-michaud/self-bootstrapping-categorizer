import {z} from 'zod';

export const Policy = z.object({
  maxDepth: z.number().int().min(1).max(32).default(3),
  perParentChildren: z.number().int().min(1).max(250).default(10),
  totalNodes: z.number().int().min(1).max(10000).default(100),
  maxCalls: z.number().int().min(1).max(100000).default(200),
  seedSize: z.number().int().min(1).max(1000).default(40),
  primaryLimit: z.number().int().min(1).max(10).default(10),
  specificSupport: z.number().min(0).max(1).default(0.7),
}).strict();
export type Policy = z.infer<typeof Policy>;

const text = z.string().trim().min(1).max(12000);
const reserved = ['other', 'unclear', 'specificother', 'stopatparent', 'constructor', 'prototype', '__proto__'];
export const Definition = z.object({
  name: text.refine(s => !reserved.includes(s.toLowerCase()), 'reserved name'),
  description: text,
}).strict();
export type Definition = z.infer<typeof Definition>;

export type Node = Readonly<Definition & {id: string; parentId: string | null; createdVersion: number}>;
export type Taxonomy = Readonly<{version: number; nodes: readonly Node[]; rootsFrozen: true}>;
export type RecordInput = {id: string; text: string; metadata?: Record<string, unknown>};

const Action = Definition.extend({
  op: z.literal('add'),
  target: z.string(),
  sources: z.array(z.string()),
  parentId: z.string().nullable(),
  evidence: z.array(text).min(1),
  reason: text,
}).strict();
export const Proposal = z.object({actions: z.array(Action)}).strict();
export type ParsedProposal = z.infer<typeof Proposal>;
