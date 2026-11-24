'use strict';
/**
 * mqtt-lite.js - Zero-dependency MQTT 3.1.1 over TLS (port 8883) client & non-root `mgu-uplink` bridge for MGU.
 *
 * Eliminates HTTP polling and `ntfy.sh` HTTP 429 rate-limits completely:
 *   - Maintains a single persistent TLS 8883 connection (running under our `mgu-uplink` internet UID)
 *     with automatic broker failover (`broker.emqx.io` -> `broker.hivemq.com` -> `test.mosquitto.org`).
 *   - Delivers AES-256-GCM (`BL2:`) commands, ACKs, live telemetry, factory hero PNGs, and full 360° camera
 *     snapshots (up to 512 KB in a single retained message!) in ~50 ms with zero HTTP request limits.
 *
 * Strict Node 8.16 ES2017, zero external dependencies.
 */
const tls = require('tls');
const crypto = require('crypto');
const cp = require('child_process');
const Up = require('./uplink');

const DEFAULT_BROKERS = [
    { host: 'broker.emqx.io', port: 8883 },
    { host: 'broker.hivemq.com', port: 8883 },
    { host: 'test.mosquitto.org', port: 8883 },
];

function encodeVarLen(x) {
    const bytes = [];
    let n = x >>> 0;
    do {
        let b = n & 0x7f;
        n = Math.floor(n / 128);
        if (n > 0) b |= 0x80;
        bytes.push(b);
    } while (n > 0);
    return Buffer.from(bytes);
}

function decodeVarLen(buf, offset) {
    let mul = 1;
    let val = 0;
    let pos = offset;
    for (let i = 0; i < 4; i++) {
        if (pos >= buf.length) return null;
        const b = buf[pos++];
        val += (b & 0x7f) * mul;
        if ((b & 0x80) === 0) return { value: val, next: pos };
        mul *= 128;
    }
    return { error: 'malformed varlen', next: pos };
}

function strField(s) {
    const b = Buffer.from(String(s), 'utf8');
    const len = Buffer.allocUnsafe(2);
    len.writeUInt16BE(b.length, 0);
    return Buffer.concat([len, b]);
}

function encodeConnect(clientId, keepAliveSec) {
    const vh = Buffer.from([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, (keepAliveSec || 45) & 0xff]);
    const pl = strField(clientId);
    return Buffer.concat([Buffer.from([0x10]), encodeVarLen(vh.length + pl.length), vh, pl]);
}

function encodeSubscribe(pktId, topicFilter) {
    const idBuf = Buffer.allocUnsafe(2);
    idBuf.writeUInt16BE(pktId & 0xffff, 0);
    const body = Buffer.concat([idBuf, strField(topicFilter), Buffer.from([0x00])]);
    return Buffer.concat([Buffer.from([0x82]), encodeVarLen(body.length), body]);
}

function encodePublish(topic, payload, retain) {
    const tBuf = strField(topic);
    const pBuf = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
    const hdr = 0x30 | (retain ? 0x01 : 0x00);
    return Buffer.concat([Buffer.from([hdr]), encodeVarLen(tBuf.length + pBuf.length), tBuf, pBuf]);
}

function encodePingReq() {
    return Buffer.from([0xc0, 0x00]);
}

/** Parse as many complete MQTT frames as available from `rxBuf`. Returns `{ frames, rest }`. */
function parseFrames(rxBuf) {
    const frames = [];
    let off = 0;
    while (off < rxBuf.length) {
        const hdr = rxBuf[off];
        const dl = decodeVarLen(rxBuf, off + 1);
        if (!dl) break;
        if (dl.error) { off = rxBuf.length; break; }
        const end = dl.next + dl.value;
        if (end > rxBuf.length) break;
        const body = rxBuf.slice(dl.next, end);
        off = end;

        const type = hdr >> 4;
        if (type === 2) {
            frames.push({ type: 'connack', rc: body.length >= 2 ? body[1] : 255 });
        } else if (type === 9) {
            frames.push({ type: 'suback' });
        } else if (type === 13) {
            frames.push({ type: 'pingresp' });
        } else if (type === 3 && body.length >= 2) {
            const tLen = body.readUInt16BE(0);
            const qos = (hdr >> 1) & 0x03;
            const pOff = 2 + tLen + (qos > 0 ? 2 : 0);
            if (pOff <= body.length) {
                frames.push({
                    type: 'publish',
                    retain: !!(hdr & 0x01),
                    topic: body.slice(2, 2 + tLen).toString('utf8'),
                    payload: body.slice(pOff).toString('utf8'),
                });
            }
        }
    }
    return { frames, rest: off > 0 ? rxBuf.slice(off) : rxBuf };
}

/* ---------------- Child Bridge Process (runs under mgu-uplink UID) ---------------- */

function runChildBridge(leaseFile, routeFile, subFilter) {
    let brokerIdx = 0;
    let primaryFails = 0;
    let lastPrimaryCheckAt = Date.now();
    let sock = null;
    let ready = false;
    let strictTls = true;
    let rxBuf = Buffer.alloc(0);
    let pingTimer = null;
    let reconnTimer = null;
    let lastRxAt = 0;
    const pendingByTopic = {};
    const pendingOrder = [];

    const emit = (obj) => {
        try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) {}
    };

    function queueOrSend(topic, payload, retain) {
        if (ready && sock && !sock.destroyed) {
            try {
                sock.write(encodePublish(topic, payload, retain));
                return;
            } catch (e) {}
        }
        if (pendingByTopic[topic] === undefined) {
            pendingOrder.push(topic);
            if (pendingOrder.length > 16) {
                const old = pendingOrder.shift();
                delete pendingByTopic[old];
            }
        }
        pendingByTopic[topic] = { payload, retain: !!retain };
    }

    function flushPending() {
        if (!ready || !sock || sock.destroyed) return;
        while (pendingOrder.length) {
            const t = pendingOrder.shift();
            const item = pendingByTopic[t];
            delete pendingByTopic[t];
            if (item) {
                try { sock.write(encodePublish(t, item.payload, item.retain)); } catch (e) {}
            }
        }
    }

    function scheduleReconnect(delayMs) {
        if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
        if (ready) { ready = false; emit({ ev: 'down' }); }
        if (sock) {
            try { sock.destroy(); } catch (e) {}
            sock = null;
        }
        if (reconnTimer) return;
        reconnTimer = setTimeout(() => {
            reconnTimer = null;
            connectNext();
        }, delayMs || 2500);
    }

    function onConnectFail() {
        if (brokerIdx === 0) {
            primaryFails++;
            if (primaryFails >= 3) {
                brokerIdx = 1;
                primaryFails = 0;
            }
        } else {
            brokerIdx = (brokerIdx + 1) % DEFAULT_BROKERS.length;
        }
    }

    function connectNext() {
        // Re-read /run/mgu-uplink/lease.json & /proc/net/route on every attempt so Hotspot Wi-Fi DNS is picked up immediately!
        const lookup = Up.customLookup(leaseFile, routeFile);
        if (brokerIdx !== 0 && Date.now() - lastPrimaryCheckAt > 120000) {
            brokerIdx = 0;
            lastPrimaryCheckAt = Date.now();
        }
        const b = DEFAULT_BROKERS[brokerIdx % DEFAULT_BROKERS.length];
        rxBuf = Buffer.alloc(0);
        const s = tls.connect({
            host: b.host,
            port: b.port,
            servername: b.host,
            lookup,
            rejectUnauthorized: strictTls,
        });
        sock = s;

        const connTimeout = setTimeout(() => {
            if (!ready && sock === s) {
                onConnectFail();
                scheduleReconnect(1500);
            }
        }, 9000);

        s.on('secureConnect', () => {
            if (sock !== s) return;
            lastRxAt = Date.now();
            const cid = 'blmgu_' + crypto.randomBytes(5).toString('hex');
            try { s.write(encodeConnect(cid, 45)); } catch (e) {}
        });

        s.on('data', (chunk) => {
            if (sock !== s) return;
            lastRxAt = Date.now();
            rxBuf = rxBuf.length ? Buffer.concat([rxBuf, chunk]) : chunk;
            if (rxBuf.length > 2 * 1024 * 1024) {
                rxBuf = Buffer.alloc(0);
                brokerIdx++;
                scheduleReconnect(2000);
                return;
            }
            const parsed = parseFrames(rxBuf);
            rxBuf = parsed.rest;
            for (let i = 0; i < parsed.frames.length; i++) {
                const f = parsed.frames[i];
                if (f.type === 'connack') {
                    clearTimeout(connTimeout);
                    if (f.rc === 0) {
                        ready = true;
                        primaryFails = 0;
                        lastPrimaryCheckAt = Date.now();
                        strictTls = true;
                        if (subFilter) {
                            try { s.write(encodeSubscribe(1, subFilter)); } catch (e) {}
                        }
                        flushPending();
                        emit({ ev: 'up', broker: b.host });
                        if (pingTimer) clearInterval(pingTimer);
                        pingTimer = setInterval(() => {
                            if (Date.now() - lastRxAt > 65000) {
                                onConnectFail();
                                scheduleReconnect(1500);
                                return;
                            }
                            // If running on fallback broker, return to primary broker once stable
                            if (brokerIdx !== 0 && Date.now() - lastPrimaryCheckAt > 120000) {
                                brokerIdx = 0;
                                lastPrimaryCheckAt = Date.now();
                                scheduleReconnect(500);
                                return;
                            }
                            try { s.write(encodePingReq()); } catch (e) {}
                        }, 25000);
                    } else {
                        onConnectFail();
                        scheduleReconnect(3000);
                    }
                } else if (f.type === 'publish') {
                    emit({ ev: 'msg', topic: f.topic, payload: f.payload, retain: f.retain });
                }
            }
        });

        s.on('error', (err) => {
            clearTimeout(connTimeout);
            if (sock !== s) return;
            const msg = String((err && err.code) || '') + ' ' + String((err && err.message) || '');
            if (strictTls && /CERT|TLS|SSL|UNABLE_TO_VERIFY|SELF_SIGNED/i.test(msg)) {
                strictTls = false;
                scheduleReconnect(400);
                return;
            }
            strictTls = true;
            onConnectFail();
            scheduleReconnect(2200);
        });

        s.on('close', () => {
            clearTimeout(connTimeout);
            if (sock === s) {
                onConnectFail();
                scheduleReconnect(2200);
            }
        });
    }

    let inBuf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
        inBuf += d;
        let idx;
        while ((idx = inBuf.indexOf('\n')) >= 0) {
            const line = inBuf.slice(0, idx).trim();
            inBuf = inBuf.slice(idx + 1);
            if (!line) continue;
            let cmd = null;
            try { cmd = JSON.parse(line); } catch (e) { continue; }
            if (cmd && cmd.op === 'pub' && cmd.topic) {
                queueOrSend(cmd.topic, cmd.payload || '', !!cmd.retain);
            } else if (cmd && cmd.op === 'quit') {
                process.exit(0);
            }
        }
    });
    process.stdin.on('end', () => process.exit(0));

    connectNext();
}

/* ---------------- Parent Controller Class (used inside bimmer-link.js) ---------------- */

class MqttBridge {
    constructor(opts) {
        this.upOpts = opts.upOpts;
        this.subFilter = opts.subFilter || '';
        this.onMessage = opts.onMessage || (() => {});
        this.log = opts.log || (() => {});
        this.enabled = opts.enabled !== false && !(opts.upOpts && opts.upOpts.baseUrl);
        this.child = null;
        this.connected = false;
        this.broker = '';
        this.stopped = false;
        this.outQueue = [];
    }

    start() {
        if (!this.enabled || this.stopped || this.child) return;
        const uid = Up.pickUid(this.upOpts);
        const spawnOpts = { cwd: '/', env: {}, stdio: ['pipe', 'pipe', 'ignore'] };
        if (uid !== null && !(this.upOpts && this.upOpts.noSetuid)) {
            spawnOpts.uid = uid;
            spawnOpts.gid = uid;
        }
        const args = [
            __filename,
            '--bridge',
            (this.upOpts && this.upOpts.lease) || '/run/mgu-uplink/lease.json',
            (this.upOpts && this.upOpts.route) || '/proc/net/route',
            this.subFilter,
        ];
        let child;
        try {
            child = cp.spawn(process.execPath, args, spawnOpts);
        } catch (e) {
            this.log('mqtt spawn err: ' + e.message);
            return;
        }
        this.child = child;
        child.stdin.on('error', () => {});
        let buf = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (d) => {
            buf += d;
            let idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line) continue;
                let ev = null;
                try { ev = JSON.parse(line); } catch (e) { continue; }
                if (!ev) continue;
                if (ev.ev === 'up') {
                    this.connected = true;
                    this.broker = ev.broker || '';
                    this.log('mqtt connected via ' + this.broker);
                    this._flush();
                } else if (ev.ev === 'down') {
                    this.connected = false;
                } else if (ev.ev === 'msg') {
                    this.onMessage(ev.topic, ev.payload, !!ev.retain);
                }
            }
        });
        child.on('close', () => {
            this.child = null;
            this.connected = false;
            if (!this.stopped) {
                setTimeout(() => this.start(), 4000);
            }
        });
        this._flush();
    }

    _flush() {
        if (!this.child || !this.child.stdin) return;
        while (this.outQueue.length) {
            const msg = this.outQueue.shift();
            try { this.child.stdin.write(JSON.stringify(msg) + '\n'); } catch (e) { break; }
        }
    }

    publish(topic, payload, retain) {
        if (!this.enabled || this.stopped) return false;
        if (!this.child) this.start();
        const msg = { op: 'pub', topic, payload: String(payload || ''), retain: !!retain };
        if (this.child && this.child.stdin) {
            try {
                this.child.stdin.write(JSON.stringify(msg) + '\n');
                return this.connected;
            } catch (e) {}
        }
        if (this.outQueue.length > 16) this.outQueue.shift();
        this.outQueue.push(msg);
        return false;
    }

    stop() {
        this.stopped = true;
        this.connected = false;
        if (this.child) {
            try { this.child.stdin.write('{"op":"quit"}\n'); } catch (e) {}
            try { this.child.kill('SIGTERM'); } catch (e) {}
            this.child = null;
        }
    }
}

if (require.main === module && process.argv[2] === '--bridge') {
    process.on('SIGTERM', () => process.exit(0));
    runChildBridge(process.argv[3] || '', process.argv[4] || '', process.argv[5] || '');
}

module.exports = {
    DEFAULT_BROKERS,
    encodeVarLen,
    decodeVarLen,
    encodeConnect,
    encodeSubscribe,
    encodePublish,
    encodePingReq,
    parseFrames,
    MqttBridge,
};
