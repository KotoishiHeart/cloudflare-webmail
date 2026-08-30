import { describe, expect, it } from 'vitest';
import { shouldShowHtmlByDefault } from '../apps/web/public/ui/body-display.js';

describe('webmail body display selection', () => {
  it('falls back to safe HTML for HTML-only messages', () => {
    expect(shouldShowHtmlByDefault({ text: '', html: '<p>code</p>' }, false)).toBe(true);
  });

  it('respects the text preference when a plain-text part exists', () => {
    expect(shouldShowHtmlByDefault({ text: 'code', html: '<p>code</p>' }, false)).toBe(false);
    expect(shouldShowHtmlByDefault({ text: 'code', html: '<p>code</p>' }, true)).toBe(true);
  });

  it('does not select HTML when no HTML part exists', () => {
    expect(shouldShowHtmlByDefault({ text: 'code', html: null }, true)).toBe(false);
  });
});
