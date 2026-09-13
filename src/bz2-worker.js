'use strict';

const { parentPort, workerData } = require('worker_threads');
const compressjs = require('./vendor/compressjs/main.js');

function verify(input, compressed) {
  try {
    const roundTrip = Buffer.from(compressjs.Bzip2.decompressFile(compressed));
    if (roundTrip.length !== input.length || !roundTrip.equals(input)) {
      return 'decompressed output does not match the original data';
    }
    return null;
  } catch (e) {
    return e && e.message ? e.message : String(e);
  }
}

try {
  const input = Buffer.from(workerData.buffer);
  const blockSizeMultiplier = workerData.blockSizeMultiplier || 9;
  const compressed = Buffer.from(compressjs.Bzip2.compressFile(input, undefined, blockSizeMultiplier));

  const verifyError = verify(input, compressed);
  if (verifyError) {
    parentPort.postMessage({ ok: false, verifyFailed: true, error: verifyError });
  } else {

    const ab = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);
    parentPort.postMessage({ ok: true, buffer: ab }, [ab]);
  }
} catch (e) {
  parentPort.postMessage({ ok: false, error: e && e.message ? e.message : String(e) });
}
