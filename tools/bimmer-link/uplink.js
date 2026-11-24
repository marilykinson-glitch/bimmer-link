'use strict';
/**
 * uplink.js - reaches the internet on the BMW MGU head unit through the Store's `mgu-uplink`.
 *
 * `mgu-uplink` blocks UID 0 (root) and requires resolving DNS via `/run/mgu-uplink/lease.json` (or hotspot gateway / public DNS).
 * Every outbound HTTP/HTTPS request runs in a short-lived child process under our dedicated non-root UID
 * (`/var/opt/mgu-uplink/uids.d/bimmer-link` and `state/internet-uids`).
 *
 * Supports:
 *   - HTTPS GET & POST (JSON)
 *   - HTTPS POST `multipart/form-data` (for uploading Park Snapshot PNGs to Telegram `sendPhoto`)
 *   - Automatic TLS fallback when MGU's older Node 8.16 CA bundle lacks newer root certificates
 *   - Local HTTP test base override (`opts.baseUrl`) for offline unit tests
 *
 * Node 8, zero dependencies.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const https = require('https');
const http = require('http');
const dns = require('dns');

const SELF = 'bimmer-link';
const MAX_UID = 60000;
const MAINAPPS = [
    { root: '/usr/lib/oap-mainapp', hmi: 'HmiMain3D' },
    { root: '/usr/lib/oap-mainapp21', hmi: 'Hmi8' },
];

const lines = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n'); } catch (e) { return []; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const list = (d) => { try { return fs.readdirSync(d); } catch (e) { return []; } };
const isId = (n) => n > 0 && n === Math.floor(n);
const mkdirp = (d) => {
    if (fs.existsSync(d)) return;
    mkdirp(path.dirname(d));
    try { fs.mkdirSync(d); } catch (e) { if (e.code !== 'EEXIST') throw e; }
};

function options(over) {
    return Object.assign({
        stateDir: '/var/opt/bimmer-link/state',
        etcDir: '/etc',
        oapRoot: '/var/opt/public/oap',
        toolRoot: '/var/opt',
        procDir: '/proc',
        mainapps: MAINAPPS,
        lease: '/run/mgu-uplink/lease.json',
        route: '/proc/net/route',
        fetchCmd: [process.execPath, __filename, '--fetch'],
        noSetuid: false,
        baseUrl: '',
        log: () => {},
    }, over || {});
}

function mainappRanges(o) {
    const have = o.mainapps.filter((m) => fs.existsSync(path.join(m.root, 'config', 'base.json')));
    let m = have.length === 1 ? have[0] : null;
    if (have.length > 1) {
        const running = list(o.procDir).filter((n) => /^\d+$/.test(n)).map((n) => (lines(path.join(o.procDir, n, 'comm'))[0] || '').trim());
        const which = have.filter((x) => running.indexOf(x.hmi) >= 0);
        m = which.length === 1 ? which[0] : null;
    }
    const c = m && readJson(path.join(m.root, 'config', 'base.json'));
    if (!c) return null;
    const rse = c.usableUidsAndGidsRse || {};
    const ranges = [c.usableUidsAndGids].concat(Object.keys(rse).map((k) => rse[k]))
        .filter((r) => r && isId(Number(r.min)) && Number(r.max) >= Number(r.min))
        .map((r) => ({ min: Number(r.min), max: Number(r.max) }));
    return ranges.length ? { ranges, own: (Array.isArray(c.mainAppUids) ? c.mainAppUids : []).map(Number).filter(isId) } : null;
}

function takenIds(o, cfg, procs) {
    const ids = {};
    const add = (v) => { const n = Number(v); if (String(v).trim() !== '' && isId(n)) ids[n] = true; };
    lines(path.join(o.etcDir, 'passwd')).forEach((l) => { const f = l.split(':'); add(f[2] || ''); add(f[3] || ''); });
    lines(path.join(o.etcDir, 'group')).forEach((l) => add(l.split(':')[2] || ''));
    list(o.oapRoot).forEach((n) => { const m = /^oap_(\d+)$/.exec(n); if (m) add(m[1]); });
    const mgr = path.join(o.oapRoot, 'oap_12201');
    list(path.join(mgr, 'data', 'apps')).forEach((n) => {
        const e = readJson(path.join(mgr, 'data', 'apps', n));
        add(e && e.userId !== undefined ? e.userId : '');
    });
    lines(path.join(mgr, 'security', 'uids.txt')).forEach((l) => add(l.split('=')[0]));
    const dropins = path.join(o.toolRoot, 'mgu-uplink', 'uids.d');
    list(dropins).filter((n) => n !== SELF && !/^\./.test(n)).forEach((n) =>
        lines(path.join(dropins, n)).forEach((l) => l.split('#')[0].split(/[\s,]+/).forEach(add)));
    const upd = readJson(path.join(o.toolRoot, 'mgu-updater', 'state', 'uids.json')) || {};
    Object.keys(upd).forEach((k) => add(upd[k]));
    (cfg ? cfg.own : []).forEach(add);
    if (procs) {
        list(o.procDir).filter((n) => /^\d+$/.test(n)).forEach((pid) => lines(path.join(o.procDir, pid, 'status')).forEach((l) => {
            const m = /^[UG]id:\s+(.*)$/.exec(l);
            if (m) m[1].split(/\s+/).forEach(add);
        }));
    }
    return ids;
}

function writeIfChanged(file, text, mode) {
    try { if (fs.readFileSync(file, 'utf8') === text) return; } catch (e) { /* create */ }
    fs.writeFileSync(file + '.tmp', text, { mode });
    fs.renameSync(file + '.tmp', file);
}

function pickUid(o) {
    const kept = Number((readJson(path.join(o.stateDir, 'uids.json')) || {}).fetch);
    const cfg = mainappRanges(o);
    const inRange = (u) => !!cfg && cfg.ranges.some((r) => u >= r.min && u <= r.max);
    let uid = null;
    if (isId(kept) && !takenIds(o, cfg, false)[kept] && !inRange(kept)) uid = kept;
    else if (cfg) {
        const all = takenIds(o, cfg, true);
        let u = Math.max.apply(null, cfg.ranges.map((r) => r.max)) + 1;
        while (u <= MAX_UID && (all[u] || inRange(u))) u++;
        if (u <= MAX_UID) { uid = u; o.log('internet uid: ' + u); }
    }
    if (uid === null) return null;
    if (!fs.existsSync(o.stateDir)) { mkdirp(path.dirname(o.stateDir)); fs.mkdirSync(o.stateDir, 0o700); }
    writeIfChanged(path.join(o.stateDir, 'uids.json'), JSON.stringify({ fetch: uid }) + '\n', 0o644);
    writeIfChanged(path.join(o.stateDir, 'internet-uids'), uid + '\n', 0o644);
    const uplink = path.join(o.toolRoot, 'mgu-uplink');
    if (fs.existsSync(path.join(uplink, 'current')) || fs.existsSync(path.join(uplink, 'uids.d'))) {
        try { mkdirp(path.join(uplink, 'uids.d')); writeIfChanged(path.join(uplink, 'uids.d', SELF), uid + '\n', 0o644); } catch (e) {}
    }
    return uid;
}

function dnsServers(leaseFile, routeFile) {
    const out = [];
    const add = (ip) => {
        if (typeof ip === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(ip) && ip !== '0.0.0.0' && !/^127\./.test(ip) && out.indexOf(ip) < 0) out.push(ip);
    };
    const lease = readJson(leaseFile || '/run/mgu-uplink/lease.json') || {};
    (lease.dns || []).forEach(add);
    ['/etc/resolv.conf', '/run/connman/resolv.conf', '/var/run/connman/resolv.conf'].forEach((f) => {
        lines(f).forEach((l) => { const m = /^\s*nameserver\s+(\S+)/.exec(l); if (m) add(m[1]); });
    });
    lines(routeFile || '/proc/net/route').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length > 7 && c[1] === '00000000').forEach((c) => {
        const g = parseInt(c[2], 16);
        if (isFinite(g)) add([g & 255, (g >>> 8) & 255, (g >>> 16) & 255, (g >>> 24) & 255].join('.'));
    });
    ['1.1.1.1', '8.8.8.8'].forEach(add);
    return out;
}

function customLookup(leaseFile, routeFile) {
    const servers = dnsServers(leaseFile, routeFile);
    if (!servers.length) return undefined;
    return function (host, opts, cb) {
        if (typeof opts === 'function') cb = opts;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return cb(null, host, 4);
        let idx = 0;
        const tryNext = (lastErr) => {
            if (idx >= servers.length) return cb(lastErr || new Error('DNS failed for ' + host));
            const r = new dns.Resolver();
            try { r.setServers([servers[idx++]]); } catch (e) { return tryNext(e); }
            let done = false;
            const timer = setTimeout(() => { if (!done) { done = true; tryNext(new Error('DNS timeout')); } }, 2800);
            r.resolve4(host, (err, ips) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                if (err || !ips || !ips.length) return tryNext(err || new Error('no A record'));
                cb(null, ips[0], 4);
            });
        };
        tryNext(null);
    };
}

/** Execute a request directly (used inside the `--fetch` child or when `noSetuid` / `baseUrl` is active). */
function doHttp(q, lookup, strictTls) {
    return new Promise((resolve, reject) => {
        let done = false, size = 0;
        const finish = (e, v) => { if (done) return; done = true; clearTimeout(timer); e ? reject(e) : resolve(v); };
        const bodyBuf = q.bodyBase64 ? Buffer.from(q.bodyBase64, 'base64') : (q.body ? Buffer.from(String(q.body), 'utf8') : null);
        const headers = Object.assign({ 'User-Agent': 'bimmer-link/0.1', Accept: 'application/json' }, q.headers || {});
        if (bodyBuf) headers['Content-Length'] = bodyBuf.length;

        let transport = https;
        let reqOpts;
        if (q.baseUrl) {
            const m = /^http:\/\/([^:/]+):(\d+)/.exec(q.baseUrl);
            transport = http;
            reqOpts = {
                host: m ? m[1] : '127.0.0.1',
                port: m ? Number(m[2]) : 80,
                path: String(q.path),
                method: q.method || (bodyBuf ? 'POST' : 'GET'),
                headers,
            };
        } else {
            reqOpts = {
                host: String(q.host),
                servername: String(q.host),
                path: String(q.path),
                method: q.method || (bodyBuf ? 'POST' : 'GET'),
                headers,
                lookup,
                rejectUnauthorized: strictTls !== false,
            };
        }

        const req = transport.request(reqOpts, (res) => {
            const chunks = [];
            res.on('data', (c) => {
                size += c.length;
                if (size > 4e6) { req.abort(); finish(new Error('response too large')); return; }
                chunks.push(c);
            });
            res.on('end', () => finish(null, { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
            res.on('error', finish);
        });
        const timer = setTimeout(() => { req.abort(); finish(new Error('timeout')); }, q.timeoutMs || 20000);
        req.on('error', finish);
        if (bodyBuf) req.write(bodyBuf);
        req.end();
    });
}

function doHttpWithTlsFallback(q, lookup) {
    return doHttp(q, lookup, true).catch((err) => {
        const msg = String((err && err.code) || '') + ' ' + String((err && err.message) || '');
        if (/CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(msg) && !q.baseUrl) {
            return doHttp(q, lookup, false);
        }
        throw err;
    });
}

/** Run request through the non-root UID child (or directly in test mode when `baseUrl` / `uid === null`). */
function request(o, reqSpec) {
    if (o.baseUrl) {
        return doHttpWithTlsFallback(Object.assign({}, reqSpec, { baseUrl: o.baseUrl }), undefined);
    }
    const uid = pickUid(o);
    if (uid === null || o.noSetuid) {
        return doHttpWithTlsFallback(reqSpec, customLookup(o.lease, o.route));
    }
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = cp.spawn(o.fetchCmd[0], o.fetchCmd.slice(1), {
                uid, gid: uid, cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'],
            });
        } catch (e) { return reject(e); }
        const chunks = [];
        let size = 0, done = false;
        const finish = (e, v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            if (e) { try { child.kill('SIGKILL'); } catch (x) {} reject(e); } else resolve(v);
        };
        const timer = setTimeout(() => finish(new Error('uplink timeout')), (reqSpec.timeoutMs || 20000) + 2000);
        child.on('error', finish);
        child.stdin.on('error', () => {});
        child.stdout.on('data', (c) => {
            size += c.length;
            if (size > 5e6) return finish(new Error('uplink output too large'));
            chunks.push(c);
        });
        child.on('close', () => {
            let r = null;
            try { r = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
            if (!r) return finish(new Error('uplink helper empty reply'));
            if (r.error) return finish(new Error(r.error));
            return finish(null, { status: r.status, body: String(r.body) });
        });
        child.stdin.end(JSON.stringify(Object.assign({}, reqSpec, { lease: o.lease, route: o.route })));
    });
}

/** Build a `multipart/form-data` Buffer for Telegram `sendPhoto`. */
function buildMultipart(fields, fileField, filename, mimeType, fileBuf) {
    const boundary = '----BimmerLinkBoundary' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const parts = [];
    Object.keys(fields || {}).forEach((k) => {
        if (fields[k] === undefined || fields[k] === null) return;
        parts.push(Buffer.from(
            '--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="' + k + '"\r\n\r\n' +
            String(fields[k]) + '\r\n', 'utf8'
        ));
    });
    if (fileBuf) {
        parts.push(Buffer.from(
            '--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="' + fileField + '"; filename="' + filename + '"\r\n' +
            'Content-Type: ' + mimeType + '\r\n\r\n', 'utf8'
        ));
        parts.push(fileBuf);
        parts.push(Buffer.from('\r\n', 'utf8'));
    }
    parts.push(Buffer.from('--' + boundary + '--\r\n', 'utf8'));
    return { boundary, buffer: Buffer.concat(parts) };
}

if (require.main === module && process.argv[2] === '--fetch') {
    const chunks = [];
    const out = (o) => process.stdout.write(JSON.stringify(o), () => process.exit(0));
    process.stdin.on('data', (d) => chunks.push(d));
    process.stdin.on('end', () => {
        let q;
        try { q = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return out({ error: 'bad request' }); }
        if (!/^[a-z0-9.-]+$/i.test(String(q.host)) || String(q.path).charAt(0) !== '/') return out({ error: 'bad host/path' });
        doHttpWithTlsFallback(q, customLookup(q.lease, q.route))
            .then(out, (e) => out({ error: e.code ? e.code + ' ' + e.message : e.message }));
    });
}

module.exports = {
    SELF,
    options,
    pickUid,
    mainappRanges,
    takenIds,
    dnsServers,
    request,
    buildMultipart,
};
