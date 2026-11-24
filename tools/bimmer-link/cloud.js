'use strict';
/**
 * cloud.js - Zero-config End-to-End Encrypted (AES-256-GCM) Cloud Relay for MyBMW MGU (iPhone PWA + Android APK).
 *
 * Architecture:
 *   - Generates a persistent 24-byte cryptographic `pairSeed` on the car (`/var/opt/bimmer-link/cloud-identity.json`, mode 0600).
 *   - Deterministic derivation via SHA-256:
 *       aesKey  = SHA256("BL-AES-KEY:" + seedBytes)              (256-bit AES-GCM key)
 *       topicId = SHA256("BL-TOPIC:" + seedBytes).hex[0..19]     (unlisted channel ID)
 *   - Channels on `ntfy.sh` (or custom relay host):
 *       bl_st_<topicId>  Car -> Phones encrypted vehicle state, trip log & status (cached 12h while car sleeps 0W!)
 *       bl_ph_<topicId>  Car -> Phones encrypted chunked PNG snapshot (<3.6KB/chunk so all chunks stay cached 12h!)
 *       bl_cm_<topicId>  Phones -> Car encrypted remote commands (`start1cr`, `stop1cr`, `timer_set`, `valet_set`, `snap_now`, `schema`, `invoke_raw`)
 *       bl_dg_<topicId>  Car -> Phones encrypted 1CR SOME/IP schema & raw diagnostic replies
 *   - Wire format: `BL2:<base64(iv12 || ciphertext || authTag16)>` — 100% compatible with Browser WebCrypto & Android `javax.crypto.Cipher`.
 *
 * Node 8.16 compatible, zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Up = require('./uplink');

const DEFAULT_RELAY_HOST = 'ntfy.sh';
const DEFAULT_APP_BASE = 'https://marilykinson-glitch.github.io/bimmer-link/app/';
const CHUNK_BYTES = 2400; // ~3.2 KB base64 per chunk (< 4096-byte inline message cache limit)

function toBase64Url(buf) {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
    let s = String(str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return Buffer.from(s, 'base64');
}

function deriveIdentity(seedBuf) {
    if (!Buffer.isBuffer(seedBuf) || seedBuf.length < 16) throw new Error('invalid pair seed');
    const aesKey = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('BL-AES-KEY:', 'utf8'), seedBuf])).digest();
    const topicId = crypto.createHash('sha256').update(Buffer.concat([Buffer.from('BL-TOPIC:', 'utf8'), seedBuf])).digest('hex').slice(0, 20);
    const pairCode = toBase64Url(seedBuf);
    return {
        pairCode,
        seedBuf,
        aesKey,
        topicId,
        topics: {
            state: 'bl_st_' + topicId,
            photo: 'bl_ph_' + topicId,
            cmd: 'bl_cm_' + topicId,
            diag: 'bl_dg_' + topicId,
        },
    };
}

function loadOrCreateIdentity(identityFile) {
    try {
        const j = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
        if (j && typeof j.pairCode === 'string') {
            const sb = fromBase64Url(j.pairCode);
            if (sb.length === 24) return deriveIdentity(sb);
        }
    } catch (e) { /* generate fresh */ }
    const seed = crypto.randomBytes(24);
    const id = deriveIdentity(seed);
    try {
        const dir = path.dirname(identityFile);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        fs.writeFileSync(identityFile + '.tmp', JSON.stringify({ pairCode: id.pairCode, createdAt: Date.now() }, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(identityFile + '.tmp', identityFile);
    } catch (e) {}
    return id;
}

/** Encrypt a UTF-8 string or Buffer into `BL2:<base64(iv12 + ciphertext + tag16)>`. */
function encryptPacket(aesKey, plain) {
    const data = Buffer.isBuffer(plain) ? plain : Buffer.from(String(plain), 'utf8');
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const enc = Buffer.concat([cipher.update(data), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'BL2:' + Buffer.concat([iv, enc, tag]).toString('base64');
}

/** Decrypt `BL2:<base64(iv12 + ciphertext + tag16)>` into a Buffer (returns null on tamper/mismatch). */
function decryptPacket(aesKey, wire) {
    if (typeof wire !== 'string' || wire.slice(0, 4) !== 'BL2:') return null;
    try {
        const raw = Buffer.from(wire.slice(4), 'base64');
        if (raw.length < 28) return null;
        const iv = raw.slice(0, 12);
        const tag = raw.slice(raw.length - 16);
        const ct = raw.slice(12, raw.length - 16);
        const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]);
    } catch (e) {
        return null;
    }
}

function encryptJson(aesKey, obj) {
    return encryptPacket(aesKey, JSON.stringify(obj));
}

function decryptJson(aesKey, wire) {
    const b = decryptPacket(aesKey, wire);
    if (!b) return null;
    try { return JSON.parse(b.toString('utf8')); } catch (e) { return null; }
}

/** Split a PNG Buffer into encrypted `< 4KB` text messages so relay servers cache every chunk for 12h. */
function encodePhotoChunks(aesKey, pngBuf, meta) {
    const snapId = (meta && meta.id) || Date.now().toString(36);
    const total = Math.max(1, Math.ceil(pngBuf.length / CHUNK_BYTES));
    const packets = [];
    for (let i = 0; i < total; i++) {
        const slice = pngBuf.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
        packets.push(encryptJson(aesKey, {
            t: 'photo_chunk',
            id: snapId,
            idx: i,
            total,
            at: (meta && meta.at) || Date.now(),
            title: (meta && meta.title) || '',
            alert: !!(meta && meta.alert),
            b64: slice.toString('base64'),
        }));
    }
    return packets;
}

class CloudBridge {
    constructor(opts) {
        this.identity = opts.identity;
        this.upOpts = opts.upOpts;
        this.relayHost = opts.relayHost || DEFAULT_RELAY_HOST;
        this.appBase = opts.appBase || DEFAULT_APP_BASE;
        this.onCommand = opts.onCommand;   // async (cmdObj) => resultObj
        this.log = opts.log || (() => {});
        this.enabled = opts.enabled !== false;
        this.lastPushHash = '';
        this.lastPushAt = 0;
        this.lastOkAt = 0;
        this.lastError = '';
        this.seenCmdIds = {};
        this.lastCmdTime = Math.floor(Date.now() / 1000) - 10;
        this.polling = false;
        this.stopped = false;
    }

    pairingUrl() {
        return this.appBase + '#' + this.identity.pairCode;
    }

    async _postTopic(topic, textBody, timeoutMs) {
        if (!this.enabled) return null;
        const res = await Up.request(this.upOpts, {
            host: this.relayHost,
            path: '/' + topic,
            method: 'POST',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            body: textBody,
            timeoutMs: timeoutMs || 15000,
        });
        if (res.status < 200 || res.status >= 300) {
            this.lastError = 'HTTP ' + res.status;
            throw new Error('cloud POST HTTP ' + res.status);
        }
        this.lastError = '';
        this.lastOkAt = Date.now();
        return res;
    }

    /** Publish compact encrypted vehicle state (debounced unless `force` is true, e.g. on park/action/alert). */
    async publishState(statePayload, force) {
        if (!this.enabled || this.stopped) return false;
        const now = Date.now();
        const coreSig = JSON.stringify([
            statePayload.telemetry && statePayload.telemetry.condition,
            statePayload.telemetry && statePayload.telemetry.engineRunning,
            statePayload.telemetry && Math.round((statePayload.telemetry.speed || 0) / 3),
            statePayload.telemetry && statePayload.telemetry.fuelPct,
            statePayload.telemetry && statePayload.telemetry.battery12v,
            statePayload.telemetry && statePayload.telemetry.locked,
            statePayload.telemetry && statePayload.telemetry.doorsOpen,
            statePayload.telemetry && statePayload.telemetry.trunkOpen,
            statePayload.telemetry && statePayload.telemetry.climate1cr,
            statePayload.valet && statePayload.valet.enabled,
            statePayload.lastTrip && statePayload.lastTrip.endedAt,
            statePayload.alert,
        ]);
        if (!force && coreSig === this.lastPushHash && (now - this.lastPushAt < 25000)) return false;
        if (!force && (now - this.lastPushAt < 4000)) return false;

        this.lastPushHash = coreSig;
        this.lastPushAt = now;
        const packet = encryptJson(this.identity.aesKey, Object.assign({ t: 'state', at: now }, statePayload));
        await this._postTopic(this.identity.topics.state, packet, 12000);
        return true;
    }

    /** Publish an encrypted PNG snapshot across 12h-cached chunks so sleeping-car opens still show the photo. */
    async publishSnapshot(pngBuf, meta) {
        if (!this.enabled || this.stopped || !Buffer.isBuffer(pngBuf)) return false;
        const chunks = encodePhotoChunks(this.identity.aesKey, pngBuf, meta);
        for (let i = 0; i < chunks.length; i++) {
            await this._postTopic(this.identity.topics.photo, chunks[i], 15000);
        }
        return true;
    }

    /** Publish encrypted 1CR schema or command result to `diag` topic. */
    async publishDiag(payload) {
        if (!this.enabled || this.stopped) return false;
        // Trim large schema arrays if needed to fit 3.8KB message limit cleanly
        const compact = JSON.stringify(payload);
        if (compact.length <= 2600) {
            await this._postTopic(this.identity.topics.diag, encryptPacket(this.identity.aesKey, compact), 12000);
            return true;
        }
        const total = Math.ceil(compact.length / 2200);
        const did = Date.now().toString(36);
        for (let i = 0; i < total; i++) {
            await this._postTopic(this.identity.topics.diag, encryptJson(this.identity.aesKey, {
                t: 'diag_chunk', id: did, idx: i, total, part: compact.slice(i * 2200, (i + 1) * 2200),
            }), 12000);
        }
        return true;
    }

    /** Poll incoming encrypted commands sent from iPhone PWA or Android APK. */
    async pollCommandsOnce() {
        if (!this.enabled || this.polling || this.stopped) return;
        this.polling = true;
        try {
            const since = Math.max(0, this.lastCmdTime);
            const res = await Up.request(this.upOpts, {
                host: this.relayHost,
                path: '/' + this.identity.topics.cmd + '/json?poll=1&since=' + since,
                method: 'GET',
                timeoutMs: 10000,
            });
            if (res.status === 200 && res.body) {
                this.lastOkAt = Date.now();
                this.lastError = '';
                const lines = res.body.split('\n').filter(Boolean);
                for (let i = 0; i < lines.length; i++) {
                    let ev = null;
                    try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
                    if (!ev || ev.event !== 'message' || typeof ev.message !== 'string') continue;
                    if (typeof ev.time === 'number' && ev.time >= this.lastCmdTime) this.lastCmdTime = ev.time + 1;
                    if (ev.id && this.seenCmdIds[ev.id]) continue;
                    if (ev.id) this.seenCmdIds[ev.id] = true;
                    const cmdObj = decryptJson(this.identity.aesKey, ev.message);
                    if (!cmdObj || !cmdObj.cmd) continue;
                    // Ignore stale commands older than 5 minutes unless explicitly flagged `queueIfAsleep`
                    if (cmdObj.at && (Date.now() - cmdObj.at > 5 * 60000) && !cmdObj.queueIfAsleep) continue;
                    if (cmdObj.id && this.seenCmdIds['c_' + cmdObj.id]) continue;
                    if (cmdObj.id) this.seenCmdIds['c_' + cmdObj.id] = true;
                    await this.onCommand(cmdObj);
                }
            }
        } catch (e) {
            // Normal when car has no internet uplink yet
        }
        this.polling = false;
    }
}

module.exports = {
    DEFAULT_RELAY_HOST,
    DEFAULT_APP_BASE,
    toBase64Url,
    fromBase64Url,
    deriveIdentity,
    loadOrCreateIdentity,
    encryptPacket,
    decryptPacket,
    encryptJson,
    decryptJson,
    encodePhotoChunks,
    CloudBridge,
};
