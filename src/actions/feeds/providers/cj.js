/**
 * Commission Junction (CJ Affiliate) product feed.
 *
 * CJ's Shopping feed follows the Google Shopping spec, so the `g:` RSS format is
 * accepted directly. Point CJ's HTTP data-import at this endpoint to replace the
 * current SFTP drop. `gtin` (required by CJ for branded goods) now flows from
 * the GMC feed.
 *
 * Future option: CSV output and/or push via CJ's GraphQL Product Import API.
 */
export default {
  contentType: 'application/xml',
  /**
   * @param {Record<string, unknown>} item
   * @returns {Record<string, unknown>}
   */
  transformItem: (item) => item,
};
