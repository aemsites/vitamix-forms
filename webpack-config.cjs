/**
 * Extra webpack config merged by `aio app build` into every action bundle.
 *
 * ssh2 (used by feeds-push for SFTP) optionally loads two native add-ons inside
 * try/catch: `cpu-features` and its own `sshcrypto.node`. Webpack can't bundle
 * `.node` binaries, so ignore both; ssh2 then falls back to its pure-JS crypto,
 * which is fine for our small, infrequent uploads.
 */
const webpack = require('webpack');

module.exports = {
  plugins: [
    new webpack.IgnorePlugin({ resourceRegExp: /^cpu-features$|sshcrypto\.node$/ }),
  ],
};
