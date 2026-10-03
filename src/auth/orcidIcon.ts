import { svg } from '../ui/dom.js';

/** The ORCID iD mark: a green disc with a white "iD", as ORCID's brand guidelines ask buttons and badges to show. */
export function orcidIcon(size = 16): SVGElement {
  const root = svg('svg', { viewBox: '0 0 256 256', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', class: 'orcid-icon' });
  root.append(
    svg('circle', { cx: 128, cy: 128, r: 128, fill: '#A6CE39' }),
    svg('rect', { x: 70, y: 98, width: 21, height: 97, rx: 2, fill: '#fff' }),
    svg('circle', { cx: 80.5, cy: 74, r: 13, fill: '#fff' }),
    svg('path', {
      fill: '#fff',
      d: 'M110 98h38c36 0 52 26 52 48.5 0 24.5-19.5 48.5-52 48.5h-38zm21 78h16c23.5 0 32-16.5 32-29.5 0-15-9.5-29.5-32.5-29.5H131z',
    }),
  );
  return root;
}
