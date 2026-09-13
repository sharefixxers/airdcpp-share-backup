module.exports = (function() {
  'use strict';

  // Object.freeze(), or a thunk if that method is not present in this
  // JavaScript environment.

  if (Object.freeze) {
    return Object.freeze;
  } else {
    return function(o) { return o; };
  }

})();
