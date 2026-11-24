'use strict';
/**
 * car-hero.js - Read-only scanner & genuine BMW carpaint renderer for the MGU head unit.
 *
 * Capabilities:
 *   1. Inspects `/dev/shm/rawcodingdata` + `HmiMain3D` open vehicle assets (resolving `/mnt/dataro/dataro1` symlinks
 *      via `fs.realpathSync`) to detect the car's chassis (`BAUREIHE`), trim (`TRIM_LINE`), and paint (`VEHICLE_COLOUR`).
 *   2. Lists all available 2D vehicle studio bundles (`availableModels`) on `/mnt/dataro` so if `HU_MGU` was coded
 *      to another model (e.g. `F90LCI` M5 CS Kombi coding on a G30/G20) or wrapped/repainted, the owner can pick
 *      any genuine BMW model, trim, and factory paint swatch in 1 tap on the MyBMW App!
 *   3. Pairs each `vehicle2D_big` / `vehicle2D_small` picture with its exact paint mask via `scene.pbx` `byTrim`
 *      and numbered bitmap conventions (`..._0_bitmap` + `..._mask_1_bitmap`), shades it with BMW's exact GLSL
 *      carpaint formula (`VEHICLE_CARPAINT_colorregistry.pbc`), and encodes a compact Sub-filtered PNG (~20 KB).
 *
 * Never modifies any file on `/mnt/dataro`. Node 8 compatible, zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const W = require('./wbm');
const CARPAINT = require('./carpaint');

const SERIES_TITLES = {
    G20: 'BMW 3 Series', G20LCI: 'BMW 3 Series LCI', G21: 'BMW 3 Series Touring', G21LCI: 'BMW 3 Series Touring', G28: 'BMW 3 Series Li', G28LCI: 'BMW 3 Series Li LCI',
    G80: 'BMW M3', G81: 'BMW M3 Touring',
    G22: 'BMW 4 Series Coupé', G23: 'BMW 4 Series Convertible', G26: 'BMW 4 Series Gran Coupé', G26BEV: 'BMW i4',
    G82: 'BMW M4 Coupé', G83: 'BMW M4 Convertible',
    G30: 'BMW 5 Series', G30LCI: 'BMW 5 Series LCI', G31: 'BMW 5 Series Touring', G31LCI: 'BMW 5 Series Touring', G38: 'BMW 5 Series Li', G38LCI: 'BMW 5 Series Li LCI',
    G60: 'BMW 5 Series', F90: 'BMW M5', F90LCI: 'BMW M5 LCI',
    G32: 'BMW 6 Series GT', G32LCI: 'BMW 6 Series GT LCI',
    G11: 'BMW 7 Series', G12: 'BMW 7 Series', G70: 'BMW 7 Series',
    G14: 'BMW 8 Series Convertible', G15: 'BMW 8 Series Coupé', G16: 'BMW 8 Series Gran Coupé', F91: 'BMW M8 Convertible', F92: 'BMW M8 Coupé', F93: 'BMW M8 Gran Coupé',
    G01: 'BMW X3', G01LCI: 'BMW X3 LCI', G08: 'BMW iX3', G08BEV: 'BMW iX3', G08BEVLCI: 'BMW iX3 LCI', F97: 'BMW X3 M', F97LCI: 'BMW X3 M LCI',
    G02: 'BMW X4', G02LCI: 'BMW X4 LCI', F98: 'BMW X4 M', F98LCI: 'BMW X4 M LCI',
    G05: 'BMW X5', G18: 'BMW X5 Li', F95: 'BMW X5 M',
    G06: 'BMW X6', F96: 'BMW X6 M',
    G07: 'BMW X7', G07LCI: 'BMW X7 LCI',
    G29: 'BMW Z4', G42: 'BMW 2 Series Coupé', G87: 'BMW M2', F40: 'BMW 1 Series', F44: 'BMW 2 Series Gran Coupé',
};

const TRIM_LABELS = {
    base: '',
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

/** Built-in fallback shader parameters for common BMW paints when running offline or if a custom colour isn't in .pbc */
const BUILTIN_PAINTS = {
    alpin_white: { name: 'alpin_white_U300', base: [0.82, 0.83, 0.86, 1.4], spec: [0.85, 0.86, 0.90, 8.5], refl: [1.08, 1.08, 1.10, 1.0] },
    mineralweiss_metallic: { name: 'mineralweiss_metallic_WA96', base: [0.78, 0.79, 0.82, 1.6], spec: [0.95, 0.96, 1.0, 9.5], refl: [1.12, 1.12, 1.14, 1.0] },
    black_sapphire_metallic: { name: 'black_sapphire_metallic_0475', base: [0.05, 0.055, 0.065, 4.2], spec: [0.62, 0.65, 0.70, 11.0], refl: [0.95, 0.97, 1.0, 1.0] },
    carbonschwarz_metallic: { name: 'carbonschwarz_metallic_0416', base: [0.045, 0.065, 0.13, 4.5], spec: [0.55, 0.65, 0.85, 11.0], refl: [0.92, 0.96, 1.05, 1.0] },
    sophistograu_brillianteffekt_metallic: { name: 'sophistograu_WA90', base: [0.16, 0.17, 0.185, 3.2], spec: [0.78, 0.80, 0.84, 10.0], refl: [0.92, 0.93, 0.95, 1.0] },
    skyscraper_grey: { name: 'skyscraper_grey_WC4W', base: [0.38, 0.40, 0.43, 2.4], spec: [0.95, 0.97, 1.02, 9.5], refl: [1.02, 1.04, 1.06, 1.0] },
    brooklyn_grau_metallic: { name: 'brooklyn_grau_WC4P', base: [0.44, 0.46, 0.49, 2.0], spec: [0.88, 0.90, 0.94, 8.8], refl: [0.98, 1.0, 1.03, 1.0] },
    berningrau_bernsteineffekt_metallic: { name: 'berninagrau_WC3E', base: [0.28, 0.27, 0.26, 2.8], spec: [0.92, 0.86, 0.78, 9.8], refl: [0.96, 0.94, 0.92, 1.0] },
    glaciersilber_metallic: { name: 'glaciersilber_WA83', base: [0.58, 0.60, 0.64, 2.0], spec: [1.05, 1.07, 1.10, 9.5], refl: [1.06, 1.08, 1.10, 1.0] },
    phytonicblau_metallic: { name: 'phytonicblau_WC1M', base: [0.08, 0.22, 0.48, 3.2], spec: [0.55, 0.78, 1.15, 10.5], refl: [0.88, 0.96, 1.08, 1.0] },
    portimao_blau_metallic: { name: 'portimao_blau_WC31', base: [0.06, 0.18, 0.56, 3.0], spec: [0.52, 0.75, 1.25, 10.8], refl: [0.88, 0.96, 1.12, 1.0] },
    marina_bay_blau_metallic: { name: 'marina_bay_blau_WC1K', base: [0.05, 0.16, 0.58, 3.1], spec: [0.55, 0.80, 1.28, 11.0], refl: [0.90, 0.98, 1.14, 1.0] },
    tansanitblau_2_metallic: { name: 'tansanitblau_WC3Z', base: [0.04, 0.10, 0.30, 3.8], spec: [0.45, 0.65, 1.08, 11.2], refl: [0.86, 0.94, 1.08, 1.0] },
    melbournerot_metallic: { name: 'melbournerot_WA75', base: [0.52, 0.06, 0.07, 2.8], spec: [1.15, 0.48, 0.48, 10.0], refl: [1.02, 0.88, 0.88, 1.0] },
    aventurinrot_2_metallic: { name: 'aventurinrot_WC47', base: [0.34, 0.04, 0.06, 3.4], spec: [0.98, 0.40, 0.44, 10.6], refl: [0.96, 0.84, 0.86, 1.0] },
    toronto_rot_metallic: { name: 'toronto_rot_WC3G', base: [0.64, 0.08, 0.06, 2.5], spec: [1.22, 0.52, 0.45, 9.8], refl: [1.05, 0.90, 0.88, 1.0] },
    isle_of_man_green_metallic: { name: 'isle_of_man_green_WC4G', base: [0.05, 0.32, 0.22, 3.0], spec: [0.48, 0.98, 0.76, 10.5], refl: [0.88, 1.02, 0.95, 1.0] },
    sanremo_green_metallic: { name: 'sanremo_green_WC4E', base: [0.08, 0.24, 0.16, 3.4], spec: [0.58, 0.88, 0.68, 10.4], refl: [0.88, 0.98, 0.92, 1.0] },
};

function prettifyPaint(raw) {
    if (!raw || raw === 'DEFAULT') return '';
    return String(raw)
        .replace(/_[A-Z0-9]{4}$/i, '')
        .replace(/_U\d+$/i, '')
        .replace(/brillianteffekt/gi, '')
        .replace(/bernsteineffekt/gi, '')
        .replace(/phytonicblau/gi, 'Phytonic Blue')
        .replace(/tansanitblau/gi, 'Tanzanite Blue')
        .replace(/portimao_blau/gi, 'Portimao Blue')
        .replace(/marina_bay_blau/gi, 'Marina Bay Blue')
        .replace(/carbonschwarz/gi, 'Carbon Black')
        .replace(/sophistograu/gi, 'Sophisto Grey')
        .replace(/bernin?grau/gi, 'Bernina Grey')
        .replace(/brooklyn_grau/gi, 'Brooklyn Grey')
        .replace(/mineralweiss/gi, 'Mineral White')
        .replace(/glaciersilber/gi, 'Glacier Silver')
        .replace(/melbournerot/gi, 'Melbourne Red')
        .replace(/aventurinrot/gi, 'Aventurin Red')
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
    const isM5Cs = (code === 'F90LCI' || code === 'F90') && info && info.trimLine === 'clubsport';
    const series = isM5Cs ? 'BMW M5 CS' : (SERIES_TITLES[code] || (code ? ('BMW ' + code) : 'BMW iDrive 7'));
    const trimLabel = isM5Cs ? 'CS' : (TRIM_LABELS[info && info.trimLine] || '');
    const paintLabel = prettifyPaint((info && info.colour) || (info && info.paint && info.paint.name) || '');
    return {
        chassis: code,
        modelTitle: isM5Cs ? 'BMW M5 CS' : (series + (trimLabel && series.indexOf(trimLabel) < 0 ? (' · ' + trimLabel) : '')),
        series,
        trimLine: (info && info.trimLine) || '',
        trimLabel,
        colour: (info && info.colour) || '',
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
    const padX = Math.round((maxX - minX + 1) * 0.03);
    const padY = Math.round((maxY - minY + 1) * 0.05);
    const x0 = Math.max(0, minX - padX), y0 = Math.max(0, minY - padY);
    const x1 = Math.min(w - 1, maxX + padX), y1 = Math.min(h - 1, maxY + padY);
    const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
    const out = Buffer.allocUnsafe(cw * ch * 4);
    for (let y = 0; y < ch; y++) {
        rgba.copy(out, y * cw * 4, ((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4);
    }
    return { rgba: out, w: cw, h: ch };
}

/** Encode RGBA PNG using PNG Sub filter (filter=1) + deflate level 9 so 440px studio renders shrink to ~20 KB (~9 chunks)! */
function encodeCompactPng(rgba, w, h) {
    const stride = w * 4 + 1;
    const raw = Buffer.allocUnsafe(stride * h);
    for (let y = 0; y < h; y++) {
        const rowOff = y * stride;
        const srcOff = y * w * 4;
        raw[rowOff] = 1; // PNG Sub filter
        for (let x = 0; x < w * 4; x++) {
            const prev = x >= 4 ? rgba[srcOff + x - 4] : 0;
            raw[rowOff + 1 + x] = (rgba[srcOff + x] - prev) & 255;
        }
    }
    const chunk = (type, data) => {
        const b = Buffer.alloc(12 + data.length);
        b.writeUInt32BE(data.length, 0);
        b.write(type, 4, 'latin1');
        data.copy(b, 8);
        b.writeUInt32BE(W.crc32(b.slice(4, 8 + data.length)), 8 + data.length);
        return b;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

function findMaskForPic(picKey, masks, scene) {
    if (scene && scene.byTrim) {
        const trKeys = Object.keys(scene.byTrim);
        for (let i = 0; i < trKeys.length; i++) {
            const pair = scene.byTrim[trKeys[i]];
            if (pair && pair.pic === picKey && pair.mask) {
                const hit = masks.find((m) => m.key === pair.mask);
                if (hit) return hit;
            }
        }
    }
    if (scene && scene.picOfMask) {
        const hit = masks.find((m) => scene.picOfMask[m.key] === picKey);
        if (hit) return hit;
    }
    const num = (k) => { const m = /(\d+)_bitmap$/.exec(k); return m ? Number(m[1]) : -1; };
    return masks.find((m) => m.key.replace(/_mask_?\d*_bitmap$/, '_bitmap') === picKey) ||
        masks.find((m) => num(picKey) >= 0 && num(m.key) === num(picKey) + 1 &&
            picKey.replace(/_?\d+_bitmap$/, '') === m.key.replace(/_mask_?\d+_bitmap$/, '')) ||
        (masks.length === 1 ? masks[0] : null);
}

function scanFactoryVehicle(opts) {
    opts = opts || {};
    const hmiRoot = opts.hmiRoot || '/mnt/dataro/dataro1/hmi';
    const vehicleRoots = opts.vehicles || [
        path.join(hmiRoot, 'bmw/widgetasset/vehicles'),
        path.join(hmiRoot, 'bmwm/widgetasset/vehicles'),
        path.join(hmiRoot, 'mini/widgetasset/vehicles'),
    ];
    const procDir = opts.procDir || '/proc';
    const rawCodingPath = opts.rawCodingPath || '/dev/shm/rawcodingdata';
    const mguStudioBackupDir = opts.backupDir || '/var/opt/anh-dai-dien/backup';
    const override = opts.override && typeof opts.override === 'object' ? opts.override : {};

    // Discover all vehicle models available on /mnt/dataro that have 2D bitmaps
    const modelMap = {}; // UPPER_CODE -> { base, brand, modelName }
    const availableModels = [];
    for (let r = 0; r < vehicleRoots.length; r++) {
        const vr = vehicleRoots[r];
        const brand = vr.indexOf('/bmwm/') >= 0 ? 'bmwm' : (vr.indexOf('/mini/') >= 0 ? 'mini' : 'bmw');
        let names = [];
        try { names = fs.readdirSync(vr).sort(); } catch (e) { continue; }
        for (let ni = 0; ni < names.length; ni++) {
            const nm = names[ni];
            const base = path.join(vr, nm);
            const has2d = fs.existsSync(path.join(base, 'vehicle2D_big', 'bitmaps.res')) ||
                fs.existsSync(path.join(base, 'vehicle2D_small', 'bitmaps.res'));
            const has3d = fs.existsSync(path.join(base, 'vehicle', 'meshes.res'));
            if (!has2d && !has3d) continue;
            const code = nm.toUpperCase();
            if (!modelMap[code] || has2d) modelMap[code] = { base, brand, modelName: nm, has2d };
            if (has2d && availableModels.indexOf(code) < 0) availableModels.push(code);
        }
    }

    const coding = CARPAINT.readRawCoding(rawCodingPath);

    // Inspect HmiMain3D & HmiKombi open vehicle directories (resolving /mnt/dataro/dataro1 symlinks!)
    const rootPairs = vehicleRoots.map((given) => {
        let real = given;
        try { real = fs.realpathSync(given); } catch (e) { real = given; }
        return { given, real };
    });

    const open3d = [], open2d = [];
    let kombiModel = '', kombiTrim = '';
    try {
        const pids = fs.readdirSync(procDir).filter((d) => /^\d+$/.test(d));
        for (let i = 0; i < pids.length; i++) {
            let comm = '';
            try { comm = fs.readFileSync(path.join(procDir, pids[i], 'comm'), 'utf8').trim(); } catch (e) { continue; }
            if (!/^Hmi/.test(comm)) continue;
            let fds = [];
            try { fds = fs.readdirSync(path.join(procDir, pids[i], 'fd')); } catch (e) { continue; }
            for (let k = 0; k < fds.length; k++) {
                let to = '';
                try { to = fs.readlinkSync(path.join(procDir, pids[i], 'fd', fds[k])); } catch (e) { continue; }
                const km = /\/kombi_model\/([^/]+)\/Trim([A-Za-z0-9]+)\./i.exec(to);
                if (km && !kombiTrim) { kombiModel = km[1]; kombiTrim = km[2].toUpperCase(); }
                for (let r = 0; r < rootPairs.length; r++) {
                    const pair = rootPairs[r];
                    const matchRoot = to.indexOf(pair.given + '/') === 0 ? pair.given : (to.indexOf(pair.real + '/') === 0 ? pair.real : '');
                    if (!matchRoot) continue;
                    const parts = to.slice(matchRoot.length + 1).split('/');
                    const relModel = parts[0], subDir = parts[1] || '';
                    if (!relModel) continue;
                    const canonicalBase = path.join(pair.given, relModel);
                    if (subDir === 'vehicle' && open3d.indexOf(canonicalBase) < 0) open3d.push(canonicalBase);
                    if (/^vehicle2D_/.test(subDir) && relModel !== 'F40' && open2d.indexOf(canonicalBase) < 0) open2d.push(canonicalBase);
                }
            }
        }
    } catch (e) {}

    // Sibling 2D bundle map when an M / LCI / Li / BEV variant only ships 3D `vehicle/` on MGU
    const SIBLING_2D = {
        F90LCI: ['F90', 'G30LCI', 'G30'], F90: ['G30LCI', 'G30'],
        F97LCI: ['F97', 'G01LCI', 'G01'], F97: ['G01LCI', 'G01'],
        F98LCI: ['F98', 'G02LCI', 'G02'], F98: ['G02LCI', 'G02'],
        F95: ['G05'], F96: ['G06'],
        G80: ['G20LCI', 'G20'], G81: ['G21LCI', 'G21'], G82: ['G22'], G83: ['G23'],
        F91: ['G14'], F92: ['G15'], F93: ['G16'], G87: ['G42'],
        G08BEVLCI: ['G08BEV', 'G08LCI', 'G08', 'G01LCI', 'G01'], G08BEV: ['G08', 'G01'],
        G26BEV: ['G26', 'G22'], G28LCI: ['G28', 'G20LCI', 'G20'], G28: ['G20'],
        G38LCI: ['G38', 'G30LCI', 'G30'], G38: ['G30'], G18: ['G05'],
    };

    function find2dForCode(code) {
        if (!code) return '';
        const up = String(code).toUpperCase();
        const tryList = [up];
        const stem = up.replace(/(?:BEV)?LCI$|BEV$/, '');
        if (stem && stem !== up) tryList.push(stem);
        if (SIBLING_2D[up]) tryList.push.apply(tryList, SIBLING_2D[up]);
        if (stem && SIBLING_2D[stem]) tryList.push.apply(tryList, SIBLING_2D[stem]);
        for (let i = 0; i < tryList.length; i++) {
            const m = modelMap[tryList[i]];
            if (m && m.has2d) return m.base;
        }
        return '';
    }

    // Determine effective chassis, trimLine & colour:
    // 1) User override on App MyBMW wins first (auto-promoting F90 + clubsport -> F90LCI where M5 CS TrimL lives)
    // 2) HU_MGU live coding (`rawcodingdata` BAUREIHE + TRIM_LINE + VEHICLE_COLOUR, e.g. F90LCI clubsport M5 CS!)
    // 3) HmiMain3D / HmiKombi open vehicle bundles, falling back to VIN trueChassis only if MGU coding is absent
    let overChassis = String(override.chassis || '').trim().toUpperCase();
    const overTrim = String(override.trimLine || '').trim();
    const overColour = String(override.colour || '').trim();
    const trueChassis = String(opts.trueChassis || '').trim().toUpperCase();
    const codedBaureihe = coding.valid && coding.baureihe ? coding.baureihe.toUpperCase() : '';

    const effectiveTrimLine = overTrim || (coding.valid ? coding.trimLine : '');
    if (overChassis === 'F90' && (effectiveTrimLine === 'clubsport' || codedBaureihe === 'F90LCI')) {
        overChassis = 'F90LCI';
    }

    let wantedCode = overChassis || codedBaureihe || kombiModel.toUpperCase() || trueChassis;
    if (wantedCode === 'F90' && effectiveTrimLine === 'clubsport') {
        wantedCode = 'F90LCI';
    }
    let chosenBase = find2dForCode(wantedCode);
    if (!chosenBase) {
        const openWith2d = open2d.concat(open3d).filter((b) => fs.existsSync(path.join(b, 'vehicle2D_big', 'bitmaps.res')) || fs.existsSync(path.join(b, 'vehicle2D_small', 'bitmaps.res')));
        chosenBase = openWith2d[0] || '';
    }
    if (!chosenBase && availableModels.length) {
        const pref = availableModels.find((c) => c === 'F90LCI' || c === 'G30LCI' || c === 'G30' || c === 'G01LCI' || c === 'G01' || c === 'G20') || availableModels.find((c) => c !== 'F40') || availableModels[0];
        if (pref && modelMap[pref]) chosenBase = modelMap[pref].base;
    }
    if (!chosenBase && wantedCode && modelMap[wantedCode]) {
        chosenBase = modelMap[wantedCode].base;
    }

    const modelName = overChassis || codedBaureihe || (chosenBase ? path.basename(chosenBase) : (kombiModel || trueChassis));
    const renderModelName = chosenBase ? path.basename(chosenBase) : modelName;
    const brand = chosenBase && chosenBase.indexOf('/bmwm/') >= 0 ? 'bmwm' : (chosenBase && chosenBase.indexOf('/mini/') >= 0 ? 'mini' : 'bmw');

    const hmiFile = (rel) => {
        const p1 = path.join(hmiRoot, brand, 'id7', rel);
        if (fs.existsSync(p1)) return p1;
        const p2 = path.join(hmiRoot, 'bmw', 'id7', rel);
        return fs.existsSync(p2) ? p2 : '';
    };

    const effectiveColour = overColour || (coding.valid ? coding.colour : '');

    let trim = kombiTrim || 'A';
    if (renderModelName && (overTrim || (coding.valid && coding.trimCode !== 0) || !kombiTrim)) {
        trim = CARPAINT.resolveHeroTrim(renderModelName, effectiveTrimLine || 'base', hmiFile('script/hmi_script.lua')) || trim;
    }

    let paint = CARPAINT.resolvePaint(
        effectiveColour,
        hmiFile('widget/VEHICLE_CARPAINT_colorregistry.pbc'),
        hmiFile('widget/variantregistry_ext_car.pbvar')
    );
    if (effectiveColour && BUILTIN_PAINTS[effectiveColour] && (!paint || paint.name === 'DEFAULT' || (paint.name === 'alpin_white_U300' && effectiveColour !== 'alpin_white'))) {
        paint = BUILTIN_PAINTS[effectiveColour];
    }

    const meta = formatVehicleIdentity({
        modelName,
        baureihe: coding.valid ? coding.baureihe : '',
        trimLine: effectiveTrimLine,
        colour: effectiveColour,
        paint,
    });
    meta.codedChassis = codedBaureihe;
    meta.trueChassis = trueChassis;
    meta.kombiSpoofed = !!(trueChassis && codedBaureihe && trueChassis !== codedBaureihe);

    // Extract genuine 2D studio bitmap + exact paint mask across BOTH `vehicle2D_big` and `vehicle2D_small`,
    // ranking exact trim match (e.g. F90LCI TrimL gold wheels & gold grille) ahead of bitmap size!
    let pngBuf = null;
    let heroNote = '';
    if (chosenBase) {
        const subs = ['vehicle2D_big', 'vehicle2D_small'];
        const candidates = [];
        const cleanBaseName = path.basename(chosenBase);
        for (let si = 0; si < subs.length; si++) {
            const sub = subs[si];
            const dir = path.join(chosenBase, sub);
            const idsPath = path.join(dir, 'bitmaps.res.ids');
            const resPath = path.join(dir, 'bitmaps.res');
            const origBackup = path.join(mguStudioBackupDir, 'car-' + (brand === 'bmw' ? '' : brand + '-') + cleanBaseName + '-' + sub.slice(10) + '.res.orig');
            const actualRes = fs.existsSync(origBackup) ? origBackup : resPath;
            if (!fs.existsSync(actualRes) || !fs.existsSync(idsPath)) continue;
            try {
                const parsed = new W.Bundle(fs.readFileSync(actualRes), fs.readFileSync(idsPath, 'utf8'));
                const scene = CARPAINT.readSceneTrims(path.join(dir, 'scene.pbx'));
                const isMask = (k) => (scene && scene.picOfMask[k] && parsed.byKey[scene.picOfMask[k]] ? true : /_mask_?\d*_bitmap$/.test(k));
                const trimOf = (k) => {
                    if (scene && scene.trimOfPic[k]) return scene.trimOfPic[k];
                    const m = /trim_?([A-Za-z]+)(?:_?\d+)?_bitmap$/i.exec(k);
                    return m ? m[1].toUpperCase() : '';
                };
                const pics = parsed.entries.filter((e) => !isMask(e.key));
                const masks = parsed.entries.filter((e) => isMask(e.key));
                if (!pics.length) continue;

                const exactSceneKey = (scene && scene.byTrim && scene.byTrim[trim] && parsed.byKey[scene.byTrim[trim].pic])
                    ? scene.byTrim[trim].pic
                    : '';
                for (let pi = 0; pi < pics.length; pi++) {
                    const pEntry = pics[pi];
                    const pTrim = trimOf(pEntry.key);
                    const rank = (pEntry.key === exactSceneKey || pTrim === trim) ? 0
                        : (pTrim === 'E' ? 1 : (pTrim === 'A' ? 2 : 3));
                    candidates.push({
                        sub,
                        parsed,
                        scene,
                        masks,
                        pick: pEntry,
                        rank,
                    });
                }
            } catch (e) {
                heroNote = 'err:' + e.message;
            }
        }

        candidates.sort((a, b) => (a.rank - b.rank) || (b.pick.w - a.pick.w));
        for (let ci = 0; ci < candidates.length && !pngBuf; ci++) {
            const c = candidates[ci];
            const pick = c.pick;
            try {
                let maskEntry = null;
                if (c.scene && c.scene.byTrim && c.scene.byTrim[trim] && c.scene.byTrim[trim].pic === pick.key && c.scene.byTrim[trim].mask) {
                    maskEntry = c.masks.find((m) => m.key === c.scene.byTrim[trim].mask) || null;
                }
                if (!maskEntry) maskEntry = findMaskForPic(pick.key, c.masks, c.scene);
                const rawPic = c.parsed.rgba(pick.key);
                const rawMask = maskEntry ? c.parsed.rgba(maskEntry.key) : Buffer.alloc(pick.w * pick.h * 4);
                let shaded = CARPAINT.shadeCarpaint(rawPic, rawMask, paint);

                // Ensure ultra-dark paints (e.g. Black2 / Sapphire Black) still show crisp studio highlights against #050811
                let opaquePx = 0, brightPx = 0;
                for (let p = 0; p < shaded.length; p += 16) {
                    if (shaded[p + 3] > 40) {
                        opaquePx++;
                        if (shaded[p] + shaded[p + 1] + shaded[p + 2] > 42) brightPx++;
                    }
                }
                if (opaquePx < 60) continue; // Skip empty/corrupted bitmap entry and try next candidate
                if (brightPx < opaquePx * 0.14 && paint && paint.base && paint.spec && paint.refl) {
                    const liftedPaint = {
                        name: paint.name,
                        base: [Math.max(0.06, paint.base[0] * 1.35), Math.max(0.065, paint.base[1] * 1.35), Math.max(0.075, paint.base[2] * 1.35), Math.min(3.8, paint.base[3])],
                        spec: [Math.max(0.68, paint.spec[0] * 1.25), Math.max(0.70, paint.spec[1] * 1.25), Math.max(0.75, paint.spec[2] * 1.25), paint.spec[3]],
                        refl: [Math.max(0.95, paint.refl[0] * 1.15), Math.max(0.97, paint.refl[1] * 1.15), Math.max(1.02, paint.refl[2] * 1.15), paint.refl[3]],
                    };
                    shaded = CARPAINT.shadeCarpaint(rawPic, rawMask, liftedPaint);
                }

                const topDown = W.flipRows(shaded, pick.w, pick.h);
                const cropped = cropAlphaBounds(topDown, pick.w, pick.h);
                const targetW = Math.min(600, cropped.w);
                const targetH = Math.max(1, Math.round(cropped.h * targetW / cropped.w));
                const scaled = W.resize(cropped.rgba, cropped.w, cropped.h, targetW, targetH);
                pngBuf = encodeCompactPng(scaled, targetW, targetH);
                heroNote = cleanBaseName + '/' + c.sub + ':' + pick.key + (maskEntry ? '+' + maskEntry.key : '');
            } catch (e) {
                heroNote = 'err:' + e.message;
            }
        }
    }
    meta.renderSource = heroNote;

    const paintRgb = paint && paint.base ? [
        Math.round(Math.min(1, Math.max(0, paint.base[0])) * 255),
        Math.round(Math.min(1, Math.max(0, paint.base[1])) * 255),
        Math.round(Math.min(1, Math.max(0, paint.base[2])) * 255),
    ] : null;
    meta.paintRgb = paintRgb;
    meta.availableModels = availableModels.slice(0, 40);

    return {
        detected: !!(meta.chassis || pngBuf),
        meta,
        trimCode: trim,
        paintRgb,
        availableModels,
        png: pngBuf,
    };
}

module.exports = {
    SERIES_TITLES,
    TRIM_LABELS,
    BUILTIN_PAINTS,
    prettifyPaint,
    formatVehicleIdentity,
    cropAlphaBounds,
    encodeCompactPng,
    findMaskForPic,
    scanFactoryVehicle,
};
