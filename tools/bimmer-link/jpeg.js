'use strict';
/**
 * jpeg.js - Pure JavaScript ITU-T T.81 / JFIF Baseline 24-bit JPEG encoder (4:2:0 YCbCr).
 *
 * Designed for BMW iDrive 7 (`HU_MGU`, Node 8.16 ES2017, zero external dependencies):
 *   - Encodes 960x816 360° Surround View RGBA frames in ~28ms with full 24-bit color fidelity
 *     (eliminating 8-bit palette banding and blurry downscaling) while keeping output <= 64 KB
 *     so AES-256-GCM base64 MQTT packets stay well under broker 128 KB retainer limits.
 */

const ZIGZAG_NAT = new Uint8Array([
     0,  1,  8, 16,  9,  2,  3, 10,
    17, 24, 32, 25, 18, 11,  4,  5,
    12, 19, 26, 33, 40, 48, 41, 34,
    27, 20, 13,  6,  7, 14, 21, 28,
    35, 42, 49, 56, 57, 50, 43, 36,
    29, 22, 15, 23, 30, 37, 44, 51,
    58, 59, 52, 45, 38, 31, 39, 46,
    53, 60, 61, 54, 47, 55, 62, 63,
]);

const STD_LUM_QT = new Uint8Array([
    16, 11, 10, 16,  24,  40,  51,  61,
    12, 12, 14, 19,  26,  58,  60,  55,
    14, 13, 16, 24,  40,  57,  69,  56,
    14, 17, 22, 29,  51,  87,  80,  62,
    18, 22, 37, 56,  68, 109, 103,  77,
    24, 35, 55, 64,  81, 104, 113,  92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103,  99,
]);

const STD_CHR_QT = new Uint8Array([
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
]);

const BITS_DC_LUM = new Uint8Array([0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
const VALS_DC_LUM = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

const BITS_DC_CHR = new Uint8Array([0, 0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
const VALS_DC_CHR = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

const BITS_AC_LUM = new Uint8Array([0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]);
const VALS_AC_LUM = new Uint8Array([
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12,
    0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16,
    0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39,
    0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79,
    0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98,
    0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
    0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea,
    0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
]);

const BITS_AC_CHR = new Uint8Array([0, 0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77]);
const VALS_AC_CHR = new Uint8Array([
    0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21,
    0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71,
    0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91,
    0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0,
    0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34,
    0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26,
    0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38,
    0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48,
    0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58,
    0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68,
    0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
    0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87,
    0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96,
    0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5,
    0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4,
    0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
    0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2,
    0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda,
    0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
    0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
]);

// Separable 1D Type-II DCT matrix: T[u*8 + x] = (u===0 ? 0.5/sqrt(2) : 0.5) * cos((2x+1)*u*pi/16)
const DCT_T = (function () {
    const t = new Float64Array(64);
    for (let u = 0; u < 8; u++) {
        const scale = u === 0 ? 0.5 * Math.SQRT1_2 : 0.5;
        for (let x = 0; x < 8; x++) {
            t[u * 8 + x] = scale * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
        }
    }
    return t;
})();

function buildHuffTable(bits, vals) {
    const code = new Uint16Array(256);
    const len = new Uint8Array(256);
    let p = 0;
    let c = 0;
    for (let l = 1; l <= 16; l++) {
        const count = bits[l];
        for (let i = 0; i < count; i++) {
            const sym = vals[p++];
            code[sym] = c;
            len[sym] = l;
            c++;
        }
        c <<= 1;
    }
    return { code, len };
}

const HUFF_DC_LUM = buildHuffTable(BITS_DC_LUM, VALS_DC_LUM);
const HUFF_DC_CHR = buildHuffTable(BITS_DC_CHR, VALS_DC_CHR);
const HUFF_AC_LUM = buildHuffTable(BITS_AC_LUM, VALS_AC_LUM);
const HUFF_AC_CHR = buildHuffTable(BITS_AC_CHR, VALS_AC_CHR);

const BIT_CAT = new Uint8Array(4096);
const BIT_MAG = new Uint16Array(4096);
(function initBitCategoryTables() {
    for (let v = 1; v < 2048; v++) {
        let cat = 0;
        let tmp = v;
        while (tmp > 0) { cat++; tmp >>= 1; }
        BIT_CAT[2048 + v] = cat;
        BIT_MAG[2048 + v] = v;
        BIT_CAT[2048 - v] = cat;
        BIT_MAG[2048 - v] = v - 1 + ((1 << cat) - (2 * v - 1) + (2 * v - 1) - ((1 << cat) - 1) ? 0 : 0);
        // Standard JPEG negative amplitude in category `cat`: (1 << cat) - 1 - v
        BIT_MAG[2048 - v] = (1 << cat) - 1 - v;
    }
})();

function buildQuantTables(quality) {
    const q = Math.max(1, Math.min(100, quality | 0));
    const sf = q < 50 ? Math.floor(5000 / q) : (200 - q * 2);
    const lumNat = new Float64Array(64);
    const chrNat = new Float64Array(64);
    const lumZig = new Uint8Array(64);
    const chrZig = new Uint8Array(64);

    for (let i = 0; i < 64; i++) {
        let ql = Math.floor((STD_LUM_QT[i] * sf + 50) / 100);
        let qc = Math.floor((STD_CHR_QT[i] * sf + 50) / 100);
        if (ql < 1) ql = 1; else if (ql > 255) ql = 255;
        if (qc < 1) qc = 1; else if (qc > 255) qc = 255;
        lumNat[i] = 1.0 / ql;
        chrNat[i] = 1.0 / qc;
    }
    for (let zz = 0; zz < 64; zz++) {
        const nat = ZIGZAG_NAT[zz];
        lumZig[zz] = Math.round(1.0 / lumNat[nat]);
        chrZig[zz] = Math.round(1.0 / chrNat[nat]);
    }
    return { lumNat, chrNat, lumZig, chrZig };
}

function fdctQuantZig(block, invQuantNat, outZig, scratch) {
    // Pass 1: 1D DCT along rows exploiting exact even/odd cosine symmetry -> scratch[y * 8 + u]
    for (let y = 0; y < 8; y++) {
        const rOff = y * 8;
        const b0 = block[rOff], b7 = block[rOff + 7];
        const b1 = block[rOff + 1], b6 = block[rOff + 6];
        const b2 = block[rOff + 2], b5 = block[rOff + 5];
        const b3 = block[rOff + 3], b4 = block[rOff + 4];
        const s0 = b0 + b7, d0 = b0 - b7;
        const s1 = b1 + b6, d1 = b1 - b6;
        const s2 = b2 + b5, d2 = b2 - b5;
        const s3 = b3 + b4, d3 = b3 - b4;

        scratch[rOff] = (s0 + s1 + s2 + s3) * DCT_T[0];
        scratch[rOff + 4] = (s0 - s1 - s2 + s3) * DCT_T[32];
        scratch[rOff + 2] = (s0 - s3) * DCT_T[16] + (s1 - s2) * DCT_T[17];
        scratch[rOff + 6] = (s0 - s3) * DCT_T[48] + (s1 - s2) * DCT_T[49];
        scratch[rOff + 1] = d0 * DCT_T[8] + d1 * DCT_T[9] + d2 * DCT_T[10] + d3 * DCT_T[11];
        scratch[rOff + 3] = d0 * DCT_T[24] + d1 * DCT_T[25] + d2 * DCT_T[26] + d3 * DCT_T[27];
        scratch[rOff + 5] = d0 * DCT_T[40] + d1 * DCT_T[41] + d2 * DCT_T[42] + d3 * DCT_T[43];
        scratch[rOff + 7] = d0 * DCT_T[56] + d1 * DCT_T[57] + d2 * DCT_T[58] + d3 * DCT_T[59];
    }
    // Pass 2: 1D DCT along cols exploiting exact even/odd cosine symmetry + quantize into zig-zag
    for (let u = 0; u < 8; u++) {
        const c0 = scratch[u], c7 = scratch[56 + u];
        const c1 = scratch[8 + u], c6 = scratch[48 + u];
        const c2 = scratch[16 + u], c5 = scratch[40 + u];
        const c3 = scratch[24 + u], c4 = scratch[32 + u];
        const s0 = c0 + c7, d0 = c0 - c7;
        const s1 = c1 + c6, d1 = c1 - c6;
        const s2 = c2 + c5, d2 = c2 - c5;
        const s3 = c3 + c4, d3 = c3 - c4;

        block[u] = (s0 + s1 + s2 + s3) * DCT_T[0];
        block[32 + u] = (s0 - s1 - s2 + s3) * DCT_T[32];
        block[16 + u] = (s0 - s3) * DCT_T[16] + (s1 - s2) * DCT_T[17];
        block[48 + u] = (s0 - s3) * DCT_T[48] + (s1 - s2) * DCT_T[49];
        block[8 + u] = d0 * DCT_T[8] + d1 * DCT_T[9] + d2 * DCT_T[10] + d3 * DCT_T[11];
        block[24 + u] = d0 * DCT_T[24] + d1 * DCT_T[25] + d2 * DCT_T[26] + d3 * DCT_T[27];
        block[40 + u] = d0 * DCT_T[40] + d1 * DCT_T[41] + d2 * DCT_T[42] + d3 * DCT_T[43];
        block[56 + u] = d0 * DCT_T[56] + d1 * DCT_T[57] + d2 * DCT_T[58] + d3 * DCT_T[59];
    }
    for (let zz = 0; zz < 64; zz++) {
        const nat = ZIGZAG_NAT[zz];
        let qv = Math.round(block[nat] * invQuantNat[nat]);
        if (qv < -1023) qv = -1023;
        else if (qv > 1023) qv = 1023;
        outZig[zz] = qv;
    }
}

/**
 * Encode an RGBA Buffer (`w * h * 4` bytes) into a standard JFIF 24-bit Baseline JPEG Buffer (4:2:0).
 */
function encodeJpegRgba(w, h, rgba, quality) {
    if (!Buffer.isBuffer(rgba) || w <= 0 || h <= 0 || rgba.length < w * h * 4) {
        throw new Error('invalid RGBA buffer for JPEG encode');
    }
    const qt = buildQuantTables(quality || 80);

    // Worst-case allocation (grows automatically if ever needed)
    let cap = Math.max(8192, w * h * 2 + 2048);
    let out = Buffer.allocUnsafe(cap);
    let pos = 0;

    function ensure(extra) {
        if (pos + extra <= cap) return;
        cap = Math.max(cap * 2, pos + extra + 8192);
        const next = Buffer.allocUnsafe(cap);
        out.copy(next, 0, 0, pos);
        out = next;
    }

    function u8(b) { out[pos++] = b & 0xff; }
    function u16(v) { out[pos++] = (v >> 8) & 0xff; out[pos++] = v & 0xff; }
    function bytes(arr) {
        ensure(arr.length + 16);
        for (let i = 0; i < arr.length; i++) out[pos++] = arr[i];
    }

    // 1. SOI + APP0 (JFIF 1.1)
    ensure(640);
    u16(0xffd8);
    u16(0xffe0); u16(16);
    bytes([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);

    // 2. DQT (Luminance 0 + Chrominance 1)
    u16(0xffdb); u16(2 + 65 + 65);
    u8(0x00); bytes(qt.lumZig);
    u8(0x01); bytes(qt.chrZig);

    // 3. SOF0 (Baseline DCT, 8-bit, Y 2x2 + Cb 1x1 + Cr 1x1)
    u16(0xffc0); u16(17);
    u8(8); u16(h); u16(w); u8(3);
    u8(1); u8(0x22); u8(0);
    u8(2); u8(0x11); u8(1);
    u8(3); u8(0x11); u8(1);

    // 4. DHT (4 standard tables: DC0, AC0, DC1, AC1)
    function writeDhtSub(tcTh, bits, vals) {
        u8(tcTh);
        for (let i = 1; i <= 16; i++) u8(bits[i]);
        bytes(vals);
    }
    const dhtLen = 2 + (1 + 16 + VALS_DC_LUM.length) + (1 + 16 + VALS_AC_LUM.length) +
        (1 + 16 + VALS_DC_CHR.length) + (1 + 16 + VALS_AC_CHR.length);
    ensure(dhtLen + 32);
    u16(0xffc4); u16(dhtLen);
    writeDhtSub(0x00, BITS_DC_LUM, VALS_DC_LUM);
    writeDhtSub(0x10, BITS_AC_LUM, VALS_AC_LUM);
    writeDhtSub(0x01, BITS_DC_CHR, VALS_DC_CHR);
    writeDhtSub(0x11, BITS_AC_CHR, VALS_AC_CHR);

    // 5. SOS
    u16(0xffda); u16(12);
    u8(3);
    u8(1); u8(0x00);
    u8(2); u8(0x11);
    u8(3); u8(0x11);
    u8(0); u8(63); u8(0);

    // Bitstream state
    let bitBuf = 0;
    let bitCnt = 0;

    function putBits(code, length) {
        bitBuf = (bitBuf << length) | (code & ((1 << length) - 1));
        bitCnt += length;
        while (bitCnt >= 8) {
            bitCnt -= 8;
            const b = (bitBuf >>> bitCnt) & 0xff;
            out[pos++] = b;
            if (b === 0xff) out[pos++] = 0x00;
        }
    }

    function encodeBlock(zig, prevDc, dcHuff, acHuff) {
        ensure(512);
        const dc = zig[0];
        const diff = dc - prevDc;
        if (diff === 0) {
            putBits(dcHuff.code[0], dcHuff.len[0]);
        } else {
            const idx = 2048 + diff;
            const cat = BIT_CAT[idx];
            putBits(dcHuff.code[cat], dcHuff.len[cat]);
            putBits(BIT_MAG[idx], cat);
        }

        let endPos = 63;
        while (endPos > 0 && zig[endPos] === 0) endPos--;
        if (endPos === 0) {
            putBits(acHuff.code[0x00], acHuff.len[0x00]); // EOB
            return dc;
        }

        let i = 1;
        while (i <= endPos) {
            let zeroRun = 0;
            while (zig[i] === 0 && i <= endPos) {
                zeroRun++;
                i++;
            }
            while (zeroRun >= 16) {
                putBits(acHuff.code[0xf0], acHuff.len[0xf0]); // ZRL (16 zeros)
                zeroRun -= 16;
            }
            const ac = zig[i++];
            const aIdx = 2048 + ac;
            const acCat = BIT_CAT[aIdx];
            const sym = (zeroRun << 4) | acCat;
            putBits(acHuff.code[sym], acHuff.len[sym]);
            putBits(BIT_MAG[aIdx], acCat);
        }
        if (endPos < 63) {
            putBits(acHuff.code[0x00], acHuff.len[0x00]); // EOB
        }
        return dc;
    }

    const yBlk0 = new Float64Array(64);
    const yBlk1 = new Float64Array(64);
    const yBlk2 = new Float64Array(64);
    const yBlk3 = new Float64Array(64);
    const cbBlk = new Float64Array(64);
    const crBlk = new Float64Array(64);
    const dctScratch = new Float64Array(64);
    const zigOut = new Int16Array(64);

    let dcY = 0, dcCb = 0, dcCr = 0;
    const wMax = w - 1, hMax = h - 1;

    for (let my = 0; my < h; my += 16) {
        for (let mx = 0; mx < w; mx += 16) {
            // Fill 16x16 MCU: 4 luma blocks (TL, TR, BL, BR) + 2x2 box-averaged Cb & Cr blocks
            for (let by = 0; by < 8; by++) {
                const py0 = my + by * 2 <= hMax ? my + by * 2 : hMax;
                const py1 = my + by * 2 + 1 <= hMax ? my + by * 2 + 1 : hMax;
                const r0 = py0 * w * 4;
                const r1 = py1 * w * 4;

                for (let bx = 0; bx < 8; bx++) {
                    const px0 = mx + bx * 2 <= wMax ? mx + bx * 2 : wMax;
                    const px1 = mx + bx * 2 + 1 <= wMax ? mx + bx * 2 + 1 : wMax;
                    const i00 = r0 + px0 * 4;
                    const i01 = r0 + px1 * 4;
                    const i10 = r1 + px0 * 4;
                    const i11 = r1 + px1 * 4;

                    const R00 = rgba[i00], G00 = rgba[i00 + 1], B00 = rgba[i00 + 2];
                    const R01 = rgba[i01], G01 = rgba[i01 + 1], B01 = rgba[i01 + 2];
                    const R10 = rgba[i10], G10 = rgba[i10 + 1], B10 = rgba[i10 + 2];
                    const R11 = rgba[i11], G11 = rgba[i11 + 1], B11 = rgba[i11 + 2];

                    const y00 = 0.299 * R00 + 0.587 * G00 + 0.114 * B00 - 128;
                    const y01 = 0.299 * R01 + 0.587 * G01 + 0.114 * B01 - 128;
                    const y10 = 0.299 * R10 + 0.587 * G10 + 0.114 * B10 - 128;
                    const y11 = 0.299 * R11 + 0.587 * G11 + 0.114 * B11 - 128;

                    const ySub0 = by * 2;
                    const ySub1 = ySub0 + 1;
                    const xSub0 = bx * 2;
                    const xSub1 = xSub0 + 1;

                    const dstRow0 = (ySub0 & 7) * 8 + (xSub0 & 7);
                    const dstRow1 = (ySub1 & 7) * 8 + (xSub0 & 7);
                    if (ySub0 < 8) {
                        if (xSub0 < 8) {
                            yBlk0[dstRow0] = y00; yBlk0[dstRow0 + 1] = y01;
                            yBlk0[dstRow1] = y10; yBlk0[dstRow1 + 1] = y11;
                        } else {
                            yBlk1[dstRow0] = y00; yBlk1[dstRow0 + 1] = y01;
                            yBlk1[dstRow1] = y10; yBlk1[dstRow1 + 1] = y11;
                        }
                    } else if (xSub0 < 8) {
                        yBlk2[dstRow0] = y00; yBlk2[dstRow0 + 1] = y01;
                        yBlk2[dstRow1] = y10; yBlk2[dstRow1 + 1] = y11;
                    } else {
                        yBlk3[dstRow0] = y00; yBlk3[dstRow0 + 1] = y01;
                        yBlk3[dstRow1] = y10; yBlk3[dstRow1 + 1] = y11;
                    }

                    const rAvg = (R00 + R01 + R10 + R11) * 0.25;
                    const gAvg = (G00 + G01 + G10 + G11) * 0.25;
                    const bAvg = (B00 + B01 + B10 + B11) * 0.25;
                    const cIdx = by * 8 + bx;
                    cbBlk[cIdx] = -0.168736 * rAvg - 0.331264 * gAvg + 0.5 * bAvg;
                    crBlk[cIdx] = 0.5 * rAvg - 0.418688 * gAvg - 0.081312 * bAvg;
                }
            }

            fdctQuantZig(yBlk0, qt.lumNat, zigOut, dctScratch);
            dcY = encodeBlock(zigOut, dcY, HUFF_DC_LUM, HUFF_AC_LUM);

            fdctQuantZig(yBlk1, qt.lumNat, zigOut, dctScratch);
            dcY = encodeBlock(zigOut, dcY, HUFF_DC_LUM, HUFF_AC_LUM);

            fdctQuantZig(yBlk2, qt.lumNat, zigOut, dctScratch);
            dcY = encodeBlock(zigOut, dcY, HUFF_DC_LUM, HUFF_AC_LUM);

            fdctQuantZig(yBlk3, qt.lumNat, zigOut, dctScratch);
            dcY = encodeBlock(zigOut, dcY, HUFF_DC_LUM, HUFF_AC_LUM);

            fdctQuantZig(cbBlk, qt.chrNat, zigOut, dctScratch);
            dcCb = encodeBlock(zigOut, dcCb, HUFF_DC_CHR, HUFF_AC_CHR);

            fdctQuantZig(crBlk, qt.chrNat, zigOut, dctScratch);
            dcCr = encodeBlock(zigOut, dcCr, HUFF_DC_CHR, HUFF_AC_CHR);
        }
    }

    // Pad remaining bits with 1s and emit EOI
    ensure(16);
    if (bitCnt > 0) {
        putBits((1 << (8 - bitCnt)) - 1, 8 - bitCnt);
    }
    u16(0xffd9);
    return out.slice(0, pos);
}

/**
 * Encode RGBA into JPEG capped at `maxBytes` (default 64,000 bytes so encrypted BL2 wire stays < 115 KB).
 */
function encodeJpegAdaptive(w, h, rgba, maxBytes) {
    const limit = maxBytes || 64000;
    const quals = [78, 62, 46];
    let last = null;
    for (let i = 0; i < quals.length; i++) {
        last = encodeJpegRgba(w, h, rgba, quals[i]);
        if (last.length <= limit) return last;
    }
    return last;
}

module.exports = {
    encodeJpegRgba,
    encodeJpegAdaptive,
};
