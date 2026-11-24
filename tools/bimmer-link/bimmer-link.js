'use strict';
/**
 * bimmer-link.js - main root helper daemon for the "MyBMW & 1CR" MGU Store app.
 *
 * Responsibilities:
 *   1. Supervises `car-link.js worker` (SOME/IP + UDS vehicle telemetry & 1CR Remote Start / Departure Timer engine).
 *   2. Extracts & shades genuine BMW factory 2D studio vehicle PNG (`car-hero.js`) with optional owner paint/model override,
 *      retrying chunked Cloud upload until confirmed so phones always display the exact car & paint color.
 *   3. Runs `CloudBridge` (AES-256-GCM over `ntfy.sh` with server-cursor command polling + instant `cmd_ack` replies)
 *      and `TelegramController` over `mgu-uplink`.
 *   4. Serves the PIN-protected local setup & 1CR Inspector portal on HTTP port 8139 (with `nftables` rule).
 *   5. Exchanges zero-flash-wear live state & commands with `apps/bimmer_link` through `/run/bimmer-link/`.
 *
 * Node 8, zero dependencies.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const urlMod = require('url');
const crypto = require('crypto');
const cp = require('child_process');

const Up = require('./uplink');
const Snap = require('./snapshot');
const Tg = require('./telegram');
const CarLink = require('./car-link');
const Cloud = require('./cloud');
const CarHero = require('./car-hero');
const Cam360 = require('./cam360');

const VERSION = '0.6.0';
const FW_TAG = 'bimmer-link';
const APP_RE = /^bimmer_link\d*$/;

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CFG = {
    run: env('BL_RUN', '/run/bimmer-link'),
    state: env('BL_STATE', '/var/opt/bimmer-link'),
    oap: env('BL_OAP', '/var/opt/public/oap'),
    proc: env('BL_PROC', '/proc'),
    port: Number(env('BL_PORT', 8139)),
    nft: env('BL_NFT', 'nft'),
    route: env('BL_ROUTE', '/proc/net/route'),
    ips: env('BL_IPS', ''),
    noServer: env('BL_NO_SERVER', '') === '1',
    noWorker: env('BL_NO_WORKER', '') === '1',
    workerScript: env('BL_WORKER', path.join(__dirname, 'car-link.js')),
    tgBaseUrl: env('BL_TG_BASE', ''),
    noCloud: env('BL_NO_CLOUD', '') === '1',
    relayHost: env('BL_RELAY_HOST', ''),
};

const LOGS = [];
function log(m) {
    const line = new Date().toISOString() + ' ' + m;
    LOGS.push(line);
    if (LOGS.length > 200) LOGS.shift();
    process.stdout.write(m + '\n');
}

const mkdirp = (d) => {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
};
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
function writeAtomic(file, data, mode) {
    mkdirp(path.dirname(file));
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, data, { mode: mode || 0o644 });
    fs.renameSync(tmp, file);
}

function defaultConfig() {
    return {
        botToken: '',
        chatId: '',
        ownerName: '',
        parkSnapshot: true,
        wakeNotify: false,
        autoSyncTimer: false,
        dailyTimer: '07:30',
        appearance: {
            chassis: '',
            trimLine: '',
            colour: '',
        },
        valet: {
            enabled: false,
            maxSpeed: 45,
            maxRpm: 3500,
            radiusM: 500,
            anchorPos: null,
        },
        servicePlan: {
            oilDueKm: 0,
            oilIntervalKm: 8000,
            checkDueKm: 0,
            brakeFluidDue: '',
        },
        destination: null,
    };
}

function normalizeConfig(raw) {
    const d = defaultConfig();
    const r = raw && typeof raw === 'object' ? raw : {};
    const v = r.valet && typeof r.valet === 'object' ? r.valet : {};
    const ap = r.appearance && typeof r.appearance === 'object' ? r.appearance : {};
    const sp = r.servicePlan && typeof r.servicePlan === 'object' ? r.servicePlan : {};
    const dst = r.destination && typeof r.destination === 'object' ? r.destination : null;
    return {
        botToken: typeof r.botToken === 'string' ? r.botToken.trim() : '',
        chatId: r.chatId !== undefined && r.chatId !== null ? String(r.chatId).trim() : '',
        ownerName: typeof r.ownerName === 'string' ? r.ownerName.slice(0, 60) : '',
        parkSnapshot: r.parkSnapshot !== false,
        wakeNotify: !!r.wakeNotify,
        autoSyncTimer: !!r.autoSyncTimer,
        dailyTimer: /^\d{2}:\d{2}$/.test(String(r.dailyTimer || '')) ? String(r.dailyTimer) : d.dailyTimer,
        appearance: {
            chassis: typeof ap.chassis === 'string' ? ap.chassis.trim().toUpperCase().slice(0, 20) : '',
            trimLine: typeof ap.trimLine === 'string' ? ap.trimLine.trim().slice(0, 40) : '',
            colour: typeof ap.colour === 'string' ? ap.colour.trim().slice(0, 60) : '',
        },
        valet: {
            enabled: !!v.enabled,
            maxSpeed: Math.max(20, Math.min(140, Number(v.maxSpeed) || d.valet.maxSpeed)),
            maxRpm: Math.max(2000, Math.min(7000, Number(v.maxRpm) || d.valet.maxRpm)),
            radiusM: Math.max(100, Math.min(10000, Number(v.radiusM) || d.valet.radiusM)),
            anchorPos: (v.anchorPos && typeof v.anchorPos.lat === 'number' && typeof v.anchorPos.lon === 'number') ? v.anchorPos : null,
        },
        servicePlan: {
            oilDueKm: Math.max(0, Math.round(Number(sp.oilDueKm) || 0)),
            oilIntervalKm: Math.max(3000, Math.min(25000, Math.round(Number(sp.oilIntervalKm) || d.servicePlan.oilIntervalKm))),
            checkDueKm: Math.max(0, Math.round(Number(sp.checkDueKm) || 0)),
            brakeFluidDue: typeof sp.brakeFluidDue === 'string' ? sp.brakeFluidDue.trim().slice(0, 20) : '',
        },
        destination: (dst && CarLink.validCoords(Number(dst.lat), Number(dst.lon))) ? {
            name: String(dst.name || 'Điểm đến từ MyBMW').slice(0, 80),
            address: String(dst.address || '').slice(0, 140),
            lat: Number(dst.lat),
            lon: Number(dst.lon),
            sentAt: Number(dst.sentAt) || Date.now(),
        } : null,
    };
}

function newPin() {
    const n = crypto.randomBytes(2).readUInt16BE(0) % 9000 + 1000;
    return String(n);
}

/* ---------------- Network IP discovery & nftables port management ---------------- */

let lastIfaces = {};
function addresses() {
    if (CFG.ips) return CFG.ips.split(',').filter(Boolean);
    let via = '';
    try {
        const rows = fs.readFileSync(CFG.route, 'utf8').split('\n').slice(1)
            .map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 7 && c[1] === '00000000' && c[7] === '00000000');
        rows.sort((x, y) => Number(x[6]) - Number(y[6]));
        via = rows.length ? rows[0][0] : '';
    } catch (e) { via = ''; }
    const out = [];
    const nets = os.networkInterfaces();
    Object.keys(nets).forEach((name) => (nets[name] || []).forEach((a) => {
        if (a.internal || (a.family !== 'IPv4' && a.family !== 4) || /^169\.254\./.test(a.address)) return;
        const range = /^192\.168\./.test(a.address) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(a.address) ? 1 : /^10\./.test(a.address) ? 2 : 3;
        out.push({ ip: a.address, iface: name, rank: (name === via ? 0 : /^(wl|ml|uap|ap|wifi)/i.test(name) ? 10 : 20) + range });
    }));
    lastIfaces = {};
    out.forEach((a) => { lastIfaces[a.ip] = a.iface; });
    return out.sort((a, b) => a.rank - b.rank).map((a) => a.ip);
}

function execNft(args) {
    return new Promise((resolve, reject) => cp.execFile(CFG.nft, args, { timeout: 10000, maxBuffer: 2 << 20 }, (err, out, stderr) => {
        if (!err) return resolve(out);
        const e = new Error('nft ' + args.join(' ') + ': ' + (String(stderr || '').trim() || err.message));
        e.absent = err.code === 'ENOENT' || /No such file or directory/.test(String(stderr));
        reject(e);
    }));
}

const fwRules = (out) => out.split('\n').filter((l) => /# handle \d+\s*$/.test(l) && !/^\s*(chain|table)\b/.test(l));
const fwMine = (rules) => rules.filter((l) => l.indexOf('comment "' + FW_TAG + '"') >= 0);

async function fwClose(nft) {
    nft = nft || execNft;
    let out;
    try { out = await nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']); } catch (e) { if (e.absent) return 'absent'; throw e; }
    const mine = fwMine(fwRules(out));
    for (let i = 0; i < mine.length; i++) {
        const m = /# handle (\d+)\s*$/.exec(mine[i]);
        if (m) await nft(['delete', 'rule', 'ip', 'filter', 'input', 'handle', m[1]]);
    }
    return 'closed';
}

async function fwEnsure(port, iface, nft) {
    nft = nft || execNft;
    let out;
    try { out = await nft(['-a', 'list', 'chain', 'ip', 'filter', 'input']); } catch (e) { if (e.absent) return 'absent'; throw e; }
    const mine = fwMine(fwRules(out));
    if (mine.length === 1 && mine[0].indexOf('tcp dport ' + port) >= 0 && (!iface || mine[0].indexOf('"' + iface + '"') >= 0)) return 'kept';
    for (let i = 0; i < mine.length; i++) {
        const m = /# handle (\d+)\s*$/.exec(mine[i]);
        if (m) await nft(['delete', 'rule', 'ip', 'filter', 'input', 'handle', m[1]]);
    }
    const args = ['insert', 'rule', 'ip', 'filter', 'input'];
    if (iface) args.push('iifname', iface);
    args.push('tcp', 'dport', String(port), 'accept', 'comment', FW_TAG);
    await nft(args);
    return 'added';
}

/* ---------------- App discovery & zero-flash RAM IPC folder ---------------- */

let appFindCache = { oapRoot: '', at: 0, app: null };
let appProcCache = { root: '', procDir: '', at: 0, who: null };

function findInstalledApp(oapRoot) {
    const now = Date.now();
    if (appFindCache.oapRoot === oapRoot && appFindCache.app && fs.existsSync(appFindCache.app.spec)) {
        return appFindCache.app;
    }
    if (appFindCache.oapRoot === oapRoot && !appFindCache.app && now - appFindCache.at < 4000) {
        return null;
    }
    let dirs = [];
    try { dirs = fs.readdirSync(oapRoot).filter((d) => /^oap_\d+$/.test(d)); } catch (e) { return null; }
    for (let i = 0; i < dirs.length; i++) {
        const rels = ['source/javascript/kit/app-spec.json', 'javascript/kit/app-spec.json'];
        for (let k = 0; k < rels.length; k++) {
            const specPath = path.join(oapRoot, dirs[i], rels[k]);
            const s = readJson(specPath);
            if (s && typeof s.id === 'string' && APP_RE.test(s.id)) {
                const found = { id: s.id, root: path.join(oapRoot, dirs[i]), spec: specPath };
                appFindCache = { oapRoot, at: now, app: found };
                return found;
            }
        }
    }
    appFindCache = { oapRoot, at: now, app: null };
    return null;
}

function findAppProcessUid(app, procDir) {
    if (!app || !procDir) return null;
    const now = Date.now();
    if (
        appProcCache.root === app.root &&
        appProcCache.procDir === procDir &&
        now - appProcCache.at < 15000 &&
        (!appProcCache.who || fs.existsSync(path.join(procDir, String(appProcCache.who.pid))))
    ) {
        return appProcCache.who;
    }
    let who = null;
    let pids = [];
    try { pids = fs.readdirSync(procDir).filter((d) => /^\d+$/.test(d) && Number(d) !== process.pid); } catch (e) { pids = []; }
    const inApp = (s) => !!s && (s === app.root || s.indexOf(app.root + '/') >= 0 || s.indexOf(app.root + '\0') >= 0);
    for (let i = 0; i < pids.length; i++) {
        const base = path.join(procDir, pids[i]);
        let cmd = null, cwd = null;
        try { cmd = fs.readFileSync(path.join(base, 'cmdline'), 'latin1'); } catch (e) {}
        try { cwd = fs.readlinkSync(path.join(base, 'cwd')); } catch (e) {}
        if (!inApp(cmd) && !inApp(cwd)) continue;
        try {
            const st = fs.readFileSync(path.join(base, 'status'), 'utf8');
            const u = /^Uid:\s+(\d+)/m.exec(st), g = /^Gid:\s+(\d+)/m.exec(st);
            if (u && g && Number(u[1]) > 0) {
                who = { uid: Number(u[1]), gid: Number(g[1]), pid: Number(pids[i]) };
                break;
            }
        } catch (e) {}
    }
    appProcCache = { root: app.root, procDir, at: now, who };
    return who;
}

function ensureAppRamDir(runDir, oapRoot, procDir) {
    const app = findInstalledApp(oapRoot);
    if (!app) return null;
    const appRun = path.join(runDir, 'app');
    mkdirp(appRun);
    let uid = null, gid = null, fromProc = false;
    try {
        if (!fs.lstatSync(appRun).isDirectory()) {
            fs.unlinkSync(appRun);
            fs.mkdirSync(appRun, 0o770);
        }
        const who = findAppProcessUid(app, procDir);
        if (who) {
            uid = who.uid;
            gid = who.gid;
            fromProc = true;
        } else {
            const st = fs.statSync(path.join(app.root, 'data'));
            uid = st.uid;
            gid = st.gid;
        }
        if (uid > 0 && typeof process.getuid === 'function' && process.getuid() === 0) {
            fs.chownSync(appRun, uid, gid);
            fs.chmodSync(appRun, 0o770);
        }
    } catch (e) {}
    return { id: app.id, root: app.root, uid, gid, fromProc };
}

/* ---------------- Main Service State & Orchestration ---------------- */

function createService(customCfg) {
    const C = Object.assign({}, CFG, customCfg || {});
    mkdirp(C.run);
    mkdirp(C.state);

    const cfgFile = path.join(C.state, 'config.json');
    const tripsFile = path.join(C.state, 'trips.json');
    let config = normalizeConfig(readJson(cfgFile));
    let trips = Array.isArray(readJson(tripsFile)) ? readJson(tripsFile).slice(0, 20) : [];

    const saveConfig = () => writeAtomic(cfgFile, JSON.stringify(config, null, 2) + '\n', 0o600);
    const saveTrips = () => writeAtomic(tripsFile, JSON.stringify(trips.slice(0, 20), null, 2) + '\n', 0o644);

    const S = {
        pin: newPin(),
        port: C.port,
        ipIndex: 0,
        telemetry: new CarLink.TelemetryTracker().state,
        activeTrip: null,
        lastTrip: trips[0] || null,
        workerUp: false,
        message: 'Sẵn sàng. Quét mã QR bên trái để ghép App MyBMW (iPhone / Android).',
        messageKind: 'dim',
        seenCmdId: -1,
        valetAlerts: {},
        badPins: {},
        worker: null,
        pendingReqs: {},
        reqSeq: 1,
        wantCamUntil: 0,
        oapReq: null,
        oapSeq: 1,
        server: null,
    };

    const upOpts = Up.options({
        stateDir: path.join(C.state, 'state'),
        oapRoot: C.oap,
        procDir: C.proc,
        route: C.route,
        baseUrl: C.tgBaseUrl,
        noSetuid: !!C.tgBaseUrl,
        log,
    });

    const tell = (msg, kind) => { S.message = msg; S.messageKind = kind || 'go'; writeStatus(); };

    const tg = new Tg.TelegramController({
        upOpts,
        getConfig: () => config,
        log,
        onAction: (act, arg) => executeAction(act, arg, 'Telegram'),
    });

    const identity = Cloud.loadOrCreateIdentity(path.join(C.state, 'cloud-identity.json'));
    let heroData = { detected: false, meta: { chassis: '', modelTitle: 'BMW iDrive 7', series: 'BMW', trimLabel: '', paintLabel: '', paintRgb: null, availableModels: [] }, png: null };
    let heroConfirmedSig = '';
    let lastTrueChassis = '';

    function computeHeroSig() {
        return JSON.stringify([heroData.meta.chassis, heroData.meta.trimLine, heroData.meta.colour, heroData.meta.renderSource]) + '|' + (heroData.png ? heroData.png.length : 0);
    }

    function refreshFactoryHero(forcePush) {
        try {
            const scanned = CarHero.scanFactoryVehicle({
                procDir: C.proc,
                override: config.appearance,
                trueChassis: S.telemetry && S.telemetry.trueChassis,
                kombiSpoofed: !!(S.telemetry && S.telemetry.kombiSpoofed),
            });
            if (scanned && (scanned.detected || scanned.png)) {
                heroData = scanned;
                if (scanned.png) {
                    try { writeAtomic(path.join(C.run, 'hero.png'), scanned.png, 0o644); } catch (e) {}
                }
            }
        } catch (e) { log('hero scan err: ' + e.message); }

        const sig = computeHeroSig();
        if (forcePush) heroConfirmedSig = '';
        if (heroData.png && sig !== heroConfirmedSig) {
            cloud.publishHero(heroData.png, {
                title: heroData.meta.modelTitle,
                paint: heroData.meta.paintLabel,
                at: Date.now(),
            }).then((ok) => {
                if (ok) {
                    heroConfirmedSig = sig;
                    log('factory hero uploaded (' + heroData.meta.chassis + ' ' + heroData.meta.paintLabel + ', ' + heroData.png.length + ' bytes)');
                }
            }).catch((e) => {
                log('hero upload deferred: ' + e.message);
            });
        }
        writeStatus();
    }

    const cloud = new Cloud.CloudBridge({
        identity,
        upOpts,
        relayHost: C.relayHost || undefined,
        seenFile: path.join(C.state, 'seen-cmds.json'),
        enabled: !C.noCloud,
        log,
        onCommand: async (cmdObj) => {
            const c = String(cmdObj.cmd || '');
            const a = cmdObj.arg || {};
            const ack = (ok, message, detail) => cloud.publishDiag({
                t: 'cmd_ack',
                id: cmdObj.id,
                cmd: c,
                ok: !!ok,
                message: String(message || ''),
                detail: detail || null,
                at: Date.now(),
            }).catch(() => {});

            if (c === 'refresh_hero') {
                refreshFactoryHero(true);
                syncCloudState(true);
                await ack(true, 'Đang đồng bộ lại mẫu xe & màu sơn từ đầu MGU (' + (heroData.meta.modelTitle || 'BMW') + ')…');
                return;
            }
            if (c === 'set_appearance') {
                if (a.reset) {
                    config.appearance = { chassis: '', trimLine: '', colour: '' };
                } else {
                    config.appearance = normalizeConfig({ appearance: Object.assign({}, config.appearance, a) }).appearance;
                }
                saveConfig();
                refreshFactoryHero(true);
                const desc = heroData.meta.modelTitle + (heroData.meta.paintLabel ? (' · ' + heroData.meta.paintLabel) : '');
                tell('Đã cập nhật giao diện xe: ' + desc, 'go');
                syncCloudState(true);
                await ack(true, 'Đã render xe chuẩn hãng: ' + desc);
                return;
            }
            if (c === 'schema') {
                const oapLiveRep = await callOapBridge('ClimateMaster', 'read_1cr_live', 'all', {}, undefined, 2200);
                const rep = await callWorker('schema', { oapLive: (oapLiveRep && oapLiveRep.liveAfter) || null }, 5000);
                await cloud.publishDiag({
                    t: 'schema',
                    reqId: cmdObj.id,
                    schema: (rep && rep.schema) || { interfaces: [], live: {}, pinnedProfile: null },
                    logs: LOGS.slice(-30),
                });
                return;
            }
            if (c === 'invoke_raw') {
                let res = null;
                const oapRes = await callOapBridge(a.iface, a.kind, a.name, a.payload, undefined, 3600);
                if (oapRes && oapRes.ok) {
                    const vRep = await callWorker('verify_1cr', { waitMs: oapRes.liveAfter ? 250 : 700, oapLive: oapRes.liveAfter || null }, 3500);
                    const vd = (vRep && vRep.result && vRep.result.verdict) || null;
                    res = { ok: true, via: 'OAP-ACL', verified: !!(vd && vd.active), verdict: vd, trace: [oapRes], saved: !!a.saveAsDefault };
                    if (a.saveAsDefault) {
                        const profFile = path.join(C.state, '1cr-profile.json');
                        const cur = readJson(profFile) || {};
                        cur[a.role || 'start'] = { iface: a.iface, kind: a.kind, name: a.name, payload: a.payload };
                        writeAtomic(profFile, JSON.stringify(cur, null, 2) + '\n', 0o600);
                    }
                } else {
                    const rep = await callWorker('invoke_raw', a, 5000);
                    res = (rep && rep.result) || rep;
                }
                await cloud.publishDiag({ t: 'raw_result', reqId: cmdObj.id, result: res });
                syncCloudState(true);
                return;
            }
            if (c === 'valet_prefs' && a) {
                config.valet = normalizeConfig({ valet: Object.assign({}, config.valet, a) }).valet;
                saveConfig();
                tell('Đã cập nhật ngưỡng Valet từ App MyBMW.', 'go');
                syncCloudState(true);
                await ack(true, 'Đã lưu ngưỡng giám sát Valet mới!');
                return;
            }
            if (c === 'timer_prefs' && a) {
                if (typeof a.autoSyncTimer === 'boolean') config.autoSyncTimer = a.autoSyncTimer;
                if (a.dailyTimer) config.dailyTimer = String(a.dailyTimer);
                saveConfig();
                syncCloudState(true);
                await ack(true, 'Đã lưu tuỳ chọn tự đồng bộ hẹn giờ 1CR!');
                return;
            }

            if (c === 'snap_now') {
                await ack(true, '📸 Xe đang chụp ảnh 360° & đọc thông số — chờ ~3 giây…');
            } else if (c === 'scan_health') {
                await ack(true, '🩺 Xe đang quét 8 hộp ECU (DME, Hộp số, BDC, Phanh, Điều hoà…) — chờ ~2 giây…');
            }
            const out = await executeAction(c, a, cmdObj.device || 'MyBMW App');
            syncCloudState(true);
            await ack(out && out.ok, (out && (out.message || out.error)) || 'Đã xử lý lệnh.', out && out.detail);
        },
    });

    function cloudSnapshotPayload(extra) {
        const lanEndpoints = !C.noServer ? addresses().map((ip) => 'http://' + ip + ':' + S.port) : [];
        return Object.assign({
            version: VERSION,
            lanEndpoints,
            vehicleProfile: heroData.meta,
            appearanceOverride: config.appearance,
            hasFactoryHero: !!heroData.png,
            telemetry: S.telemetry,
            lastTrip: S.lastTrip,
            trips: trips.slice(0, 12),
            valet: config.valet,
            servicePlan: config.servicePlan,
            destination: config.destination,
            autoSyncTimer: config.autoSyncTimer,
            dailyTimer: config.dailyTimer,
            message: S.message,
            messageKind: S.messageKind,
        }, extra || {});
    }

    function syncCloudState(force, extra) {
        cloud.publishState(cloudSnapshotPayload(extra), !!force).catch(() => {});
    }

    function callWorker(op, params, timeoutMs) {
        if (!S.worker || !S.worker.stdin || S.worker.killed) {
            return Promise.resolve({ ok: false, error: 'Trợ thủ tín hiệu xe chưa chạy' });
        }
        const id = ++S.reqSeq;
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                delete S.pendingReqs[id];
                resolve({ ok: false, error: 'Quá thời gian chờ phản hồi từ xe' });
            }, timeoutMs || 6000);
            S.pendingReqs[id] = (msg) => { clearTimeout(timer); resolve(msg); };
            try { S.worker.stdin.write(JSON.stringify({ reqId: id, op, params: params || {} }) + '\n'); } catch (e) {
                clearTimeout(timer);
                delete S.pendingReqs[id];
                resolve({ ok: false, error: e.message });
            }
        });
    }

    function startWorker() {
        if (C.noWorker || S.worker) return;
        const child = cp.spawn(process.execPath, [C.workerScript, 'worker'], {
            env: process.env,
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        S.worker = child;
        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
            buf += d;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                let msg = null;
                try { msg = JSON.parse(line); } catch (e) { continue; }
                onWorkerEvent(msg);
            }
        });
        child.on('close', () => {
            S.worker = null;
            S.workerUp = false;
            Object.keys(S.pendingReqs).forEach((k) => { S.pendingReqs[k]({ ok: false, error: 'worker restarted' }); delete S.pendingReqs[k]; });
            setTimeout(() => { if (!tg.stopped) startWorker(); }, 3000);
        });
    }

    function onWorkerEvent(msg) {
        if (!msg) return;
        if (msg.ev === 'ready') {
            S.workerUp = true;
            log('car-link ready (climate interfaces=' + msg.discoveredClimate + ')');
            writeStatus();
        } else if (msg.ev === 'telemetry') {
            S.workerUp = true;
            if (msg.state) S.telemetry = msg.state;
            S.activeTrip = msg.activeTrip || null;
            if (msg.lastTrip) S.lastTrip = msg.lastTrip;
            if (S.telemetry && S.telemetry.trueChassis && S.telemetry.trueChassis !== lastTrueChassis) {
                lastTrueChassis = S.telemetry.trueChassis;
                refreshFactoryHero(true);
                syncCloudState(true);
            }
            checkValetViolations();
            writeStatus();
            syncCloudState(false);
        } else if (msg.ev === 'parked') {
            if (msg.state) S.telemetry = msg.state;
            onCarParked(msg.trip || null);
        } else if (msg.ev === 'dwa_alarm') {
            if (msg.state) S.telemetry = msg.state;
            onDwaAlarmTriggered(msg.reason || 'DWA');
        } else if (msg.ev === 'reply' && msg.reqId && S.pendingReqs[msg.reqId]) {
            const cb = S.pendingReqs[msg.reqId];
            delete S.pendingReqs[msg.reqId];
            if (msg.state) S.telemetry = msg.state;
            cb(msg);
            writeStatus();
        } else if (msg.ev === 'log') {
            log('[car-link] ' + msg.text);
        }
    }

    let oapChain = Promise.resolve();
    function callOapBridge(iface, kind, name, payload, altPayload, timeoutMs) {
        const runOne = () => {
            const app = ensureAppRamDir(C.run, C.oap, C.proc);
            if (!app) return Promise.resolve({ ok: false, error: 'OAP app not installed' });
            const seq = ++S.oapSeq;
            S.oapReq = { seq, iface, kind, name, payload, altPayload, at: Date.now() };
            writeStatus();
            const deadline = Date.now() + (timeoutMs || 4200);
            const f1 = path.join(C.run, 'app', 'oap-reply.json');
            const f2 = path.join(app.root, 'data', 'oap-reply.json');
            return new Promise((resolve) => {
                const iv = setInterval(() => {
                    const r = readJson(f1) || readJson(f2);
                    if (r && r.seq === seq) {
                        clearInterval(iv);
                        if (S.oapReq && S.oapReq.seq === seq) { S.oapReq = null; writeStatus(); }
                        resolve(r);
                        return;
                    }
                    if (Date.now() >= deadline) {
                        clearInterval(iv);
                        if (S.oapReq && S.oapReq.seq === seq) { S.oapReq = null; writeStatus(); }
                        resolve({ ok: false, error: 'OAP bridge timeout' });
                    }
                }, 90);
            });
        };
        const p = oapChain.then(runOne, runOne);
        oapChain = p.catch(() => {});
        return p;
    }

    async function tryGrab360(timeoutMs) {
        if (C.noWorker) return null;
        const dur = timeoutMs || 6200;
        const rawPath = path.join(C.run, 'cam4.rgba');
        try { fs.unlinkSync(rawPath); } catch (e) {}
        try {
            return await Cam360.capture360Frame({
                runDir: C.run,
                rawOutFile: rawPath,
                timeoutMs: dur,
                wakeCam: async () => {
                    const r1 = await callOapBridge('ICAM2', 'cam_attach', 'cam', {}, undefined, 3200);
                    if (r1 && r1.ok) return r1;
                    return callWorker('cam_wake', {}, 3500);
                },
                releaseCam: async () => {
                    await callOapBridge('ICAM2', 'cam_detach', 'cam', {}, undefined, 1800).catch(() => {});
                    return callWorker('cam_release', {}, 2000).catch(() => {});
                },
                log,
            });
        } catch (e) {
            return null;
        }
    }

    async function onCarParked(trip) {
        if (trip && trip.distanceKm >= 0.1) {
            trips.unshift(trip);
            if (trips.length > 20) trips.length = 20;
            S.lastTrip = trip;
            saveTrips();
        }
        await callWorker('refresh_vitals', {}, 3500);

        if (config.autoSyncTimer && /^\d{2}:\d{2}$/.test(config.dailyTimer)) {
            const parts = config.dailyTimer.split(':');
            await callWorker('schedule1cr', { hour: Number(parts[0]), minute: Number(parts[1]), enabled: true, userInitiated: true }, 4500);
        }

        if (config.parkSnapshot) {
            const camGrab = await tryGrab360(4800);
            const camFrame = (camGrab && camGrab.ok && camGrab.rgba) ? { w: camGrab.width, h: camGrab.height, rgba: camGrab.rgba } : null;
            const snap = Snap.renderSnapshotPng(S.telemetry, { title: 'DA DO XE AN TOAN', modelTitle: heroData.meta.modelTitle, trip, valet: config.valet, at: Date.now() }, { camFrame, rawCamFile: path.join(C.run, 'cam4.rgba') });
            syncCloudState(true, { event: 'parked' });
            cloud.publishSnapshot(snap.png, { title: snap.hasCamera ? 'Ảnh 4 camera 360° lúc đỗ xe' : 'Đã đỗ xe', camMeta: snap.camMeta || null, at: Date.now() }).then((ok) => {
                log('park snapshot: hasCamera=' + snap.hasCamera + ', bytes=' + snap.png.length + ', sent=' + ok);
            }).catch(() => {});
            if (config.botToken && config.chatId) {
                try {
                    const cap = Tg.formatStatusCaption('XE VỪA ĐỖ XONG', S.telemetry, { trip, valet: config.valet });
                    await tg.sendSnapshotPhoto(snap.png, cap, S.telemetry, config.valet.enabled);
                    tell('Đã đồng bộ vị trí đỗ xe lên App MyBMW & Telegram.', 'go');
                } catch (e) {
                    log('park snapshot telegram error: ' + e.message);
                }
            } else {
                tell('Đã lưu ảnh & vị trí đỗ xe lên App MyBMW.', 'go');
            }
        } else {
            syncCloudState(true, { event: 'parked' });
        }
        writeStatus();
    }

    async function onDwaAlarmTriggered(reason) {
        const now = Date.now();
        if (S.valetAlerts.dwa && now - S.valetAlerts.dwa < 90000) return;
        S.valetAlerts.dwa = now;
        const alertReason = 'Báo động chống trộm DWA kích hoạt (' + reason + ')!';
        tell('🚨 CẢNH BÁO DWA: ' + alertReason, 'crit');
        const camGrab = await tryGrab360(4500);
        const camFrame = (camGrab && camGrab.ok && camGrab.rgba) ? { w: camGrab.width, h: camGrab.height, rgba: camGrab.rgba } : null;
        const snap = Snap.renderSnapshotPng(S.telemetry, { title: 'BAO DONG CHONG TROM DWA!', modelTitle: heroData.meta.modelTitle, alert: true, valet: config.valet, at: now }, { camFrame, rawCamFile: path.join(C.run, 'cam4.rgba') });
        syncCloudState(true, { alert: { kind: 'dwa_alarm', reason: alertReason, at: now } });
        cloud.publishSnapshot(snap.png, { title: '🚨 ' + alertReason, alert: true, camMeta: snap.camMeta || null, at: now }).catch(() => {});
        if (config.botToken && config.chatId) {
            const cap = Tg.formatStatusCaption('🚨 ' + alertReason, S.telemetry, { valet: config.valet });
            tg.sendSnapshotPhoto(snap.png, cap, S.telemetry, config.valet.enabled).catch((e) => log('dwa alert err: ' + e.message));
        }
        writeStatus();
    }

    function checkValetViolations() {
        const v = config.valet;
        if (!v || !v.enabled) return;
        const t = S.telemetry;
        const now = Date.now();
        const trigger = (kind, reason) => {
            if (S.valetAlerts[kind] && now - S.valetAlerts[kind] < 90000) return;
            S.valetAlerts[kind] = now;
            tell('CẢNH BÁO VALET: ' + reason, 'crit');
            const snap = Snap.renderSnapshotPng(t, { title: 'CANH BAO VALET: ' + reason, alert: true, valet: v, at: now }, { rawCamFile: path.join(C.run, 'cam4.rgba') });
            syncCloudState(true, { alert: { kind, reason, at: now } });
            cloud.publishSnapshot(snap.png, { title: 'Cảnh báo Valet: ' + reason, alert: true, camMeta: snap.camMeta || null, at: now }).catch(() => {});
            if (config.botToken && config.chatId) {
                const cap = Tg.formatStatusCaption('🚨 CẢNH BÁO VALET: ' + reason, t, { valet: v });
                tg.sendSnapshotPhoto(snap.png, cap, t, true).catch((e) => log('valet alert err: ' + e.message));
            }
        };

        if ((t.speed || 0) > v.maxSpeed) {
            trigger('speed', 'Tốc độ vượt mức (' + Math.round(t.speed) + ' > ' + v.maxSpeed + ' km/h)');
        }
        if ((t.rpm || 0) > v.maxRpm) {
            trigger('rpm', 'Đạp tua máy cao (' + Math.round(t.rpm) + ' > ' + v.maxRpm + ' RPM)');
        }
        if (v.anchorPos && t.pos) {
            const distM = Math.round(CarLink.haversineKm(v.anchorPos.lat, v.anchorPos.lon, t.pos.lat, t.pos.lon) * 1000);
            if (distM > v.radiusM) {
                trigger('geo', 'Xe ra khỏi bán kính cho phép (' + distM + 'm > ' + v.radiusM + 'm)');
            }
        }
    }

    /** Unified action handler called by MyBMW Cloud App, Telegram Bot, Phone QR Portal, and In-Car App. */
    async function executeAction(action, arg, source) {
        arg = arg || {};
        source = source || 'App';
        if (action === 'help') {
            const helpMsg =
                '🤖 Trợ lý MyBMW & 1CR (MGU Store)\n' +
                '  /status — Xem vị trí, xăng, bình 12V, cửa\n' +
                '  /photo — Chụp ảnh thẻ trạng thái / cam 360\n' +
                '  /1cr — Kích nổ máy / làm mát từ xa 1CR ngay\n' +
                '  /stop1cr — Tắt nổ máy từ xa 1CR\n' +
                '  /timer 17:15 — Nạp giờ nổ máy 1CR vào hộp BDC (chạy cả khi MGU ngủ)\n' +
                '  /valet on|off — Bật/tắt giám sát giao xe rửa xe / garage\n' +
                '  /trips — Xem lịch sử 5 chuyến đi gần nhất';
            if (config.botToken && config.chatId) await tg.sendMessage(helpMsg, S.telemetry, config.valet.enabled);
            return { ok: true, message: 'Đã gửi hướng dẫn.' };
        }

        if (action === 'status') {
            await callWorker('refresh_vitals', {}, 3500);
            const txt = Tg.formatStatusCaption('TRẠNG THÁI HIỆN TẠI', S.telemetry, { trip: S.lastTrip, valet: config.valet });
            if (config.botToken && config.chatId) await tg.sendMessage(txt, S.telemetry, config.valet.enabled);
            return { ok: true, message: 'Đã cập nhật thông số xe mới nhất.' };
        }

        if (action === 'snap_now') {
            const pairRes = await Promise.all([
                callWorker('refresh_vitals', {}, 3500),
                tryGrab360(4800),
            ]);
            const camGrab = pairRes[1];
            const camFrame = (camGrab && camGrab.ok && camGrab.rgba) ? { w: camGrab.width, h: camGrab.height, rgba: camGrab.rgba } : null;
            const snap = Snap.renderSnapshotPng(S.telemetry, { title: 'ANH CHUP TRUC TIEP TU XE', modelTitle: heroData.meta.modelTitle, trip: S.lastTrip, valet: config.valet, at: Date.now() }, { camFrame, rawCamFile: path.join(C.run, 'cam4.rgba') });
            syncCloudState(true);
            const snapLabel = snap.hasCamera ? '4 camera 360° quanh xe' : 'thẻ trạng thái đỗ xe';
            const cloudSent = await cloud.publishSnapshot(snap.png, { title: snap.hasCamera ? 'Ảnh 4 camera 360° trực tiếp' : 'Ảnh chụp trực tiếp', camMeta: snap.camMeta || null, at: Date.now() }).catch(() => false);
            log('snap_now: hasCamera=' + snap.hasCamera + ', bytes=' + snap.png.length + ', sent=' + cloudSent);
            if (config.botToken && config.chatId) {
                const cap = Tg.formatStatusCaption('ẢNH CHỤP TRỰC TIẾP TỪ XE', S.telemetry, { trip: S.lastTrip, valet: config.valet });
                await tg.sendSnapshotPhoto(snap.png, cap, S.telemetry, config.valet.enabled);
                tell('Đã chụp ' + snapLabel + ' & gửi lên App MyBMW + Telegram!', 'go');
                return { ok: true, hasCamera: snap.hasCamera, message: S.message };
            }
            tell(cloudSent ? ('Đã chụp ' + snapLabel + ' & gửi về App MyBMW!') : ('Đã chụp ' + snapLabel + '.'), 'go');
            return { ok: true, hasCamera: snap.hasCamera, message: S.message };
        }

        if (action === 'start1cr' || action === 'stop1cr') {
            const wantOn = action === 'start1cr';
            const preOap = await callOapBridge('ClimateMaster', 'read_1cr_live', 'all', {}, undefined, 1800);
            const prepRep = await callWorker('prepare_1cr', { wantOn, oapLive: (preOap && preOap.liveAfter) || null }, 4500);
            if (!prepRep || !prepRep.ok || !prepRep.result) {
                const fallbackErr = (prepRep && prepRep.error) || 'Trợ thủ tín hiệu xe chưa sẵn sàng';
                tell('1CR: ' + fallbackErr, 'warn');
                return { ok: false, error: fallbackErr };
            }
            const prep = prepRep.result;
            let verdict = prep.verdict || { active: false, mode: 'off' };
            const trace = [];

            if (wantOn && verdict.consentEnabled === false && Array.isArray(prep.consentCandidates)) {
                for (let ci = 0; ci < prep.consentCandidates.length; ci++) {
                    const cc = prep.consentCandidates[ci];
                    const oc = await callOapBridge(cc.iface, cc.kind, cc.name, cc.payload, cc.altPayload, 2500);
                    if (!oc || !oc.ok) await callWorker('invoke_one', cc, 2000);
                }
            }

            const cands = Array.isArray(prep.candidates) ? prep.candidates : [];
            let hitLabel = '';
            let lastVerifyRes = null;
            let lastOapLive = null;

            for (let i = 0; i < cands.length; i++) {
                const cd = cands[i];
                const shortName = cd.iface.split('.').pop() + '.' + cd.name + (cd.stage ? ('[' + cd.stage + ']') : '');
                const oapRes = await callOapBridge(cd.iface, cd.kind, cd.name, cd.payload, cd.altPayload, 3500);
                let sentAny = !!(oapRes && oapRes.ok);
                if (oapRes && oapRes.liveAfter) lastOapLive = oapRes.liveAfter;
                if (oapRes && oapRes.ok) {
                    const respNote = oapRes.response ? (' resp=' + JSON.stringify(oapRes.response)) : '';
                    log('1CR OAP ' + shortName + ': ok' + respNote);
                    trace.push({ via: 'OAP-ACL', step: shortName, response: oapRes.response || null });
                    if (oapRes.response && oapRes.response.accepted && /NOT_ACCEPTED/.test(String(oapRes.response.accepted))) {
                        continue;
                    }
                } else {
                    const wkRes = await callWorker('invoke_one', cd, cd.hasLiveProvider === false ? 1500 : 2400);
                    if (wkRes && wkRes.ok && wkRes.result && wkRes.result.ok) {
                        sentAny = true;
                        log('1CR Worker ' + shortName + ': ok');
                        trace.push({ via: 'worker', step: shortName, response: wkRes.result.response || null });
                    } else {
                        log('1CR ' + shortName + ' err: ' + ((oapRes && oapRes.error) || (wkRes && wkRes.result && wkRes.result.error) || 'fail'));
                    }
                }
                if (!sentAny) continue;

                if (!wantOn) {
                    hitLabel = shortName;
                    continue;
                }

                let vRep = await callWorker('verify_1cr', {
                    waitMs: (oapRes && oapRes.liveAfter) ? 250 : 800,
                    oapLive: (oapRes && oapRes.liveAfter) || null,
                }, 3500);
                lastVerifyRes = vRep && vRep.result;
                if (lastVerifyRes && lastVerifyRes.verdict) verdict = lastVerifyRes.verdict;

                if (!verdict.active && oapRes && oapRes.ok && cd.hasLiveProvider !== false) {
                    const wkTry = await callWorker('invoke_one', cd, 2000);
                    if (wkTry && wkTry.ok && wkTry.result && wkTry.result.ok) {
                        const liveChk = await callOapBridge('ClimateMaster', 'read_1cr_live', 'all', {}, undefined, 1600);
                        vRep = await callWorker('verify_1cr', {
                            waitMs: 550,
                            oapLive: (liveChk && liveChk.liveAfter) || null,
                        }, 3200);
                        lastVerifyRes = vRep && vRep.result;
                        if (lastVerifyRes && lastVerifyRes.verdict) verdict = lastVerifyRes.verdict;
                    }
                }

                if (verdict.active) {
                    hitLabel = shortName;
                    if (verdict.mode === 'auto_precond' && !verdict.engineRemoteActive) {
                        const crankLive = await callOapBridge('ClimateMaster', 'read_1cr_live', 'all', {}, undefined, 1800);
                        const crankCheck = await callWorker('verify_1cr', {
                            waitMs: 1100,
                            oapLive: (crankLive && crankLive.liveAfter) || null,
                        }, 3500);
                        if (crankCheck && crankCheck.result && crankCheck.result.verdict) {
                            verdict = crankCheck.result.verdict;
                        }
                    }
                    break;
                }
            }

            if (!wantOn) {
                const postOffOap = await callOapBridge('ClimateMaster', 'read_1cr_live', 'all', {}, undefined, 1600);
                const offRep = await callWorker('verify_1cr', {
                    waitMs: 450,
                    oapLive: (postOffOap && postOffOap.liveAfter) || lastOapLive || null,
                    lastAction: 'Tắt làm mát 1CR',
                    lastResult: 'Đã tắt 1CR',
                }, 3500);
                if (offRep && offRep.result && offRep.result.verdict) verdict = offRep.result.verdict;
                S.telemetry.climate1cr.active = !!verdict.active;
                const stopMsg = verdict.active
                    ? 'Đã gửi lệnh tắt 1CR nhưng hộp điều hoà vẫn báo đang chạy — hãy bấm thêm lần nữa.'
                    : ('Đã tắt đề nổ / làm mát 1CR' + (hitLabel ? (' (' + hitLabel + ')') : '') + '.');
                tell(stopMsg, verdict.active ? 'warn' : 'go');
                if (config.botToken && config.chatId) {
                    tg.sendMessage('⏹ ' + stopMsg, S.telemetry, config.valet.enabled).catch(() => {});
                }
                return { ok: !verdict.active, verified: !verdict.active, message: stopMsg, detail: { verdict, trace } };
            }

            S.telemetry.climate1cr.active = !!verdict.active;
            if (verdict.active) {
                let startMsg;
                if (verdict.mode === 'engine_1cr') {
                    startMsg = '🔥 Đã đề nổ động cơ 1CR & bật điều hoà làm mát cabin (' + hitLabel + ')!';
                } else if (verdict.mode === 'vent_only') {
                    startMsg = '🌬️ Đã bật quạt thông gió cabin (' + hitLabel + '), nhưng động cơ chưa nổ — muốn nổ máy 1CR hãy ra ngoài bấm KHOÁ XE (hoặc kiểm tra FSC 1CR trong DME/BDC).';
                } else {
                    startMsg = '❄️ Đã bật chế độ làm mát từ xa AutoMode (' + hitLabel + ')!';
                }
                await callWorker('verify_1cr', {
                    waitMs: 0,
                    lastAction: 'Kích nổ / Làm mát 1CR',
                    lastResult: startMsg.slice(0, 90),
                }, 2000);
                tell(startMsg, verdict.mode === 'vent_only' ? 'warn' : 'go');
                if (config.botToken && config.chatId) {
                    tg.sendMessage(startMsg, S.telemetry, config.valet.enabled).catch(() => {});
                }
                return { ok: true, verified: true, mode: verdict.mode, message: startMsg, detail: { method: hitLabel, verdict, trace } };
            }

            const errText = (lastVerifyRes && lastVerifyRes.explanation) || CarLink.explain1crError(verdict, S.telemetry);
            await callWorker('verify_1cr', {
                waitMs: 0,
                lastAction: 'Kích nổ 1CR (Chưa bật)',
                lastResult: errText.slice(0, 90),
            }, 2000);
            tell('1CR chưa bật: ' + errText, 'warn');
            if (source === 'Telegram' && config.botToken && config.chatId) {
                tg.sendMessage('⚠️ 1CR chưa bật: ' + errText, S.telemetry, config.valet.enabled).catch(() => {});
            }
            return { ok: false, verified: false, error: errText, detail: { verdict, trace } };
        }

        if (action === 'timer_set' || action === 'timer_off') {
            const en = action === 'timer_set';
            const h = Number(arg.hour) || 7, m = Number(arg.minute) || 30;
            const hhmm = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
            if (en) config.dailyTimer = hhmm;
            else config.autoSyncTimer = false;
            saveConfig();
            const rep = await callWorker('schedule1cr', { hour: h, minute: m, enabled: en, userInitiated: true }, 6000);
            let timerMethod = rep && rep.ok && rep.result ? rep.result.method : '';
            if (!timerMethod && rep && rep.result && Array.isArray(rep.result.timerCandidates)) {
                const tc = rep.result.timerCandidates.slice(0, 4);
                for (let ti = 0; ti < tc.length; ti++) {
                    const tr = await callOapBridge(tc[ti].iface, tc[ti].kind, tc[ti].name, tc[ti].payload, tc[ti].altPayload, 3200);
                    if (tr && tr.ok) {
                        timerMethod = tc[ti].iface.split('.').pop() + '.' + tc[ti].name;
                        break;
                    }
                }
            }
            S.telemetry.climate1cr.timerText = en ? hhmm : 'Tắt';
            const plain = en
                ? ('Đã đặt hẹn giờ nổ máy 1CR lúc ' + hhmm + (timerMethod ? (' (' + timerMethod + ')') : ' (đã lưu lịch)'))
                : 'Đã tắt hẹn giờ nổ máy 1CR.';
            tell(plain, 'go');
            if (config.botToken && config.chatId) {
                tg.sendMessage((en ? '⏰ ' : '❌ ') + plain, S.telemetry, config.valet.enabled).catch(() => {});
            }
            return { ok: true, message: plain, detail: rep && rep.result };
        }

        if (action === 'valet_toggle' || action === 'valet_set') {
            const next = action === 'valet_toggle' ? !config.valet.enabled : (arg.mode === 'on' ? true : arg.mode === 'off' ? false : !config.valet.enabled);
            config.valet.enabled = next;
            config.valet.anchorPos = (next && S.telemetry.pos) ? { lat: S.telemetry.pos.lat, lon: S.telemetry.pos.lon } : null;
            S.valetAlerts = {};
            saveConfig();
            const plain = next
                ? ('Đã BẬT chế độ Valet (giới hạn ' + config.valet.maxSpeed + ' km/h, ' + config.valet.maxRpm + ' RPM, bán kính ' + config.valet.radiusM + 'm).')
                : 'Đã TẮT chế độ Valet.';
            tell(plain, next ? 'warn' : 'go');
            if (config.botToken && config.chatId) {
                tg.sendMessage('🛡️ ' + plain, S.telemetry, config.valet.enabled).catch(() => {});
            }
            return { ok: true, message: plain, valet: config.valet };
        }

        if (action === 'trips') {
            const rows = trips.slice(0, 5).map((tr, idx) => {
                const d = new Date(tr.endedAt);
                const pad = (n) => (n < 10 ? '0' : '') + n;
                const when = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + pad(d.getDate()) + '/' + (d.getMonth() + 1);
                return (idx + 1) + '. [' + when + '] ' + tr.distanceKm + ' km · ' + tr.durationMin + 'p · Max ' + tr.maxSpeed + ' km/h';
            });
            const msg = '🏁 LỊCH SỬ CHUYẾN ĐI GẦN ĐÂY:\n' + (rows.length ? rows.join('\n') : 'Chưa có chuyến đi nào được ghi nhận.');
            if (config.botToken && config.chatId) await tg.sendMessage(msg, S.telemetry, config.valet.enabled);
            return { ok: true, message: msg };
        }

        if (action === 'scan_health') {
            const rep = await callWorker('scan_health', {}, 15000);
            if (!rep || !rep.ok || !rep.result) {
                const err = (rep && rep.error) || 'Không thể kết nối cổng chẩn đoán UDS InternalTasu';
                tell('Sức khoẻ xe: ' + err, 'warn');
                return { ok: false, error: err };
            }
            const h = rep.result;
            const summary = (h.activeFaultCount === 0 && h.storedFaultCount === 0)
                ? ('Tất cả hệ thống hoạt động hoàn hảo (' + h.ecusAnswered + '/' + h.ecusScanned + ' hộp ECU 0 lỗi, 12V ' + (S.telemetry.battery12v || '--') + 'V)!')
                : ('Đã quét ' + h.ecusAnswered + ' hộp ECU: ' + h.activeFaultCount + ' lỗi đang hiện hữu, ' + h.storedFaultCount + ' mã lưu bộ nhớ.');
            tell(summary, h.activeFaultCount > 0 ? 'warn' : 'go');
            if (source === 'Telegram' && config.botToken && config.chatId) {
                const faultLines = (h.faults || []).slice(0, 8).map((f) => '  • ' + f.ecuName + ': 0x' + f.code + ' (' + f.statusLabel + ')');
                tg.sendMessage('🩺 KIỂM TRA SỨC KHOẺ XE:\n' + summary + (faultLines.length ? ('\n' + faultLines.join('\n')) : ''), S.telemetry, config.valet.enabled).catch(() => {});
            }
            return { ok: true, message: summary, detail: h };
        }

        if (action === 'send_destination') {
            const lat = Number(arg.lat), lon = Number(arg.lon);
            if (!CarLink.validCoords(lat, lon)) {
                return { ok: false, error: 'Toạ độ điểm đến không hợp lệ.' };
            }
            const name = String(arg.name || 'Điểm đến từ MyBMW').trim().slice(0, 80);
            const address = String(arg.address || '').trim().slice(0, 140);
            config.destination = { name, address, lat, lon, sentAt: Date.now() };
            saveConfig();
            let distNote = '';
            if (S.telemetry && S.telemetry.pos) {
                const dKm = CarLink.haversineKm(S.telemetry.pos.lat, S.telemetry.pos.lon, lat, lon);
                distNote = ' (cách xe ' + dKm.toFixed(1) + ' km)';
            }
            const msg = '📍 Đã nhận điểm đến trên xe: ' + name + distNote;
            tell(msg, 'go');
            return { ok: true, message: msg, detail: config.destination };
        }

        if (action === 'clear_destination') {
            config.destination = null;
            saveConfig();
            tell('Đã xoá điểm đến đã gửi.', 'dim');
            return { ok: true, message: 'Đã xoá điểm đến trên màn hình xe.' };
        }

        if (action === 'service_prefs') {
            const curOdo = Math.round(Number(S.telemetry && S.telemetry.odometerKm) || 0);
            const nextSp = Object.assign({}, config.servicePlan);
            if (arg.oilIntervalKm !== undefined) nextSp.oilIntervalKm = Math.max(3000, Math.min(25000, Math.round(Number(arg.oilIntervalKm) || 8000)));
            if (arg.resetOilNow) nextSp.oilDueKm = curOdo + nextSp.oilIntervalKm;
            else if (arg.oilDueKm !== undefined) nextSp.oilDueKm = Math.max(0, Math.round(Number(arg.oilDueKm) || 0));
            if (arg.resetCheckNow) nextSp.checkDueKm = curOdo + 15000;
            else if (arg.checkDueKm !== undefined) nextSp.checkDueKm = Math.max(0, Math.round(Number(arg.checkDueKm) || 0));
            if (arg.brakeFluidDue !== undefined) nextSp.brakeFluidDue = String(arg.brakeFluidDue || '').trim().slice(0, 20);
            config.servicePlan = normalizeConfig({ servicePlan: nextSp }).servicePlan;
            saveConfig();
            tell('Đã cập nhật lịch nhắc bảo dưỡng theo ODO thực tế.', 'go');
            return { ok: true, message: 'Đã lưu lịch nhắc bảo dưỡng xe!', detail: config.servicePlan };
        }

        if (action === 'next_ip') {
            S.ipIndex++;
            writeStatus();
            fwCheck();
            return { ok: true, message: 'Đã chuyển địa chỉ mạng.' };
        }

        return { ok: false, error: 'Lệnh không hợp lệ: ' + action };
    }

    function currentUrl() {
        const ips = addresses();
        if (!ips.length) return '';
        const ip = ips[S.ipIndex % ips.length];
        return 'http://' + ip + ':' + S.port + '/?pin=' + S.pin;
    }

    function writeStatus() {
        const url = currentUrl();
        const payload = {
            at: Date.now(),
            version: VERSION,
            vehicleProfile: heroData.meta,
            url,
            cloudUrl: cloud.pairingUrl(),
            pairCode: identity.pairCode,
            cloudOk: cloud.isOnline(),
            pin: S.pin,
            ips: addresses(),
            telegramOk: !!(config.botToken && config.chatId),
            ownerName: config.ownerName || (config.chatId ? ('ID ' + config.chatId) : ''),
            tgLastOkAt: tg.lastOkAt,
            tgError: tg.lastError,
            parkSnapshot: config.parkSnapshot,
            autoSyncTimer: config.autoSyncTimer,
            dailyTimer: config.dailyTimer,
            valet: config.valet,
            servicePlan: config.servicePlan,
            destination: config.destination,
            workerUp: S.workerUp,
            telemetry: S.telemetry,
            activeTrip: S.activeTrip,
            lastTrip: S.lastTrip,
            trips: trips.slice(0, 6),
            wantCamUntil: S.wantCamUntil || 0,
            oapReq: S.oapReq || null,
            message: S.message,
            messageKind: S.messageKind,
        };
        try { writeAtomic(path.join(C.run, 'status.json'), JSON.stringify(payload), 0o644); } catch (e) {}
    }

    function pollAppCommands() {
        const app = ensureAppRamDir(C.run, C.oap, C.proc);
        const candidates = [path.join(C.run, 'app', 'command.json')];
        if (app) candidates.push(path.join(app.root, 'data', 'command.json'));
        let newest = null;
        candidates.forEach((f) => {
            const c = readJson(f);
            if (c && typeof c.id === 'number' && (!newest || c.id > newest.id)) newest = c;
        });
        if (!newest) return;
        if (S.seenCmdId < 0) { S.seenCmdId = newest.id; return; }
        if (newest.id === S.seenCmdId) return;
        S.seenCmdId = newest.id;
        executeAction(newest.cmd, newest.arg || {}, 'Màn hình xe')
            .then(() => syncCloudState(true))
            .catch((e) => tell('Lỗi: ' + e.message, 'crit'));
    }

    function fwCheck() {
        if (C.noServer) return;
        const ips = addresses();
        const ip = ips.length ? ips[S.ipIndex % ips.length] : '';
        const iface = ip ? lastIfaces[ip] : '';
        fwEnsure(S.port, iface).catch(() => {});
    }

    /* ---------------- Local HTTP Phone Setup & 1CR Inspector Server ---------------- */

    function checkPin(req, queryPin) {
        const remote = String((req.socket && req.socket.remoteAddress) || 'local');
        const now = Date.now();
        const rec = S.badPins[remote];
        if (rec && rec.until > now) return { ok: false, locked: true };
        const pin = String(queryPin || req.headers['x-pin'] || '').trim();
        if (pin === S.pin) {
            delete S.badPins[remote];
            return { ok: true };
        }
        const count = (rec ? rec.count : 0) + 1;
        S.badPins[remote] = { count, until: count >= 5 ? now + 60000 : 0 };
        return { ok: false, locked: count >= 5 };
    }

    function sendJson(res, code, obj) {
        const body = Buffer.from(JSON.stringify(obj), 'utf8');
        res.writeHead(code, {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, X-Pin',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Content-Length': body.length,
        });
        res.end(body);
    }

    function readBodyJson(req) {
        return new Promise((resolve, reject) => {
            const chunks = [];
            let sz = 0;
            req.on('data', (c) => { sz += c.length; if (sz > 256 * 1024) { req.destroy(); reject(new Error('body too large')); return; } chunks.push(c); });
            req.on('end', () => {
                if (!chunks.length) return resolve({});
                try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new Error('JSON không hợp lệ')); }
            });
            req.on('error', reject);
        });
    }

    async function handleHttp(req, res) {
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Content-Type, X-Pin',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            });
            res.end();
            return;
        }
        const parsed = urlMod.parse(req.url || '/', true);
        const pathname = parsed.pathname || '/';

        if (req.method === 'GET' && pathname === '/') {
            const html = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
            const buf = Buffer.from(html, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
            res.end(buf);
            return;
        }

        const auth = checkPin(req, parsed.query && parsed.query.pin);
        if (!auth.ok) {
            return sendJson(res, auth.locked ? 429 : 403, {
                ok: false,
                error: auth.locked ? 'Nhập sai mã PIN quá 5 lần. Vui lòng thử lại sau 1 phút.' : 'Sai mã PIN (xem mã 4 số trên màn hình xe).',
            });
        }

        if (req.method === 'GET' && pathname === '/api/state') {
            return sendJson(res, 200, {
                ok: true,
                version: VERSION,
                vehicleProfile: heroData.meta,
                appearance: config.appearance,
                cloudUrl: cloud.pairingUrl(),
                pairCode: identity.pairCode,
                cloudOk: cloud.lastOkAt > 0,
                config: {
                    hasToken: !!config.botToken,
                    maskedToken: config.botToken ? (config.botToken.slice(0, 8) + '…' + config.botToken.slice(-4)) : '',
                    chatId: config.chatId,
                    ownerName: config.ownerName,
                    parkSnapshot: config.parkSnapshot,
                    wakeNotify: config.wakeNotify,
                    autoSyncTimer: config.autoSyncTimer,
                    dailyTimer: config.dailyTimer,
                    appearance: config.appearance,
                    valet: config.valet,
                },
                telemetry: S.telemetry,
                lastTrip: S.lastTrip,
                trips: trips.slice(0, 10),
                message: S.message,
                tgError: tg.lastError,
            });
        }

        if (req.method === 'GET' && pathname === '/api/hero.png') {
            if (!heroData.png) return sendJson(res, 404, { ok: false, error: 'No factory hero image' });
            res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'Content-Length': heroData.png.length });
            res.end(heroData.png);
            return;
        }

        if (req.method === 'GET' && pathname === '/api/snapshot.png') {
            const snap = Snap.renderSnapshotPng(S.telemetry, { title: 'XEM TRUOC ANH TRANG THAI', trip: S.lastTrip, valet: config.valet, at: Date.now() }, { rawCamFile: path.join(C.run, 'cam4.rgba') });
            res.writeHead(200, { 'Content-Type': snap.mime || 'image/png', 'Cache-Control': 'no-store', 'Content-Length': snap.png.length });
            res.end(snap.png);
            return;
        }

        if (req.method === 'GET' && pathname === '/api/1cr-schema') {
            const rep = await callWorker('schema', {}, 5000);
            return sendJson(res, 200, {
                ok: !!(rep && rep.ok),
                schema: (rep && rep.schema) || { interfaces: [], live: {}, pinnedProfile: null },
                telemetry: S.telemetry,
                logs: LOGS.slice(-40),
            });
        }

        if (req.method === 'POST' && pathname === '/api/config') {
            const b = await readBodyJson(req);
            const merged = Object.assign({}, config, b);
            if (!b.botToken && config.botToken && b.keepToken !== false) merged.botToken = config.botToken;
            if (b.valet) merged.valet = Object.assign({}, config.valet, b.valet);
            if (b.appearance) merged.appearance = Object.assign({}, config.appearance, b.appearance);
            if (merged.valet.enabled && !merged.valet.anchorPos && S.telemetry.pos) {
                merged.valet.anchorPos = { lat: S.telemetry.pos.lat, lon: S.telemetry.pos.lon };
            }
            config = normalizeConfig(merged);
            saveConfig();
            if (b.appearance) refreshFactoryHero(true);
            tell('Đã lưu cấu hình từ điện thoại.', 'go');
            syncCloudState(true);
            return sendJson(res, 200, { ok: true, message: S.message });
        }

        if (req.method === 'POST' && pathname === '/api/detect-chat') {
            const b = await readBodyJson(req);
            const token = (b.botToken && String(b.botToken).trim()) || config.botToken;
            if (!token) return sendJson(res, 400, { ok: false, error: 'Hãy dán Bot Token trước.' });
            const found = await tg.detectOwnerChat(token);
            if (!found) {
                return sendJson(res, 200, { ok: false, error: 'Chưa thấy tin nhắn nào. Hãy mở Telegram, bấm Start hoặc nhắn "hi" cho Bot rồi bấm lại!' });
            }
            config.botToken = token;
            config.chatId = found.chatId;
            config.ownerName = found.name;
            saveConfig();
            tell('Đã kết nối Telegram với ' + found.name + '!', 'go');
            return sendJson(res, 200, { ok: true, chatId: found.chatId, ownerName: found.name });
        }

        if (req.method === 'POST' && pathname === '/api/test-telegram') {
            const b = await readBodyJson(req);
            const token = (b.botToken && String(b.botToken).trim()) || config.botToken;
            const chatId = (b.chatId && String(b.chatId).trim()) || config.chatId;
            if (!token || !chatId) return sendJson(res, 400, { ok: false, error: 'Cần cả Bot Token và Chat ID.' });
            config.botToken = token;
            config.chatId = chatId;
            saveConfig();
            const snap = Snap.renderSnapshotPng(S.telemetry, { title: 'KET NOI TELEGRAM THANH CONG!', trip: S.lastTrip, valet: config.valet, at: Date.now() }, { rawCamFile: path.join(C.run, 'cam4.rgba') });
            const cap = Tg.formatStatusCaption('✅ KẾT NỐI XE BMW THÀNH CÔNG!', S.telemetry, { note: 'Bấm các nút bên dưới để điều khiển 1CR, chụp ảnh hoặc bật Valet.' });
            await tg.sendSnapshotPhoto(snap.png, cap, S.telemetry, config.valet.enabled, token, chatId);
            tell('Đã gửi ảnh thử nghiệm thành công về Telegram!', 'go');
            return sendJson(res, 200, { ok: true, message: S.message });
        }

        if (req.method === 'POST' && pathname === '/api/action') {
            const b = await readBodyJson(req);
            const out = await executeAction(String(b.action || ''), b.arg || {}, 'Điện thoại');
            syncCloudState(true);
            return sendJson(res, 200, out);
        }

        if (req.method === 'POST' && pathname === '/api/1cr-raw') {
            const b = await readBodyJson(req);
            const rep = await callWorker('invoke_raw', b, 6000);
            syncCloudState(true);
            return sendJson(res, 200, (rep && rep.result) || rep || { ok: false });
        }

        return sendJson(res, 404, { ok: false, error: 'Not found' });
    }

    function start() {
        try { Up.pickUid(upOpts); } catch (e) {}
        startWorker();

        if (!C.noServer) {
            const srv = http.createServer((req, res) => {
                handleHttp(req, res).catch((e) => {
                    log('http err: ' + e.message);
                    try { sendJson(res, 500, { ok: false, error: e.message }); } catch (x) {}
                });
            });
            let p = C.port;
            srv.on('error', (e) => {
                if (e.code === 'EADDRINUSE' && p < C.port + 8) { p++; srv.listen(p, '0.0.0.0'); }
                else log('http server error: ' + e.message);
            });
            srv.on('listening', () => {
                S.port = srv.address().port;
                log('bimmer-link portal listening on port ' + S.port + ', PIN ' + S.pin);
                writeStatus();
                fwCheck();
            });
            srv.listen(p, '0.0.0.0');
            S.server = srv;
        }

        const tickTimer = setInterval(() => {
            try { pollAppCommands(); } catch (e) {}
            writeStatus();
            tg.pollOnce();
            cloud.pollCommandsOnce();
        }, 1500);

        const fwTimer = setInterval(() => {
            fwCheck();
            // Retry uploading factory hero automatically until confirmed!
            if (!heroData.png || computeHeroSig() !== heroConfirmedSig) {
                refreshFactoryHero(false);
            }
        }, 25000);

        // Scan factory hero locally first, then push to cloud once uplink settles (3s)
        setTimeout(() => {
            refreshFactoryHero(false);
            syncCloudState(true, { event: 'online' });
        }, 2800);
        writeStatus();

        if (config.wakeNotify && config.botToken && config.chatId) {
            setTimeout(() => {
                tg.sendMessage('🟢 Đầu xe BMW vừa khởi động và kết nối mạng sẵn sàng.', S.telemetry, config.valet.enabled).catch(() => {});
            }, 6000);
        }

        return {
            S,
            tg,
            cloud,
            getConfig: () => config,
            executeAction,
            onWorkerEvent,
            stop: () => {
                tg.stopped = true;
                cloud.stop();
                clearInterval(tickTimer);
                clearInterval(fwTimer);
                if (S.server) { try { S.server.close(); } catch (e) {} }
                if (S.worker) { try { S.worker.kill('SIGTERM'); } catch (e) {} }
            },
        };
    }

    return { S, tg, start, executeAction, onWorkerEvent, writeStatus, handleHttp };
}

if (require.main === module) {
    const cmd = process.argv[2] || 'run';
    if (cmd === 'fwclose') {
        fwClose().then((r) => process.stdout.write(r + '\n'), (e) => process.stdout.write(e.message + '\n'));
    } else if (cmd === 'status') {
        process.stdout.write(JSON.stringify(readJson(path.join(CFG.run, 'status.json')) || {}, null, 2) + '\n');
    } else {
        const svc = createService();
        const running = svc.start();
        process.on('SIGTERM', () => { running.stop(); process.exit(0); });
    }
}

module.exports = {
    VERSION,
    CFG,
    defaultConfig,
    normalizeConfig,
    addresses,
    findInstalledApp,
    findAppProcessUid,
    ensureAppRamDir,
    fwEnsure,
    fwClose,
    createService,
};
