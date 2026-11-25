import { describe, expect, it } from 'vitest';

import { isMarkdownPath, lineKinds, markerRole } from '../src/markdown.ts';

describe('isMarkdownPath', () => {
  it('matches markdown extensions', () => {
    expect(isMarkdownPath('docs/plan.md')).toBe(true);
    expect(isMarkdownPath('page.MDX')).toBe(true);
    expect(isMarkdownPath('src/md.ts')).toBe(false);
  });
});

describe('lineKinds', () => {
  it('names each kind of line', () => {
    expect(
      lineKinds([
        '# Title',
        '## Section',
        '#### Deep',
        '',
        'Some prose.',
        '- item',
        '1. step',
        '> quote',
        '| a | b |',
        '---',
        '    indented code',
      ])
    ).toEqual([
      'h1',
      'h2',
      'h4',
      'blank',
      'prose',
      'list',
      'list',
      'quote',
      'table',
      'rule',
      'code',
    ]);
  });

  it('treats lines inside a fence as code', () => {
    expect(
      lineKinds(['```ts', '# not a heading', '~~~', '```', 'after'])
    ).toEqual(['fence', 'code', 'code', 'fence', 'prose']);
  });

  it('caps heading levels at four', () => {
    expect(lineKinds(['###### six'])).toEqual(['h4']);
  });
});

describe('markerRole', () => {
  it('fades markdown syntax and hides link URLs', () => {
    expect(markerRole('pl-s', '**')).toBe('syntax');
    expect(markerRole('pl-s', '`')).toBe('syntax');
    expect(markerRole('pl-s', '[')).toBe('syntax');
    expect(markerRole('pl-corl', '#scheduling')).toBe('url');
    expect(markerRole('pl-v', '-')).toBe('bullet');
    expect(markerRole('pl-v', '2.')).toBe('bullet');
    expect(markerRole('pl-s', '"quoted"')).toBeNull();
    expect(markerRole('pl-c1', 'code')).toBeNull();
  });
});
