'use strict';
/**
 * snapshot.js - self-contained PNG parking & telemetry card generator + 4-camera 360 frame compositor.
 *
 * Runs inside `/var/opt/bimmer-link/current/` on Node 8 with ZERO external dependencies (only built-in `zlib`, `fs`, `child_process`).
 *
 * Modes:
 *   1. If a 4-camera RGBA frame (`cam4.rgba` or output of optional `mgu-camshot` AVB helper) is available and fresh,
 *      renders a 960x600 2x2 360-degree camera composite (CAM TRUOC / CAM SAU / GUONG TRAI / GUONG PHAI) with a dark
 *      BMW ConnectedDrive HUD status bar underneath.
 *   2. Otherwise renders a crisp 880x500 dark-metallic BMW Telemetry & Parking Snapshot PNG showing status, 1CR state,
 *      coordinates, battery 12V, fuel & range, engine/ambient temperatures, lock/door check, and last trip summary.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const cp = require('child_process');
const Jpeg = require('./jpeg');

/* ---------------- Minimal fast CRC32 & PNG encoder (Node 8 Buffer + zlib) ---------------- */

const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

function encodePngRgba(w, h, rgba) {
    const stride = w * 4 + 1;
    const raw = Buffer.allocUnsafe(stride * h);
    for (let y = 0; y < h; y++) {
        const rowStart = y * stride;
        const srcOff = y * w * 4;
        raw[rowStart] = 1; // PNG Sub filter for ~3x smaller UI card files
        for (let x = 0; x < w * 4; x++) {
            const prev = x >= 4 ? rgba[srcOff + x - 4] : 0;
            raw[rowStart + 1 + x] = (rgba[srcOff + x] - prev) & 255;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/**
 * Encode photographic 360-camera RGBA composites as an 8-bit indexed PNG (6x7x6 RGB cube + 2x2 ordered dither)
 * so real camera snapshots stay ~35-48 KB (~13 chunks = ~1.7s over ntfy.sh) with zero external libraries.
 */
function encodeIndexedPngRgba(w, h, rgba) {
    const plte = Buffer.alloc(256 * 3);
    let pi = 0;
    for (let r = 0; r < 6; r++) {
        for (let g = 0; g < 7; g++) {
            for (let b = 0; b < 6; b++) {
                plte[pi] = Math.round((r * 255) / 5);
                plte[pi + 1] = Math.round((g * 255) / 6);
                plte[pi + 2] = Math.round((b * 255) / 5);
                pi += 3;
            }
        }
    }
    const stride = w + 1;
    const raw = Buffer.allocUnsafe(stride * h);
    const bayer = [-1, 0, 1, 0];
    for (let y = 0; y < h; y++) {
        const rowOff = y * stride;
        raw[rowOff] = 0;
        let si = y * w * 4;
        const by = (y & 1) << 1;
        for (let x = 0; x < w; x++, si += 4) {
            const d = bayer[by | (x & 1)];
            const r = Math.max(0, Math.min(255, rgba[si] + d));
            const g = Math.max(0, Math.min(255, rgba[si + 1] + d));
            const b = Math.max(0, Math.min(255, rgba[si + 2] + d));
            const ri = Math.round((r * 5) / 255);
            const gi = Math.round((g * 6) / 255);
            const bi = Math.round((b * 5) / 255);
            raw[rowOff + 1 + x] = ri * 42 + gi * 6 + bi;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 3; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const idat = zlib.deflateSync(raw, { level: 9 });
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        pngChunk('IHDR', ihdr),
        pngChunk('PLTE', plte),
        pngChunk('IDAT', idat),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/* ---------------- Compact 5x7 crisp pixel font + Vietnamese ASCII folding ---------------- */

const GLYPHS = {
    ' ': [0, 0, 0, 0, 0, 0, 0],
    '0': [14, 17, 19, 21, 25, 17, 14], '1': [4, 12, 4, 4, 4, 4, 14], '2': [14, 17, 1, 6, 8, 16, 31],
    '3': [31, 2, 4, 6, 1, 17, 14], '4': [2, 6, 10, 18, 31, 2, 2], '5': [31, 16, 30, 1, 1, 17, 14],
    '6': [6, 8, 16, 30, 17, 17, 14], '7': [31, 1, 2, 4, 8, 8, 8], '8': [14, 17, 17, 14, 17, 17, 14],
    '9': [14, 17, 17, 15, 1, 2, 12],
    'A': [14, 17, 17, 31, 17, 17, 17], 'B': [30, 17, 17, 30, 17, 17, 30], 'C': [14, 17, 16, 16, 16, 17, 14],
    'D': [28, 18, 17, 17, 17, 18, 28], 'E': [31, 16, 16, 30, 16, 16, 31], 'F': [31, 16, 16, 30, 16, 16, 16],
    'G': [14, 17, 16, 23, 17, 17, 15], 'H': [17, 17, 17, 31, 17, 17, 17], 'I': [14, 4, 4, 4, 4, 4, 14],
    'J': [7, 2, 2, 2, 2, 18, 12], 'K': [17, 18, 20, 24, 20, 18, 17], 'L': [16, 16, 16, 16, 16, 16, 31],
    'M': [17, 27, 21, 21, 17, 17, 17], 'N': [17, 25, 21, 19, 17, 17, 17], 'O': [14, 17, 17, 17, 17, 17, 14],
    'P': [30, 17, 17, 30, 16, 16, 16], 'Q': [14, 17, 17, 17, 21, 18, 13], 'R': [30, 17, 17, 30, 20, 18, 17],
    'S': [15, 16, 16, 14, 1, 1, 30], 'T': [31, 4, 4, 4, 4, 4, 4], 'U': [17, 17, 17, 17, 17, 17, 14],
    'V': [17, 17, 17, 17, 17, 10, 4], 'W': [17, 17, 17, 21, 21, 27, 17], 'X': [17, 17, 10, 4, 10, 17, 17],
    'Y': [17, 17, 10, 4, 4, 4, 4], 'Z': [31, 1, 2, 4, 8, 16, 31],
    '.': [0, 0, 0, 0, 0, 12, 12], ',': [0, 0, 0, 0, 12, 4, 8], ':': [0, 12, 12, 0, 12, 12, 0],
    '-': [0, 0, 0, 31, 0, 0, 0], '+': [0, 4, 4, 31, 4, 4, 0], '/': [1, 2, 2, 4, 8, 8, 16],
    '%': [25, 25, 2, 4, 8, 19, 19], '(': [2, 4, 8, 8, 8, 4, 2], ')': [8, 4, 2, 2, 2, 4, 8],
    '!': [4, 4, 4, 4, 4, 0, 4], '?': [14, 17, 1, 6, 4, 0, 4], '*': [0, 4, 21, 14, 21, 4, 0],
};

function foldAscii(str) {
    return String(str || '')
        .replace(/[àáạảãâầấậẩẫăằắặẳẵ]/g, 'a').replace(/[ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴ]/g, 'A')
        .replace(/[èéẹẻẽêềếệểễ]/g, 'e').replace(/[ÈÉẸẺẼÊỀẾỆỂỄ]/g, 'E')
        .replace(/[ìíịỉĩ]/g, 'i').replace(/[ÌÍỊỈĨ]/g, 'I')
        .replace(/[òóọỏõôồốộổỗơờớợởỡ]/g, 'o').replace(/[ÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠ]/g, 'O')
        .replace(/[ùúụủũưừứựửữ]/g, 'u').replace(/[ÙÚỤỦŨƯỪỨỰỬỮ]/g, 'U')
        .replace(/[ỳýỵỷỹ]/g, 'y').replace(/[ỲÝỴỶỸ]/g, 'Y')
        .replace(/đ/g, 'd').replace(/Đ/g, 'D')
        .replace(/°/g, '*');
}

function parseHex(hex) {
    const s = String(hex || '#000000').replace('#', '');
    return [
        parseInt(s.slice(0, 2), 16) || 0,
        parseInt(s.slice(2, 4), 16) || 0,
        parseInt(s.slice(4, 6), 16) || 0,
        s.length >= 8 ? (parseInt(s.slice(6, 8), 16) || 255) : 255,
    ];
}

class MiniSurface {
    constructor(w, h, bgHex) {
        this.w = w; this.h = h;
        this.buf = Buffer.alloc(w * h * 4);
        this.fillRect(0, 0, w, h, bgHex || '#080b12');
    }

    fillRect(x, y, rw, rh, colorHex) {
        const c = Array.isArray(colorHex) ? colorHex : parseHex(colorHex);
        const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
        const x1 = Math.min(this.w, (x + rw) | 0), y1 = Math.min(this.h, (y + rh) | 0);
        const a = (c[3] === undefined ? 255 : c[3]) / 255;
        for (let py = y0; py < y1; py++) {
            let p = (py * this.w + x0) * 4;
            for (let px = x0; px < x1; px++, p += 4) {
                if (a >= 0.999) {
                    this.buf[p] = c[0]; this.buf[p + 1] = c[1]; this.buf[p + 2] = c[2]; this.buf[p + 3] = 255;
                } else {
                    const ia = 1 - a;
                    this.buf[p] = Math.round(c[0] * a + this.buf[p] * ia);
                    this.buf[p + 1] = Math.round(c[1] * a + this.buf[p + 1] * ia);
                    this.buf[p + 2] = Math.round(c[2] * a + this.buf[p + 2] * ia);
                    this.buf[p + 3] = 255;
                }
            }
        }
    }

    card(x, y, w, h, borderHex, fillHex) {
        this.fillRect(x, y, w, h, fillHex || '#111724');
        const b = borderHex || '#223049';
        this.fillRect(x, y, w, 2, b);
        this.fillRect(x, y + h - 2, w, 2, b);
        this.fillRect(x, y, 2, h, b);
        this.fillRect(x + w - 2, y, 2, h, b);
    }

    text(str, x, y, scale, colorHex, maxChars) {
        const s = foldAscii(str).toUpperCase().slice(0, maxChars || 80);
        const c = parseHex(colorHex || '#ffffff');
        const sc = Math.max(1, scale | 0);
        let cx = x | 0;
        for (let i = 0; i < s.length; i++) {
            const g = GLYPHS[s[i]] || GLYPHS[' '];
            for (let row = 0; row < 7; row++) {
                const bits = g[row];
                for (let col = 0; col < 5; col++) {
                    if ((bits >> (4 - col)) & 1) {
                        this.fillRect(cx + col * sc, y + row * sc, sc, sc, c);
                    }
                }
            }
            cx += 6 * sc;
        }
    }

    blitRgbaScaled(src, sw, sh, dx, dy, dw, dh) {
        if (!src || src.length < sw * sh * 4) return;
        const x0 = Math.max(0, dx | 0), y0 = Math.max(0, dy | 0);
        const x1 = Math.min(this.w, (dx + dw) | 0), y1 = Math.min(this.h, (dy + dh) | 0);
        for (let py = y0; py < y1; py++) {
            const sy = Math.min(sh - 1, Math.floor(((py - dy) * sh) / dh));
            let di = (py * this.w + x0) * 4;
            for (let px = x0; px < x1; px++, di += 4) {
                const sx = Math.min(sw - 1, Math.floor(((px - dx) * sw) / dw));
                const si = (sy * sw + sx) * 4;
                this.buf[di] = src[si];
                this.buf[di + 1] = src[si + 1];
                this.buf[di + 2] = src[si + 2];
                this.buf[di + 3] = 255;
            }
        }
    }

    png() {
        return encodePngRgba(this.w, this.h, this.buf);
    }
}

/* ---------------- Optional 4-camera AVB capture helper (`mgu-camshot`) ---------------- */

function tryCapture4Cam(opts) {
    opts = opts || {};
    if (opts.camFrame && Buffer.isBuffer(opts.camFrame.rgba) && opts.camFrame.w > 0 && opts.camFrame.h > 0 && opts.camFrame.rgba.length >= opts.camFrame.w * opts.camFrame.h * 4) {
        return { w: opts.camFrame.w, h: opts.camFrame.h, rgba: opts.camFrame.rgba };
    }
    const rawFile = opts.rawCamFile || '/run/bimmer-link/cam4.rgba';
    const bin = opts.camshotBin || path.join(__dirname, 'mgu-camshot');
    if (fs.existsSync(bin)) {
        try {
            cp.execFileSync(bin, ['-o', rawFile, '-w', '960', '-h', '720', '-t', '1800'], { timeout: 2500 });
        } catch (e) { /* camera bus asleep or car has no 360 camera */ }
    }
    try {
        const st = fs.statSync(rawFile);
        const mtime = st.mtime ? st.mtime.getTime() : st.mtimeMs;
        if (Math.abs(Date.now() - mtime) < 25000) {
            if (st.size === 960 * 720 * 4) return { w: 960, h: 720, rgba: fs.readFileSync(rawFile) };
            if (st.size === 960 * 440 * 4) return { w: 960, h: 440, rgba: fs.readFileSync(rawFile) };
        }
    } catch (e) { /* absent */ }
    return null;
}

function fmtVal(v, suffix, fallback) {
    return (v !== null && v !== undefined && v !== '' && !(typeof v === 'number' && !isFinite(v)))
        ? (v + (suffix || '')) : (fallback || '--');
}

function formatClock(ms) {
    const d = new Date(ms || Date.now());
    const pad = (n) => (n < 10 ? '0' : '') + n;
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + '  ' + pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear();
}

/**
 * Render a PNG Buffer representing the vehicle's current parking/live snapshot.
 * Uses 4-camera 360 composite (`640x416` so encrypted BL2 wire stays < 115 KB inside MQTT broker retainers!)
 * if available, otherwise renders the full BMW Dark Telemetry Card.
 */
function renderSnapshotPng(telemetry, extra, opts) {
    const t = telemetry || {};
    const ex = extra || {};
    const c1 = t.climate1cr || {};
    const cam = tryCapture4Cam(opts);

    if (cam) {
        // Full 960x720 (4:3) 24-bit True-Color 2x2 Mosaic (4 crisp 480x360 cameras, ZERO overlays on camera pixels!) + 96px HUD footer
        const s = new MiniSurface(960, 816, '#070a10');
        if (cam.w === 960 && cam.h === 720 && cam.rgba.length >= 960 * 720 * 4) {
            cam.rgba.copy(s.buf, 0, 0, 960 * 720 * 4);
        } else {
            s.blitRgbaScaled(cam.rgba, cam.w, cam.h, 0, 0, 960, 720);
        }
        // Clean telemetry HUD bar exclusively below y=720 so all 4 quadrants crop cleanly in the mobile app
        s.fillRect(0, 720, 960, 96, '#0b101b');
        s.fillRect(0, 720, 960, 3, '#2fd27a');
        const carHdr = ex.modelTitle ? (ex.modelTitle + ' - ') : 'BMW 360 - ';
        s.text(carHdr + (ex.title || t.conditionLabel || 'DA DO XE'), 16, 732, 2, '#2fd27a', 56);
        s.text(formatClock(ex.at), 724, 732, 2, '#94a3b8', 18);
        const loc = t.pos
            ? ((t.pos.street ? t.pos.street + ', ' : '') + (t.pos.district ? t.pos.district + ', ' : '') + (t.pos.city || '') + ' (' + t.pos.lat.toFixed(5) + ', ' + t.pos.lon.toFixed(5) + ')')
            : 'CHUA CO TOA DO GPS';
        s.text('VI TRI: ' + loc, 16, 758, 2, '#f8fafc', 77);
        const doorsWarn = (t.doorsOpen && t.doorsOpen.length) || t.trunkOpen || t.hoodOpen || t.locked === false;
        const secTag = doorsWarn ? 'KIEM TRA CUA/KHOA!' : 'KHOA AN TOAN';
        const line2 = 'XANG: ' + fmtVal(t.fuelPct, '%') + ' (' + fmtVal(t.rangeKm, ' KM') + ') | 12V: ' + fmtVal(t.battery12v, 'V') +
            ' | NHIET: ' + fmtVal(t.ambientC, '*C') + '/' + fmtVal(t.coolantC, '*C') + ' | ' + secTag;
        s.text(line2, 16, 784, 2, doorsWarn ? '#ffb020' : '#cbd5e1', 77);
        const jpgBuf = Jpeg.encodeJpegAdaptive(s.w, s.h, s.buf, 68000);
        return {
            png: jpgBuf,
            mime: 'image/jpeg',
            hasCamera: true,
            camMeta: { grid: '2x2', camW: 960, camH: 720, totalW: 960, totalH: 816 },
        };
    }

    // Pure Dark-Metallic BMW ConnectedDrive Telemetry Card (880x500)
    const s = new MiniSurface(880, 500, '#070b14');
    // Top accent bar (BMW M tri-color inspired subtle stripe + header)
    s.fillRect(0, 0, 293, 5, '#38bdf8');
    s.fillRect(293, 0, 293, 5, '#1d4ed8');
    s.fillRect(586, 0, 294, 5, '#ef4444');

    const badgeColor = ex.alert ? '#ef4444' : (c1.active ? '#2fd27a' : '#38bdf8');
    s.text(ex.modelTitle || 'MYBMW MGU LINK & 1CR', 28, 26, 3, '#f8fafc', 31);
    s.text(formatClock(ex.at), 610, 30, 2, '#94a3b8');

    // Status banner
    s.card(28, 66, 824, 66, badgeColor, '#0f172a');
    const headline = ex.title || (c1.active ? '1CR DANG NO MAY LAM MAT CABIN' : (t.engineRunning ? 'XE DANG NO MAY (' + (t.speed || 0) + ' KM/H)' : 'XE DA DO AN TOAN'));
    s.text(headline, 48, 80, 2, badgeColor, 64);
    const locLine = t.pos
        ? ('VI TRI: ' + [t.pos.street, t.pos.district, t.pos.city].filter(Boolean).join(', ') + '  [' + t.pos.lat.toFixed(5) + ', ' + t.pos.lon.toFixed(5) + ' - ' + String(t.pos.source || 'NAV').toUpperCase() + ']')
        : 'VI TRI: DANG CHO TIN HIEU DINH VI CUA XE';
    s.text(locLine, 48, 106, 2, '#e2e8f0', 65);

    // 6 Telemetry Tiles (2 rows x 3 columns)
    const tiles = [
        {
            label: 'NHIEN LIEU & TAM CHAY',
            big: fmtVal(t.fuelPct, '%', '--%'),
            sub: 'QUANG DUONG CON: ' + fmtVal(t.rangeKm, ' KM'),
            accent: (t.fuelPct !== null && t.fuelPct < 15) ? '#ef4444' : '#38bdf8',
        },
        {
            label: 'AC QUY 12V & ODO',
            big: fmtVal(t.battery12v, ' V', '12V OK'),
            sub: 'ODO: ' + fmtVal(t.odometerKm, ' KM'),
            accent: (t.battery12v !== null && t.battery12v < 11.9) ? '#ffb020' : '#2fd27a',
        },
        {
            label: 'DE NO TU XA 1CR',
            big: c1.active ? 'DANG CHAY' : (c1.timerText ? ('HEN ' + c1.timerText) : 'SAN SANG'),
            sub: c1.lastResult ? c1.lastResult.slice(0, 26) : 'DIEU HOA & BDC/IHKA',
            accent: c1.active ? '#2fd27a' : '#a78bfa',
        },
        {
            label: 'NHIET DO XE',
            big: 'NGOAI ' + fmtVal(t.ambientC, '*C'),
            sub: 'NUOC ' + fmtVal(t.coolantC, '*C') + '  |  DAU ' + fmtVal(t.oilC, '*C'),
            accent: '#38bdf8',
        },
        {
            label: 'CUA, COP & KHOA XE',
            big: (t.doorsOpen && t.doorsOpen.length) || t.trunkOpen || t.hoodOpen ? 'CUA DANG MO!' : (t.locked === false ? 'CHUA KHOA' : 'KHOA KIN'),
            sub: t.trunkOpen ? 'COP SAU DANG MO' : (t.hoodOpen ? 'NAP CAPO MO' : '4 CUA & COP AN TOAN'),
            accent: ((t.doorsOpen && t.doorsOpen.length) || t.trunkOpen || t.hoodOpen || t.locked === false) ? '#ffb020' : '#2fd27a',
        },
        {
            label: 'CHUYEN DI VUA XONG',
            big: ex.trip ? (ex.trip.distanceKm + ' KM') : (t.speed ? (t.speed + ' KM/H') : 'DUNG YEN'),
            sub: ex.trip ? (ex.trip.durationMin + ' PHUT  |  MAX ' + ex.trip.maxSpeed + ' KM/H') : ('SO: ' + (t.stage || 'P') + '  |  RPM: ' + (t.rpm || 0)),
            accent: '#f59e0b',
        },
    ];

    for (let i = 0; i < tiles.length; i++) {
        const col = i % 3, row = (i / 3) | 0;
        const tx = 28 + col * 280, ty = 152 + row * 148;
        const tl = tiles[i];
        s.card(tx, ty, 264, 130, '#1e293b', '#0f172a');
        s.fillRect(tx, ty, 5, 130, tl.accent);
        s.text(tl.label, tx + 18, ty + 18, 2, '#94a3b8', 20);
        s.text(tl.big, tx + 18, ty + 50, 3, '#f8fafc', 13);
        s.text(tl.sub, tx + 18, ty + 96, 2, tl.accent, 20);
    }

    // Footer Valet bar
    const valetText = ex.valet && ex.valet.enabled
        ? ('CHE DO VALET DANG BAT (GIOI HAN ' + ex.valet.maxSpeed + ' KM/H  |  ' + ex.valet.maxRpm + ' RPM  |  BAN KINH ' + ex.valet.radiusM + 'M)')
        : 'CHE DO VALET: TAT  -  DIEU KHIEN QUA TELEGRAM BOT HOAC QUET MA QR TREN XE';
    s.text(valetText, 28, 464, 2, ex.valet && ex.valet.enabled ? '#ffb020' : '#64748b', 68);

    return { png: s.png(), hasCamera: false };
}

module.exports = {
    MiniSurface,
    encodePngRgba,
    encodeIndexedPngRgba,
    foldAscii,
    renderSnapshotPng,
    tryCapture4Cam,
};
