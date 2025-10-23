import { describe, it, expect } from 'vitest';
import { cn } from '../../lib/utils';

describe('cn()', () => {
  it('merges class strings and ignores falsy values', () => {
    const out = cn('btn', undefined, false && 'hidden', null as any, 'rounded');
    expect(out).toBe('btn rounded');
  });

  it('preserves duplicate non-Tailwind classes (twMerge only resolves conflicts)', () => {
    const out = cn('btn', 'btn', 'rounded', 'rounded');
    expect(out).toBe('btn btn rounded'); // duplicates kept
  });

  it('resolves Tailwind conflicts (later wins)', () => {
    const out = cn('p-2', 'p-4'); // twMerge should keep p-4
    expect(out).toBe('p-4');
  });

  it('handles array inputs from clsx signature', () => {
    const out = cn(['text-sm', ['font-medium']], {
      hidden: false,
      block: true
    });
    expect(out).toBe('text-sm font-medium block');
  });
});
