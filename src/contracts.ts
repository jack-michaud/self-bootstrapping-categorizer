import {z} from 'zod';

const reservedIds = ['__proto__', 'constructor', 'prototype', 'other', 'unclear', 'no_match', 'ambiguous'];
const reservedCategoryNames = ['other', 'unclear', 'ambiguous', 'no match', 'no_match'];
const Text = z.string().trim().min(1).max(12000);

export const Id = z.string().min(1).max(200).refine(
  value => !reservedIds.includes(value.toLowerCase()),
  'reserved ID',
);

export const Category = z.object({
  id: Id,
  name: Text.refine(
    value => !reservedCategoryNames.includes(value.toLowerCase()),
    'reserved category name',
  ),
  description: Text,
}).strict();
export type Category = z.infer<typeof Category>;

export const MAX_CATEGORIES = 253;
export const SEED_MAX_CATEGORIES = 10;
export const CategoryLimit = z.number().int().min(1).max(MAX_CATEGORIES).default(100);

function hasDuplicateCategoryIdsOrNames(categories: Category[]): boolean {
  const ids = new Set(categories.map(category => category.id));
  const names = new Set(categories.map(category => category.name.toLowerCase()));
  return ids.size !== categories.length || names.size !== categories.length;
}

export const Categories = z.array(Category).min(1).max(MAX_CATEGORIES).superRefine((categories, context) => {
  if (hasDuplicateCategoryIdsOrNames(categories)) {
    context.addIssue({code: 'custom', message: 'duplicate category IDs/names'});
  }
});

export function boundedCategories(raw: unknown, maxCategories = 100): Category[] {
  const limit = CategoryLimit.parse(maxCategories);
  const categories = Categories.parse(raw);
  if (categories.length > limit) {
    throw Error(`category count ${categories.length} exceeds limit ${limit}`);
  }
  return categories;
}

export const RecordSchema = z.object({
  id: Id,
  text: Text,
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();
export type InputRecord = z.infer<typeof RecordSchema>;

export function records(raw: string): InputRecord[] {
  const rows = raw
    .split('\n')
    .filter(line => line.trim())
    .map(line => RecordSchema.parse(JSON.parse(line)));
  const hasDuplicateIds = new Set(rows.map(record => record.id)).size !== rows.length;
  if (!rows.length || hasDuplicateIds) throw Error('empty inputs or duplicate IDs');
  return rows;
}

export const Action = z.object({
  op: z.enum(['add', 'revise', 'merge']),
  target: z.string(),
  sources: z.array(Id),
  name: Text,
  description: Text,
  evidence: z.array(Id).min(1),
  reason: Text,
}).strict();
export const Proposal = z.object({actions: z.array(Action)}).strict();
export type Proposal = z.infer<typeof Proposal>;

export const proposalContract = {
  actions: [{
    op: 'add | revise | merge',
    target: 'empty for add; existing ID otherwise',
    sources: ['merge source IDs excluding target; empty otherwise'],
    name: 'category name',
    description: 'definition and exclusions',
    evidence: ['supplied record IDs'],
    reason: 'evidence-backed justification',
  }],
};

function validateActionEvidence(action: Proposal['actions'][number], validEvidenceIds: Set<string>): void {
  if (action.evidence.some(id => !validEvidenceIds.has(id))) throw Error('unknown evidence ID');
}

function applyAddition(
  categories: Category[],
  action: Proposal['actions'][number],
  actionIndex: number,
  version: number,
): Category[] {
  if (action.target || action.sources.length) throw Error('add cannot target existing categories');
  categories.push({
    id: `task-v${version}-${actionIndex + 1}`,
    name: action.name,
    description: action.description,
  });
  return categories;
}

function applyRevisionOrMerge(
  categories: Category[],
  current: Category[],
  action: Proposal['actions'][number],
  touchedIds: Set<string>,
): Category[] {
  if (!current.some(category => category.id === action.target)) throw Error('unknown target');

  const affectedIds = [action.target, ...action.sources];
  if (new Set(affectedIds).size !== affectedIds.length || affectedIds.some(id => touchedIds.has(id))) {
    throw Error('conflicting actions');
  }
  affectedIds.forEach(id => touchedIds.add(id));

  if (action.op === 'revise' && action.sources.length) {
    throw Error('revise sources must be empty');
  }
  if (action.op === 'merge' && (
    !action.sources.length || action.sources.some(id => !current.some(category => category.id === id))
  )) {
    throw Error('invalid merge sources');
  }

  return categories
    .filter(category => !action.sources.includes(category.id))
    .map(category => category.id === action.target
      ? {id: category.id, name: action.name, description: action.description}
      : category);
}

export function applyProposal(
  current: Category[],
  raw: unknown,
  evidenceIds: string[],
  version: number,
  maxCategories = 100,
): Category[] {
  const proposal = Proposal.parse(raw);
  const validEvidenceIds = new Set(evidenceIds);
  const touchedIds = new Set<string>();
  let next = structuredClone(current);

  for (const [index, action] of proposal.actions.entries()) {
    validateActionEvidence(action, validEvidenceIds);
    next = action.op === 'add'
      ? applyAddition(next, action, index, version)
      : applyRevisionOrMerge(next, current, action, touchedIds);
  }

  return boundedCategories(next, maxCategories);
}

export const ProviderConfig = z.object({
  curatorBackend: z.enum(['pi', 'hermes-chat', 'hermes-native']).default('hermes-native'),
  hermesRuntimePath: z.string().min(1).optional(),
  maxOutputBytes: z.number().int().min(1024).max(2000000).default(262144),
  jevModel: z.string().min(1).default('jev-latest'),
  jevUrl: z.url().default('https://api.typesafe.ai/v1/systemone'),
  curatorProvider: z.string().default('openai-codex'),
  curatorModel: z.string().default('gpt-5.4'),
  timeoutMs: z.number().int().min(100).max(600000).default(120000),
  maxTokens: z.number().int().min(100).max(32000).default(8000),
}).strict();

const Thresholds = z.object({
  gap: z.number().min(0).max(1).default(0.7),
  membershipYes: z.number().min(0).max(1).default(0.7),
  membershipNo: z.number().min(0).max(1).default(0.3),
  primaryMembershipMin: z.number().min(0).max(1).default(0.5),
  choiceConfidence: z.number().min(0).max(1).default(0.5),
}).strict().default({
  gap: 0.7,
  membershipYes: 0.7,
  membershipNo: 0.3,
  primaryMembershipMin: 0.5,
  choiceConfidence: 0.5,
}).refine(thresholds => thresholds.membershipNo < thresholds.membershipYes, 'membershipNo must be below membershipYes');

const defaultDomains = [
  {id: 'technology', name: 'Technology', description: 'Computing and engineering'},
  {id: 'business', name: 'Business', description: 'Organizations and commercial operations'},
  {id: 'science', name: 'Science', description: 'Research and scientific work'},
  {id: 'creative', name: 'Creative', description: 'Art and media'},
  {id: 'personal', name: 'Personal', description: 'Personal activities and daily life'},
];

// maxRounds/review are legacy, parsed for config compatibility but ignored.
export const Config = ProviderConfig.extend({
  maxCategories: CategoryLimit,
  normalizationMinWinningProbability: z.number().min(0).max(1).default(0.95),
  mode: z.enum(['discovery', 'assessment']).default('discovery'),
  maxRounds: z.number().int().min(0).max(20).default(3),
  maxCalls: z.number().int().min(1).max(100000).default(200),
  sampleSize: z.number().int().min(1).max(1000).default(40),
  review: z.boolean().default(false),
  thresholds: Thresholds,
  domains: Categories.default(defaultDomains),
}).strict();
export type Config = z.infer<typeof Config>;

export type Question = {
  type: 'choice' | 'noul';
  instructions: unknown;
  criteria?: Record<string, unknown>;
};

export type Request = {
  model: string;
  state: unknown;
  questions: Record<string, Question>;
};

export const Choice = z.object({
  type: z.literal('choice'),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
  confidence: z.number().min(0).max(1),
});
export const Noul = z.object({
  type: z.literal('noul'),
  noul: z.number().min(0).max(1),
});
export const JevResult = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.union([Choice, Noul])),
  usage: z.unknown().optional(),
});
export type JevResult = z.infer<typeof JevResult>;

function validateChoiceDistribution(question: Question, answer: z.infer<typeof Choice>): void {
  const keys = Object.keys(question.criteria!);
  const probabilities = answer.probabilities;
  const hasExpectedChoices = keys.includes(answer.choice);
  const hasEveryProbability = keys.length === Object.keys(probabilities).length
    && keys.every(key => probabilities[key] !== undefined);
  const probabilityTotal = Object.values(probabilities).reduce((sum, probability) => sum + probability, 0);

  if (!hasExpectedChoices || !hasEveryProbability || Math.abs(probabilityTotal - 1) > 0.02) {
    throw Error('invalid Choice distribution');
  }
}

export function validateJev(raw: unknown, request: Request): JevResult {
  const result = JevResult.parse(raw);
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = result.answers[id];
    if (!answer || answer.type !== question.type) throw Error(`missing/wrong answer ${id}`);
    if (answer.type === 'choice') validateChoiceDistribution(question, answer);
  }
  return result;
}

function hasDuplicateTruthItemIdsOrUnknownLabels(truth: {
  labels: {id: string}[];
  items: {id: string; label_id: string}[];
}): boolean {
  const itemIds = new Set(truth.items.map(item => item.id));
  return itemIds.size !== truth.items.length
    || truth.items.some(item => !truth.labels.some(label => label.id === item.label_id));
}

export const Truth = z.object({
  labels: Categories,
  items: z.array(z.object({id: Id, label_id: Id, rationale: Text}).strict()).min(1),
}).strict().superRefine((truth, context) => {
  if (hasDuplicateTruthItemIdsOrUnknownLabels(truth)) {
    context.addIssue({code: 'custom', message: 'duplicate item or unknown truth label'});
  }
});
export type Truth = z.infer<typeof Truth>;
