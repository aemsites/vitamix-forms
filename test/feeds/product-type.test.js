import { describe, test, expect } from '@jest/globals';
import {
  categoryToProductType, resolveProductType, unknownCategories,
} from '../../src/actions/feeds/product-type.js';

describe('categoryToProductType (category slugs)', () => {
  test.each([
    ['all-blenders,full-size-blenders', 'Countertop Blender'],
    ['shop,legacy-series-blenders', 'Countertop Blender'],
    ['shop,all-blenders,explorian-series', 'Countertop Blender'],
    ['all-blenders,immersion-blender', 'Immersion Blender'],
    ['all-blenders,personal-blending', 'Personal Blender'],
    ['juicing', 'Kitchen Tool'],
    // specific types win over the broader groupings
    ['accessories,blender-containers,personal-blending', 'Blender Container'],
    ['accessories,blender-containers,smoothie-cups', 'Smoothie Cup'],
    ['accessories,blender-containers,food-processing', 'Food Processing'],
    ['shop,compact-food-recycling,kitchen-tools', 'Compact Food Recycling'],
    ['shop,accessories,tampers', 'Tamper'],
    ['shop,accessories,cookbooks', 'Cookbook'],
    // whitespace / case tolerant
    [' Full-Size-Blenders ', 'Countertop Blender'],
  ])('%s -> %s', (slugs, type) => {
    expect(categoryToProductType(slugs)).toBe(type);
  });

  test('generic / promo / accessory-series categories map to nothing', () => {
    expect(categoryToProductType('shop,accessories')).toBeUndefined();
    expect(categoryToProductType('all-blenders,blenders,eligible-employee-discount')).toBeUndefined();
    // named "Explorian Series" like the blender category, but accessories
    expect(categoryToProductType('accessories,explorian-series-accessories')).toBeUndefined();
    expect(categoryToProductType('sale-skus')).toBeUndefined();
    expect(categoryToProductType('')).toBeUndefined();
    expect(categoryToProductType(undefined)).toBeUndefined();
  });

  test('unknownCategories reports only unmapped, non-ignored slugs', () => {
    expect(unknownCategories('shop,accessories,sale-skus,frozen-desserts')).toEqual(['frozen-desserts']);
  });
});

describe('resolveProductType', () => {
  const index = new Map([
    // category wins over the legacy productType
    ['A', { sku: 'A', productType: 'Tamper', categoriesUrlKey: 'all-blenders,full-size-blenders' }],
    ['P', { sku: 'P', categoriesUrlKey: 'all-blenders,full-size-blenders' }],
    ['V', { sku: 'V', parentSku: 'P' }],
    // no type-bearing category -> legacy productType
    ['L', { sku: 'L', productType: 'Cookbook', categoriesUrlKey: 'accessories' }],
    ['LP', { sku: 'LP', productType: 'Countertop Blender' }],
    ['LV', { sku: 'LV', parentSku: 'LP' }],
  ]);

  test('source value wins', () => {
    expect(resolveProductType({ id: 'A', product_type: 'X' }, index))
      .toEqual({ productType: 'X', source: 'source' });
  });
  test('categories win over the legacy productType', () => {
    expect(resolveProductType({ id: 'A' }, index))
      .toEqual({ productType: 'Countertop Blender', source: 'category' });
  });
  test('variant uses the parent categories (item_group_id or parentSku)', () => {
    const expected = { productType: 'Countertop Blender', source: 'category' };
    expect(resolveProductType({ id: 'V', item_group_id: 'P' }, index)).toEqual(expected);
    expect(resolveProductType({ id: 'V' }, index)).toEqual(expected);
  });
  test('falls back to the legacy productType (own, then parent)', () => {
    expect(resolveProductType({ id: 'L' }, index)).toEqual({ productType: 'Cookbook', source: 'legacy' });
    expect(resolveProductType({ id: 'LV', item_group_id: 'LP' }, index))
      .toEqual({ productType: 'Countertop Blender', source: 'legacy' });
  });
  test('none when nothing is known', () => {
    expect(resolveProductType({ id: 'nope' }, index)).toEqual({ source: 'none' });
  });
});
