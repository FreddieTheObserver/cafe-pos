import { describe, expect, it } from 'vitest';
import { setLocale, t } from '../src/i18n';

describe('t', () => {
  it('fills placeholders', () => {
    expect(t('menu.itemMany', { count: 3 })).toBe('3 items');
    expect(t('cart.issue.unavailable', { name: 'Latte' })).toBe(
      'Latte is sold out.',
    );
  });

  it('leaves a placeholder visible rather than printing undefined when a value is missing', () => {
    expect(t('menu.itemMany')).toBe('{count} items');
  });

  it('falls back to English for a locale it does not have', () => {
    setLocale('th');
    expect(t('common.back')).toBe('Back');
  });
});
