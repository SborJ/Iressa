import type { Story } from './narrative.js';

/**
 * What each phase of the run is coloured.
 *
 * Teal is the only colour that means good news, and it means one thing: the
 * treatment is working. A growing tumour gets no colour at all - it is the
 * default state of the experiment, not an event - and warm means the treatment
 * has stopped reaching something.
 */
export const TONE: Record<Story['tone'], string> = {
  grow: 'var(--fg-2)',
  respond: 'var(--respond)',
  resist: 'var(--resist)',
  danger: 'var(--danger)',
  neutral: 'var(--fg-3)',
};
