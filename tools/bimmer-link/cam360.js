'use strict';
/**
 * cam360.js - Ephemeral 4-camera Surround View (ICAM2 AVB) frame grabber for BMW iDrive 7 (MGU).
 *
 * Captures a real live 2x2 Surround View frame (CAM TRUOC / CAM SAU / GUONG TRAI / GUONG PHAI)
 * completely in the background without changing the car's center screen or instrument cluster:
 *   1. Asks `car-link.js` (`cam_wake`) to attach to `ICAM2Proxy` as `CLIENT_INDIRECT` in
 *      `DR_ACTIVE` / `MODE_MOSAIK` perspective 7 (unless another app or Parking View already has it on).
 *   2. Hosts a temporary Unix socket speaking the `cluster-render` v1 protocol (`/run/bimmer-link/cam.sock`)
 *      and spawns `mgu-sidecam --socket <sock>` requesting `view: "all"` (`pair: 1`, `960x720` @ `30 fps`).
 *   3. Waits until `mgu-sidecam`'s `PairTagger` locks onto `"sei@..."` plus 2 post-lock frames so both halves
 *      (`09` Front/Rear + `0a` Left/Right) are guaranteed aligned and non-duplicated, converts the full-range
 *      4:2:0 YUV atlas into `960x720` RGBA (`cam4.rgba`), shuts down `mgu-sidecam`, and releases `ICAM2Proxy`.
 *
 * Strict Node 8.16 ES2017, zero external dependencies.
 */
const fs = require('fs');
const net = require('net');
const path = require('path');
const cp = require('child_process');
const Wbm = require('./wbm');

const CR_JSON = 0x4a;   // 'J'
const CR_FRAME = 0x46;  // 'F'
const MAX_CR_MSG = 1920 * 720 * 4 + 64;

function encodeCrMessage(typeByte, bodyBuf) {
    const b = Buffer.isBuffer(bodyBuf) ? bodyBuf : Buffer.from(String(bodyBuf), 'utf8');
    const out = Buffer.allocUnsafe(5 + b.length);
    out.writeUInt32LE(b.length + 1, 0);
    out[4] = typeByte & 0xff;
    b.copy(out, 5);
    return out;
}

function encodeCrJson(obj) {
    return encodeCrMessage(CR_JSON, Buffer.from(JSON.stringify(obj), 'utf8'));
}

function parseCrFrame(body) {
    if (!Buffer.isBuffer(body) || body.length < 14) return null;
    const ref = body.readUInt32LE(0);
    const idLo = body.readUInt32LE(4);
    const idHi = body.readUInt32LE(8);
    const nr = body.readUInt16LE(12);
    const hdrLen = 14 + nr * 8;
    if (body.length < hdrLen) return null;
    return {
        ref,
        id: idHi * 4294967296 + idLo,
        rectsCount: nr,
        pixels: body.slice(hdrLen),
    };
}

function hasLiveLuma(atlas, w, h) {
    const yLen = w * h;
    if (!atlas || atlas.length < (yLen * 3) / 2) return false;
    let bright = 0;
    const step = Math.max(7, Math.floor(yLen / 2400));
    for (let i = 0; i < yLen; i += step) {
        if (atlas[i] > 14) {
            bright++;
            if (bright >= 120) return true;
        }
    }
    return false;
}

/**
 * Convert `mgu-sidecam`'s full-range 4:2:0 YUV atlas (Y plane w*h, then U left-half + V right-half per chroma row)
 * into straight RGBA (`w * h * 4` bytes).
 */
function yuv420AtlasToRgba(atlas, w, h) {
    const out = Buffer.allocUnsafe(w * h * 4);
    const cw = w >> 1;
    const cBase = w * h;
    let di = 0;
    for (let py = 0; py < h; py++) {
        const yRow = py * w;
        const cRow = cBase + (py >> 1) * w;
        for (let px = 0; px < w; px++) {
            const yVal = atlas[yRow + px];
            const cx = px >> 1;
            const u = atlas[cRow + cx] - 128;
            const v = atlas[cRow + cw + cx] - 128;
            let r = yVal + ((359 * v + 128) >> 8);
            let g = yVal - ((88 * u + 183 * v + 128) >> 8);
            let b = yVal + ((454 * u + 128) >> 8);
            if (r < 0) r = 0; else if (r > 255) r = 255;
            if (g < 0) g = 0; else if (g > 255) g = 255;
            if (b < 0) b = 0; else if (b > 255) b = 255;
            out[di] = r;
            out[di + 1] = g;
            out[di + 2] = b;
            out[di + 3] = 255;
            di += 4;
        }
    }
    return out;
}

function findSidecamBin(customBin) {
    const cands = [
        customBin,
        path.join(__dirname, 'mgu-sidecam'),
        '/var/opt/bimmer-link/current/mgu-sidecam',
        '/var/opt/xinhan-cam/current/mgu-sidecam',
    ].filter(Boolean);
    for (let i = 0; i < cands.length; i++) {
        try {
            const st = fs.statSync(cands[i]);
            if (st.isFile() && st.size > 1000) return cands[i];
        } catch (e) {}
    }
    return null;
}

/**
 * Attempt to grab a fresh 4-camera Surround View RGBA frame (`960x720` exact 4:3 = four `480x360` cameras).
 * Resolves `{ ok: true, width, height, rgba }` or `{ ok: false, reason }` — never rejects.
 */
function capture360Frame(opts) {
    opts = opts || {};
    const W = (opts.width || 960) & ~3;
    const H = (opts.height || 720) & ~1;
    const minFrames = opts.minFrames || 9;
    const timeoutMs = opts.timeoutMs || 4800;
    const runDir = opts.runDir || '/run/bimmer-link';
    const sockPath = opts.sockPath || path.join(runDir, 'cam360-' + process.pid + '.sock');
    const rawOutFile = opts.rawOutFile || path.join(runDir, 'cam4.rgba');
    const log = opts.log || function () {};
    const bin = findSidecamBin(opts.bin);
    const spawnFn = opts.spawnFn || ((cmd, args) => cp.spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] }));

    if (!bin && !opts.spawnFn) {
        return Promise.resolve({ ok: false, reason: 'mgu-sidecam absent' });
    }

    let settled = false;
    let server = null;
    let activeConn = null;
    let child = null;
    let hbTimer = null;
    let mainTimer = null;
    let settleTimer = null;
    let bestAtlas = null;
    let validCount = 0;
    let pairMode = '';
    let seiLocked = false;
    let postSeiFrames = 0;

    try { fs.unlinkSync(sockPath); } catch (e) {}

    return Promise.resolve()
        .then(() => (typeof opts.wakeCam === 'function' ? Promise.resolve(opts.wakeCam()).catch(() => null) : null))
        .then((wakeRes) => new Promise((resolve) => {
            function cleanupAndFinish(result) {
                if (settled) return;
                settled = true;
                if (hbTimer) clearInterval(hbTimer);
                if (mainTimer) clearTimeout(mainTimer);
                if (settleTimer) clearTimeout(settleTimer);
                if (child) {
                    try { child.stdin.write('{"op":"quit"}\n'); } catch (e) {}
                    try { child.kill('SIGTERM'); } catch (e) {}
                    child = null;
                }
                if (activeConn) {
                    try { activeConn.destroy(); } catch (e) {}
                    activeConn = null;
                }
                if (server) {
                    try { server.close(); } catch (e) {}
                    server = null;
                }
                try { fs.unlinkSync(sockPath); } catch (e) {}
                Promise.resolve()
                    .then(() => (typeof opts.releaseCam === 'function' ? opts.releaseCam() : null))
                    .catch(() => null)
                    .then(() => resolve(result));
            }

            const layers = {};

            function finalizeFromAtlas(frameObj) {
                try {
                    const fw = frameObj.vw || W;
                    const fh = frameObj.vh || H;
                    const srcRgba = yuv420AtlasToRgba(frameObj.pixels, fw, fh);
                    const rgba = (fw === W && fh === H) ? srcRgba : Wbm.resize(srcRgba, fw, fh, W, H);
                    if (rawOutFile) {
                        try {
                            fs.writeFileSync(rawOutFile + '.tmp', rgba);
                            fs.renameSync(rawOutFile + '.tmp', rawOutFile);
                        } catch (e) {}
                    }
                    log('cam360 captured ' + fw + 'x' + fh + ' -> ' + W + 'x' + H + ' (' + validCount + ' frames, pair=' + (pairMode || 'auto') + ')');
                    cleanupAndFinish({ ok: true, width: W, height: H, srcWidth: fw, srcHeight: fh, rgba, frames: validCount, pairMode: pairMode || 'auto' });
                } catch (e) {
                    cleanupAndFinish({ ok: false, reason: e.message });
                }
            }

            server = net.createServer((conn) => {
                activeConn = conn;
                let rx = Buffer.alloc(0);
                conn.on('error', () => {});

                const sendCr = (obj) => {
                    try { conn.write(encodeCrJson(obj)); } catch (e) {}
                };

                conn.on('data', (chunk) => {
                    if (settled) return;
                    rx = rx.length ? Buffer.concat([rx, chunk]) : chunk;
                    while (rx.length >= 4) {
                        const len = rx.readUInt32LE(0);
                        if (len < 1 || len > MAX_CR_MSG) {
                            rx = Buffer.alloc(0);
                            break;
                        }
                        if (rx.length < 4 + len) break;
                        const type = rx[4];
                        const body = rx.slice(5, 4 + len);
                        rx = rx.slice(4 + len);

                        if (type === CR_JSON) {
                            let j = null;
                            try { j = JSON.parse(body.toString('utf8')); } catch (e) {}
                            if (!j) continue;
                            if (j.op === 'hello') {
                                sendCr({
                                    ev: 'hello',
                                    proto: 1,
                                    backend: 'id7',
                                    targets: 'map:1088x480,panel:1920x720,hud:800x480',
                                    repeat: 1,
                                });
                            } else if (j.op === 'layer') {
                                const ref = Number(j.ref) || 1;
                                const hidden = j.visible === 0 || j.visible === '0' || j.visible === false;
                                layers[ref] = {
                                    vw: Number(j.vw) || W,
                                    vh: Number(j.vh) || H,
                                    target: j.target || 'map',
                                    visible: hidden ? 0 : 1,
                                };
                                sendCr({ ev: 'target', target: j.target || 'map', state: 'shown', holder: '', reason: '' });
                                sendCr({ ev: 'layer', ref, state: hidden ? 'hidden' : 'shown', reason: '' });
                            } else if (j.op === 'set') {
                                const ref = Number(j.ref) || 1;
                                const hidden = j.visible === 0 || j.visible === '0' || j.visible === false;
                                if (layers[ref]) Object.assign(layers[ref], j);
                                sendCr({ ev: 'layer', ref, state: hidden ? 'hidden' : 'shown', reason: '' });
                            }
                        } else if (type === CR_FRAME) {
                            const f = parseCrFrame(body);
                            if (!f || f.id === 0) continue;
                            const lay = layers[f.ref] || { vw: W, vh: H };
                            const wantBytes = (lay.vw * lay.vh * 3) / 2;
                            if (f.pixels.length !== wantBytes) continue;
                            if (!hasLiveLuma(f.pixels, lay.vw, lay.vh)) continue;
                            bestAtlas = { pixels: Buffer.from(f.pixels), vw: lay.vw, vh: lay.vh };
                            validCount++;
                            if (seiLocked) postSeiFrames++;
                            if (child && child.stdin) {
                                try { child.stdin.write('{"op":"status"}\n'); } catch (e) {}
                            }
                            const readyByExplicit = typeof opts.minFrames === 'number' && validCount >= opts.minFrames;
                            const readyBySingle = pairMode === 'off' && validCount >= 3;
                            const readyBySei = seiLocked && postSeiFrames >= 2;
                            if (readyByExplicit || readyBySingle || readyBySei || validCount >= minFrames) {
                                finalizeFromAtlas(bestAtlas);
                                return;
                            }
                            if (settleTimer) clearTimeout(settleTimer);
                            settleTimer = setTimeout(() => {
                                if (bestAtlas) finalizeFromAtlas(bestAtlas);
                            }, 900);
                        }
                    }
                });
            });

            server.on('error', (e) => {
                cleanupAndFinish({ ok: false, reason: 'sock: ' + e.message });
            });

            server.listen(sockPath, () => {
                const args = ['--socket', sockPath];
                if (opts.extraArgs && Array.isArray(opts.extraArgs)) {
                    for (let i = 0; i < opts.extraArgs.length; i++) args.push(opts.extraArgs[i]);
                }
                try {
                    child = spawnFn(bin, args);
                } catch (e) {
                    cleanupAndFinish({ ok: false, reason: 'spawn: ' + e.message });
                    return;
                }
                child.on('error', (e) => {
                    if (!bestAtlas) cleanupAndFinish({ ok: false, reason: 'child: ' + e.message });
                });
                child.on('close', (code) => {
                    if (!settled && bestAtlas) finalizeFromAtlas(bestAtlas);
                    else if (!settled) {
                        log('cam360 exited (' + code + ') before frame');
                        cleanupAndFinish({ ok: false, reason: 'sidecam exited (' + code + ')' });
                    }
                });
                if (child.stdin) child.stdin.on('error', () => {});
                if (child.stdout) {
                    let sbuf = '';
                    child.stdout.on('data', (d) => {
                        sbuf += String(d || '');
                        let nl;
                        while ((nl = sbuf.indexOf('\n')) >= 0) {
                            const ln = sbuf.slice(0, nl).trim();
                            sbuf = sbuf.slice(nl + 1);
                            if (!ln) continue;
                            try {
                                const st = JSON.parse(ln);
                                if (st && typeof st.pair === 'string' && st.pair) {
                                    pairMode = st.pair;
                                    if (/^sei@\d+$/.test(st.pair) && !seiLocked) {
                                        seiLocked = true;
                                        postSeiFrames = 0;
                                    }
                                }
                            } catch (e) {}
                            if (ln.indexOf('"fps":0') < 0) log('sidecam: ' + ln.slice(0, 380));
                        }
                    });
                }

                const cfgMsg = JSON.stringify({
                    op: 'config',
                    target: 'panel',
                    klass: 'overlay',
                    w: W,
                    h: H,
                    x: 0,
                    y: 0,
                    fps: 30,
                    exclusive: 0,
                    contend: 1,
                    persist: 1,
                    pair: 1,
                    pair_swap: 0,
                    all: '0,0,1000,1000',
                    all_rot: 0,
                    all_flip: 0,
                    all_sar: 100,
                }) + '\n';
                const viewMsg = '{"op":"view","side":"all"}\n';
                try {
                    child.stdin.write(cfgMsg);
                    child.stdin.write(viewMsg);
                } catch (e) {}

                hbTimer = setInterval(() => {
                    if (child && child.stdin) {
                        try { child.stdin.write(viewMsg); } catch (e) {}
                    }
                }, 450);
            });

            mainTimer = setTimeout(() => {
                if (bestAtlas) {
                    finalizeFromAtlas(bestAtlas);
                } else {
                    log('cam360 timeout (' + (wakeRes && wakeRes.note ? wakeRes.note : 'no AVB frame') + ')');
                    cleanupAndFinish({ ok: false, reason: 'timeout' });
                }
            }, timeoutMs);
        }));
}

module.exports = {
    CR_JSON,
    CR_FRAME,
    encodeCrMessage,
    encodeCrJson,
    parseCrFrame,
    hasLiveLuma,
    yuv420AtlasToRgba,
    findSidecamBin,
    capture360Frame,
};
