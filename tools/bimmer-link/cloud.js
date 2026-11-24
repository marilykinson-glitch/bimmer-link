'use strict';
/**
 * cloud.js - Zero-config End-to-End Encrypted (AES-256-GCM) Dual-Engine Relay for MyBMW MGU.
 *
 * Dual-Engine Zero-429 Architecture:
 *   1. Real-Time Engine (`mqtt-lite.js` over TLS 8883 <-> Mobile WSS `8084/8884`):
 *      - Single persistent connection (`broker.emqx.io` -> `broker.hivemq.com` -> `test.mosquitto.org`),
 *        delivering commands, ACKs, live telemetry, factory hero PNG, and full 360° camera snapshots
 *        in ~50 ms with `retain=true` and ZERO HTTP 429 rate limits (even on shared Hotspot IPs!).
 *   2. 12-Hour Deep-Sleep Backup (`ntfy.sh` with Single-PUT `Filename:` attachments & strict 45s pacing):
 *      - Keeps the last parked state & 360° photo cached for 12h when the car sleeps at 0W, using a single
 *        `PUT` per image (1 request instead of 45 chunks) and automatic 90s cooldown on HTTP 429.
 *
 * Strict Node 8.16 ES2017, zero external dependencies.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Up = require('./uplink');
const Mqtt = require('./mqtt-lite');

const DEFAULT_RELAY_HOST = 'ntfy.sh';
const DEFAULT_APP_BASE = 'https://marilykinson-glitch.github.io/bimmer-link/app/';
const CHUNK_BYTES = 1500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const mqttBase = 'bl2/' + topicId;
    return {
        pairCode,
        seedBuf,
        aesKey,
        topicId,
        mqttTopics: {
            state: mqttBase + '/st',
            photo: mqttBase + '/ph',
            hero: mqttBase + '/hr',
            cmd: mqttBase + '/cm',
            diag: mqttBase + '/dg',
        },
        topics: {
            state: 'bl_st_' + topicId,
            photo: 'bl_ph_' + topicId,
            hero: 'bl_hr_' + topicId,
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

/** Legacy chunk helper preserved for compatibility & unit tests. */
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
            paint: (meta && meta.paint) || '',
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
        this.seenFile = opts.seenFile || '';
        this.onCommand = opts.onCommand;
        this.log = opts.log || (() => {});
        this.enabled = opts.enabled !== false;

        this.lastPushHash = '';
        this.lastMqttPushAt = 0;
        this.lastNtfyPushAt = 0;
        this.lastNtfyPollAt = 0;
        this.ntfyCooldownUntil = 0;
        this.lastOkAt = 0;
        this.lastError = '';

        this.seenCmdIds = this._loadSeen();
        this.lastCmdCursor = '';
        this.bootSynced = false;
        this.polling = false;
        this.uploadingHero = false;
        this.heroUploadSeq = 0;
        this.stopped = false;

        this.latestStateWire = '';
        this.latestSnapWire = '';
        this.latestHeroWire = '';
        this.lastDiagObj = null;

        this.mqtt = new Mqtt.MqttBridge({
            upOpts: this.upOpts,
            subFilter: this.identity.mqttTopics.cmd,
            enabled: this.enabled,
            log: this.log,
            onMessage: (topic, payload, retain) => {
                if (retain) return;
                if (topic === this.identity.mqttTopics.cmd) {
                    this.lastOkAt = Date.now();
                    this.handleIncomingCommandWire(payload).catch((e) => this.log('mqtt cmd err: ' + e.message));
                }
            },
        });
        if (this.enabled) {
            this.mqtt.start();
        }
    }

    isOnline() {
        return !!(this.mqtt.connected || (this.lastOkAt && Date.now() - this.lastOkAt < 120000));
    }

    _loadSeen() {
        if (!this.seenFile) return {};
        try {
            const j = JSON.parse(fs.readFileSync(this.seenFile, 'utf8'));
            return (j && typeof j === 'object') ? j : {};
        } catch (e) { return {}; }
    }

    _saveSeen() {
        if (!this.seenFile) return;
        try {
            const keys = Object.keys(this.seenCmdIds);
            const trimmed = {};
            keys.slice(-160).forEach((k) => { trimmed[k] = 1; });
            this.seenCmdIds = trimmed;
            fs.writeFileSync(this.seenFile + '.tmp', JSON.stringify(trimmed));
            fs.renameSync(this.seenFile + '.tmp', this.seenFile);
        } catch (e) {}
    }

    pairingUrl() {
        return this.appBase + '#' + this.identity.pairCode;
    }

    /** Decrypt & deduplicate an incoming `BL2:` command packet from MQTT, Hotspot LAN HTTP, or `ntfy.sh`. */
    async handleIncomingCommandWire(wire, opts) {
        const cmdObj = decryptJson(this.identity.aesKey, wire);
        if (!cmdObj || !cmdObj.cmd) return { ok: false, error: 'invalid encrypted command' };
        const cid = cmdObj.id ? ('c_' + cmdObj.id) : '';
        if (cid && this.seenCmdIds[cid]) {
            return { ok: true, duplicate: true };
        }
        if (cid) {
            this.seenCmdIds[cid] = 1;
            this._saveSeen();
        }
        if (opts && opts.skipStaleSec && !cmdObj.queueIfAsleep && typeof opts.ageSec === 'number' && opts.ageSec > opts.skipStaleSec) {
            return { ok: true, skippedStale: true };
        }
        this.lastDiagObj = null;
        if (typeof this.onCommand === 'function') {
            await this.onCommand(cmdObj);
        }
        return { ok: true, diag: this.lastDiagObj };
    }

    async _sendNtfy(topic, textBody, asAttachmentName, timeoutMs) {
        if (!this.enabled || Date.now() < this.ntfyCooldownUntil) return null;
        const useAttach = !!asAttachmentName || textBody.length > 3800;
        const headers = useAttach
            ? { Filename: asAttachmentName || 'blob.txt', 'Content-Type': 'text/plain; charset=utf-8' }
            : { 'Content-Type': 'text/plain; charset=utf-8' };
        try {
            const res = await Up.request(this.upOpts, {
                host: this.relayHost,
                path: '/' + topic,
                method: useAttach ? 'PUT' : 'POST',
                headers,
                body: textBody,
                timeoutMs: timeoutMs || 15000,
            });
            if (res.status >= 200 && res.status < 300) {
                this.lastError = '';
                this.lastOkAt = Date.now();
                return res;
            }
            if (res.status === 429) {
                this.ntfyCooldownUntil = Date.now() + 90000;
                this.lastError = 'ntfy cooldown (429)';
                return null;
            }
            this.lastError = 'ntfy HTTP ' + res.status;
        } catch (e) {
            this.lastError = e.message;
        }
        return null;
    }

    /** Publish encrypted vehicle state instantly over MQTT (`retain=true`) and gently (<= 1/45s) to `ntfy.sh`. */
    async publishState(statePayload, force) {
        if (!this.enabled || this.stopped) return false;
        const now = Date.now();
        const coreSig = JSON.stringify([
            statePayload.vehicleProfile,
            statePayload.hasFactoryHero,
            statePayload.telemetry && statePayload.telemetry.condition,
            statePayload.telemetry && statePayload.telemetry.engineRunning,
            statePayload.telemetry && Math.round((statePayload.telemetry.speed || 0) / 3),
            statePayload.telemetry && statePayload.telemetry.fuelPct,
            statePayload.telemetry && statePayload.telemetry.rangeKm,
            statePayload.telemetry && statePayload.telemetry.odometerKm,
            statePayload.telemetry && statePayload.telemetry.battery12v,
            statePayload.telemetry && statePayload.telemetry.locked,
            statePayload.telemetry && statePayload.telemetry.dwaArmed,
            statePayload.telemetry && statePayload.telemetry.dwaAlarmActive,
            statePayload.telemetry && statePayload.telemetry.doorsOpen,
            statePayload.telemetry && statePayload.telemetry.windowsOpen,
            statePayload.telemetry && statePayload.telemetry.tires,
            statePayload.telemetry && statePayload.telemetry.trunkOpen,
            statePayload.telemetry && statePayload.telemetry.hoodOpen,
            statePayload.telemetry && statePayload.telemetry.checkControl,
            statePayload.telemetry && statePayload.telemetry.cbsList,
            statePayload.telemetry && statePayload.telemetry.climate1cr,
            statePayload.telemetry && statePayload.telemetry.health && statePayload.telemetry.health.checkedAt,
            statePayload.valet && statePayload.valet.enabled,
            statePayload.servicePlan,
            statePayload.destination,
            statePayload.lastTrip && statePayload.lastTrip.endedAt,
            statePayload.alert,
        ]);

        const sigChanged = coreSig !== this.lastPushHash;
        if (!force && !sigChanged && (now - this.lastMqttPushAt < 15000)) return false;
        if (!force && (now - this.lastMqttPushAt < 2500)) return false;

        this.lastPushHash = coreSig;
        this.lastMqttPushAt = now;
        const packet = encryptJson(this.identity.aesKey, Object.assign({ t: 'state', at: now }, statePayload));
        this.latestStateWire = packet;

        const mqttSent = this.mqtt.publish(this.identity.mqttTopics.state, packet, true);
        if (mqttSent) this.lastOkAt = now;

        const urgentSleepEvent = !!(statePayload.event === 'parked' || statePayload.alert);
        if (urgentSleepEvent || (now - this.lastNtfyPushAt >= 45000)) {
            this.lastNtfyPushAt = now;
            await this._sendNtfy(this.identity.topics.state, packet, null, 12000);
        }
        return true;
    }

    /** Publish encrypted JPEG/PNG snapshot in 1 retained MQTT packet + 1 single `PUT` attachment on `ntfy.sh` (ZERO chunk flood!). */
    async publishSnapshot(pngBuf, meta) {
        if (!this.enabled || this.stopped || !Buffer.isBuffer(pngBuf)) return false;
        const now = (meta && meta.at) || Date.now();
        const fullPacket = encryptJson(this.identity.aesKey, {
            t: 'photo_full',
            id: (meta && meta.id) || now.toString(36),
            at: now,
            title: (meta && meta.title) || '',
            alert: !!(meta && meta.alert),
            camMeta: (meta && meta.camMeta) || null,
            b64: pngBuf.toString('base64'),
        });
        this.latestSnapWire = fullPacket;

        const mqttSent = this.mqtt.publish(this.identity.mqttTopics.photo, fullPacket, true);
        if (mqttSent) this.lastOkAt = Date.now();

        const ntfyRes = await this._sendNtfy(this.identity.topics.photo, fullPacket, 'snap.txt', 20000);
        return !!(mqttSent || ntfyRes);
    }

    /** Publish genuine factory 2D BMW hero PNG in 1 retained MQTT packet + 1 single `PUT` attachment on `ntfy.sh`. */
    async publishHero(pngBuf, meta) {
        if (!this.enabled || this.stopped || !Buffer.isBuffer(pngBuf)) return false;
        const mySeq = ++this.heroUploadSeq;
        while (this.uploadingHero && !this.stopped) {
            await sleep(80);
            if (this.heroUploadSeq !== mySeq) return false;
        }
        if (this.stopped || this.heroUploadSeq !== mySeq) return false;
        this.uploadingHero = true;
        try {
            const now = (meta && meta.at) || Date.now();
            const fullPacket = encryptJson(this.identity.aesKey, {
                t: 'photo_full',
                id: 'h_' + now.toString(36) + '_' + (mySeq % 1000),
                at: now,
                title: (meta && meta.title) || '',
                paint: (meta && meta.paint) || '',
                b64: pngBuf.toString('base64'),
            });
            this.latestHeroWire = fullPacket;

            const mqttSent = this.mqtt.publish(this.identity.mqttTopics.hero, fullPacket, true);
            if (mqttSent) this.lastOkAt = Date.now();

            const ntfyRes = await this._sendNtfy(this.identity.topics.hero, fullPacket, 'hero.txt', 20000);
            return (this.heroUploadSeq === mySeq) && !!(mqttSent || ntfyRes);
        } finally {
            this.uploadingHero = false;
        }
    }

    /** Publish encrypted command ACK, 1CR schema, or raw diagnostic result. */
    async publishDiag(payload) {
        if (!this.enabled || this.stopped) return false;
        this.lastDiagObj = payload;
        const packet = encryptJson(this.identity.aesKey, payload);
        const mqttSent = this.mqtt.publish(this.identity.mqttTopics.diag, packet, false);
        if (mqttSent) this.lastOkAt = Date.now();

        // Only send diag over ntfy if MQTT is down or client may be waiting on ntfy
        if (!mqttSent) {
            await this._sendNtfy(this.identity.topics.diag, packet, packet.length > 3800 ? 'diag.txt' : null, 12000);
        }
        return true;
    }

    /** Gentle fallback command poll on `ntfy.sh` (every 45s when MQTT is up, 14s when MQTT is down; 90s rest on 429). */
    async pollCommandsOnce() {
        if (!this.enabled || this.polling || this.stopped) return;
        const now = Date.now();
        if (now < this.ntfyCooldownUntil) return;
        const minGap = this.mqtt.connected ? 45000 : 14000;
        if (this.lastNtfyPollAt && (now - this.lastNtfyPollAt < minGap)) return;

        this.polling = true;
        this.lastNtfyPollAt = now;
        try {
            const sinceParam = this.lastCmdCursor ? encodeURIComponent(this.lastCmdCursor) : '10m';
            const res = await Up.request(this.upOpts, {
                host: this.relayHost,
                path: '/' + this.identity.topics.cmd + '/json?poll=1&since=' + sinceParam,
                method: 'GET',
                timeoutMs: 9000,
            });
            if (res.status === 429) {
                this.ntfyCooldownUntil = Date.now() + 90000;
                this.polling = false;
                return;
            }
            if (res.status === 200) {
                this.lastOkAt = Date.now();
                this.lastError = '';
                const lines = String(res.body || '').split('\n').filter(Boolean);
                const parsedEvents = [];
                let maxServerTime = 0;
                for (let i = 0; i < lines.length; i++) {
                    let ev = null;
                    try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
                    if (!ev || ev.event !== 'message' || typeof ev.message !== 'string') continue;
                    if (typeof ev.time === 'number' && ev.time > maxServerTime) maxServerTime = ev.time;
                    parsedEvents.push(ev);
                }

                const isBootstrap = !this.bootSynced;
                this.bootSynced = true;
                let dirtySeen = false;

                for (let i = 0; i < parsedEvents.length; i++) {
                    const ev = parsedEvents[i];
                    if (ev.id) this.lastCmdCursor = ev.id;
                    if (ev.id && this.seenCmdIds[ev.id]) continue;
                    if (ev.id) { this.seenCmdIds[ev.id] = 1; dirtySeen = true; }
                    const ageSec = (maxServerTime > 0 && typeof ev.time === 'number') ? (maxServerTime - ev.time) : 0;
                    await this.handleIncomingCommandWire(ev.message, {
                        skipStaleSec: isBootstrap ? 45 : 0,
                        ageSec,
                    });
                }
                if (dirtySeen) this._saveSeen();
            }
        } catch (e) {}
        this.polling = false;
    }

    stop() {
        this.stopped = true;
        if (this.mqtt) this.mqtt.stop();
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
