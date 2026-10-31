# inventory-sync

Applies sold units queued by `ebs-sync` to the managed inventory sheet and marks sold-out
managed products `OutOfStock`. Prod only (`INVENTORY_SYNC_ENABLED=true`). See the header of
`sync.js` for the run steps, and `index.js` for the status / manual-run endpoints.

## Notes for authors editing the inventory sheet

Sheet: `/us/en_us/products/config/inventory.json` (DA).

- inventory-sync writes **only** `Qty` and `Availability`, and only on rows with
  `Managed Stock = Yes` and a numeric `Qty`. It runs every 5 minutes.
- Its writes are conditional (`If-Match`): if you save the sheet while it is working, it
  re-reads your version and applies its decrement on top. Your edit is kept.
- **The other direction is not protected.** DA's sheet editor saves its whole in-memory copy
  without a precondition. If the sheet has been **open in the editor since before** an
  inventory-sync write and you then edit anything, your save replaces the sheet with your
  copy, and the sold units applied in between are lost (they are not re-applied).
  - Before changing `Qty`/`Availability`, **reload the sheet** (or close and reopen it), make
    the change, and close it when done. Don't leave the sheet open in a tab.
- Restock: set `Qty > 0` and `Availability = InStock`, preview, then run "Update managed
  inventory" in product-admin.
