import { describe, test, expect } from '@jest/globals';
import cj from '../../src/actions/feeds/providers/cj.js';

describe('cj provider', () => {
  test('does not emit item_group_id', () => {
    expect(cj.fields).not.toContain('item_group_id');
    expect(cj.fields).toContain('color');
  });

  test('identifier_exists is "no" when gtin and mpn are both missing', () => {
    expect(cj.transformItem({ id: 'VBNDX', gtin: '', brand: 'Vitamix' }).identifier_exists).toBe('no');
    expect(cj.transformItem({ id: 'VBNDX' }).identifier_exists).toBe('no');
  });

  test('identifier_exists is left unset when gtin or mpn is present', () => {
    const withGtin = { id: '1', gtin: '0123456789012' };
    const withMpn = { id: '2', mpn: '064306' };
    expect(cj.transformItem(withGtin)).toEqual(withGtin);
    expect(cj.transformItem(withMpn)).toEqual(withMpn);
  });
});
