// The band's mascot: a little RAM stick whose mood follows the alert level.
// Calm and blinking at ok, sweating at warning, shaking and steaming at
// critical. Desktop and VS Code draw it as an animated SVG (SMIL); a terminal
// draws a text face whose frames the band steps through. Pure: no `$` here.

import type { Level } from './memory'

/** How long a terminal frame shows, in ms. */
export const FRAME_MS = 800

/**
 * The terminal faces per level, every frame of a level the same width so the
 * band text beside it never jumps. Critical shakes by moving a space across.
 */
const FACES: Record<Level, readonly string[]> = {
  ok: ['(•‿•)', '(•‿•)', '(•‿•)', '(•‿•)', '(-‿-)'],
  warning: ['(°_°;)', '(°o°;)'],
  critical: ['(ﾟДﾟ) ', ' (ﾟДﾟ)'],
}

/** The terminal face for `level` at time `now` (ms): frames step every `FRAME_MS`. */
export function mascotFrame(level: Level, now: number): string {
  const frames = FACES[level]

  return frames[Math.floor(now / FRAME_MS) % frames.length] ?? frames[0] ?? ''
}

const MOOD: Record<Level, string> = { ok: 'calm', warning: 'sweating', critical: 'panicking' }

/** What the SVG mascot shows, for a reader that cannot see it. */
export const mascotAlt = (level: Level): string => `RAM mascot, ${MOOD[level]}`

const INK = '#1d1d1f'

/** The stick's gold contacts along its bottom edge, with the notch left out. */
const PINS = [8, 12, 16, 20, 28, 32, 36, 40].map(x => `<rect x="${x}" y="25" width="2" height="4" fill="#d4a72c"/>`).join('')

/** The stick body: a PCB with two chips, filled `fill`; `flash` makes it pulse to a lighter shade. */
const body = (fill: string, flash?: string): string =>
  `<rect x="4" y="5" width="40" height="21" rx="3" fill="${fill}">` +
  (flash === undefined ? '' : `<animate attributeName="fill" values="${fill};${flash};${fill}" dur="0.6s" repeatCount="indefinite"/>`) +
  '</rect>' +
  '<rect x="7" y="8" width="6" height="5" rx="1" fill="#000" opacity="0.18"/>' +
  '<rect x="35" y="8" width="6" height="5" rx="1" fill="#000" opacity="0.18"/>' +
  PINS

/** Eyes that blink about every 4 s. */
const BLINKING_EYES = [18, 30]
  .map(
    cx =>
      `<ellipse cx="${cx}" cy="14" rx="2.2" ry="2.2" fill="${INK}">` +
      '<animate attributeName="ry" values="2.2;2.2;0.3;2.2" keyTimes="0;0.92;0.96;1" dur="4s" repeatCount="indefinite"/>' +
      '</ellipse>',
  )
  .join('')

const PARTS: Record<Level, string> = {
  // A slow float, blinking, smiling.
  ok:
    '<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -1.5;0 0" dur="2.4s" repeatCount="indefinite"/>' +
    body('#3fae6a') +
    BLINKING_EYES +
    `<path d="M19 18 Q24 22 29 18" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>` +
    '</g>',
  // A nervous bounce, wide eyes, a wobbly mouth and a falling drop of sweat.
  warning:
    '<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -2;0 0" dur="0.9s" repeatCount="indefinite"/>' +
    body('#e0a526') +
    `<circle cx="18" cy="14" r="2.6" fill="${INK}"/><circle cx="30" cy="14" r="2.6" fill="${INK}"/>` +
    `<path d="M15 11 L20 9.5 M33 11 L28 9.5" stroke="${INK}" stroke-width="1.3" stroke-linecap="round"/>` +
    `<path d="M19 20 q2.5 -2 5 0 t5 0" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>` +
    '</g>' +
    '<path d="M41 2 q-2.2 3 0 4.4 q2.2 -1.4 0 -4.4z" fill="#5ab0f0">' +
    '<animateTransform attributeName="transform" type="translate" values="0 0;0 9" dur="1.2s" repeatCount="indefinite"/>' +
    '<animate attributeName="opacity" values="1;1;0" dur="1.2s" repeatCount="indefinite"/>' +
    '</path>',
  // A fast shake, a flashing red body, X eyes, an open mouth and steam rising.
  critical:
    '<g><animateTransform attributeName="transform" type="translate" values="0 0;-1.5 0;1.5 0;-1 0;0 0" dur="0.3s" repeatCount="indefinite"/>' +
    body('#e5484d', '#ff8a8a') +
    `<path d="M16 12 L20 16 M20 12 L16 16 M28 12 L32 16 M32 12 L28 16" stroke="${INK}" stroke-width="1.6" stroke-linecap="round"/>` +
    `<ellipse cx="24" cy="20.5" rx="2.4" ry="2" fill="${INK}"/>` +
    '</g>' +
    [
      [12, '0s'],
      [24, '0.4s'],
      [36, '0.8s'],
    ]
      .map(
        ([cx, begin]) =>
          `<circle cx="${cx}" cy="4" r="1.6" fill="#b8b8b8" opacity="0">` +
          `<animate attributeName="cy" values="4;-2" dur="1.2s" begin="${begin}" repeatCount="indefinite"/>` +
          `<animate attributeName="opacity" values="0;0.9;0" dur="1.2s" begin="${begin}" repeatCount="indefinite"/>` +
          '</circle>',
      )
      .join(''),
}

/** The animated SVG mascot for `level`: 48 × 32, room above the stick for sweat and steam. */
export function mascotSvg(level: Level): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -4 48 36" width="48" height="36">${PARTS[level]}</svg>`
}
