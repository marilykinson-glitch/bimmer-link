'use strict';
/**
 * car-link.js - live BMW MGU vehicle bridge (SOME/IP + UDS over InternalTasu) and 1CR Remote Start / Pre-conditioning engine.
 *
 * Runs as an isolated child process (`node car-link.js worker`) so native `/usr/lib/someip.node` calls never block
 * the HTTP setup portal or Telegram uplink. Communicates over newline-delimited JSON on stdin/stdout.
 *
 * Capabilities:
 *   1. Live Positioning (`Positioning.currentLocation` map-matched dead-reckoning for underground garages + `rawPositionData` / `GnssPositioning`).
 *   2. Vehicle state transitions (`VehicleCondition`: FAHREN -> FAHRBEREITSCHAFT_BEENDEN / WOHNEN / PARKEN_BN_IO) for automatic Park Snapshot & Trip summary.
 *   3. Driving & status signals: Speed, RPM, Gear/Selector (P/R/N/D), Coolant/Oil/Ambient/Cabin temperatures, Fuel %, Remaining Range, Odometer, Doors/Windows/Trunk/Hood/Lock states.
 *   4. On-demand 12V battery voltage read via UDS 0x22 F442 (ISO Control Module Voltage on DME 0x12 / BDC 0x40) — only on snapshot/manual refresh so sleep is never delayed.
 *   5. Option 1CR (Remote Engine Start & Auxiliary Pre-conditioning):
 *      - Auto-discovers all Climate / Auxiliary / Standheizung / Preconditioning / DepartureTimer interfaces in `/etc/oap/someip/someip-interfaces.json`.
 *      - Synthesizes schema-valid payloads from the car's own Franca type catalog for:
 *          * `start1cr`: Enables 1CR engine-start consent if needed + triggers immediate pre-conditioning / engine start (with near-now timer fallback).
 *          * `stop1cr`: Stops active remote start / auxiliary conditioning.
 *          * `schedule1cr`: Programs the hardware Departure Timer in BDC_BODY3 / IHKA so the car wakes from 0W deep sleep at HH:MM and starts via 1CR.
 *          * `invokeRaw`: Executes any specific SOME/IP setter/method from the Phone 1CR Inspector UI and optionally saves it as the car's pinned 1CR profile.
 *
 * Node 8 compatible, zero external npm dependencies.
 */
const fs = require('fs');
const path = require('path');

const env = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const CATALOG_PATH = env('BL_CATALOG', '/etc/oap/someip/someip-interfaces.json');
const SOMEIP_PATH = env('BL_SOMEIP', '/usr/lib/someip.node');
const PROFILE_PATH = env('BL_1CR_PROFILE', '/var/opt/bimmer-link/1cr-profile.json');
const APPMGMTS = (env('BL_APPMGMT', '') ? [env('BL_APPMGMT', '')] : []).concat([
    '/usr/lib/oap-mainapp/src/AppManagement/AppManagement.js',
    '/usr/lib/oap-mainapp21/src/AppManagement/AppManagement.js',
]);

/* ---------------- Pure scaling & parsing helpers (unit-testable without car) ---------------- */

const CONDITIONS = {
    PARKEN_BN_NIO: 1, PARKEN_BN_IO: 2, STANDFUNKTIONEN_KUNDE_NICHT_IM_FZG: 3,
    WOHNEN: 5, PRUEFEN_ANALYSE_DIAGNOSE: 7, FAHRBEREITSCHAFT_HERSTELLEN: 8,
    FAHREN: 10, FAHRBEREITSCHAFT_BEENDEN: 12,
};
const CONDITION_LABELS = {
    1: 'Ngủ sâu (PARKEN_NIO)', 2: 'Đã đỗ & khoá (PARKEN)', 3: 'Làm mát từ xa (STANDFUNKTIONEN)',
    5: 'Tắt máy ngồi xe (WOHNEN)', 7: 'Bật điện (IGNITION)', 8: 'Đang đề nổ',
    10: 'Đang nổ máy / Lái (FAHREN)', 12: 'Vừa tắt máy',
};

function parseCondition(x) {
    const n = typeof x === 'number' ? x : CONDITIONS[String(x || '').toUpperCase()];
    return n >= 1 && n <= 12 ? n : null;
}

function validCoords(lat, lon) {
    if (typeof lat !== 'number' || typeof lon !== 'number' || !isFinite(lat) || !isFinite(lon)) return false;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
    if (Math.abs(lat) < 0.001 && Math.abs(lon) < 0.001) return false;
    return true;
}

function scaleDeg(v, maxAbs) {
    if (typeof v !== 'number' || !isFinite(v)) return NaN;
    if (Math.abs(v) <= maxAbs) return v;
    if (Math.abs(v) <= maxAbs * 1e7 && Math.floor(v) === v) return v * 1e-7;
    return NaN;
}

function extractCoords(v, depth) {
    if (!v || typeof v !== 'object' || (depth || 0) > 4) return null;
    if (v.coordinatesValid === false) return null;
    const rawLat = v.latitude !== undefined ? v.latitude : v.wgs84Latitude;
    const rawLon = v.longitude !== undefined ? v.longitude : v.wgs84Longitude;
    if (rawLat !== undefined && rawLon !== undefined) {
        const lat = scaleDeg(Number(rawLat), 90), lon = scaleDeg(Number(rawLon), 180);
        if (validCoords(lat, lon)) return { lat, lon };
    }
    const sub = ['position', 'baseLocation', 'geoLocation', 'guidableLocation', 'location', 'coordinates'];
    for (let i = 0; i < sub.length; i++) {
        if (v[sub[i]] && typeof v[sub[i]] === 'object') {
            const hit = extractCoords(v[sub[i]], (depth || 0) + 1);
            if (hit) return hit;
        }
    }
    return null;
}

const TEXT_IDS = {
    1: 'LOCATION_NAME', 2: 'FULL_ADDRESS', 11: 'COUNTRY', 12: 'STATE', 13: 'TOWN_CITY',
    14: 'STREET', 31: 'PREFECTURE', 33: 'DISTRICT', 34: 'PROVINCE', 204: 'WARD',
};

function speechText(v) {
    if (typeof v === 'string') return v.trim();
    if (!v || typeof v !== 'object') return '';
    const s = v.orthography || v.text || v.value || '';
    return typeof s === 'string' ? s.trim() : '';
}

function extractPlaceText(v) {
    const td = (v && v.textDescription) || (v && v.baseLocation && v.baseLocation.textDescription) ||
        (v && v.geoLocation && v.geoLocation.textDescription) || null;
    const list = td && td.textDescriptorList;
    if (!list || typeof list !== 'object') return { street: '', district: '', city: '' };
    const map = {};
    const put = (k, val) => {
        const key = TEXT_IDS[k] || String(k || '').toUpperCase();
        const txt = speechText(val);
        if (key && txt && !map[key]) map[key] = txt;
    };
    if (Array.isArray(list)) {
        list.forEach((item) => {
            if (Array.isArray(item) && item.length >= 2) put(item[0], item[1]);
            else if (item && typeof item === 'object') put(item.key !== undefined ? item.key : item.id, item.value !== undefined ? item.value : item);
        });
    } else {
        Object.keys(list).forEach((k) => put(k, list[k]));
    }
    return {
        street: map.STREET || map.LOCATION_NAME || '',
        district: map.DISTRICT || map.WARD || '',
        city: map.TOWN_CITY || map.PROVINCE || map.STATE || '',
    };
}

function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad, dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/* ---------------- Catalog Introspection & 1CR Payload Synthesis ---------------- */

const CLIMATE_IFACE_RE = /climate|auxiliary|standheiz|stationary|precond|parkheat|remotestart|independentvent/i;
const BODY_IFACE_RE = /(^|\.)(Door|Window|Lock|CentralLock|Tailgate|Trunk|Bonnet|Flap|Body|Kombi|Vehicle|CDS|TPMS)/i;

/** Classify a Climate / 1CR field or method into semantic roles for automatic invocation. */
function classifyClimateMember(ifaceName, memberName, kind, meta) {
    const full = ifaceName + '.' + memberName;
    const roles = [];
    const writable = kind === 'method' || !!(meta && meta.setter);
    if (/remote.*engine.*start|engine.*start.*climat|allow.*engine.*start|1cr/i.test(full)) {
        roles.push(writable ? 'consent_write' : 'consent_read');
    }
    if (/direct.*oper|immediate|adhoc|ad_hoc|activate.*aux|start.*aux|park.*heat|stationary.*clim|standheiz|standklima|independent.*vent|precond|aux.*clim|climatization.*now/i.test(full)) {
        if (!/timer|schedule|weekly|abfahrt|departure/i.test(memberName)) {
            roles.push(writable ? 'direct_write' : 'direct_read');
        }
    }
    if (/timer|departure|abfahrt|schedule|weekly/i.test(full)) {
        roles.push(writable ? 'timer_write' : 'timer_read');
    }
    if (/temp/i.test(memberName) && !writable) roles.push('temp_read');
    if (/status|state|active|on/i.test(memberName) && !writable && !roles.length) roles.push('state_read');
    return roles;
}

/**
 * Inspects a Franca / OAP master catalog (`db`) and returns structured descriptors for all
 * Climate / 1CR / Pre-conditioning interfaces, fields, and methods.
 */
function discoverClimateCatalog(db) {
    const interfaces = (db && db.interfaces) || {};
    const types = Object.assign({}, (db && db.types) || {}, (db && db.typeDefinitions) || {}, (db && db.enumerations) || {}, (db && db.structs) || {});
    const found = [];

    Object.keys(interfaces).sort().forEach((ifaceName) => {
        if (!CLIMATE_IFACE_RE.test(ifaceName)) return;
        const iv = interfaces[ifaceName] || {};
        const fields = iv.fields || {};
        const methods = iv.methods || {};
        const broadcasts = iv.broadcasts || iv.events || {};
        const item = {
            iface: ifaceName,
            serviceId: iv.serviceId || null,
            fields: [],
            methods: [],
            broadcasts: Object.keys(broadcasts),
        };
        Object.keys(fields).sort().forEach((fname) => {
            const fm = fields[fname] || {};
            const typeDef = resolveTypeDef(db, iv, fm.type);
            item.fields.push({
                name: fname,
                getter: !!fm.getter,
                setter: !!fm.setter,
                notifier: fm.notifier !== false,
                type: fm.type || null,
                typeDef,
                roles: classifyClimateMember(ifaceName, fname, 'field', fm),
            });
        });
        Object.keys(methods).sort().forEach((mname) => {
            const mm = methods[mname] || {};
            const inArgs = Array.isArray(mm.inArgs) ? mm.inArgs : Object.keys(mm.in || mm.inArgs || {}).map((k) => Object.assign({ name: k }, (mm.in || mm.inArgs)[k]));
            item.methods.push({
                name: mname,
                inArgs: inArgs.map((a) => ({
                    name: a && a.name,
                    type: a && a.type,
                    typeDef: resolveTypeDef(db, iv, a && a.type),
                })),
                roles: classifyClimateMember(ifaceName, mname, 'method', mm),
            });
        });
        found.push(item);
    });
    return { interfaces: found, hasTypes: Object.keys(types).length > 0 };
}

function resolveTypeDef(db, iv, typeName) {
    if (!typeName || typeof typeName !== 'string') return null;
    const pools = [
        iv && iv.types, iv && iv.enumerations, iv && iv.structs,
        db && db.types, db && db.enumerations, db && db.structs, db && db.typeDefinitions,
    ];
    const shortName = typeName.split('.').pop();
    for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        if (!p || typeof p !== 'object') continue;
        if (p[typeName]) return summarizeType(p[typeName]);
        if (p[shortName]) return summarizeType(p[shortName]);
    }
    return null;
}

function summarizeType(t) {
    if (!t || typeof t !== 'object') return null;
    if (t.enumerators || t.values || t.enumValues) {
        const ev = t.enumerators || t.values || t.enumValues;
        return { kind: 'enum', values: Array.isArray(ev) ? ev.map((x) => (x && x.name !== undefined ? x.name : x)) : Object.keys(ev) };
    }
    if (t.fields || t.members || t.elements) {
        const fl = t.fields || t.members || t.elements;
        const fields = Array.isArray(fl)
            ? fl.map((x) => ({ name: x && x.name, type: x && x.type }))
            : Object.keys(fl).map((k) => ({ name: k, type: fl[k] && fl[k].type }));
        return { kind: 'struct', fields };
    }
    return { kind: String(t.kind || t.type || 'primitive') };
}

/**
 * Pick an enum/boolean/numeric value for turning a feature ON or OFF based on its Franca type definition
 * or its last observed live value on the bus (`sample`).
 */
function pickEnumOrBool(typeDef, wantOn, sample) {
    if (typeDef && typeDef.kind === 'enum' && Array.isArray(typeDef.values) && typeDef.values.length) {
        const vals = typeDef.values.map(String);
        const posRe = wantOn
            ? /^(ON|ACTIVE|ACTIVATE|START|ENABLE|ENABLED|TRUE|IMMEDIATE|DIRECT_ON|CLIMATE_ON|RUN|1)$/i
            : /^(OFF|INACTIVE|DEACTIVATE|STOP|DISABLE|DISABLED|FALSE|DIRECT_OFF|CLIMATE_OFF|0)$/i;
        const looseRe = wantOn
            ? /(^|_)(ON|ACTIVE|START|ENABLE|RUN|HEAT|COOL|VENT)(_|$)/i
            : /(^|_)(OFF|INACTIVE|STOP|DISABLE|CANCEL)(_|$)/i;
        const noInvalid = vals.filter((v) => !/INVALID|UNKNOWN|ERROR|SIGNAL_UNAVAILABLE|NO_ACTION|INIT/i.test(v));
        const exact = noInvalid.find((v) => posRe.test(v));
        if (exact !== undefined) return exact;
        const loose = noInvalid.find((v) => looseRe.test(v));
        if (loose !== undefined) return loose;
    }
    if (typeof sample === 'boolean') return !!wantOn;
    if (typeof sample === 'number') return wantOn ? 1 : 0;
    if (typeof sample === 'string') {
        if (/^(true|false)$/i.test(sample)) return !!wantOn;
        if (/OFF|INACTIVE|STOP|DISABLE/i.test(sample) && wantOn) {
            return sample.replace(/INACTIVE/ig, 'ACTIVE').replace(/DISABLE[D]?/ig, 'ENABLED').replace(/STOP/ig, 'START').replace(/OFF/ig, 'ON');
        }
        if (/ON|ACTIVE|START|ENABLE/i.test(sample) && !wantOn) {
            return sample.replace(/ACTIVE/ig, 'INACTIVE').replace(/ENABLE[D]?/ig, 'DISABLED').replace(/START/ig, 'STOP').replace(/ON/ig, 'OFF');
        }
    }
    return wantOn ? 1 : 0;
}

/**
 * Build a payload for a direct Start/Stop setter or method, guided by `typeDef` and any live `sample` struct.
 */
function buildDirectPayload(meta, wantOn, sample) {
    const td = meta && meta.typeDef;
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        const out = {};
        Object.keys(sample).forEach((k) => {
            if (/zone|slot|id|index/i.test(k)) out[k] = sample[k];
            else out[k] = pickEnumOrBool(null, wantOn, sample[k]);
        });
        return out;
    }
    if (td && td.kind === 'struct' && Array.isArray(td.fields)) {
        const out = {};
        td.fields.forEach((f) => {
            if (!f || !f.name) return;
            if (/zone|id|index|slot/i.test(f.name)) out[f.name] = 0;
            else out[f.name] = pickEnumOrBool(null, wantOn, /bool/i.test(String(f.type)) ? false : 0);
        });
        return out;
    }
    return pickEnumOrBool(td, wantOn, sample);
}

/**
 * Build a payload for a Departure Timer (`BDC_BODY3 / IHKA` wake schedule) setter or method.
 * Mirrors how BMW's `KombiIF.timeDate` and `Climate` timer structs name `hour`/`minute`/`active` fields.
 */
function buildTimerPayload(meta, hour, minute, enabled, sample) {
    const h = Math.max(0, Math.min(23, Number(hour) | 0));
    const m = Math.max(0, Math.min(59, Number(minute) | 0));
    const setField = (obj, k, cur) => {
        if (/hour|stunde|std/i.test(k)) obj[k] = h;
        else if (/min/i.test(k)) obj[k] = m;
        else if (/sec|sek/i.test(k)) obj[k] = 0;
        else if (/slot|index|id|timer.?nr|number/i.test(k)) obj[k] = typeof cur === 'number' ? cur : 1;
        else if (/active|enable|on|state|status|mode|operation/i.test(k)) obj[k] = pickEnumOrBool(null, enabled, cur);
        else if (cur !== undefined) obj[k] = cur;
        else obj[k] = 0;
    };
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        const out = {};
        Object.keys(sample).forEach((k) => setField(out, k, sample[k]));
        return out;
    }
    const td = meta && meta.typeDef;
    if (td && td.kind === 'struct' && Array.isArray(td.fields)) {
        const out = {};
        td.fields.forEach((f) => { if (f && f.name) setField(out, f.name, /bool/i.test(String(f.type)) ? false : undefined); });
        return out;
    }
    return {
        operationHour: h,
        operationMinute: m,
        hour: h,
        minute: m,
        active: !!enabled,
    };
}

/* ---------------- Trip & Vehicle State Tracker (pure state machine) ---------------- */

class TelemetryTracker {
    constructor() {
        this.state = {
            condition: null,
            conditionLabel: 'Chưa rõ',
            engineRunning: false,
            rpm: 0,
            speed: 0,
            stage: 'P',
            gear: 0,
            coolantC: null,
            oilC: null,
            ambientC: null,
            cabinC: null,
            fuelPct: null,
            fuelLiters: null,
            rangeKm: null,
            odometerKm: null,
            battery12v: null,
            doorsOpen: [],
            windowsOpen: [],
            locked: null,
            trunkOpen: false,
            hoodOpen: false,
            pos: null,
            climate1cr: {
                consentEnabled: null,
                active: false,
                rawState: '',
                timerText: '',
                lastAction: '',
                lastResult: '',
                discoveredCount: 0,
            },
            updatedAt: 0,
        };
        this.activeTrip = null;
        this.lastTrip = null;
        this._wasDriving = false;
    }

    /** Update fields and return emitted high-level events: [{ type: 'trip_end' | 'parked', trip }] */
    update(patch, now) {
        now = now || Date.now();
        const events = [];
        const s = this.state;
        const prevCond = s.condition;
        const prevEngine = s.engineRunning;

        Object.keys(patch || {}).forEach((k) => {
            if (patch[k] !== undefined && patch[k] !== null) s[k] = patch[k];
        });
        if (patch && patch.condition !== undefined && patch.condition !== null) {
            s.conditionLabel = CONDITION_LABELS[patch.condition] || ('Trạng thái ' + patch.condition);
            if (patch.condition === 3) s.climate1cr.active = true;
        }
        s.engineRunning = (typeof s.rpm === 'number' && s.rpm >= 400) || s.condition === 10;
        s.updatedAt = now;

        const movingOrRunning = s.engineRunning || (typeof s.speed === 'number' && s.speed > 2);
        if (movingOrRunning) {
            if (!this.activeTrip) {
                this.activeTrip = {
                    startedAt: now,
                    startPos: s.pos ? Object.assign({}, s.pos) : null,
                    lastPos: s.pos ? Object.assign({}, s.pos) : null,
                    startOdo: s.odometerKm,
                    startFuel: s.fuelPct,
                    distanceKm: 0,
                    maxSpeed: s.speed || 0,
                    maxRpm: s.rpm || 0,
                };
            } else {
                if ((s.speed || 0) > this.activeTrip.maxSpeed) this.activeTrip.maxSpeed = Math.round(s.speed);
                if ((s.rpm || 0) > this.activeTrip.maxRpm) this.activeTrip.maxRpm = Math.round(s.rpm);
                if (s.odometerKm != null && this.activeTrip.startOdo != null && s.odometerKm >= this.activeTrip.startOdo) {
                    this.activeTrip.distanceKm = Math.max(this.activeTrip.distanceKm, +(s.odometerKm - this.activeTrip.startOdo).toFixed(2));
                } else if (s.pos && this.activeTrip.lastPos) {
                    const stepKm = haversineKm(this.activeTrip.lastPos.lat, this.activeTrip.lastPos.lon, s.pos.lat, s.pos.lon);
                    if (stepKm >= 0.015 && stepKm < 5) {
                        this.activeTrip.distanceKm = +(this.activeTrip.distanceKm + stepKm).toFixed(2);
                        this.activeTrip.lastPos = Object.assign({}, s.pos);
                    }
                } else if (s.pos && !this.activeTrip.lastPos) {
                    this.activeTrip.startPos = Object.assign({}, s.pos);
                    this.activeTrip.lastPos = Object.assign({}, s.pos);
                }
            }
            if ((s.speed || 0) > 5 || s.engineRunning) this._wasDriving = true;
        }

        // Detect transition from driving/running -> shutdown/parked
        const shuttingDown = (prevCond === 10 && s.condition != null && s.condition !== 10 && s.condition !== 8) ||
            (prevEngine && !s.engineRunning && (s.speed || 0) < 1 && s.stage === 'P');

        if (shuttingDown && this._wasDriving) {
            this._wasDriving = false;
            let trip = null;
            if (this.activeTrip) {
                const durMin = Math.max(1, Math.round((now - this.activeTrip.startedAt) / 60000));
                const fuelUsed = (this.activeTrip.startFuel != null && s.fuelPct != null && this.activeTrip.startFuel >= s.fuelPct)
                    ? +(this.activeTrip.startFuel - s.fuelPct).toFixed(1) : null;
                trip = {
                    startedAt: this.activeTrip.startedAt,
                    endedAt: now,
                    durationMin: durMin,
                    distanceKm: +this.activeTrip.distanceKm.toFixed(1),
                    maxSpeed: Math.round(this.activeTrip.maxSpeed),
                    maxRpm: Math.round(this.activeTrip.maxRpm),
                    avgSpeed: durMin > 0 ? Math.round((this.activeTrip.distanceKm / (durMin / 60)) || 0) : 0,
                    fuelUsedPct: fuelUsed,
                    endPos: s.pos ? Object.assign({}, s.pos) : null,
                };
                this.lastTrip = trip;
                this.activeTrip = null;
            }
            events.push({ type: 'parked', trip });
        }
        return events;
    }
}

/* ---------------- Loading BMW's IFConfigGenerator on the MGU ---------------- */

function loadIFConfigGeneratorFromText(bundleText) {
    const m = /"someip-interfaces-generator\/IFConfigGenerator(?:\.js)?":(\d+)/.exec(bundleText);
    if (m) {
        const tail = /,\{\},\[\d+\]\)\s*;?\s*$/;
        if (!tail.test(bundleText)) throw new Error('unexpected browserify bundle tail');
        const req = new Function('require', 'return ' + bundleText.replace(tail, ',{},[])'))(require);
        return req(m[1]);
    }
    let start = bundleText.indexOf('/*** "./node_modules/mgu-IFA/IFConfigGenerator.js":');
    if (start < 0) start = bundleText.indexOf('IFConfigGenerator.js":');
    if (start >= 0) {
        const firstFn = bundleText.indexOf('function(', start);
        const end = bundleText.indexOf('\n/***/ }),', firstFn);
        if (firstFn >= 0 && end > firstFn) {
            const mod = { exports: {} };
            let src = bundleText.slice(firstFn, end).trim();
            if (src.slice(-1) !== '}') src += '\n}';
            const fn = new Function('return (' + src + ')')();
            fn(mod, mod.exports, function (id) { return require(id); });
            if (mod.exports && typeof mod.exports.generate === 'function') return mod.exports;
        }
    }
    throw new Error('IFConfigGenerator not found in bundle');
}

function loadIFConfigGenerator() {
    let lastErr = null;
    for (let i = 0; i < APPMGMTS.length; i++) {
        if (!fs.existsSync(APPMGMTS[i])) continue;
        try { return loadIFConfigGeneratorFromText(fs.readFileSync(APPMGMTS[i], 'utf8')); } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('no AppManagement.js found');
}

/* ---------------- Worker runtime on the MGU head unit ---------------- */

const within = (p, ms, label) => Promise.race([
    Promise.resolve(p),
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ': timeout')), ms)),
]);

function readJsonSafe(f) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; }
}

function writeJsonSafe(f, obj) {
    try {
        const dir = path.dirname(f);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        fs.writeFileSync(f + '.tmp', JSON.stringify(obj, null, 2) + '\n');
        fs.renameSync(f + '.tmp', f);
    } catch (e) { /* ignore read-only in tests */ }
}

async function runWorker() {
    const emit = (msg) => {
        try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { /* parent closed */ }
    };

    const tracker = new TelemetryTracker();
    const climateLive = {};        // "iface.field" -> latest value
    const climateProxies = {};     // iface -> { proxy, desc }
    let climateCatalog = { interfaces: [] };
    let tasuProxy = null;

    let db = null, gen = null, someip = null;
    try { db = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')); } catch (e) {
        emit({ ev: 'log', level: 'warn', text: 'catalog unavailable: ' + e.message });
    }
    if (db) {
        try { gen = loadIFConfigGenerator(); } catch (e) { emit({ ev: 'log', level: 'warn', text: 'IFConfigGenerator: ' + e.message }); }
        try { someip = require(SOMEIP_PATH); } catch (e) { emit({ ev: 'log', level: 'warn', text: 'someip.node: ' + e.message }); }
    }

    // Serialize native buildProxy/init ticks just like kit/runtime/signals.js to avoid vsomeip futex contention
    let chain = Promise.resolve();
    function nativeTick(fn) {
        const step = () => new Promise((res, rej) => setImmediate(() => {
            try { Promise.resolve(fn()).then(res, rej); } catch (e) { rej(e); }
        }));
        const p = chain.then(step, step);
        chain = p.catch(() => {});
        return p;
    }

    async function openDynamicProxy(ifaceName, attrMap, methods, broadcasts) {
        if (!db || !gen || !someip || !db.interfaces || !db.interfaces[ifaceName]) return null;
        const spec = { instances: '*' };
        if (attrMap && Object.keys(attrMap).length) spec.attributes = attrMap;
        if (methods && methods.length) spec.methods = methods;
        if (broadcasts && broadcasts.length) spec.broadcasts = broadcasts;
        const proxies = {};
        proxies[ifaceName] = spec;
        const generated = gen.generate(db, { proxies, services: {} });
        const cfg = generated && generated[ifaceName];
        if (!cfg) return null;
        const inst = Object.keys(cfg.instances || { '1': 1 })[0] || '1';
        return nativeTick(() => within(someip.buildProxy(cfg, String(inst)).then((px) => px.init().then(() => px)), 5000, ifaceName));
    }

    function pushPatch(patch) {
        const evs = tracker.update(patch, Date.now());
        emit({ ev: 'telemetry', state: tracker.state, activeTrip: tracker.activeTrip, lastTrip: tracker.lastTrip });
        evs.forEach((e) => emit({ ev: e.type, trip: e.trip, state: tracker.state }));
    }

    // 1. Subscribe to Positioning, Core Driving, Fuel/Range/Body, and Climate/1CR
    if (db && gen && someip) {
        // Positioning
        const allIfaces = Object.keys(db.interfaces || {});
        for (let i = 0; i < allIfaces.length; i++) {
            const name = allIfaces[i];
            const iv = db.interfaces[name] || {};
            const fnames = Object.keys(iv.fields || {});
            const bnames = Object.keys(iv.broadcasts || iv.events || {});
            if (/(^|\.)Positioning$/.test(name) && (fnames.indexOf('currentLocation') >= 0 || fnames.indexOf('rawPositionData') >= 0)) {
                const attrs = {};
                if (fnames.indexOf('currentLocation') >= 0) attrs.currentLocation = 'rs';
                if (fnames.indexOf('rawPositionData') >= 0) attrs.rawPositionData = 'rs';
                try {
                    const px = await openDynamicProxy(name, attrs, [], []);
                    if (px) {
                        const onPos = (f, val) => {
                            const c = extractCoords(val, 0);
                            if (!c) return;
                            const pl = f === 'currentLocation' ? extractPlaceText(val) : { street: '', district: '', city: '' };
                            if (f === 'rawPositionData' && tracker.state.pos && tracker.state.pos.source === 'nav' && (Date.now() - tracker.state.pos.at < 60000)) return;
                            pushPatch({ pos: { lat: c.lat, lon: c.lon, street: pl.street, district: pl.district, city: pl.city, source: f === 'currentLocation' ? 'nav' : 'gnss', at: Date.now() } });
                        };
                        Object.keys(attrs).forEach((f) => {
                            try { px.subscribe({ name: f, onReceive: (v) => onPos(f, v) }); } catch (e) {}
                            try { px.getValue(f, 2500).then((v) => onPos(f, v)).catch(() => {}); } catch (e) {}
                        });
                    }
                } catch (e) { emit({ ev: 'log', level: 'warn', text: 'pos proxy: ' + e.message }); }
            } else if (/GnssPositioning$/i.test(name) && bnames.indexOf('positioning') >= 0) {
                try {
                    const px = await openDynamicProxy(name, {}, [], ['positioning']);
                    if (px) px.subscribe({ name: 'positioning', onReceive: (v) => {
                        if (tracker.state.pos && (Date.now() - tracker.state.pos.at < 60000)) return;
                        const c = extractCoords(v, 0);
                        if (c) pushPatch({ pos: { lat: c.lat, lon: c.lon, street: '', district: '', city: '', source: 'gnss', at: Date.now() } });
                    } });
                } catch (e) {}
            }
        }

        // Core driving signals (CDS, Vehicle2, VehicleInformation, VehicleCondition)
        const coreSpecs = [
            {
                iface: 'de.bmw.infotainment.vehicle.CDS',
                fields: ['statusEngineSpeed2', 'statusEngineTemperature'],
                onField: (f, v) => {
                    if (!v) return;
                    if (f === 'statusEngineSpeed2' && v.actualValueRPMEngineCrankshaft !== undefined && v.actualValueRPMEngineCrankshaft !== 65535) {
                        const rpm = v.actualValueRPMEngineCrankshaft * 0.25;
                        pushPatch({ rpm: rpm < 400 ? 0 : Math.round(rpm) });
                    } else if (f === 'statusEngineTemperature') {
                        const patch = {};
                        if (v.temperatureEngineDrive !== undefined && v.temperatureEngineDrive !== 255) patch.coolantC = v.temperatureEngineDrive - 48;
                        if (v.temperatureEngineOilDrive !== undefined && v.temperatureEngineOilDrive !== 255) patch.oilC = v.temperatureEngineOilDrive - 48;
                        pushPatch(patch);
                    }
                },
            },
            {
                iface: 'de.bmw.infotainment.vehicle.Vehicle2',
                fields: ['statusCarSpeed2'],
                onField: (f, v) => {
                    if (v && v.speedVehicleCentreOfGravity !== undefined && v.speedVehicleCentreOfGravity !== 65535) {
                        pushPatch({ speed: +(v.speedVehicleCentreOfGravity * 0.015625).toFixed(1) });
                    }
                },
            },
            {
                iface: 'de.bmw.infrastructure.VehicleCondition',
                fields: ['VehicleCondition'],
                onField: (f, v) => {
                    const c = parseCondition(v && v.statusConditionVehicle);
                    if (c !== null) pushPatch({ condition: c });
                },
            },
            {
                iface: 'de.bmw.infrastructure.VehicleInformation',
                fields: ['statusGearboxDrive', 'DataPowerTrain2'],
                onField: (f, v) => {
                    if (!v) return;
                    if (f === 'statusGearboxDrive') {
                        const st = { 1: 'P', 2: 'R', 3: 'N', 4: 'D', P: 'P', R: 'R', N: 'N', D: 'D' }[v.statusActualStageDrive];
                        if (st) pushPatch({ stage: st });
                    } else if (f === 'DataPowerTrain2' && v.statusGearSelectionDrive !== undefined) {
                        const raw = v.statusGearSelectionDrive;
                        const map = { 1: 'N', 2: 'R', 3: 'P', N: 'N', R: 'R', P: 'P' };
                        if (map[raw]) pushPatch({ stage: map[raw] });
                        else if ((typeof raw === 'number' && raw >= 5 && raw <= 13) || /^_\d$/.test(String(raw))) pushPatch({ stage: 'D' });
                    }
                },
            },
        ];

        for (let i = 0; i < coreSpecs.length; i++) {
            const cs = coreSpecs[i];
            const iv = db.interfaces && db.interfaces[cs.iface];
            if (!iv) continue;
            const attrs = {};
            cs.fields.forEach((f) => { if (iv.fields && iv.fields[f]) attrs[f] = 'rs'; });
            if (!Object.keys(attrs).length) continue;
            try {
                const px = await openDynamicProxy(cs.iface, attrs, [], []);
                if (px) {
                    Object.keys(attrs).forEach((f) => {
                        try { px.subscribe({ name: f, onReceive: (v) => cs.onField(f, v) }); } catch (e) {}
                        try { px.getValue(f, 2500).then((v) => cs.onField(f, v)).catch(() => {}); } catch (e) {}
                    });
                }
            } catch (e) { emit({ ev: 'log', level: 'warn', text: cs.iface + ': ' + e.message }); }
        }

        // Dynamic Fuel / Range / Odometer / Ambient Temp / Door / Lock watchers
        for (let i = 0; i < allIfaces.length; i++) {
            const name = allIfaces[i];
            if (!BODY_IFACE_RE.test(name)) continue;
            const iv = db.interfaces[name] || {};
            const fnames = Object.keys(iv.fields || {});
            const want = fnames.filter((f) => /tank|fuel|range|reichweite|odometer|mileage|outsideTemp|exteriorTemp|ambientTemp|door|window|lock|tailgate|trunk|bonnet|hood/i.test(f)).slice(0, 12);
            if (!want.length) continue;
            for (let k = 0; k < want.length; k++) {
                const fname = want[k];
                const fm = iv.fields[fname] || {};
                const mode = fm.getter ? 'rs' : 's';
                try {
                    const attrs = {}; attrs[fname] = mode;
                    const px = await openDynamicProxy(name, attrs, [], []);
                    if (!px) continue;
                    const onBody = (val) => interpretBodyField(name, fname, val, pushPatch, tracker.state);
                    try { px.subscribe({ name: fname, onReceive: onBody }); } catch (e) {}
                    if (fm.getter) { try { px.getValue(fname, 2500).then(onBody).catch(() => {}); } catch (e) {} }
                } catch (e) {}
            }
        }

        // 2. Discover & open ALL Climate / 1CR / Pre-conditioning interfaces
        climateCatalog = discoverClimateCatalog(db);
        tracker.state.climate1cr.discoveredCount = climateCatalog.interfaces.length;
        for (let i = 0; i < climateCatalog.interfaces.length; i++) {
            const desc = climateCatalog.interfaces[i];
            const attrs = {};
            desc.fields.forEach((f) => {
                attrs[f.name] = (f.getter ? 'r' : '') + (f.setter ? 'w' : '') + (f.notifier ? 's' : '');
                if (!attrs[f.name]) attrs[f.name] = 'r';
            });
            const methods = desc.methods.map((m) => m.name);
            let px = null;
            try {
                px = await openDynamicProxy(desc.iface, attrs, methods, desc.broadcasts);
            } catch (e) {
                // Fallback: build read/write per field safely if combined schema had an unsupported type
                const safeAttrs = {};
                desc.fields.forEach((f) => {
                    if (f.roles.length) safeAttrs[f.name] = (f.getter ? 'r' : '') + (f.setter ? 'w' : '') + (f.notifier ? 's' : '') || 'r';
                });
                try { px = await openDynamicProxy(desc.iface, safeAttrs, methods, []); } catch (e2) {}
            }
            if (!px) continue;
            climateProxies[desc.iface] = { proxy: px, desc };
            desc.fields.forEach((f) => {
                const key = desc.iface + '.' + f.name;
                const onVal = (val) => {
                    climateLive[key] = val;
                    interpretClimateField(desc.iface, f, val, pushPatch, tracker.state);
                };
                if (f.notifier) { try { px.subscribe({ name: f.name, onReceive: onVal }); } catch (e) {} }
                if (f.getter) { try { px.getValue(f.name, 2500).then(onVal).catch(() => {}); } catch (e) {} }
            });
        }

        // 3. Optional UDS TASU proxy for on-demand 12V battery voltage read (never polled continuously!)
        const tasuName = 'com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu';
        if (db.interfaces && db.interfaces[tasuName]) {
            try {
                const generated = gen.generate(db, {
                    proxies: { [tasuName]: { instances: '*', methods: ['sendTasuRequest'], broadcasts: ['sendTasuResponse'] } },
                    services: {},
                });
                const cfg = generated && generated[tasuName];
                if (cfg) {
                    tasuProxy = await nativeTick(() => someip.buildProxy(cfg, 'SystemFunctionsInternalTasuInst1').then((p) => p.init().then(() => p)));
                }
            } catch (e) { emit({ ev: 'log', level: 'warn', text: 'TASU init: ' + e.message }); }
        }
    }

    /** Read 12V battery voltage on demand via UDS 0x22 F442 on DME (0x12) or BDC (0x40). */
    async function readBattery12V() {
        if (!tasuProxy) return tracker.state.battery12v;
        const tryEcu = (ecu, didHi, didLo, factor) => new Promise((resolve) => {
            let done = false;
            const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
            const timer = setTimeout(() => finish(null), 2200);
            try {
                tasuProxy.subscribe({
                    name: 'sendTasuResponse',
                    onReceive: (msg) => {
                        const raw = msg && (msg.udsResponse || msg);
                        const b = Buffer.isBuffer(raw) ? raw : (raw && raw.data ? Buffer.from(raw.data) : null);
                        if (!b || b.length < 14 || b[6] !== ecu) return;
                        const uds = b.slice(9);
                        if (uds[0] === 0x62 && uds[1] === didHi && uds[2] === didLo && uds.length >= 5) {
                            const volts = +(((uds[3] << 8) | uds[4]) * factor).toFixed(2);
                            if (volts >= 8 && volts <= 16.8) finish(volts);
                        }
                    },
                });
                tasuProxy.callMethod('sendTasuRequest', {
                    sourceAddress: 0xF2, targetAddress: ecu, serviceID: 0x22, subroutineID: 0,
                    udsDataLength: 2, udsData: Buffer.from([didHi, didLo]), deadlockTime: 0,
                }, 2000).catch(() => finish(null));
            } catch (e) { finish(null); }
        });
        const v = (await tryEcu(0x12, 0xF4, 0x42, 0.001)) || (await tryEcu(0x40, 0xF4, 0x42, 0.001));
        if (v) pushPatch({ battery12v: v });
        return v;
    }

    /** Execute 1CR Start / Stop / Schedule or Raw Inspector test */
    async function execute1CR(action, params) {
        params = params || {};
        const trace = [];
        const savedProfile = readJsonSafe(PROFILE_PATH);

        // Helper to invoke a single setter or method
        const callOne = async (iface, kind, name, payload) => {
            const entry = climateProxies[iface];
            if (!entry || !entry.proxy) throw new Error('Proxy not open: ' + iface);
            if (kind === 'setter') {
                await within(entry.proxy.setValue(name, payload, 4000), 4500, iface + '.' + name);
                return { ok: true, iface, kind, name, payload };
            }
            const res = await within(entry.proxy.callMethod(name, payload || {}, 4000), 4500, iface + '.' + name);
            return { ok: true, iface, kind, name, payload, response: res };
        };

        if (action === 'invoke_raw') {
            try {
                const r = await callOne(params.iface, params.kind, params.name, params.payload);
                if (params.saveAsDefault) {
                    const cur = savedProfile || {};
                    cur[params.role || 'start'] = { iface: params.iface, kind: params.kind, name: params.name, payload: params.payload };
                    writeJsonSafe(PROFILE_PATH, cur);
                }
                return { ok: true, trace: [r], saved: !!params.saveAsDefault };
            } catch (e) {
                return { ok: false, error: e.message, trace: [{ ok: false, error: e.message }] };
            }
        }

        if (action === 'start1cr' || action === 'stop1cr') {
            const wantOn = action === 'start1cr';
            const roleKey = wantOn ? 'start' : 'stop';

            // 1. Pinned profile wins first if user saved a verified car profile
            if (savedProfile && savedProfile[roleKey]) {
                const p = savedProfile[roleKey];
                try {
                    const r = await callOne(p.iface, p.kind, p.name, p.payload);
                    trace.push(r);
                    tracker.state.climate1cr.active = wantOn;
                    tracker.state.climate1cr.lastAction = wantOn ? 'Kích nổ 1CR (Cấu hình ghim)' : 'Tắt 1CR (Cấu hình ghim)';
                    tracker.state.climate1cr.lastResult = 'Đã gửi lệnh tới ' + p.iface.split('.').pop() + '.' + p.name;
                    pushPatch({});
                    return { ok: true, method: p.iface + '.' + p.name, trace };
                } catch (e) {
                    trace.push({ ok: false, step: 'pinned', error: e.message });
                }
            }

            // 2. Ensure 1CR Remote Engine Start consent flag is enabled before starting
            if (wantOn) {
                for (let i = 0; i < climateCatalog.interfaces.length; i++) {
                    const d = climateCatalog.interfaces[i];
                    if (!climateProxies[d.iface]) continue;
                    for (let k = 0; k < d.fields.length; k++) {
                        const f = d.fields[k];
                        if (f.setter && f.roles.indexOf('consent_write') >= 0) {
                            const sample = climateLive[d.iface + '.' + f.name];
                            const payload = buildDirectPayload(f, true, sample);
                            try { trace.push(await callOne(d.iface, 'setter', f.name, payload)); } catch (e) {
                                trace.push({ ok: false, iface: d.iface, name: f.name, error: e.message });
                            }
                        }
                    }
                }
            }

            // 3. Try discovered direct-operation setters & methods
            let succeeded = null;
            for (let i = 0; i < climateCatalog.interfaces.length; i++) {
                const d = climateCatalog.interfaces[i];
                if (!climateProxies[d.iface]) continue;
                for (let k = 0; k < d.fields.length; k++) {
                    const f = d.fields[k];
                    if (!f.setter || f.roles.indexOf('direct_write') < 0) continue;
                    const sample = climateLive[d.iface + '.' + f.name];
                    const payload = buildDirectPayload(f, wantOn, sample);
                    try {
                        const r = await callOne(d.iface, 'setter', f.name, payload);
                        trace.push(r);
                        if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + f.name;
                    } catch (e) {
                        trace.push({ ok: false, iface: d.iface, name: f.name, error: e.message });
                    }
                }
                for (let k = 0; k < d.methods.length; k++) {
                    const m = d.methods[k];
                    if (m.roles.indexOf('direct_write') < 0) continue;
                    const argObj = {};
                    m.inArgs.forEach((a) => {
                        if (a && a.name) argObj[a.name] = buildDirectPayload(a, wantOn, undefined);
                    });
                    try {
                        const r = await callOne(d.iface, 'method', m.name, argObj);
                        trace.push(r);
                        if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + m.name + '()';
                    } catch (e) {
                        trace.push({ ok: false, iface: d.iface, name: m.name, error: e.message });
                    }
                }
            }

            // 4. Smart fallback on Start: if no direct-operation writable member answered, program Departure Timer to Now + 2 min
            if (!succeeded && wantOn) {
                const target = new Date(Date.now() + 2 * 60000);
                const sched = await execute1CR('schedule1cr', { hour: target.getHours(), minute: target.getMinutes(), enabled: true });
                if (sched.ok) {
                    succeeded = 'Timer+2p (' + sched.method + ')';
                    trace.push({ ok: true, fallback: 'near_now_timer', method: sched.method });
                }
            }

            tracker.state.climate1cr.lastAction = wantOn ? 'Kích nổ / Làm mát 1CR' : 'Tắt làm mát 1CR';
            if (succeeded) {
                tracker.state.climate1cr.active = wantOn;
                tracker.state.climate1cr.lastResult = 'Thành công qua ' + succeeded;
                pushPatch({});
                return { ok: true, method: succeeded, trace };
            }
            const noCatalog = !climateCatalog.interfaces.length;
            tracker.state.climate1cr.lastResult = noCatalog
                ? 'Chưa đọc được catalog xe (chế độ mô phỏng / chưa lên xe)'
                : 'Chưa khớp tự động — mở tab Chuyên sâu 1CR trên QR để chọn đúng hàm của xe';
            pushPatch({});
            return { ok: false, error: tracker.state.climate1cr.lastResult, trace };
        }

        if (action === 'schedule1cr') {
            const h = Number(params.hour) | 0, m = Number(params.minute) | 0, en = params.enabled !== false;
            const hhmm = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
            if (savedProfile && savedProfile.timer) {
                const p = savedProfile.timer;
                const payload = buildTimerPayload({ typeDef: null }, h, m, en, p.payload);
                try {
                    const r = await callOne(p.iface, p.kind, p.name, payload);
                    tracker.state.climate1cr.timerText = en ? hhmm : 'Tắt';
                    tracker.state.climate1cr.lastAction = 'Hẹn giờ BDC/IHKA ' + hhmm;
                    tracker.state.climate1cr.lastResult = 'Đã nạp vào hộp ' + p.iface.split('.').pop();
                    pushPatch({});
                    return { ok: true, method: p.iface + '.' + p.name, trace: [r] };
                } catch (e) { trace.push({ ok: false, error: e.message }); }
            }

            let succeeded = null;
            for (let i = 0; i < climateCatalog.interfaces.length; i++) {
                const d = climateCatalog.interfaces[i];
                if (!climateProxies[d.iface]) continue;
                for (let k = 0; k < d.fields.length; k++) {
                    const f = d.fields[k];
                    if (!f.setter || f.roles.indexOf('timer_write') < 0) continue;
                    const sample = climateLive[d.iface + '.' + f.name];
                    const payload = buildTimerPayload(f, h, m, en, sample);
                    try {
                        const r = await callOne(d.iface, 'setter', f.name, payload);
                        trace.push(r);
                        if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + f.name;
                    } catch (e) { trace.push({ ok: false, iface: d.iface, name: f.name, error: e.message }); }
                }
                for (let k = 0; k < d.methods.length; k++) {
                    const mt = d.methods[k];
                    if (mt.roles.indexOf('timer_write') < 0) continue;
                    const argObj = {};
                    mt.inArgs.forEach((a) => {
                        if (a && a.name) argObj[a.name] = buildTimerPayload(a, h, m, en, undefined);
                    });
                    try {
                        const r = await callOne(d.iface, 'method', mt.name, argObj);
                        trace.push(r);
                        if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + mt.name + '()';
                    } catch (e) { trace.push({ ok: false, iface: d.iface, name: mt.name, error: e.message }); }
                }
            }
            tracker.state.climate1cr.timerText = en ? hhmm : 'Tắt';
            tracker.state.climate1cr.lastAction = (en ? 'Đặt hẹn giờ 1CR ' : 'Huỷ hẹn giờ 1CR ') + hhmm;
            tracker.state.climate1cr.lastResult = succeeded ? ('Đã lưu vào BDC/IHKA qua ' + succeeded) : 'Đã lưu lịch chờ đồng bộ xuống xe';
            pushPatch({});
            return { ok: !!succeeded, method: succeeded || 'queued', trace };
        }

        return { ok: false, error: 'unknown 1CR action: ' + action };
    }

    // Listen for JSON commands from parent daemon on stdin
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (!line) continue;
            let cmd = null;
            try { cmd = JSON.parse(line); } catch (e) { continue; }
            handleParentCmd(cmd);
        }
    });

    async function handleParentCmd(cmd) {
        const reqId = cmd.reqId;
        if (cmd.op === 'refresh_vitals') {
            await readBattery12V();
            emit({ ev: 'reply', reqId, ok: true, state: tracker.state });
        } else if (cmd.op === 'start1cr' || cmd.op === 'stop1cr' || cmd.op === 'schedule1cr' || cmd.op === 'invoke_raw') {
            const res = await execute1CR(cmd.op, cmd.params);
            emit({ ev: 'reply', reqId, ok: res.ok, result: res, state: tracker.state });
        } else if (cmd.op === 'schema') {
            emit({
                ev: 'reply',
                reqId,
                ok: true,
                schema: {
                    interfaces: climateCatalog.interfaces,
                    live: climateLive,
                    pinnedProfile: readJsonSafe(PROFILE_PATH),
                },
            });
        }
    }

    emit({ ev: 'ready', discoveredClimate: climateCatalog.interfaces.length });
    emit({ ev: 'telemetry', state: tracker.state, activeTrip: null, lastTrip: null });
}

/* ---------------- Field heuristic interpreters ---------------- */

function extractFirstNum(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (!v || typeof v !== 'object') return null;
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
        const x = v[keys[i]];
        if (typeof x === 'number' && isFinite(x) && x !== 65535 && x !== 255 && x !== 4095) return x;
    }
    return null;
}

function interpretBodyField(iface, fname, val, pushPatch, curState) {
    if (val === undefined || val === null) return;
    const key = iface + '.' + fname;
    if (/range|reichweite/i.test(fname)) {
        const n = extractFirstNum(val);
        if (n !== null && n >= 0 && n <= 2000) pushPatch({ rangeKm: Math.round(n) });
    } else if (/tank|fuel/i.test(fname)) {
        const n = extractFirstNum(val);
        if (n !== null && n >= 0 && n <= 100) pushPatch({ fuelPct: Math.round(n) });
    } else if (/odometer|mileage|totalDistance/i.test(fname)) {
        const n = extractFirstNum(val);
        if (n !== null && n > 0 && n < 2000000) pushPatch({ odometerKm: Math.round(n) });
    } else if (/outsideTemp|exteriorTemp|ambientTemp/i.test(fname)) {
        let n = extractFirstNum(val);
        if (n !== null) {
            if (n > 65 && n < 220) n = n * 0.5 - 40;
            if (n >= -45 && n <= 60) pushPatch({ ambientC: +n.toFixed(1) });
        }
    } else if (/lock/i.test(fname)) {
        const s = JSON.stringify(val).toUpperCase();
        if (/LOCKED|SECURED/.test(s) && !/UNLOCKED/.test(s)) pushPatch({ locked: true });
        else if (/UNLOCKED/.test(s)) pushPatch({ locked: false });
    } else if (/door|tailgate|trunk|bonnet|hood/i.test(key)) {
        const s = JSON.stringify(val).toUpperCase();
        const isOpen = /OPEN|AJAR/.test(s) && !/CLOSED|NOT_OPEN/.test(s);
        if (/tailgate|trunk/i.test(key)) pushPatch({ trunkOpen: isOpen });
        else if (/bonnet|hood/i.test(key)) pushPatch({ hoodOpen: isOpen });
        else if (isOpen && curState.doorsOpen.indexOf(fname) < 0) {
            pushPatch({ doorsOpen: curState.doorsOpen.concat([fname]).slice(0, 4) });
        } else if (!isOpen && curState.doorsOpen.indexOf(fname) >= 0) {
            pushPatch({ doorsOpen: curState.doorsOpen.filter((x) => x !== fname) });
        }
    }
}

function interpretClimateField(iface, fieldDesc, val, pushPatch, curState) {
    if (val === undefined || val === null) return;
    const s = JSON.stringify(val);
    const c1 = Object.assign({}, curState.climate1cr);
    if (fieldDesc.roles.indexOf('consent_read') >= 0 || fieldDesc.roles.indexOf('consent_write') >= 0) {
        if (/ON|TRUE|ACTIVE|ENABLE/i.test(s) && !/OFF|FALSE|INACTIVE|DISABLE/i.test(s)) c1.consentEnabled = true;
        else if (/OFF|FALSE|INACTIVE|DISABLE/i.test(s)) c1.consentEnabled = false;
    }
    if (fieldDesc.roles.indexOf('direct_read') >= 0 || fieldDesc.roles.indexOf('direct_write') >= 0) {
        c1.rawState = fieldDesc.name + '=' + s.slice(0, 60);
        if (/ON|ACTIVE|RUNNING|START/i.test(s) && !/OFF|INACTIVE|STOP/i.test(s)) c1.active = true;
        else if (/OFF|INACTIVE|STOP/i.test(s)) c1.active = false;
    }
    if (fieldDesc.roles.indexOf('temp_read') >= 0 && /interior|cabin|innen/i.test(fieldDesc.name)) {
        const n = extractFirstNum(val);
        if (n !== null && n >= -20 && n <= 70) pushPatch({ cabinC: +n.toFixed(1) });
    }
    pushPatch({ climate1cr: c1 });
}

if (require.main === module && process.argv[2] === 'worker') {
    process.on('SIGTERM', () => process.exit(0));
    runWorker().catch((e) => {
        try { process.stdout.write(JSON.stringify({ ev: 'log', level: 'error', text: String(e && e.message || e) }) + '\n'); } catch (x) {}
        process.exit(1);
    });
}

module.exports = {
    CONDITIONS,
    CONDITION_LABELS,
    parseCondition,
    validCoords,
    scaleDeg,
    extractCoords,
    extractPlaceText,
    haversineKm,
    classifyClimateMember,
    discoverClimateCatalog,
    pickEnumOrBool,
    buildDirectPayload,
    buildTimerPayload,
    TelemetryTracker,
    loadIFConfigGeneratorFromText,
};
