import { describe, test, expect } from '@jest/globals';
import {
  selectRow, applyDeltas, mergeDeltas, soldOutRows, getRows, localesForMarket,
} from '../../src/actions/inventory-sync/sheet.js';

const row = (SKU, Qty, extra = {}) => ({
  SKU, Title: `T ${SKU}`, Variant: 'Black', Availability: 'InStock', 'Managed Stock': 'Yes', Qty, Market: '', ...extra,
});

const delta = (sku, market, units, orderIds = ['o1']) => ({
  sku, market, units, orderIds, seqs: [1],
});

describe('selectRow', () => {
  const rows = [
    row('A', '5', { Market: 'US' }),
    row('A', '9', { Market: '' }),
    row(' b ', '3', { Market: ' ca ' }),
  ];

  test('prefers the row whose Market equals the order market', () => {
    expect(selectRow(rows, 'a', 'us')).toBe(rows[0]);
  });

  test('falls back to the blank-market row', () => {
    expect(selectRow(rows, 'A', 'ca')).toBe(rows[1]);
    expect(selectRow(rows, 'A', '')).toBe(rows[1]);
  });

  test('exact SKU match only (trim + uppercase), no other-market fallback', () => {
    expect(selectRow(rows, 'B', 'ca')).toBe(rows[2]);
    expect(selectRow(rows, 'B', 'us')).toBeNull();
    // no leading-zero / -NN normalization
    expect(selectRow([row('073492-04', '1')], '73492', '')).toBeNull();
    expect(selectRow([row('073492-04', '1')], '073492', '')).toBeNull();
  });
});

describe('applyDeltas', () => {
  test('decrements Qty and keeps InStock while stock remains', () => {
    const sheet = { data: [row('A', '5')] };
    const res = applyDeltas(sheet, [delta('A', 'us', 2)]);
    expect(sheet.data[0].Qty).toBe('3');
    expect(sheet.data[0].Availability).toBe('InStock');
    expect(res.changes).toHaveLength(1);
    expect(res.oversold).toEqual([]);
    expect(res.outOfStock).toEqual([]);
  });

  test('selling the last unit sets OutOfStock and emits an out-of-stock event', () => {
    const sheet = { data: [row('A', '2', { Market: 'CA' })] };
    const res = applyDeltas(sheet, [delta('A', 'ca', 2, ['o1', 'o2'])]);
    expect(sheet.data[0].Qty).toBe('0');
    expect(sheet.data[0].Availability).toBe('OutOfStock');
    expect(res.outOfStock).toEqual([{
      action: 'inventory-out-of-stock', sku: 'A', market: 'ca', orderIds: ['o1', 'o2'],
    }]);
    expect(res.oversold).toEqual([]);
  });

  test('oversell: Qty floors at 0, emits oversold + out-of-stock', () => {
    const sheet = { data: [row('A', '1')] };
    const res = applyDeltas(sheet, [delta('A', 'us', 3)]);
    expect(sheet.data[0].Qty).toBe('0');
    expect(sheet.data[0].Availability).toBe('OutOfStock');
    expect(res.oversold).toEqual([{
      action: 'inventory-oversold', sku: 'A', market: 'us', available: 1, sold: 3, oversold: 2, orderIds: ['o1'],
    }]);
    expect(res.outOfStock).toHaveLength(1);
  });

  test('row already at 0: oversold event, no sheet change, no out-of-stock event', () => {
    const sheet = { data: [row('A', '0', { Availability: 'OutOfStock' })] };
    const res = applyDeltas(sheet, [delta('A', 'us', 1)]);
    expect(sheet.data[0].Qty).toBe('0');
    expect(res.changes).toEqual([]);
    expect(res.oversold[0]).toMatchObject({ available: 0, sold: 1, oversold: 1 });
    expect(res.outOfStock).toEqual([]);
  });

  test('does not rewrite an Availability cell that is already OutOfStock (whitespace kept)', () => {
    const sheet = { data: [row('A', '1', { Availability: 'OutOfStock ' })] };
    applyDeltas(sheet, [delta('A', 'us', 1)]);
    expect(sheet.data[0].Availability).toBe('OutOfStock ');
    expect(sheet.data[0].Qty).toBe('0');
  });

  test('skips unmanaged rows, blank Qty, and unknown SKUs', () => {
    const sheet = {
      data: [
        row('A', '5', { 'Managed Stock': 'No' }),
        row('B', ''),
        row('C', ' '),
      ],
    };
    const before = JSON.stringify(sheet);
    const res = applyDeltas(sheet, [delta('A', 'us', 1), delta('B', 'us', 1), delta('C', 'us', 1), delta('Z', 'us', 1)]);
    expect(JSON.stringify(sheet)).toBe(before);
    expect(res.skipped.map((s) => s.reason)).toEqual(['not-managed', 'no-qty', 'no-qty', 'no-row']);
  });

  test('US and CA sales share a blank-market pool', () => {
    const sheet = { data: [row('A', '3')] };
    applyDeltas(sheet, [delta('A', 'us', 1), delta('A', 'ca', 1)]);
    expect(sheet.data[0].Qty).toBe('1');
  });

  test('Managed Stock column is never changed', () => {
    const sheet = { data: [row('A', '1', { 'Managed Stock': ' yes ' })] };
    applyDeltas(sheet, [delta('A', 'us', 5)]);
    expect(sheet.data[0]['Managed Stock']).toBe(' yes ');
  });

  test('round-trip preserves untouched cells, row order, whitespace and metadata', () => {
    const sheet = {
      total: 4,
      limit: 4,
      offset: 0,
      ':type': 'sheet',
      ':colWidths': [100, 200, 80, 90, 90, 50, 60],
      ':private': { notes: { data: [{ x: '1' }] } },
      data: [
        row('KEEP1', '', { Availability: 'InStock ', 'Managed Stock': 'No' }),
        row('A', '4', { Title: ' Title with spaces ', Variant: '' }),
        row('KEEP2', '7', { Market: 'US', Extra: ' x ' }),
        row('A', '2', { Market: 'CA' }),
      ],
    };
    const original = JSON.parse(JSON.stringify(sheet));
    applyDeltas(sheet, [delta('A', 'us', 1), delta('A', 'ca', 2)]);

    const expected = JSON.parse(JSON.stringify(original));
    expected.data[1].Qty = '3';
    expected.data[3].Qty = '0';
    expected.data[3].Availability = 'OutOfStock';
    expect(sheet).toEqual(expected);
    // key order of every row is unchanged
    sheet.data.forEach((r, i) => expect(Object.keys(r)).toEqual(Object.keys(original.data[i])));
    expect(Object.keys(sheet)).toEqual(Object.keys(original));
  });

  test('multi-sheet JSON: edits the data sheet in place', () => {
    const sheet = {
      ':version': 3,
      ':type': 'multi-sheet',
      ':names': ['data', 'other'],
      data: { total: 1, data: [row('A', '2')] },
      other: { total: 1, data: [{ foo: 'bar' }] },
    };
    applyDeltas(sheet, [delta('A', 'us', 1)]);
    expect(sheet.data.data[0].Qty).toBe('1');
    expect(sheet.other).toEqual({ total: 1, data: [{ foo: 'bar' }] });
    expect(getRows(sheet)).toBe(sheet.data.data);
  });
});

describe('mergeDeltas', () => {
  test('merges by (sku, market) across entries and tracks orderIds + seqs', () => {
    const merged = mergeDeltas([
      { seq: 3, deltas: [{ sku: 'a ', market: 'US', units: 1, orderId: 'o1' }, { sku: 'A', market: 'ca', units: 2, orderId: 'o1' }] },
      { seq: 4, deltas: [{ sku: 'A', market: 'us', units: 2, orderId: 'o2' }, { sku: 'B', market: 'us', units: 0, orderId: 'o2' }] },
    ]);
    expect(merged).toEqual([
      { sku: 'A', market: 'us', units: 3, orderIds: ['o1', 'o2'], seqs: [3, 4] },
      { sku: 'A', market: 'ca', units: 2, orderIds: ['o1'], seqs: [3] },
    ]);
  });
});

describe('soldOutRows', () => {
  test('managed + numeric Qty <= 0 + OutOfStock only', () => {
    const sheet = {
      data: [
        row('A', '0', { Availability: 'OutOfStock' }),
        row('B', '', { Availability: 'OutOfStock' }), // not counted
        row('C', '0', { Availability: 'OutOfStock', 'Managed Stock': 'No' }),
        row('D', '0'), // InStock
        row('E', '-1', { Availability: 'OutOfStock ', Market: 'CA' }),
        row('F', '2', { Availability: 'OutOfStock' }),
      ],
    };
    expect(soldOutRows(sheet)).toEqual([
      { sku: 'A', market: '', locales: ['us/en_us', 'ca/en_us', 'ca/fr_ca'] },
      { sku: 'E', market: 'ca', locales: ['ca/en_us', 'ca/fr_ca'] },
    ]);
  });

  test('blank-market row excludes locales of a market with its own row', () => {
    const sheet = {
      data: [
        row('A', '0', { Availability: 'OutOfStock' }),
        row('A', '5', { Market: 'US' }),
      ],
    };
    expect(soldOutRows(sheet)).toEqual([{ sku: 'A', market: '', locales: ['ca/en_us', 'ca/fr_ca'] }]);
  });

  test('localesForMarket', () => {
    expect(localesForMarket('US')).toEqual(['us/en_us']);
    expect(localesForMarket('ca')).toEqual(['ca/en_us', 'ca/fr_ca']);
    expect(localesForMarket('')).toEqual(['us/en_us', 'ca/en_us', 'ca/fr_ca']);
    expect(localesForMarket('gb')).toEqual([]);
  });
});
