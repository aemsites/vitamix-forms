import { deriveOrderStatus } from '../src/order-status.js';

describe('deriveOrderStatus', () => {
  test('ignores non-Each service lines', () => {
    expect(deriveOrderStatus([
      { unitOfMeasure: 'Years', status: 'Entered', quantity: '1' },
    ])).toBe('shipped');
  });

  test.each([
    ['Entered', 'received'],
    ['Booked', 'processed'],
    ['AwaitingShipping', 'processed'],
    ['Picked', 'processed'],
    ['Shipped', 'shipped'],
    ['Closed', 'shipped'],
  ])('maps %s to %s', (status, expected) => {
    expect(deriveOrderStatus([
      { unitOfMeasure: 'Each', status, quantity: '1' },
    ])).toBe(expected);
  });

  test('treats Closed quantity zero as cancelled', () => {
    expect(deriveOrderStatus([
      { unitOfMeasure: 'Each', status: 'Closed', quantity: '0' },
    ])).toBe('cancelled');
  });

  test('evaluates remaining items after cancelled items are excluded', () => {
    expect(deriveOrderStatus([
      { unitOfMeasure: 'Each', status: 'Closed', quantity: '0' },
      { unitOfMeasure: 'Each', status: 'Booked', quantity: '1' },
    ])).toBe('processed');
  });

  test('returns partiallyShipped when some active items shipped', () => {
    expect(deriveOrderStatus([
      { unitOfMeasure: 'Each', status: 'Shipped', quantity: '1' },
      { unitOfMeasure: 'Each', status: 'Booked', quantity: '1' },
    ])).toBe('partiallyShipped');
  });
});
