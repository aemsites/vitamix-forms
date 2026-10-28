import { describe, test, expect } from '@jest/globals';
import {
  categoryToProductType, resolveProductType, unknownCategories,
} from '../../src/actions/feeds/product-type.js';

describe('categoryToProductType', () => {
  test.each([
    ['All Blenders,Full Size Blenders', 'Countertop Blender'],
    ['Shop,Legacy Series Blenders', 'Countertop Blender'],
    ['All Blenders,Immersion Blender', 'Immersion Blender'],
    ['All Blenders,Personal Blending', 'Personal Blender'],
    // specific accessory types win over the broader groupings
    ['Accessories,Blender Containers,Personal Blending', 'Blender Container'],
    ['Accessories,Blender Containers,Smoothie Cups', 'Smoothie Cup'],
    ['Accessories,Blender Containers,Food Processing', 'Food Processing'],
    ['Shop,Compact Food Recycling,Kitchen Tools', 'Compact Food Recycling'],
    ['Juicing', 'Kitchen Tool'],
    // whitespace / case tolerant
    [' full size blenders ', 'Countertop Blender'],
  ])('%s -> %s', (cats, type) => {
    expect(categoryToProductType(cats)).toBe(type);
  });

  test('generic / promo categories map to nothing', () => {
    expect(categoryToProductType('Shop,Accessories')).toBeUndefined();
    expect(categoryToProductType('All Blenders,Eligible Employee Discount')).toBeUndefined();
    expect(categoryToProductType('')).toBeUndefined();
    expect(categoryToProductType(undefined)).toBeUndefined();
  });

  test('unknownCategories reports only unmapped, non-ignored categories', () => {
    expect(unknownCategories('Shop,Accessories,Frozen Desserts')).toEqual(['frozen desserts']);
  });
});

describe('resolveProductType', () => {
  const index = new Map([
    ['A', { sku: 'A', productType: 'Tamper', categories: 'All Blenders,Full Size Blenders' }],
    ['P', { sku: 'P', productType: 'Countertop Blender' }],
    ['V', { sku: 'V', parentSku: 'P' }],
    ['Q', { sku: 'Q', categories: 'All Blenders,Full Size Blenders' }],
    ['W', { sku: 'W', parentSku: 'Q' }],
  ]);

  test('source value wins', () => {
    expect(resolveProductType({ id: 'A', product_type: 'X' }, index)).toBe('X');
  });
  test('index productType wins over categories', () => {
    expect(resolveProductType({ id: 'A' }, index)).toBe('Tamper');
  });
  test('variant inherits the parent productType (item_group_id or parentSku)', () => {
    expect(resolveProductType({ id: 'V', item_group_id: 'P' }, index)).toBe('Countertop Blender');
    expect(resolveProductType({ id: 'V' }, index)).toBe('Countertop Blender');
  });
  test('falls back to the parent categories', () => {
    expect(resolveProductType({ id: 'W', item_group_id: 'Q' }, index)).toBe('Countertop Blender');
  });
  test('undefined when nothing is known', () => {
    expect(resolveProductType({ id: 'nope' }, index)).toBeUndefined();
  });
});
