import { NO_DRUG } from '../format/events.js';
import type { ResolvedRules } from '../sim/rules.js';

/**
 * Every bit of wording the interface shows about a cause or a state comes out
 * of rules.json. The templates substitute {drug} and {clone}, which is how
 * "Apoptosis: {drug}" becomes "Apoptosis: Gefitinib (Iressa)".
 */
export function causeLabel(
  rules: ResolvedRules,
  causeId: number,
  drugId: number = NO_DRUG,
  cloneId?: number,
): string {
  const cause = rules.causeById.get(causeId);
  if (!cause) return `cause ${causeId}`;
  const template = cause.label ?? cause.name;
  const drug = rules.drugById.get(drugId);
  return template
    .replace('{drug}', drug ? (drug.displayName ?? drug.name) : 'drug')
    .replace('{clone}', cloneId !== undefined ? (rules.clones[cloneId]?.name ?? `clone ${cloneId}`) : 'clone');
}

export function causeName(rules: ResolvedRules, causeId: number): string {
  const c = rules.causeById.get(causeId);
  if (!c) return `cause ${causeId}`;
  // Drop the parenthetical qualifier for the compact tally and legend rows.
  return c.name.replace(/\s*\([^)]*\)\s*$/, '');
}

export function stateLabel(rules: ResolvedRules, stateId: number): string {
  const s = rules.stateById.get(stateId);
  return s?.label ?? s?.name ?? `state ${stateId}`;
}

export function cloneName(rules: ResolvedRules, cloneId: number): string {
  return rules.clones[cloneId]?.name ?? `clone ${cloneId}`;
}

/** Causes whose kind means the cell is in trouble, so the hover card names them. */
export function causeIsNoteworthy(rules: ResolvedRules, causeId: number): boolean {
  const kind = rules.causeById.get(causeId)?.kind;
  return kind === 'death' || kind === 'arrest' || kind === 'damage' || kind === 'mutation';
}

export function formatDuration(hours: number): string {
  const days = Math.floor(hours / 24);
  const rem = Math.round(hours % 24);
  return days > 0 ? `day ${days}, ${String(rem).padStart(2, '0')}:00` : `${rem}:00`;
}
