/**
 * Unit tests for the virtual-bundle Discount Reason Code (VBND) resolver.
 */

import { describe, test, expect } from '@jest/globals';
import {
  VBND_REASON_CODES,
  VBND_REASON_CODES_BY_BUNDLE,
  bundleUrlKey,
  resolveVbndReasonCode,
} from '../../src/actions/ebs-sync/discount-reason-codes.js';

describe('bundleUrlKey', () => {
  test('returns the last path segment', () => {
    expect(bundleUrlKey('/us/en_us/products/ascent-x5-smartprep-kitchen-system'))
      .toBe('ascent-x5-smartprep-kitchen-system');
  });

  test('handles a trailing slash', () => {
    expect(bundleUrlKey('/ca/en_ca/products/5200-legacy-bundle/')).toBe('5200-legacy-bundle');
  });

  test('strips a .json suffix', () => {
    expect(bundleUrlKey('/us/en_us/products/propel-750-classic-bundle.json'))
      .toBe('propel-750-classic-bundle');
  });

  test('drops a query string', () => {
    expect(bundleUrlKey('/us/en_us/products/5200-legacy-bundle?x=1')).toBe('5200-legacy-bundle');
  });

  test('returns the value unchanged when there is no slash', () => {
    expect(bundleUrlKey('5200-legacy-bundle')).toBe('5200-legacy-bundle');
  });

  test('returns empty string for missing path', () => {
    expect(bundleUrlKey(undefined)).toBe('');
    expect(bundleUrlKey('')).toBe('');
  });
});

describe('resolveVbndReasonCode', () => {
  test('resolves a mapped (bundle, variant) pair', () => {
    expect(resolveVbndReasonCode({
      path: '/us/en_us/products/ascent-x5-smartprep-kitchen-system',
      sku: '074104-04-VB',
    })).toBe('VBND8.1');
  });

  test('resolves the same variant under a country-specific path', () => {
    expect(resolveVbndReasonCode({
      path: '/ca/en_ca/products/5200-legacy-bundle',
      sku: '001372-1093-VB',
    })).toBe('VBND10');
  });

  test('is country-independent (keys off the url-key only)', () => {
    const us = resolveVbndReasonCode({
      path: '/us/en_us/products/5200-legacy-bundle',
      sku: '001392-1138-VB',
    });
    const ca = resolveVbndReasonCode({
      path: '/ca/en_ca/products/5200-legacy-bundle',
      sku: '001392-1138-VB',
    });
    expect(us).toBe('VBND10.2');
    expect(ca).toBe('VBND10.2');
  });

  test('returns empty string for an unmapped variant', () => {
    expect(resolveVbndReasonCode({
      path: '/us/en_us/products/ascent-x5-smartprep-kitchen-system',
      sku: '999999-99-VB',
    })).toBe('');
  });

  test('returns empty string for an unmapped bundle', () => {
    expect(resolveVbndReasonCode({
      path: '/us/en_us/products/some-other-bundle',
      sku: '074104-04-VB',
    })).toBe('');
  });

  test('disambiguates a shared variant SKU by bundle url-key', () => {
    // 074104-04-VB is the Graphite blender in both the X5 SmartPrep bundle
    // and the X5 + Stainless Steel Container bundle; only the bundle differs.
    expect(resolveVbndReasonCode({
      path: '/us/en_us/products/ascent-x5-smartprep-kitchen-system',
      sku: '074104-04-VB',
    })).toBe('VBND8.1');
    expect(resolveVbndReasonCode({
      path: '/us/en_us/products/ascent-x5-plus-stainless-steel-container',
      sku: '074104-04-VB',
    })).toBe('VBND12.1');
  });

  test('falls back to a bundle-level code for parent-only bundles', () => {
    // Immersion Blender Complete Bundle matches on the bundle regardless of
    // which child SKU the line carries.
    expect(resolveVbndReasonCode({
      path: '/us/en_us/products/5-speed-immersion-blender-complete-bundle',
      sku: '069811-VB',
    })).toBe('VBND7');
    expect(resolveVbndReasonCode({
      path: '/us/en_us/products/5-speed-immersion-blender-complete-bundle',
      sku: 'anything',
    })).toBe('VBND7');
  });

  test('returns empty string when path or sku is missing', () => {
    expect(resolveVbndReasonCode({ sku: '074104-04-VB' })).toBe('');
    expect(resolveVbndReasonCode({ path: '/us/en_us/products/5200-legacy-bundle' })).toBe('');
    expect(resolveVbndReasonCode({})).toBe('');
  });
});

describe('VBND_REASON_CODES data', () => {
  test('every variant key has the "urlKey|variantSku" shape and a VBND code', () => {
    for (const [key, code] of Object.entries(VBND_REASON_CODES)) {
      expect(key).toMatch(/^[a-z0-9-]+\|[0-9-]+-VB$/);
      expect(code).toMatch(/^VBND[0-9.]+$/);
    }
  });

  test('every bundle-level key is a url-key mapped to a VBND code', () => {
    for (const [key, code] of Object.entries(VBND_REASON_CODES_BY_BUNDLE)) {
      expect(key).toMatch(/^[a-z0-9-]+$/);
      expect(code).toMatch(/^VBND[0-9.]+$/);
    }
  });
});
