// Bundles src/index.js (which wraps src/main.js with ManagedExtension from
// the airdcpp-extension package) and all its npm dependencies into a single,
// fully self-contained dist/main.js. AirDC++ only ever copies that one file
// (plus package.json/README.md) into its extensions folder -- there is no
// node_modules folder alongside it at runtime, so anything not bundled in
// here would fail to load.
//
// The entry point is index.js, NOT main.js -- main.js only exports the raw
// extension logic as `function(socket, extension) {...}`; something has to
// actually open the connection to AirDC++ and call that function once
// connected. That's what ManagedExtension (bundled from the airdcpp-extension
// package) does. Without this wrapper the process has no way to talk to
// AirDC++ and exits immediately on start.
const path = require('path');

module.exports = {
  mode: 'production',
  target: 'node',
  entry: './src/index.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'main.js',
    libraryTarget: 'commonjs2',
  },
  externalsPresets: { node: true },
};
