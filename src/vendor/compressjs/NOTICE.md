This folder contains a vendored, modified copy of the `compressjs` npm
package (https://www.npmjs.com/package/compressjs), used here for its pure-
JavaScript bzip2 encoder (no native/compiled dependency available in this
environment).

Original work Copyright (C) 2013 C. Scott Ananian and contributors
(see individual file headers), licensed under the GNU Lesser General Public
License v2.1 or later (LGPL-2.1+).

Modification made here: every file's AMD module wrapper
(`if (typeof define !== 'function') { var define = require('amdefine')(module); } define([...], function(...) {...});`)
was mechanically rewritten to plain CommonJS
(`module.exports = (function(...) {...})(require(...), ...);`), with the
implementation code itself left untouched. This was necessary because the
AMD wrapper (via the `amdefine` package) does not bundle correctly with
webpack, which this extension needs since AirDC++ only loads a single,
fully self-contained dist/main.js file.
