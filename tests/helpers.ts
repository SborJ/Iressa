import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRules, type RulesFile, type ResolvedRules } from '../src/sim/rules.js';
import { loadVisuals, type Visuals } from '../src/render/visuals.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const readJson = (p: string): any => JSON.parse(readFileSync(join(root, p), 'utf8'));

export const rulesSchema = () => readJson('data/schema/rules.schema.json');
export const visualsSchema = () => readJson('data/schema/visuals.schema.json');
export const rawRules = (): RulesFile => readJson('data/rules.json');
export const rawVisuals = () => readJson('data/visuals.json');

export function projectRules(mutate?: (r: any) => void): ResolvedRules {
  const raw = rawRules();
  mutate?.(raw);
  return loadRules(raw, rulesSchema());
}

export function projectVisuals(rules: ResolvedRules, mutate?: (v: any) => void): Visuals {
  const raw = rawVisuals();
  mutate?.(raw);
  return loadVisuals(raw, visualsSchema(), rules);
}
