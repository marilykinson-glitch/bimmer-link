'use strict';
/**
 * car-hero.js - Read-only scanner that extracts the car's exact chassis, trim package, factory paint color,
 * and genuine BMW factory 2D studio render (`vehicle2D_big`) directly from the MGU head unit.
 *
 * Never modifies any file on `/mnt/dataro`. If `anh-dai-dien` (MGU Studio) backed up an untouched original
 * `bitmaps.res.orig`, prefers that original bundle so the genuine BMW vehicle render is preserved.
 *
 * Node 8 compatible, zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const W = require('./wbm');
const CARPAINT = require('./carpaint');

const SERIES_TITLES = {
    G20: 'BMW 3 Series', G20LCI: 'BMW 3 Series LCI', G21: 'BMW 3 Series Touring', G21LCI: 'BMW 3 Series Touring', G28: 'BMW 3 Series Li',
    G80: 'BMW M3', G81: 'BMW M3 Touring',
    G22: 'BMW 4 Series Coupé', G23: 'BMW 4 Series Convertible', G26: 'BMW 4 Series Gran Coupé', G26BEV: 'BMW i4',
    G82: 'BMW M4 Coupé', G83: 'BMW M4 Convertible',
    G30: 'BMW 5 Series', G30LCI: 'BMW 5 Series LCI', G31: 'BMW 5 Series Touring', G31LCI: 'BMW 5 Series Touring', G38: 'BMW 5 Series Li', G38LCI: 'BMW 5 Series Li',
    F90: 'BMW M5', F90LCI: 'BMW M5 LCI',
    G32: 'BMW 6 Series GT', G32LCI: 'BMW 6 Series GT',
    G11: 'BMW 7 Series', G12: 'BMW 7 Series', G70: 'BMW 7 Series',
    G14: 'BMW 8 Series', G15: 'BMW 8 Series Coupé', G16: 'BMW 8 Series Gran Coupé', F93: 'BMW M8 Gran Coupé',
    G01: 'BMW X3', G08: 'BMW iX3', F97: 'BMW X3 M', F97LCI: 'BMW X3 M',
    G02: 'BMW X4', F98: 'BMW X4 M', F98LCI: 'BMW X4 M',
    G05: 'BMW X5', F95: 'BMW X5 M',
    G06: 'BMW X6', F96: 'BMW X6 M',
    G07: 'BMW X7', G07LCI: 'BMW X7 LCI',
    G29: 'BMW Z4', G42: 'BMW 2 Series Coupé', G87: 'BMW M2',
};

const TRIM_LABELS = {
    m_sportpaket: 'M Sport',
    sportpaket: 'Sport Package',
    m_sport_package_pro: 'M Sport Pro',
    m_competition: 'Competition',
    clubsport: 'CS',
    luxury_line: 'Luxury Line',
    sport_line: 'Sport Line',
    xline: 'xLine',
    m_sport_x_paket: 'M Sport X',
    m_aerodynamikpaket: 'M Aerodynamics',
    alpina_package: 'ALPINA',
};

function prettifyPaint(raw) {
    if (!raw || raw === 'DEFAULT') return '';
    return String(raw)
        .replace(/_U\d+$/i, '')
        .replace(/brillianteffekt/gi, '')
        .replace(/bernsteineffekt/gi, '')
        .replace(/blau/gi, 'Blue')
        .replace(/grau/gi, 'Grey')
        .replace(/schwarz/gi, 'Black')
        .replace(/weiss/gi, 'White')
        .replace(/rot/gi, 'Red')
        .replace(/gruen/gi, 'Green')
        .replace(/silber/gi, 'Silver')
        .replace(/gelb/gi, 'Yellow')
        .replace(/_/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatVehicleIdentity(info) {
    const code = String((info && (info.modelName || info.baureihe)) || '').replace(/^bmwm-|^mini-/i, '').toUpperCase();
    const series = SERIES_TITLES[code] || (code ? ('BMW ' + code) : 'BMW iDrive 7');
    const trimLabel = TRIM_LABELS[info && info.trimLine] || '';
    const paintLabel = prettifyPaint((info && info.colour) || (info && info.paint && info.paint.name) || '');
    return {
        chassis: code,
        modelTitle: series + (trimLabel && series.indexOf(trimLabel) < 0 ? (' · ' + trimLabel) : ''),
        series,
        trimLabel,
        paintLabel,
    };
}

function cropAlphaBounds(rgba, w, h) {
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            if (rgba[(y * w + x) * 4 + 3] > 12) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }
    if (maxX < minX || maxY < minY) return { rgba, w, h };
    const padX = Math.round((maxX - minX + 1) * 0.04);
    const padY = Math.round((maxY - minY + 1) * 0.06);
    const x0 = Math.max(0, minX - padX), y0 = Math.max(0, minY - padY);
    const x1 = Math.min(w - 1, maxX + padX), y1 = Math.min(h - 1, maxY + padY);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const out = Buffer.allocUnsafe(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
        rgba.copy(out, y * cw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4);
    }
    return { rgba: out, w: cw, h: ch };
}

function scanFactoryVehicle(opts) {
    opts = opts || {};
    const hmiRoot = opts.hmiRoot || '/mnt/dataro/dataro1/hmi';
    const vehicleRoots = (opts.vehicles || [
        path.join(hmiRoot, 'bmw/widgetasset/vehicles'),
        path.join(hmiRoot, 'bmwm/widgetasset/vehicles'),
        path.join(hmiRoot, 'mini/widgetasset/vehicles'),
    ]);
    const procDir = opts.procDir || '/proc';
    const rawCodingPath = opts.rawCodingPath || '/dev/shm/rawcodingdata';
    const mguStudioBackupDir = opts.backupDir || '/var/opt/anh-dai-dien/backup';

    const coding = CARPAINT.readRawCoding(rawCodingPath);

    // Inspect HmiMain3D open vehicle directories & Kombi trim if running on the head unit
    const openBases = [];
    let kombiTrim = '';
    try {
        const pids = fs.readdirSync(procDir).filter((d) => /^\d+$/.test(d));
        for (let i = 0; i < pids.length; i++) {
            let comm = '';
            try { comm = fs.readFileSync(path.join(procDir, pids[i], 'comm'), 'utf8').trim(); } catch (e) { continue; }
            if (comm !== 'HmiMain3D') continue;
            let fds = [];
            try { fds = fs.readdirSync(path.join(procDir, pids[i], 'fd')); } catch (e) { continue; }
            for (let k = 0; k < fds.length; k++) {
                let to = '';
                try { to = fs.readlinkSync(path.join(procDir, pids[i], 'fd', fds[k])); } catch (e) { continue; }
                const km = /\/kombi_model\/[^/]+\/Trim([A-Za-z0-9]+)\./i.exec(to);
                if (km && !kombiTrim) kombiTrim = km[1].toUpperCase();
                for (let r = 0; r < vehicleRoots.length; r++) {
                    const vr = vehicleRoots[r];
                    if (to.indexOf(vr + '/') === 0) {
                        const rel = to.slice(vr.length + 1).split('/')[0];
                        const base = path.join(vr, rel);
                        if (rel && rel !== 'F40' && openBases.indexOf(base) < 0) openBases.push(base);
                    }
                }
            }
        }
    } catch (e) {}

    // Fallback to coded BAUREIHE folder if HmiMain3D wasn't caught yet
    if (!openBases.length && coding.valid && coding.baureihe) {
        for (let r = 0; r < vehicleRoots.length; r++) {
            const cand = path.join(vehicleRoots[r], coding.baureihe);
            if (fs.existsSync(cand)) openBases.push(cand);
        }
    }

    const chosenBase = openBases[0] || '';
    const modelName = chosenBase ? path.basename(chosenBase) : (coding.valid ? coding.baureihe : '');
    const brand = chosenBase && chosenBase.indexOf('/bmwm/') >= 0 ? 'bmwm' : (chosenBase && chosenBase.indexOf('/mini/') >= 0 ? 'mini' : 'bmw');

    const hmiFile = (rel) => {
        const p1 = path.join(hmiRoot, brand, 'id7', rel);
        if (fs.existsSync(p1)) return p1;
        const p2 = path.join(hmiRoot, 'bmw', 'id7', rel);
        return fs.existsSync(p2) ? p2 : '';
    };

    let trim = kombiTrim || 'A';
    if (coding.valid && modelName) {
        const heroTrim = CARPAINT.resolveHeroTrim(modelName, coding.trimLine, hmiFile('script/hmi_script.lua'));
        if (coding.trimCode !== 0 || !kombiTrim) trim = heroTrim || trim;
    }
    const paint = CARPAINT.resolvePaint(
        coding.valid ? coding.colour : '',
        hmiFile('widget/VEHICLE_CARPAINT_colorregistry.pbc'),
        hmiFile('widget/variantregistry_ext_car.pbvar')
    );

    const meta = formatVehicleIdentity({
        modelName,
        baureihe: coding.valid ? coding.baureihe : '',
        trimLine: coding.valid ? coding.trimLine : '',
        colour: coding.valid ? coding.colour : '',
        paint,
    });

    // Try extracting genuine 2D studio bitmap + mask from `<chosenBase>/vehicle2D_big` (or `vehicle2D_small`)
    let pngBuf = null;
    if (chosenBase) {
        const subs = ['vehicle2D_big', 'vehicle2D_small'];
        for (let si = 0; si < subs.length && !pngBuf; si++) {
            const sub = subs[si];
            const dir = path.join(chosenBase, sub);
            const idsPath = path.join(dir, 'bitmaps.res.ids');
            const resPath = path.join(dir, 'bitmaps.res');
            const origBackup = path.join(mguStudioBackupDir, 'car-' + (brand === 'bmw' ? '' : brand + '-') + modelName + '-' + sub.slice(10) + '.res.orig');
            const actualRes = fs.existsSync(origBackup) ? origBackup : resPath;
            if (!fs.existsSync(actualRes) || !fs.existsSync(idsPath)) continue;
            try {
                const parsed = new W.Bundle(fs.readFileSync(actualRes), fs.readFileSync(idsPath, 'utf8'));
                const scene = CARPAINT.readSceneTrims(path.join(dir, 'scene.pbx'));
                const isMask = (k) => (scene && scene.picOfMask[k] ? true : /_mask\d*_bitmap$/.test(k));
                const trimOf = (k) => {
                    if (scene && scene.trimOfPic[k]) return scene.trimOfPic[k];
                    const m = /trim([A-Za-z]+)\d*_bitmap$/i.exec(k);
                    return m ? m[1].toUpperCase() : '';
                };
                const pics = parsed.entries.filter((e) => !isMask(e.key));
                const masks = parsed.entries.filter((e) => isMask(e.key));
                if (!pics.length) continue;
                pics.sort((a, b) => {
                    const ra = trimOf(a.key) === trim ? 0 : (trimOf(a.key) === 'A' ? 1 : 2);
                    const rb = trimOf(b.key) === trim ? 0 : (trimOf(b.key) === 'A' ? 1 : 2);
                    return ra - rb || (b.w - a.w);
                });
                const pick = pics[0];
                const maskEntry = masks.find((m) => (scene && scene.picOfMask[m.key] === pick.key) || m.key.replace(/_mask\d*_bitmap$/, '_bitmap') === pick.key);
                const shaded = CARPAINT.shadeCarpaint(
                    parsed.rgba(pick.key),
                    maskEntry ? parsed.rgba(maskEntry.key) : Buffer.alloc(pick.w * pick.h * 4),
                    paint
                );
                const topDown = W.flipRows(shaded, pick.w, pick.h);
                const cropped = cropAlphaBounds(topDown, pick.w, pick.h);
                const targetW = Math.min(520, cropped.w);
                const targetH = Math.max(1, Math.round(cropped.h * targetW / cropped.w));
                const scaled = W.resize(cropped.rgba, cropped.w, cropped.h, targetW, targetH);
                pngBuf = W.png(scaled, targetW, targetH);
            } catch (e) { /* try next */ }
        }
    }

    return {
        detected: !!(meta.chassis || pngBuf),
        meta,
        trimCode: trim,
        paintRgb: paint && paint.base ? [
            Math.round(Math.min(1, Math.max(0, paint.base[0])) * 255),
            Math.round(Math.min(1, Math.max(0, paint.base[1])) * 255),
            Math.round(Math.min(1, Math.max(0, paint.base[2])) * 255),
        ] : null,
        png: pngBuf,
    };
}

module.exports = {
    SERIES_TITLES,
    TRIM_LABELS,
    prettifyPaint,
    formatVehicleIdentity,
    cropAlphaBounds,
    scanFactoryVehicle,
};
