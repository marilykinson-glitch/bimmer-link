'use strict';
/**
 * aa-wifi.js - Smart Wireless Android Auto & Personal Hotspot coordinator for BMW MGU (iDrive 7).
 *
 * Solves the single-radio Broadcom BCM4359 (`bcmdhd`) startup/entry contention between:
 *   - `aapd.service` (UID 13006, Wireless Android Auto 5 GHz P2P GO on `p2p-wlan0-*`), and
 *   - `mgu-uplink.service` (`car-supplicant` on `wlan0` scanning all channels & joining the same Android phone's 2.4 GHz Hotspot).
 *
 * Design guarantees:
 *   1. Keeps `mgu-uplink` Wi-Fi ON 24/7 when parked, locked, DWA armed, during Option 1CR remote start,
 *      during Valet mode, during Park Snapshot 360 upload, and whenever no Android hotspot phone is in the cabin.
 *   2. Yields `mgu-uplink` Wi-Fi (`{"op":"wifi-enable","on":false}` on `/run/mgu-uplink/ctl.sock`) ONLY once per
 *      cabin-entry / in-car boot / sleep-wake cycle when the driver is in the car with a saved Android phone hotspot
 *      visible and Wireless AA/CarPlay is not yet established.
 *   3. Restores `mgu-uplink` Wi-Fi (`{"op":"wifi-enable","on":true}`) 4.5s after `aapd` (UID 13006) or `carplay` (UID 13002)
 *      establishes its TCP session (so `mgu-uplink` immediately applies its 2.4 GHz `scanHold`), or after a bounded 22s-30s
 *      timeout if AA does not connect, or immediately if the car leaves driver-present state / daemon stops / recovers from reboot.
 *   4. Auto-heals ConnMan `"the car's Wi-Fi is off"` (`Powered=true` on `wifi` & `p2p` + soft-rfkill unblock) with strict rate-limiting.
 *   5. Safely neutralizes & cleans up legacy `20-devlink-wait-car-wifi.conf` / `wait-car-wifi.sh` boot-blocking scripts.
 *
 * Strict Node 8.16 (ES2017), zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const cp = require('child_process');

const UID_CARPLAY = 13002;
const UID_ANDROID_AUTO = 13006;

const SETTLE_MS = 4500;
const MAX_YIELD_MS = 22000;
const HARD_MAX_YIELD_MS = 30000;
const PARK_GRACE_MS = 60000;
const REMOTE_GRACE_MS = 30000;
const ENTRY_WINDOW_MS = 90000;
const OUTSIDE_RESET_MS = 15000;
const SLEEP_GAP_MS = 20000;
const CONNMAN_ERR_WAIT_MS = 12000;
const CONNMAN_RETRY_COOLDOWN_MS = 60000;
const MAX_CONNMAN_RESCUES = 2;

const IOS_SSID_RE = /iphone|ipad|ipod|macbook|airpods/i;
const FIXED_ROUTER_SSID_RE = /asus_[a-z0-9]|(?:^|[^a-z0-9])(tp-link|tplink|netgear|linksys|ubiquiti|unifi|mikrotik|starlink|viettel|vnpt|fpt|mobifone|vinaphone|hikvision|dashcam|70mai|vietmap|ddpai|blackvue|thinkware|garmin)(?:$|[^a-z0-9])/i;
const ANDROID_PHONE_SSID_RE = /xiaomi|redmi|poco|(?:^|[^a-z0-9])mi[\s_-]*(?:9|1\d|mix|max|note)|pixel|galaxy|samsung|sm-[a-z]\d{2,4}|oppo|find[\s_-]*x|reno[\s_-]*\d+|vivo|iqoo|oneplus|realme|honor|magic[\s_-]*\d|rog[\s_-]*phone|zenfone|nothing[\s_-]*phone|motorola|moto[\s_-]*[gezx]\d*|xperia|tecno|infinix|android[\s_-]*ap|androidshare/i;

function readText(f) {
    try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; }
}

function readJson(f) {
    const raw = readText(f);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
}

function mkdirp(d) {
    if (!d || fs.existsSync(d)) return;
    const parent = path.dirname(d);
    if (parent && parent !== d) mkdirp(parent);
    try { fs.mkdirSync(d, 0o755); } catch (e) { if (e.code !== 'EEXIST') throw e; }
}

function writeAtomicJson(file, obj) {
    try {
        mkdirp(path.dirname(file));
        const tmp = file + '.tmp.' + process.pid;
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(tmp, file);
        return true;
    } catch (e) {
        return false;
    }
}

/** True when a `/proc/net/tcp` or `tcp6` hex remote address is 0.0.0.0/:: or 127.0.0.0/8 / ::1 loopback. */
function isLocalHexAddr(addrPort) {
    const a = String(addrPort || '').split(':')[0].toUpperCase();
    if (!a || /^0+$/.test(a)) return true;
    if (a.length === 8) {
        return a.slice(6, 8) === '7F';
    }
    if (a === '00000000000000000000000001000000') return true;
    if (a.length === 32 && a.slice(0, 24) === '0000000000000000FFFF0000' && a.slice(30, 32) === '7F') {
        return true;
    }
    return false;
}

/** Parse `/proc/net/tcp` + `/proc/net/tcp6` for established non-loopback projection sockets. */
function parseProjectionTcp(tcpText, tcp6Text) {
    let aaUp = false;
    let carplayUp = false;
    const scan = (txt) => {
        if (!txt) return;
        const rows = String(txt).split('\n');
        for (let i = 1; i < rows.length; i++) {
            const f = rows[i].trim().split(/\s+/);
            if (f.length < 8 || f[3] !== '01') continue;
            const uid = Number(f[7]);
            if (uid !== UID_ANDROID_AUTO && uid !== UID_CARPLAY) continue;
            if (isLocalHexAddr(f[2])) continue;
            if (uid === UID_ANDROID_AUTO) aaUp = true;
            if (uid === UID_CARPLAY) carplayUp = true;
        }
    };
    scan(tcpText);
    scan(tcp6Text);
    return { aaUp: aaUp, carplayUp: carplayUp };
}

/** Parse `/proc/net/dev` for `p2p-*` interfaces and sum their RX bytes. */
function parseP2pRxBytes(devText) {
    let totalRx = 0;
    let count = 0;
    if (!devText) return { totalRx: 0, count: 0 };
    const rows = String(devText).split('\n');
    for (let i = 0; i < rows.length; i++) {
        const idx = rows[i].indexOf(':');
        if (idx < 0) continue;
        const ifname = rows[i].slice(0, idx).trim();
        if (!/^p2p-/.test(ifname)) continue;
        const fields = rows[i].slice(idx + 1).trim().split(/\s+/);
        const rx = Number(fields[0]);
        if (isFinite(rx) && rx >= 0) {
            totalRx += rx;
            count++;
        }
    }
    return { totalRx: totalRx, count: count };
}

/** Check `/proc/net/arp` for a live P2P client on `wlan_bridge` or `p2p-*` (e.g. `172.16.222.x` flags `0x2`). */
function hasActiveP2pPeerArp(arpText) {
    if (!arpText) return false;
    const rows = String(arpText).split('\n');
    for (let i = 1; i < rows.length; i++) {
        const f = rows[i].trim().split(/\s+/);
        if (f.length < 6) continue;
        const ip = f[0], flags = f[2].toLowerCase(), mac = f[3].toLowerCase(), dev = f[5];
        if (flags === '0x0' || mac === '00:00:00:00:00:00') continue;
        if (dev === 'wlan_bridge' || /^p2p-/.test(dev) || /^172\.16\.222\./.test(ip)) {
            return true;
        }
    }
    return false;
}

/**
 * Detect whether a DHCP `lease.json` matches Android AOSP/MIUI/OneUI Wi-Fi Tethering (`IpServer.java`):
 *   - Legacy Android <=10: `192.168.43.1`
 *   - Android 11-15+: randomized `/24` in `10.x.x.y` or `192.168.x.y` with randomized gateway octet (`y != 1 && y != 254`)
 *     and ~1 hour lease (`3500..3700` seconds).
 *   - Explicitly rejects iOS Personal Hotspot (`172.20.10.1`).
 */
function isAndroidHotspotLease(lease) {
    if (!lease || typeof lease !== 'object') return false;
    const router = String(lease.router || '').trim();
    if (!/^\d+\.\d+\.\d+\.\d+$/.test(router)) return false;
    if (/^172\.20\.10\./.test(router)) return false;
    if (router === '192.168.43.1') return true;
    const octets = router.split('.').map(Number);
    const last = octets[3];
    const prefix = Number(lease.prefix);
    const secs = Number(lease.leaseSeconds);
    const isPrivate = octets[0] === 10 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31);
    if (!isPrivate) return false;
    if (prefix === 24 && last > 1 && last < 254 && secs >= 3400 && secs <= 3800) {
        return true;
    }
    return false;
}

function isAndroidAaSsid(ssid, learnedList) {
    const s = String(ssid || '').trim();
    if (!s) return false;
    if (IOS_SSID_RE.test(s) || FIXED_ROUTER_SSID_RE.test(s)) return false;
    if (Array.isArray(learnedList) && learnedList.indexOf(s) >= 0) return true;
    return ANDROID_PHONE_SSID_RE.test(s);
}

/** Default Unix domain socket client for `/run/mgu-uplink/ctl.sock`. */
function sendUplinkCtlSocket(sockPath, payload, timeoutMs) {
    return new Promise((resolve) => {
        let done = false;
        const finish = (res) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(res);
        };
        let sock;
        try {
            sock = net.createConnection(sockPath);
        } catch (e) {
            finish({ ok: false, error: e.message });
            return;
        }
        let buf = '';
        const timer = setTimeout(() => {
            try { sock.destroy(); } catch (e) {}
            finish({ ok: false, error: 'ctl timeout' });
        }, timeoutMs || 2800);
        sock.on('connect', () => {
            try {
                sock.write(JSON.stringify(payload) + '\n');
            } catch (e) {
                finish({ ok: false, error: e.message });
            }
        });
        sock.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            const nl = buf.indexOf('\n');
            if (nl >= 0) {
                const line = buf.slice(0, nl).trim();
                try { sock.end(); } catch (e) {}
                try {
                    finish(JSON.parse(line));
                } catch (e) {
                    finish({ ok: false, error: 'bad ctl json' });
                }
            }
        });
        sock.on('end', () => {
            if (!done) {
                const line = buf.trim();
                if (line) {
                    try { finish(JSON.parse(line)); return; } catch (e) {}
                }
                finish({ ok: false, error: 'empty ctl reply' });
            }
        });
        sock.on('error', (err) => {
            finish({ ok: false, error: err ? err.message : 'ctl error' });
        });
    });
}

function defaultExecCmd(bin, args, timeoutMs) {
    return new Promise((resolve) => {
        cp.execFile(bin, args || [], { timeout: timeoutMs || 4000 }, (err, stdout, stderr) => {
            resolve({
                ok: !err,
                code: err && typeof err.code !== 'undefined' ? err.code : 0,
                stdout: String(stdout || ''),
                stderr: String(stderr || ''),
                error: err ? err.message : '',
            });
        });
    });
}

/** Evaluate whether the driver is inside the cabin and none of the MyBMW/1CR/Valet/Park exclusions apply. */
function evaluateVehicleGate(telemetry, valetEnabled, now, parkedUntil, remoteActiveUntil) {
    const t = telemetry && typeof telemetry === 'object' ? telemetry : {};
    const c1 = t.climate1cr && typeof t.climate1cr === 'object' ? t.climate1cr : {};
    const cond = typeof t.condition === 'number' ? t.condition : null;
    const doorsOpen = Array.isArray(t.doorsOpen) && t.doorsOpen.length > 0;

    if (valetEnabled) return { mustKeepWifiOn: true, driverPresent: false, outsideIdle: false, reason: 'valet' };
    if (c1.active === true) return { mustKeepWifiOn: true, driverPresent: false, outsideIdle: true, reason: '1cr_active' };
    if (t.dwaAlarmActive === true) return { mustKeepWifiOn: true, driverPresent: false, outsideIdle: true, reason: 'dwa_alarm' };
    if (t.dwaArmed === true) return { mustKeepWifiOn: true, driverPresent: false, outsideIdle: true, reason: 'dwa_armed' };
    if (cond === 1 || cond === 2 || cond === 3) {
        return { mustKeepWifiOn: true, driverPresent: false, outsideIdle: true, reason: 'parked_cond_' + cond };
    }
    if (cond === 12) {
        return { mustKeepWifiOn: true, driverPresent: false, outsideIdle: false, reason: 'shutdown_cond_12' };
    }
    if (now < parkedUntil) {
        return { mustKeepWifiOn: true, driverPresent: false, outsideIdle: false, reason: 'park_grace' };
    }
    if (now < remoteActiveUntil) {
        return { mustKeepWifiOn: true, driverPresent: false, outsideIdle: false, reason: 'remote_grace' };
    }

    const inActiveCond = cond === 5 || cond === 7 || cond === 8 || cond === 10;
    const unlockedEntry = doorsOpen && t.locked !== true;
    const driverPresent = inActiveCond || unlockedEntry;
    const outsideIdle = !driverPresent && (t.locked === true && !inActiveCond);

    return {
        mustKeepWifiOn: false,
        driverPresent: driverPresent,
        outsideIdle: outsideIdle,
        reason: driverPresent ? (inActiveCond ? 'cabin_cond_' + cond : 'door_entry') : 'waiting_telemetry',
    };
}

function parseRootMountMode(mountsText) {
    if (!mountsText) return 'unknown';
    const rows = String(mountsText).split('\n');
    for (let i = 0; i < rows.length; i++) {
        const f = rows[i].trim().split(/\s+/);
        if (f.length >= 4 && f[1] === '/') {
            const opts = f[3].split(',');
            if (opts.indexOf('ro') >= 0) return 'ro';
            if (opts.indexOf('rw') >= 0) return 'rw';
        }
    }
    return 'unknown';
}

/**
 * Read monotonic `CLOCK_BOOTTIME` milliseconds from `/proc/uptime` on Linux MGU.
 * Immune to BMW MGU's `Aug 2023 -> 2026` wall-clock jump at boot, while still advancing across suspend-to-RAM!
 */
function readBootTimeMs(procDir) {
    const raw = readText(path.join(procDir || '/proc', 'uptime'));
    if (raw) {
        const secs = parseFloat(String(raw).trim().split(/\s+/)[0]);
        if (isFinite(secs) && secs >= 0) {
            return Math.round(secs * 1000);
        }
    }
    if (typeof process.hrtime === 'function') {
        const hr = process.hrtime();
        return Math.round(hr[0] * 1000 + hr[1] / 1e6);
    }
    return Date.now();
}

class AaWifiCoordinator {
    constructor(opts) {
        const o = opts || {};
        this.stateDir = o.stateDir || '/var/opt/bimmer-link/state';
        this.guardFile = path.join(this.stateDir, 'wifi-guard.json');
        this.uplinkRun = o.uplinkRun || '/run/mgu-uplink';
        this.procDir = o.procDir || '/proc';
        this.sysDir = o.sysDir || '/sys';
        this.legacyDir = o.legacyDir || '/var/opt/devlink-wifi';
        this.legacyDropIn = o.legacyDropIn || '/etc/systemd/system/mgu-uplink.service.d/20-devlink-wait-car-wifi.conf';
        this.legacyWifilogUnit = o.legacyWifilogUnit || '/etc/systemd/system/devlink-wifilog.service';
        this.legacyWifilogWant = o.legacyWifilogWant || '/etc/systemd/system/multi-user.target.wants/devlink-wifilog.service';
        this.deployLockFile = o.deployLockFile || '/var/opt/mgu-deploy/lock';
        this.wocRemountLock = o.wocRemountLock || '/dev/shm/waze-on-cluster/remount.lock';
        this.getTelemetry = typeof o.getTelemetry === 'function' ? o.getTelemetry : function () { return {}; };
        this.isValetEnabled = typeof o.isValetEnabled === 'function' ? o.isValetEnabled : function () { return false; };
        this.nowFn = typeof o.now === 'function' ? o.now : () => readBootTimeMs(this.procDir);
        this.wallNowFn = typeof o.wallNow === 'function' ? o.wallNow : (typeof o.now === 'function' ? o.now : function () { return Date.now(); });
        this.getuid = typeof o.getuid === 'function' ? o.getuid : (typeof process.getuid === 'function' ? function () { return process.getuid(); } : function () { return -1; });
        this.log = typeof o.log === 'function' ? o.log : function () {};
        this.sendCtl = typeof o.sendCtl === 'function'
            ? o.sendCtl
            : (payload) => sendUplinkCtlSocket(path.join(this.uplinkRun, 'ctl.sock'), payload, 2800);
        this.execCmd = typeof o.execCmd === 'function' ? o.execCmd : defaultExecCmd;
        this.disabled = !!o.disabled;

        const saved = readJson(this.guardFile) || {};
        this.pausedByUs = !!saved.pausedByUs;
        this.pausedAt = Number(saved.pausedAt) || 0;
        this.recoveredPause = this.pausedByUs;
        this.learnedAaSsids = Array.isArray(saved.learnedAaSsids)
            ? saved.learnedAaSsids.filter((x) => typeof x === 'string' && x.trim().length > 0).slice(0, 12)
            : [];

        this.yieldedThisCycle = false;
        this.pauseAttempts = 0;
        this.cabinEnteredAt = 0;
        this.outsideSince = 0;
        this.parkedUntil = 0;
        this.remoteActiveUntil = 0;
        this.lastCond = null;
        this.lastTickAt = 0;

        this.aaUp = false;
        this.carplayUp = false;
        this.projectionSince = 0;
        this.wasProjectionUp = false;
        this.wasProjectionSettled = false;
        this.prevP2pRx = null;
        this.prevP2pAt = 0;
        this.lastP2pGrowthAt = 0;

        this.carWifiOffSince = 0;
        this.connmanRescues = 0;
        this.lastConnmanRescueAt = 0;

        this.busy = false;
        this.stopped = false;
        this.timer = null;
        this.cleanupTimer = null;
        this.phase = this.pausedByUs ? 'recovering' : 'idle';
    }

    now() {
        return this.nowFn();
    }

    wallNow() {
        return this.wallNowFn();
    }

    saveGuardState() {
        writeAtomicJson(this.guardFile, {
            pausedByUs: this.pausedByUs,
            pausedAt: this.pausedAt,
            learnedAaSsids: this.learnedAaSsids,
        });
    }

    notifyParked() {
        const ts = this.now();
        this.parkedUntil = Math.max(this.parkedUntil, ts + PARK_GRACE_MS);
        if (this.pausedByUs && !this.busy) {
            this.tick();
        }
    }

    notifyRemoteActivity() {
        const ts = this.now();
        this.remoteActiveUntil = Math.max(this.remoteActiveUntil, ts + REMOTE_GRACE_MS);
        if (this.pausedByUs && !this.busy) {
            this.tick();
        }
    }

    summary() {
        return {
            phase: this.phase,
            pausedByUs: this.pausedByUs,
            yieldedThisCycle: this.yieldedThisCycle,
            aaUp: this.aaUp,
            carplayUp: this.carplayUp,
            learnedAaSsids: this.learnedAaSsids.slice(0, 6),
        };
    }

    /** Detect active Wireless Android Auto / CarPlay session + P2P handshake activity. */
    inspectProjection(ts) {
        const tcp = readText(path.join(this.procDir, 'net', 'tcp'));
        const tcp6 = readText(path.join(this.procDir, 'net', 'tcp6'));
        const proj = parseProjectionTcp(tcp, tcp6);

        const dev = parseP2pRxBytes(readText(path.join(this.procDir, 'net', 'dev')));
        if (this.prevP2pRx !== null && ts > this.prevP2pAt && ts - this.prevP2pAt <= 10000) {
            if (dev.totalRx >= this.prevP2pRx + 512) {
                this.lastP2pGrowthAt = ts;
            }
        }
        this.prevP2pRx = dev.totalRx;
        this.prevP2pAt = ts;

        const arpPeer = hasActiveP2pPeerArp(readText(path.join(this.procDir, 'net', 'arp')));
        const p2pHandshakeActive = arpPeer || (this.lastP2pGrowthAt > 0 && ts - this.lastP2pGrowthAt <= 4000);

        const upNow = proj.aaUp || proj.carplayUp;
        if (upNow) {
            if (!this.projectionSince) this.projectionSince = ts;
        } else {
            this.projectionSince = 0;
        }
        const settled = upNow && this.projectionSince > 0 && (ts - this.projectionSince >= SETTLE_MS);

        const t = this.getTelemetry() || {};
        if (this.wasProjectionSettled && !upNow && !this.pausedByUs && !t.engineRunning && (Number(t.rpm) || 0) === 0) {
            this.parkedUntil = Math.max(this.parkedUntil, ts + PARK_GRACE_MS);
        }
        this.wasProjectionUp = upNow;
        this.wasProjectionSettled = settled ? true : (upNow ? this.wasProjectionSettled : false);
        this.aaUp = proj.aaUp;
        this.carplayUp = proj.carplayUp;

        return {
            aaUp: proj.aaUp,
            carplayUp: proj.carplayUp,
            upNow: upNow,
            settled: settled,
            p2pHandshakeActive: p2pHandshakeActive,
        };
    }

    /** Auto-learn custom Android hotspot SSIDs when AA is active and `lease.json` carries Android tethering signature. */
    maybeLearnAndroidSsid(upStatus) {
        if (!this.aaUp || !upStatus || !upStatus.wifi) return;
        const w = upStatus.wifi;
        if (w.link !== 'online' && w.link !== 'connected') return;
        const ssid = String(w.ssid || '').trim();
        if (!ssid || IOS_SSID_RE.test(ssid) || FIXED_ROUTER_SSID_RE.test(ssid)) return;
        if (this.learnedAaSsids.indexOf(ssid) >= 0) return;

        const lease = readJson(path.join(this.uplinkRun, 'lease.json'));
        const sig = typeof w.signal === 'number' ? w.signal : -99;
        if (ANDROID_PHONE_SSID_RE.test(ssid) || (isAndroidHotspotLease(lease) && sig >= -72)) {
            this.learnedAaSsids.unshift(ssid);
            if (this.learnedAaSsids.length > 10) this.learnedAaSsids.length = 10;
            this.saveGuardState();
            this.log('[aa-wifi] learned Android Auto phone hotspot SSID: "' + ssid + '"');
        }
    }

    /** Check whether a saved Android AA phone hotspot is currently visible or being joined by `mgu-uplink`. */
    detectVisibleAndroidHotspot(upStatus) {
        if (!upStatus || !upStatus.wifi) return null;
        const w = upStatus.wifi;
        const saved = Array.isArray(w.saved) ? w.saved : [];
        const curSsid = String(w.ssid || '').trim();
        if (curSsid && (w.link === 'connecting' || w.link === 'connected' || w.link === 'online')) {
            if (isAndroidAaSsid(curSsid, this.learnedAaSsids)) {
                return curSsid;
            }
        }
        const nets = Array.isArray(w.networks) ? w.networks : [];
        for (let i = 0; i < nets.length; i++) {
            const n = nets[i];
            if (!n || typeof n.ssid !== 'string') continue;
            const isSaved = n.saved === true || saved.indexOf(n.ssid) >= 0;
            const sig = typeof n.signal === 'number' ? n.signal : -65;
            if (isSaved && sig >= -82 && isAndroidAaSsid(n.ssid, this.learnedAaSsids)) {
                return n.ssid;
            }
        }
        return null;
    }

    /** Clear soft WLAN rfkill and ask ConnMan D-Bus to re-enable `wifi` & `p2p` when stuck in `"the car's Wi-Fi is off"`. */
    rescueConnmanWifi(ts, whyError) {
        this.connmanRescues++;
        this.lastConnmanRescueAt = ts;
        this.log('[aa-wifi] rescuing car Wi-Fi (' + whyError + ', attempt ' + this.connmanRescues + '/' + MAX_CONNMAN_RESCUES + ')');

        try {
            const rfRoot = path.join(this.sysDir, 'class', 'rfkill');
            const entries = fs.existsSync(rfRoot) ? fs.readdirSync(rfRoot) : [];
            for (let i = 0; i < entries.length; i++) {
                const dir = path.join(rfRoot, entries[i]);
                const rtype = (readText(path.join(dir, 'type')) || '').trim();
                const soft = (readText(path.join(dir, 'soft')) || '').trim();
                if (rtype === 'wlan' && soft === '1') {
                    try { fs.writeFileSync(path.join(dir, 'soft'), '0\n'); } catch (e) {}
                }
            }
        } catch (e) {}

        const setTechPowered = (tech) => this.execCmd('dbus-send', [
            '--system', '--print-reply', '--reply-timeout=2500',
            '--dest=net.connman', '/net/connman/technology/' + tech,
            'net.connman.Technology.SetProperty', 'string:Powered', 'variant:boolean:true',
        ], 3500);

        return setTechPowered('wifi')
            .then(() => setTechPowered('p2p'))
            .then(() => {
                const oper = (readText(path.join(this.sysDir, 'class', 'net', 'wlan0', 'operstate')) || '').trim();
                if (oper === 'down') {
                    return this.execCmd('ip', ['link', 'set', 'wlan0', 'up'], 2500);
                }
                return { ok: true };
            })
            .catch(() => ({ ok: false }));
    }

    pauseUplinkWifi(ts, ssid, reason) {
        this.pausedByUs = true;
        this.pausedAt = ts;
        this.pauseAttempts++;
        this.phase = 'yielding';
        this.saveGuardState();
        this.log('[aa-wifi] yielding mgu-uplink Wi-Fi for Wireless Android Auto (hotspot="' + ssid + '", ' + reason + ')');
        return this.sendCtl({ op: 'wifi-enable', on: false }).then((rep) => {
            if (!rep || rep.ok !== true) {
                this.pausedByUs = false;
                this.pausedAt = 0;
                this.phase = 'idle';
                this.saveGuardState();
                this.log('[aa-wifi] wifi-enable(false) deferred: ' + ((rep && rep.error) || 'ctl unavailable'));
                if (this.pauseAttempts >= 3) {
                    this.yieldedThisCycle = true;
                }
                return false;
            }
            this.yieldedThisCycle = true;
            this.recoveredPause = false;
            return true;
        });
    }

    restoreUplinkWifi(ts, reason) {
        this.log('[aa-wifi] restoring mgu-uplink Wi-Fi (' + reason + ')');
        return this.sendCtl({ op: 'wifi-enable', on: true }).then((rep) => {
            if (rep && rep.ok === true) {
                this.pausedByUs = false;
                this.pausedAt = 0;
                this.recoveredPause = false;
                if (reason !== 'crash_or_reboot_recovery' && String(reason).indexOf('vehicle_') !== 0) {
                    this.yieldedThisCycle = true;
                }
                this.phase = this.aaUp ? 'coexisting' : 'idle';
                this.saveGuardState();
                return true;
            }
            this.log('[aa-wifi] wifi-enable(true) retry pending: ' + ((rep && rep.error) || 'ctl unavailable'));
            return false;
        });
    }

    tick() {
        if (this.disabled || this.stopped || this.busy) return Promise.resolve(this.summary());
        const ts = this.now();

        if (!this.pausedByUs && this.lastTickAt > 0 && ts - this.lastTickAt > SLEEP_GAP_MS) {
            this.yieldedThisCycle = false;
            this.pauseAttempts = 0;
            this.cabinEnteredAt = 0;
            this.outsideSince = 0;
            this.connmanRescues = 0;
            this.carWifiOffSince = 0;
            this.log('[aa-wifi] wake gap detected (' + Math.round((ts - this.lastTickAt) / 1000) + 's) - armed for new cabin cycle');
        }
        this.lastTickAt = ts;

        const telemetry = this.getTelemetry() || {};
        const cond = typeof telemetry.condition === 'number' ? telemetry.condition : null;
        if (cond === 12 && this.lastCond !== 12) {
            this.parkedUntil = Math.max(this.parkedUntil, ts + PARK_GRACE_MS);
        }
        this.lastCond = cond;

        const proj = this.inspectProjection(ts);
        const gate = evaluateVehicleGate(telemetry, this.isValetEnabled(), ts, this.parkedUntil, this.remoteActiveUntil);

        if (gate.outsideIdle && !proj.upNow) {
            if (!this.outsideSince) this.outsideSince = ts;
            if (ts - this.outsideSince >= OUTSIDE_RESET_MS && !this.pausedByUs) {
                this.yieldedThisCycle = false;
                this.pauseAttempts = 0;
                this.cabinEnteredAt = 0;
                this.connmanRescues = 0;
            }
        } else {
            this.outsideSince = 0;
        }

        if (gate.driverPresent) {
            if (!this.cabinEnteredAt) this.cabinEnteredAt = ts;
        } else {
            this.cabinEnteredAt = 0;
        }

        const upStatus = readJson(path.join(this.uplinkRun, 'status.json'));
        this.maybeLearnAndroidSsid(upStatus);

        if (proj.upNow && !this.pausedByUs) {
            this.yieldedThisCycle = true;
            this.phase = 'coexisting';
        }

        // 1. If we paused Wi-Fi (or recovered a mid-pause reboot), check all restore triggers first!
        if (this.pausedByUs) {
            const elapsed = this.pausedAt > 0 ? Math.max(0, ts - this.pausedAt) : (HARD_MAX_YIELD_MS + 1);
            let restoreWhy = '';
            if (this.recoveredPause) {
                restoreWhy = 'crash_or_reboot_recovery';
            } else if (gate.mustKeepWifiOn || !gate.driverPresent) {
                restoreWhy = 'vehicle_' + gate.reason;
            } else if (proj.settled) {
                restoreWhy = (proj.aaUp ? 'android_auto' : 'carplay') + '_settled';
            } else if (elapsed >= HARD_MAX_YIELD_MS) {
                restoreWhy = 'hard_timeout_' + Math.round(elapsed / 1000) + 's';
            } else if (elapsed >= MAX_YIELD_MS && !proj.p2pHandshakeActive && !proj.upNow) {
                restoreWhy = 'timeout_' + Math.round(elapsed / 1000) + 's';
            }

            if (restoreWhy) {
                this.busy = true;
                return this.restoreUplinkWifi(ts, restoreWhy).then(
                    () => { this.busy = false; return this.summary(); },
                    () => { this.busy = false; return this.summary(); }
                );
            }
            this.phase = 'yielding';
            return Promise.resolve(this.summary());
        }

        // 2. Option 3: Auto-rescue ConnMan if car Wi-Fi got stuck off (`"the car's Wi-Fi is off"`).
        const wifiObj = upStatus && upStatus.wifi ? upStatus.wifi : null;
        const wifiErr = wifiObj && typeof wifiObj.error === 'string' ? wifiObj.error : '';
        if (wifiObj && wifiObj.enabled === true && (wifiErr === "the car's Wi-Fi is off" || /radio is blocked/i.test(wifiErr))) {
            if (!this.carWifiOffSince) this.carWifiOffSince = ts;
            const errDur = ts - this.carWifiOffSince;
            const sinceLastRescue = this.lastConnmanRescueAt > 0 ? (ts - this.lastConnmanRescueAt) : Infinity;
            if (errDur >= CONNMAN_ERR_WAIT_MS && this.connmanRescues < MAX_CONNMAN_RESCUES && sinceLastRescue >= CONNMAN_RETRY_COOLDOWN_MS) {
                this.busy = true;
                return this.rescueConnmanWifi(ts, wifiErr).then(
                    () => { this.busy = false; return this.summary(); },
                    () => { this.busy = false; return this.summary(); }
                );
            }
        } else {
            this.carWifiOffSince = 0;
            if (wifiObj && (wifiObj.link === 'online' || wifiObj.link === 'connected' || wifiObj.link === 'scanning' || wifiObj.link === 'idle')) {
                this.connmanRescues = 0;
            }
        }

        // 3. Yield `mgu-uplink` Wi-Fi once on cabin entry / in-car boot when a saved Android hotspot is visible and AA isn't up yet.
        if (
            gate.driverPresent &&
            !gate.mustKeepWifiOn &&
            !this.yieldedThisCycle &&
            !proj.upNow &&
            wifiObj &&
            wifiObj.enabled === true
        ) {
            if (this.cabinEnteredAt > 0 && ts - this.cabinEnteredAt > ENTRY_WINDOW_MS) {
                this.yieldedThisCycle = true;
                return Promise.resolve(this.summary());
            }
            const hotspotSsid = this.detectVisibleAndroidHotspot(upStatus);
            if (hotspotSsid) {
                this.busy = true;
                return this.pauseUplinkWifi(ts, hotspotSsid, gate.reason).then(
                    () => { this.busy = false; return this.summary(); },
                    () => { this.busy = false; return this.summary(); }
                );
            }
        }

        if (!proj.upNow) this.phase = 'idle';
        return Promise.resolve(this.summary());
    }

    /** Step 1 (instant, no remount): neutralize `/var/opt/devlink-wifi/wait-car-wifi.sh` so MGU boot is never delayed. */
    neutralizeLegacyWaitScript() {
        const scriptPath = path.join(this.legacyDir, 'wait-car-wifi.sh');
        if (!fs.existsSync(scriptPath)) return false;
        const noop = '#!/bin/sh\nexit 0\n';
        if (readText(scriptPath) === noop) return false;
        try {
            const tmp = scriptPath + '.tmp.' + process.pid;
            fs.writeFileSync(tmp, noop, { mode: 0o755 });
            fs.renameSync(tmp, scriptPath);
            this.log('[aa-wifi] neutralized legacy wait-car-wifi.sh boot blocker');
            return true;
        } catch (e) {
            return false;
        }
    }

    acquireWocRemountLock() {
        try {
            mkdirp(path.dirname(this.wocRemountLock));
            const fd = fs.openSync(this.wocRemountLock, 'wx');
            fs.writeSync(fd, process.pid + ' ' + new Date(this.wallNow()).toISOString() + '\n');
            fs.closeSync(fd);
            return true;
        } catch (e) {
            if (e.code === 'EEXIST') {
                try {
                    const st = fs.statSync(this.wocRemountLock);
                    if (this.wallNow() - st.mtime.getTime() > 120000) {
                        fs.unlinkSync(this.wocRemountLock);
                        return this.acquireWocRemountLock();
                    }
                } catch (e2) {}
            }
            return false;
        }
    }

    releaseWocRemountLock() {
        try {
            const owner = (readText(this.wocRemountLock) || '').split(' ')[0];
            if (owner === String(process.pid)) fs.unlinkSync(this.wocRemountLock);
        } catch (e) {}
    }

    /** Step 2 (deferred, safe `/` remount with lock checks): remove `20-devlink-wait-car-wifi.conf` permanently. */
    cleanupLegacyDropIn() {
        if (this.disabled || this.stopped) return Promise.resolve({ cleaned: false, reason: 'disabled' });
        const hasDropIn = fs.existsSync(this.legacyDropIn);
        const hasWifilog = fs.existsSync(this.legacyWifilogUnit);
        if (!hasDropIn && !hasWifilog) {
            this.cleanLegacyVarOptDir();
            return Promise.resolve({ cleaned: false, reason: 'absent' });
        }
        if (this.getuid() !== 0) {
            return Promise.resolve({ cleaned: false, reason: 'not_root' });
        }
        const rootMode = parseRootMountMode(readText(path.join(this.procDir, 'mounts')));
        if (rootMode !== 'ro') {
            return Promise.resolve({ cleaned: false, reason: 'root_not_ro' });
        }
        if (fs.existsSync(this.deployLockFile)) {
            try {
                const st = fs.statSync(this.deployLockFile);
                if (this.wallNow() - st.mtime.getTime() < 180000) {
                    return Promise.resolve({ cleaned: false, reason: 'mgu_deploy_busy' });
                }
            } catch (e) {}
        }
        if (!this.acquireWocRemountLock()) {
            return Promise.resolve({ cleaned: false, reason: 'remount_locked' });
        }

        return this.execCmd('mount', ['-o', 'remount,rw', '/'], 4000).then((rwRes) => {
            if (!rwRes.ok) {
                this.releaseWocRemountLock();
                return { cleaned: false, reason: 'remount_rw_failed' };
            }
            let unlinked = false;
            let unlinkErr = '';
            try {
                if (fs.existsSync(this.legacyDropIn)) {
                    fs.unlinkSync(this.legacyDropIn);
                    unlinked = true;
                    try { fs.rmdirSync(path.dirname(this.legacyDropIn)); } catch (e) {}
                }
                if (fs.existsSync(this.legacyWifilogWant)) {
                    try { fs.unlinkSync(this.legacyWifilogWant); } catch (e) {}
                }
                if (fs.existsSync(this.legacyWifilogUnit)) {
                    fs.unlinkSync(this.legacyWifilogUnit);
                    unlinked = true;
                }
            } catch (e) {
                unlinkErr = e.message;
            }
            return this.execCmd('sync', [], 3000)
                .then(() => this.execCmd('mount', ['-o', 'remount,ro', '/'], 4000))
                .then((roRes) => {
                    this.releaseWocRemountLock();
                    if (!unlinked) {
                        return { cleaned: false, reason: unlinkErr || 'unlink_failed', roRestored: roRes.ok };
                    }
                    this.log('[aa-wifi] removed legacy systemd drop-in 20-devlink-wait-car-wifi.conf (/ ro=' + roRes.ok + ')');
                    return this.execCmd('systemctl', ['daemon-reload'], 5000).then(() => {
                        this.cleanLegacyVarOptDir();
                        return { cleaned: true, roRestored: roRes.ok };
                    });
                });
        });
    }

    cleanLegacyVarOptDir() {
        if (!fs.existsSync(this.legacyDir)) return;
        if (fs.existsSync(this.legacyDropIn) || fs.existsSync(this.legacyWifilogUnit)) return;
        try {
            const names = fs.readdirSync(this.legacyDir);
            for (let i = 0; i < names.length; i++) {
                const n = names[i];
                if (n === 'wait-car-wifi.sh' || n === 'bootlog.sh' || /^boot-.*\.log$/.test(n)) {
                    try { fs.unlinkSync(path.join(this.legacyDir, n)); } catch (e) {}
                }
            }
            if (fs.readdirSync(this.legacyDir).length === 0) {
                fs.rmdirSync(this.legacyDir);
            }
        } catch (e) {}
    }

    start() {
        if (this.disabled) return this;
        this.stopped = false;
        this.neutralizeLegacyWaitScript();
        this.tick();
        if (!this.timer) {
            this.timer = setInterval(() => {
                this.tick();
            }, 1000);
            if (this.timer.unref) this.timer.unref();
        }
        if (!this.cleanupTimer) {
            this.cleanupTimer = setTimeout(() => {
                this.cleanupTimer = null;
                this.cleanupLegacyDropIn();
            }, 20000);
            if (this.cleanupTimer.unref) this.cleanupTimer.unref();
        }
        return this;
    }

    stop() {
        this.stopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        if (this.cleanupTimer) {
            clearTimeout(this.cleanupTimer);
            this.cleanupTimer = null;
        }
        if (this.pausedByUs) {
            return this.restoreUplinkWifi(this.now(), 'daemon_stop');
        }
        return Promise.resolve(true);
    }
}

module.exports = {
    UID_CARPLAY: UID_CARPLAY,
    UID_ANDROID_AUTO: UID_ANDROID_AUTO,
    SETTLE_MS: SETTLE_MS,
    MAX_YIELD_MS: MAX_YIELD_MS,
    HARD_MAX_YIELD_MS: HARD_MAX_YIELD_MS,
    PARK_GRACE_MS: PARK_GRACE_MS,
    isLocalHexAddr: isLocalHexAddr,
    parseProjectionTcp: parseProjectionTcp,
    parseP2pRxBytes: parseP2pRxBytes,
    hasActiveP2pPeerArp: hasActiveP2pPeerArp,
    isAndroidHotspotLease: isAndroidHotspotLease,
    isAndroidAaSsid: isAndroidAaSsid,
    evaluateVehicleGate: evaluateVehicleGate,
    parseRootMountMode: parseRootMountMode,
    readBootTimeMs: readBootTimeMs,
    sendUplinkCtlSocket: sendUplinkCtlSocket,
    AaWifiCoordinator: AaWifiCoordinator,
};
