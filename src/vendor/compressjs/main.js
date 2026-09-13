module.exports = (function(freeze, BitStream, Stream, BWT, Context1Model, DefSumModel, FenwickModel, MTFModel, NoModel, Huffman, RangeCoder, BWTC, Bzip2, Dmc, Lzjb, LzjbR, Lzp3, PPM, Simple) {
    'use strict';
    return freeze({
        version: "0.0.1",
        // APIs
        BitStream: BitStream,
        Stream: Stream,
        // transforms
        BWT: BWT,
        // models and coder
        Context1Model: Context1Model,
        DefSumModel: DefSumModel,
        FenwickModel: FenwickModel,
        MTFModel: MTFModel,
        NoModel: NoModel,
        Huffman: Huffman,
        RangeCoder: RangeCoder,
        // compression methods
        BWTC: BWTC,
        Bzip2: Bzip2,
        Dmc: Dmc,
        Lzjb: Lzjb,
        LzjbR: LzjbR,
        Lzp3: Lzp3,
        PPM: PPM,
        Simple: Simple
    });
})(require('./lib/freeze'), require('./lib/BitStream'), require('./lib/Stream'), require('./lib/BWT'), require('./lib/Context1Model'), require('./lib/DefSumModel'), require('./lib/FenwickModel'), require('./lib/MTFModel'), require('./lib/NoModel'), require('./lib/Huffman'), require('./lib/RangeCoder'), require('./lib/BWTC'), require('./lib/Bzip2'), require('./lib/Dmc'), require('./lib/Lzjb'), require('./lib/LzjbR'), require('./lib/Lzp3'), require('./lib/PPM'), require('./lib/Simple'));
