/**
 * Derive the customer-facing order status from EBS line items.
 *
 * This intentionally mirrors Magento's Vitamix_OrderStatus helper:
 * warranty/service lines (UnitOfMeasure != Each) are excluded, cancelled
 * lines are removed from the active-item denominator, and the final status
 * is selected in shipped -> processed -> received order.
 *
 * @param {object[]} lineItems - Transformed EBS line items
 * @returns {string} Status key for the storefront
 */
export function deriveOrderStatus(lineItems) {
  const items = (Array.isArray(lineItems) ? lineItems : []).filter(
    (item) => item?.unitOfMeasure === 'Each',
  );

  let received = 0;
  let processed = 0;
  let cancelled = 0;
  let shipped = 0;

  items.forEach((item) => {
    const status = String(item?.status ?? '').toUpperCase();
    const quantity = item?.quantity;

    if (status === 'ENTERED') {
      received += 1;
    } else if (['BOOKED', 'AWAITINGSHIPPING', 'PICKED'].includes(status)) {
      processed += 1;
    } else if (status === 'CLOSED') {
      if (quantity != null && Number(quantity) === 0) {
        cancelled += 1;
      } else {
        shipped += 1;
      }
    } else if (status === 'SHIPPED') {
      shipped += 1;
    }
  });

  const activeItemCount = items.length - cancelled;

  if (cancelled > 0 && cancelled === items.length) return 'cancelled';
  if (shipped === activeItemCount) return 'shipped';
  if (shipped > 0) return 'partiallyShipped';
  if (processed === activeItemCount) return 'processed';
  if (processed + received === activeItemCount) return 'received';
  return 'unavailable';
}
