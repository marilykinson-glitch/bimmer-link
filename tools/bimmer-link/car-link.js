'use strict';
/**
 * car-link.js - live BMW MGU vehicle bridge (SOME/IP + UDS over InternalTasu) and 1CR Remote Start / Pre-conditioning engine.
 *
 * Runs as an isolated child process (`node car-link.js worker`) so native `/usr/lib/someip.node` calls never block
 * the HTTP setup portal or Cloud/Telegram uplink. Communicates over newline-delimited JSON on stdin/stdout.
 *
 * Key architecture details verified against real BMW MGU firmware:
 *   1. Parses `/etc/oap/someip/someip-interfaces.json` `db.datatypes` (where Franca `enum`s store `{ type: 'enum', items }`
 *      and `struct`s store `{ type: 'struct', fields }`), trying BOTH enum string names AND numeric wire values across
 *      all available SOME/IP instances.
 *   2. Broadly discovers Climate / AirConditioning / HVAC / Standklima / Preconditioning / ParkHeating / 1CR / DepartureTimer
 *      interfaces and members across the master catalog.
 *   3. Groups body/vehicle watchers into one SOME/IP proxy per interface (no 12-field truncation) with strict field &
 *      sub-property matching so unrelated `range` or `trip` signals never corrupt Range km or Odometer km.
 *   4. Reads exact 12V Voltage (`F442`), Fuel % (`F42F`), Odometer (`F4A6`), Ambient °C (`F446`), and Coolant °C (`F405`)
 *      on-demand via UDS `0x22` / OBD `0x01` over `InternalTasu` (once at boot + on refresh/park — never blocking sleep).
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

/* ---------------- Catalog Introspection (`db.datatypes`) & 1CR Payload Synthesis ---------------- */

const CLIMATE_IFACE_RE = /climate|climatis|climatiz|aircond|hvac|heating|ventilat|thermal|auxiliary|standheiz|standklima|stationary|precond|parkheat|parkclim|remotestart|independent|departure/i;
const CLIMATE_MEMBER_HINT_RE = /standheiz|standklima|standlueft|parkheat|parkklima|parkclim|precond|remotestart|remote.*engine|engine.*start.*clim|auxiliary.*clim|aux.*heat|aux.*vent|independent.*vent|independent.*clim|stationary.*clim|climatis.*now|climatiz.*now|climate.*now|direct.*oper|sofort|departure.*timer|abfahrt/i;
const BODY_IFACE_RE = /(^|\.)(Door|Window|Lock|CentralLock|Tailgate|Trunk|Bonnet|Flap|Body|Kombi|Vehicle|CDS|Fuel|Tank)/i;
const STEERING_OR_SEAT_RE = /steeringwheel|lenkrad|seatheat|seatclim|seatvent|sitzheiz|sitzklima|massage|fragrance|ionis/i;

/** Classify a Climate / 1CR field or method into semantic roles for automatic invocation. */
function classifyClimateMember(ifaceName, memberName, kind, meta) {
    const full = ifaceName + '.' + memberName;
    const roles = [];
    const writable = kind === 'method' || !!(meta && meta.setter);
    if (STEERING_OR_SEAT_RE.test(full)) {
        if (/status|state|active|on|mode/i.test(memberName) && !writable) roles.push('state_read');
        return roles;
    }
    if (/remote.*engine.*start|engine.*start.*climat|allow.*engine.*start|motorstart|climatis.*engine|climatiz.*engine|1cr/i.test(full)) {
        roles.push(writable ? 'consent_write' : 'consent_read');
    }
    if (/direct.*oper|immediate|sofort|adhoc|ad_hoc|activate.*now|start.*now|climate.*now|climatis.*now|climatiz.*now|instant.*clim|activate.*aux|start.*aux|park.*heat|park.*clim|parkklima|stationary.*clim|standheiz|standklima|standlueft|independent.*vent|independent.*clim|precond|aux.*clim|aux.*vent|aux.*heat|ventilat.*now|cooling.*now|set.*climatis|set.*climatiz|switch.*climat|climate.*on.*off|air.*cond.*on.*off|activate.*clim|request.*clim|start.*clim|stop.*clim/i.test(full)) {
        if (!/timer|schedule|weekly|abfahrt|departure|zeitplan/i.test(memberName)) {
            roles.push(writable ? 'direct_write' : 'direct_read');
        }
    }
    if (/timer|departure|abfahrt|schedule|weekly|zeitplan|startzeit/i.test(full)) {
        roles.push(writable ? 'timer_write' : 'timer_read');
    }
    if (/temp/i.test(memberName) && !writable) roles.push('temp_read');
    if (/status|state|active|on|mode/i.test(memberName) && !writable && !roles.length) roles.push('state_read');
    // Broad fallback role on ClimateMaster / Auxiliary / Standklima / PreConditioning for writable switches that aren't setpoints/zones
    if (writable && !roles.length && /ClimateMaster|Auxiliary|Stand|PreCond|ParkClim|Independent|Remote/i.test(ifaceName)) {
        if (!/temp|setpoint|soll|fan|blower|geblaese|intensity|flap|distribution|defrost|recirc|sync|auto.*program|filter|style/i.test(memberName)) {
            roles.push('master_candidate');
        }
    }
    return roles;
}

function lookupRawType(db, iv, typeName) {
    if (!typeName || typeof typeName !== 'string') return null;
    const pools = [
        iv && iv.datatypes, db && db.datatypes,
        iv && iv.types, iv && iv.enumerations, iv && iv.structs,
        db && db.types, db && db.enumerations, db && db.structs, db && db.typeDefinitions,
    ];
    const shortName = typeName.split('.').pop();
    for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        if (!p || typeof p !== 'object') continue;
        if (p[typeName]) return p[typeName];
        if (p[shortName]) return p[shortName];
    }
    return null;
}

function resolveTypeDef(db, iv, typeName, depth) {
    if (!typeName || (depth || 0) > 6) return null;
    if (typeof typeName === 'object') return summarizeType(db, iv, typeName, (depth || 0) + 1);
    const raw = lookupRawType(db, iv, typeName);
    if (!raw) {
        return { kind: 'primitive', name: String(typeName) };
    }
    return summarizeType(db, iv, raw, (depth || 0) + 1);
}

function summarizeType(db, iv, t, depth) {
    if (!t || typeof t !== 'object') return null;
    // Enum in MGU `db.datatypes` (`{ type: 'enum', items: { OFF: { value: 0 }, ON: { value: 1 } } }`) or Franca `values`/`enumerators`
    if (t.type === 'enum' || t.enumerators || t.values || t.enumValues || (t.items && typeof t.items === 'object' && !Array.isArray(t.items) && t.type !== 'struct' && t.type !== 'union')) {
        const ev = t.items || t.enumerators || t.values || t.enumValues || {};
        const values = [];
        const valueMap = {};
        if (Array.isArray(ev)) {
            ev.forEach((x, idx) => {
                const nm = x && x.name !== undefined ? String(x.name) : String(x);
                const val = (x && typeof x.value === 'number') ? x.value : idx;
                values.push(nm);
                valueMap[nm] = val;
            });
        } else {
            Object.keys(ev).forEach((nm, idx) => {
                const item = ev[nm];
                const val = typeof item === 'number' ? item : (item && typeof item.value === 'number' ? item.value : idx);
                values.push(nm);
                valueMap[nm] = val;
            });
        }
        return { kind: 'enum', values, valueMap };
    }

    // Struct in MGU `db.datatypes` (`{ type: 'struct', fields: { hour: { type: 'UInt8' } } }`) or array
    if (t.type === 'struct' || t.fields || t.members || t.elements) {
        const fl = t.fields || t.members || t.elements || {};
        const fields = Array.isArray(fl)
            ? fl.map((x) => {
                const ftype = x && (x.type || x.datatype);
                return { name: x && x.name, type: typeof ftype === 'string' ? ftype : null, typeDef: resolveTypeDef(db, iv, ftype, depth) };
            })
            : Object.keys(fl).map((k) => {
                const entry = fl[k];
                const ftype = typeof entry === 'string' ? entry : (entry && (entry.type || entry.datatype));
                return { name: k, type: typeof ftype === 'string' ? ftype : null, typeDef: resolveTypeDef(db, iv, ftype, depth) };
            });
        return { kind: 'struct', fields };
    }

    // Union in MGU `db.datatypes`
    if (t.type === 'union' && (t.elements || t.fields || t.items)) {
        const ul = t.elements || t.fields || t.items || {};
        const branches = Array.isArray(ul)
            ? ul.map((x) => ({ name: x && x.name, type: x && x.type, typeDef: resolveTypeDef(db, iv, x && x.type, depth) }))
            : Object.keys(ul).map((k) => ({ name: k, type: ul[k] && ul[k].type, typeDef: resolveTypeDef(db, iv, ul[k] && ul[k].type, depth) }));
        return { kind: 'union', branches };
    }

    // Typedef alias (`{ type: 'SomeOtherType' }`)
    if (typeof t.type === 'string' && !/^(UInt\d+|Int\d+|Boolean|Float|Double|String|ByteBuffer|primitive|array|map)$/i.test(t.type)) {
        const target = resolveTypeDef(db, iv, t.type, depth);
        if (target) return target;
    }

    return { kind: String(t.kind || t.type || 'primitive') };
}

function parseMethodInArgs(db, iv, mm) {
    const rawIn = mm.inArgs || mm.in || mm.parameters || mm.args || mm.input;
    if (!rawIn) return [];
    if (Array.isArray(rawIn)) {
        return rawIn.map((a) => {
            const tp = a && (a.type || a.datatype);
            return { name: a && a.name, type: typeof tp === 'string' ? tp : null, typeDef: resolveTypeDef(db, iv, tp, 0) };
        });
    }
    if (typeof rawIn === 'object') {
        return Object.keys(rawIn).map((k) => {
            const entry = rawIn[k];
            const tp = typeof entry === 'string' ? entry : (entry && (entry.type || entry.datatype));
            return { name: k, type: typeof tp === 'string' ? tp : null, typeDef: resolveTypeDef(db, iv, tp, 0) };
        });
    }
    return [];
}

/**
 * Inspects a Franca / OAP master catalog (`db`) and returns structured descriptors for all
 * Climate / 1CR / Pre-conditioning / DepartureTimer interfaces, fields, and methods.
 */
function discoverClimateCatalog(db) {
    const interfaces = (db && db.interfaces) || {};
    const types = Object.assign({}, (db && db.datatypes) || {}, (db && db.types) || {}, (db && db.enumerations) || {}, (db && db.structs) || {});
    const found = [];

    Object.keys(interfaces).sort().forEach((ifaceName) => {
        const iv = interfaces[ifaceName] || {};
        const fields = iv.fields || {};
        const methods = iv.methods || {};
        const fkeys = Object.keys(fields);
        const mkeys = Object.keys(methods);

        const ifaceMatches = CLIMATE_IFACE_RE.test(ifaceName);
        const memberMatches = !ifaceMatches && (
            fkeys.some((k) => CLIMATE_MEMBER_HINT_RE.test(k)) ||
            mkeys.some((k) => CLIMATE_MEMBER_HINT_RE.test(k))
        );
        if (!ifaceMatches && !memberMatches) return;

        const broadcasts = iv.broadcasts || iv.events || {};
        const item = {
            iface: ifaceName,
            serviceId: iv.serviceId || null,
            fields: [],
            methods: [],
            broadcasts: Object.keys(broadcasts),
        };
        fkeys.sort().forEach((fname) => {
            const fm = fields[fname] || {};
            const roles = classifyClimateMember(ifaceName, fname, 'field', fm);
            if (!ifaceMatches && !roles.length && !CLIMATE_MEMBER_HINT_RE.test(fname)) return;
            const ftype = fm.type || fm.datatype || null;
            item.fields.push({
                name: fname,
                getter: fm.getter !== false,
                setter: !!fm.setter,
                notifier: fm.notifier !== false,
                type: typeof ftype === 'string' ? ftype : null,
                typeDef: resolveTypeDef(db, iv, ftype, 0),
                roles,
            });
        });
        mkeys.sort().forEach((mname) => {
            const mm = methods[mname] || {};
            const roles = classifyClimateMember(ifaceName, mname, 'method', mm);
            if (!ifaceMatches && !roles.length && !CLIMATE_MEMBER_HINT_RE.test(mname)) return;
            item.methods.push({
                name: mname,
                inArgs: parseMethodInArgs(db, iv, mm),
                roles,
            });
        });
        if (item.fields.length || item.methods.length) found.push(item);
    });
    return { interfaces: found, hasTypes: Object.keys(types).length > 0 };
}

/**
 * Pick an enum/boolean/numeric value for turning a feature ON or OFF based on its Franca type definition
 * or its last observed live value on the bus (`sample`). When `numericEnum` is true, returns wire integer.
 */
function pickEnumOrBool(typeDef, wantOn, sample, numericEnum) {
    if (typeDef && typeDef.kind === 'enum' && Array.isArray(typeDef.values) && typeDef.values.length) {
        const vals = typeDef.values.map(String);
        const posRe = wantOn
            ? /^(ON|ACTIVE|ACTIVATE|ACTIVATED|START|STARTED|ENABLE|ENABLED|TRUE|IMMEDIATE|DIRECT_ON|CLIMATE_ON|RUN|RUNNING|1)$/i
            : /^(OFF|INACTIVE|DEACTIVATE|DEACTIVATED|STOP|STOPPED|DISABLE|DISABLED|FALSE|DIRECT_OFF|CLIMATE_OFF|STANDBY|0)$/i;
        const looseRe = wantOn
            ? /(^|_)(ON|ACTIVE|ACTIVATE|START|ENABLE|RUN|IMMEDIATE|CLIMAT|COOL|VENT|HEAT)(_|$)/i
            : /(^|_)(OFF|INACTIVE|DEACTIVATE|STOP|DISABLE|CANCEL|IDLE|STANDBY)(_|$)/i;
        const noInvalid = vals.filter((v) => !/INVALID|UNKNOWN|ERROR|SIGNAL_UNAVAILABLE|NO_ACTION|NO_CHANGE|INIT|NOT_AVAILABLE/i.test(v));
        let chosen = noInvalid.find((v) => posRe.test(v));
        if (chosen === undefined) chosen = noInvalid.find((v) => looseRe.test(v));
        if (chosen === undefined && noInvalid.length >= 2) {
            chosen = wantOn ? noInvalid[1] : noInvalid[0];
        }
        if (chosen !== undefined) {
            if (numericEnum && typeDef.valueMap && typeDef.valueMap[chosen] !== undefined) {
                return typeDef.valueMap[chosen];
            }
            return chosen;
        }
    }
    if (typeof sample === 'boolean') return !!wantOn;
    if (typeof sample === 'number') return wantOn ? 1 : 0;
    if (typeof sample === 'string') {
        if (/^(true|false)$/i.test(sample)) return !!wantOn;
        if (numericEnum) return wantOn ? 1 : 0;
        if (/OFF|INACTIVE|STOP|DISABLE/i.test(sample) && wantOn) {
            return sample.replace(/INACTIVE/ig, 'ACTIVE').replace(/DISABLE[D]?/ig, 'ENABLED').replace(/STOP/ig, 'START').replace(/OFF/ig, 'ON');
        }
        if (/ON|ACTIVE|START|ENABLE/i.test(sample) && !wantOn) {
            return sample.replace(/ACTIVE/ig, 'INACTIVE').replace(/ENABLE[D]?/ig, 'DISABLED').replace(/START/ig, 'STOP').replace(/ON/ig, 'OFF');
        }
    }
    if (typeDef && typeDef.kind && /bool/i.test(typeDef.kind + ' ' + (typeDef.name || ''))) return !!wantOn;
    return wantOn ? 1 : 0;
}

/**
 * Build a payload for a direct Start/Stop setter or method, guided by `typeDef` and any live `sample` struct.
 */
function buildDirectPayload(meta, wantOn, sample, numericEnum) {
    const td = meta && meta.typeDef;
    if (td && td.kind === 'struct' && Array.isArray(td.fields) && td.fields.length) {
        const out = {};
        td.fields.forEach((f) => {
            if (!f || !f.name) return;
            const cur = (sample && typeof sample === 'object') ? sample[f.name] : undefined;
            if (/zone|id|index|slot|seat/i.test(f.name)) {
                out[f.name] = cur !== undefined ? cur : (f.typeDef && f.typeDef.kind === 'enum' && f.typeDef.values[0] ? (numericEnum ? 0 : f.typeDef.values[0]) : 0);
            } else {
                out[f.name] = buildDirectPayload(f, wantOn, cur, numericEnum);
            }
        });
        return out;
    }
    if (td && td.kind === 'union' && Array.isArray(td.branches) && td.branches.length) {
        const br = td.branches[0];
        const inner = buildDirectPayload(br, wantOn, undefined, numericEnum);
        const uObj = {};
        if (br && br.name) uObj[br.name] = inner;
        return uObj;
    }
    if (td && /array/i.test(td.kind)) {
        return [wantOn ? 1 : 0];
    }
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        const out = {};
        Object.keys(sample).forEach((k) => {
            if (/zone|slot|id|index/i.test(k)) out[k] = sample[k];
            else out[k] = pickEnumOrBool(null, wantOn, sample[k], numericEnum);
        });
        return out;
    }
    return pickEnumOrBool(td, wantOn, sample, numericEnum);
}

/**
 * Build a payload for a Departure Timer (`BDC_BODY3 / IHKA` wake schedule) setter or method.
 */
function buildTimerPayload(meta, hour, minute, enabled, sample, numericEnum) {
    const h = Math.max(0, Math.min(23, Number(hour) | 0));
    const m = Math.max(0, Math.min(59, Number(minute) | 0));
    const setField = (obj, k, fmeta, cur) => {
        const ftd = fmeta && fmeta.typeDef;
        if (/hour|stunde|std/i.test(k)) obj[k] = h;
        else if (/min/i.test(k)) obj[k] = m;
        else if (/sec|sek/i.test(k)) obj[k] = 0;
        else if (/slot|index|id|timer.?nr|number/i.test(k)) obj[k] = typeof cur === 'number' ? cur : 1;
        else if (/active|enable|on|state|status|mode|operation/i.test(k)) obj[k] = pickEnumOrBool(ftd, enabled, cur, numericEnum);
        else if (ftd && ftd.kind === 'struct') obj[k] = buildTimerPayload(fmeta, h, m, enabled, cur, numericEnum);
        else if (cur !== undefined) obj[k] = cur;
        else if (ftd && ftd.kind === 'enum' && ftd.values.length) obj[k] = numericEnum ? 0 : ftd.values[0];
        else if (ftd && /bool/i.test(ftd.kind + ' ' + (ftd.name || ''))) obj[k] = !!enabled;
        else obj[k] = 0;
    };
    const td = meta && meta.typeDef;
    if (td && td.kind === 'struct' && Array.isArray(td.fields) && td.fields.length) {
        const out = {};
        td.fields.forEach((f) => {
            if (!f || !f.name) return;
            const cur = (sample && typeof sample === 'object') ? sample[f.name] : undefined;
            setField(out, f.name, f, cur);
        });
        return out;
    }
    if (td && td.kind === 'union' && Array.isArray(td.branches) && td.branches.length) {
        const br = td.branches[0];
        const inner = buildTimerPayload(br, h, m, enabled, undefined, numericEnum);
        const uObj = {};
        if (br && br.name) uObj[br.name] = inner;
        return uObj;
    }
    if (td && /array/i.test(td.kind)) {
        return [{ operationHour: h, operationMinute: m, hour: h, minute: m, active: !!enabled }];
    }
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        const out = {};
        Object.keys(sample).forEach((k) => setField(out, k, null, sample[k]));
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
            rangeEstimated: false,
            odometerKm: null,
            battery12v: null,
            vin: '',
            trueChassis: '',
            kombiSpoofed: false,
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

    /** Update fields and return emitted high-level events: [{ type: 'parked', trip }] */
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
    } catch (e) {}
}

function toBytes(b) {
    if (!b) return [];
    if (Buffer.isBuffer(b) || b instanceof Uint8Array) return Array.prototype.slice.call(b);
    if (Array.isArray(b)) return b.slice();
    if (b.data) return toBytes(b.data);
    return [];
}

async function runWorker() {
    const emit = (msg) => {
        try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) {}
    };

    const tracker = new TelemetryTracker();
    const climateLive = {};        // "iface.field" -> latest value
    const climateProxies = {};     // iface -> { list: [{ inst, proxy, available }], desc, cfgSummary }
    let climateCatalog = { interfaces: [] };
    let tasuProxy = null;
    const tasuListeners = [];
    const camHolders = { icam: null, cam: null, xv: null, cookie: null, timer: null };

    let db = null, gen = null, someip = null;
    try { db = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8')); } catch (e) {
        emit({ ev: 'log', level: 'warn', text: 'catalog unavailable: ' + e.message });
    }
    if (db) {
        try { gen = loadIFConfigGenerator(); } catch (e) { emit({ ev: 'log', level: 'warn', text: 'IFConfigGenerator: ' + e.message }); }
        try { someip = require(SOMEIP_PATH); } catch (e) { emit({ ev: 'log', level: 'warn', text: 'someip.node: ' + e.message }); }
    }

    let chain = Promise.resolve();
    function nativeTick(fn) {
        const step = () => new Promise((res, rej) => setImmediate(() => {
            try { Promise.resolve(fn()).then(res, rej); } catch (e) { rej(e); }
        }));
        const p = chain.then(step, step);
        chain = p.catch(() => {});
        return p;
    }

    async function openWildcardProxies(ifaceName, maxInst) {
        if (!db || !gen || !someip || !db.interfaces || !db.interfaces[ifaceName]) return { list: [], cfg: null };
        const proxies = {};
        proxies[ifaceName] = '*';
        const generated = gen.generate(db, { proxies, services: {} });
        const cfg = generated && generated[ifaceName];
        if (!cfg) return { list: [], cfg: null };
        const insts = Object.keys(cfg.instances || { '1': 1 }).slice(0, maxInst || 4);
        const list = [];
        for (let i = 0; i < insts.length; i++) {
            const inst = insts[i];
            try {
                const px = await nativeTick(() => within(someip.buildProxy(cfg, String(inst)).then((p) => p.init().then(() => p)), 5000, ifaceName + '@' + inst));
                const entry = { inst, proxy: px, available: !!(px.isAvailable && px.isAvailable()) };
                try { px.subscribeToAvailability((a) => { entry.available = !!a; }); } catch (e) {}
                list.push(entry);
            } catch (e) {
                emit({ ev: 'log', level: 'warn', text: 'wildcard proxy ' + ifaceName + '@' + inst + ': ' + e.message });
            }
        }
        return { list, cfg };
    }

    async function openDynamicProxies(ifaceName, attrMap, methods, broadcasts, maxInst) {
        if (!db || !gen || !someip || !db.interfaces || !db.interfaces[ifaceName]) return { list: [], cfg: null };
        const spec = { instances: '*' };
        if (attrMap && Object.keys(attrMap).length) spec.attributes = attrMap;
        if (methods && methods.length) spec.methods = methods;
        if (broadcasts && broadcasts.length) spec.broadcasts = broadcasts;
        const proxies = {};
        proxies[ifaceName] = spec;
        const generated = gen.generate(db, { proxies, services: {} });
        const cfg = generated && generated[ifaceName];
        if (!cfg) return { list: [], cfg: null };
        const insts = Object.keys(cfg.instances || { '1': 1 }).slice(0, maxInst || 3);
        const list = [];
        for (let i = 0; i < insts.length; i++) {
            const inst = insts[i];
            try {
                const px = await nativeTick(() => within(someip.buildProxy(cfg, String(inst)).then((p) => p.init().then(() => p)), 5000, ifaceName + '@' + inst));
                const entry = { inst, proxy: px, available: !!(px.isAvailable && px.isAvailable()) };
                try { px.subscribeToAvailability((a) => { entry.available = !!a; }); } catch (e) {}
                list.push(entry);
            } catch (e) {
                emit({ ev: 'log', level: 'warn', text: 'proxy ' + ifaceName + '@' + inst + ': ' + e.message });
            }
        }
        return { list, cfg };
    }

    function pushPatch(patch) {
        const evs = tracker.update(patch, Date.now());
        emit({ ev: 'telemetry', state: tracker.state, activeTrip: tracker.activeTrip, lastTrip: tracker.lastTrip });
        evs.forEach((e) => emit({ ev: e.type, trip: e.trip, state: tracker.state }));
    }

    if (db && gen && someip) {
        const allIfaces = Object.keys(db.interfaces || {});

        // 1. Positioning (Underground Nav dead-reckoning + GNSS)
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
                    const opened = await openDynamicProxies(name, attrs, [], [], 2);
                    opened.list.forEach((item) => {
                        const px = item.proxy;
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
                    });
                } catch (e) {}
            } else if (/GnssPositioning$/i.test(name) && bnames.indexOf('positioning') >= 0) {
                try {
                    const opened = await openDynamicProxies(name, {}, [], ['positioning'], 1);
                    opened.list.forEach((item) => {
                        item.proxy.subscribe({ name: 'positioning', onReceive: (v) => {
                            if (tracker.state.pos && (Date.now() - tracker.state.pos.at < 60000)) return;
                            const c = extractCoords(v, 0);
                            if (c) pushPatch({ pos: { lat: c.lat, lon: c.lon, street: '', district: '', city: '', source: 'gnss', at: Date.now() } });
                        } });
                    });
                } catch (e) {}
            }
        }

        // 2 & 3. Unified single-proxy-per-interface Core + Body / Fuel / Range / Odometer / Door / Lock watchers
        const coreMap = {
            'de.bmw.infotainment.vehicle.CDS': {
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
            'de.bmw.infotainment.vehicle.Vehicle2': {
                fields: ['statusCarSpeed2'],
                onField: (f, v) => {
                    if (v && v.speedVehicleCentreOfGravity !== undefined && v.speedVehicleCentreOfGravity !== 65535) {
                        pushPatch({ speed: +(v.speedVehicleCentreOfGravity * 0.015625).toFixed(1) });
                    }
                },
            },
            'de.bmw.infrastructure.VehicleCondition': {
                fields: ['VehicleCondition'],
                onField: (f, v) => {
                    const c = parseCondition(v && v.statusConditionVehicle);
                    if (c !== null) pushPatch({ condition: c });
                },
            },
            'de.bmw.infrastructure.VehicleInformation': {
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
        };

        const BODY_FIELD_RE = /(^|status|_)(tank|fuel|kraftstoff|fuellstand|range|drivingRange|displayRange|combustionRange|cruisingRange|remainingRange|residualRange|tankRange|totalRange|electricRange|reichweite|kilometerstand|odometer|totalDistance|outsideTemp|exteriorTemp|ambientTemp|door|window|centralLock|lockState|tailgate|trunk|bonnet|hood)/i;
        const targetIfaces = {};
        Object.keys(coreMap).forEach((k) => { targetIfaces[k] = true; });
        allIfaces.forEach((k) => { if (BODY_IFACE_RE.test(k)) targetIfaces[k] = true; });

        const targetList = Object.keys(targetIfaces);
        for (let i = 0; i < targetList.length; i++) {
            const name = targetList[i];
            const iv = db.interfaces && db.interfaces[name];
            if (!iv || !iv.fields) continue;
            const cs = coreMap[name] || null;
            const fnames = Object.keys(iv.fields);
            const bodyWant = BODY_IFACE_RE.test(name) ? fnames.filter((f) => BODY_FIELD_RE.test(f) && !/dynamicRange|speedRange|scaleRange|freqRange|audio/i.test(f)).slice(0, 32) : [];
            const coreWant = cs ? cs.fields.filter((f) => !!iv.fields[f]) : [];
            const merged = {};
            coreWant.concat(bodyWant).forEach((fname) => {
                const fm = iv.fields[fname] || {};
                merged[fname] = (fm.getter !== false ? 'r' : '') + (fm.notifier !== false ? 's' : '') || 'r';
            });
            const mergedKeys = Object.keys(merged);
            if (!mergedKeys.length) continue;
            try {
                let opened = await openDynamicProxies(name, merged, [], [], 1);
                if (!opened.list.length) opened = await openWildcardProxies(name, 1);
                if (!opened.list.length) continue;
                const px = opened.list[0].proxy;
                mergedKeys.forEach((fname) => {
                    const fm = iv.fields[fname] || {};
                    const isCore = cs && cs.fields.indexOf(fname) >= 0;
                    const isBody = bodyWant.indexOf(fname) >= 0;
                    const handler = (val) => {
                        if (isCore) cs.onField(fname, val);
                        if (isBody) interpretBodyField(name, fname, val, pushPatch, tracker.state);
                    };
                    if (fm.notifier !== false) { try { px.subscribe({ name: fname, onReceive: handler }); } catch (e) {} }
                    if (fm.getter !== false) { try { px.getValue(fname, 2500).then(handler).catch(() => {}); } catch (e) {} }
                });
            } catch (e) {}
        }

        // 4. Discover & open ALL Climate / 1CR / Standklima / Pre-conditioning interfaces using BMW wildcard '*' first!
        climateCatalog = discoverClimateCatalog(db);
        tracker.state.climate1cr.discoveredCount = climateCatalog.interfaces.length;
        for (let i = 0; i < climateCatalog.interfaces.length; i++) {
            const desc = climateCatalog.interfaces[i];
            let opened = { list: [], cfg: null };
            try {
                opened = await openWildcardProxies(desc.iface, 4);
            } catch (e) {}
            if (!opened.list.length) {
                const attrs = {};
                desc.fields.forEach((f) => {
                    attrs[f.name] = (f.getter ? 'r' : '') + (f.setter ? 'w' : '') + (f.notifier ? 's' : '') || 'r';
                });
                const methods = desc.methods.map((m) => m.name);
                try { opened = await openDynamicProxies(desc.iface, attrs, methods, desc.broadcasts, 4); } catch (e2) {}
            }
            if (!opened.list.length) continue;
            const cfgSummary = opened.cfg ? {
                instances: Object.keys(opened.cfg.instances || {}),
                fields: Object.keys(opened.cfg.fields || {}),
                methods: Object.keys(opened.cfg.methods || {}),
            } : null;
            climateProxies[desc.iface] = { list: opened.list, desc, cfgSummary };
            opened.list.forEach((instEntry) => {
                const px = instEntry.proxy;
                desc.fields.forEach((f) => {
                    const key = desc.iface + '.' + f.name;
                    const onVal = (val) => {
                        climateLive[key] = val;
                        interpretClimateField(desc.iface, f, val, pushPatch, tracker.state);
                    };
                    if (f.notifier) { try { px.subscribe({ name: f.name, onReceive: onVal }); } catch (e) {} }
                    if (f.getter) { try { px.getValue(f.name, 2500).then(onVal).catch(() => {}); } catch (e) {} }
                });
            });
        }

        // 5. UDS InternalTasu proxy for on-demand accurate 12V Battery, Fuel %, Odometer, Temps (never polled continuously!)
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
                    tasuProxy.subscribe({
                        name: 'sendTasuResponse',
                        onReceive: (msg) => {
                            if (msg && msg.errorCode !== undefined && msg.errorCode !== 'NO_ERROR' && msg.errorCode !== 0) return;
                            const b = toBytes(msg && (msg.udsResponse !== undefined ? msg.udsResponse : msg));
                            if (b.length < 10 || b[2] === 0x7F) return;
                            const frame = { ecu: b[6], uds: b.slice(9) };
                            tasuListeners.slice().forEach((fn) => { try { fn(frame); } catch (e) {} });
                        },
                    });
                }
            } catch (e) { emit({ ev: 'log', level: 'warn', text: 'TASU init: ' + e.message }); }
        }
    }

    /** Send a single physical UDS/OBD read over InternalTasu with proper echo matching & busy retry. */
    async function udsQuery(ecu, sid, reqBytes, timeoutMs) {
        if (!tasuProxy) return null;
        return new Promise((resolve) => {
            let done = false, timer = null;
            const onFrame = (f) => {
                if (f.ecu !== ecu) return;
                const u = f.uds;
                if (u[0] === 0x7F && u[1] === sid && u[2] === 0x78) {
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(null), 5000);
                    return;
                }
                const matchPos = u[0] === sid + 0x40 && reqBytes.every((b, idx) => u[idx + 1] === b);
                const matchNeg = u[0] === 0x7F && u[1] === sid;
                if (!matchPos && !matchNeg) return;
                finish(matchPos ? u : null);
            };
            const finish = (v) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                const idx = tasuListeners.indexOf(onFrame);
                if (idx >= 0) tasuListeners.splice(idx, 1);
                resolve(v);
            };
            tasuListeners.push(onFrame);
            timer = setTimeout(() => finish(null), timeoutMs || 2200);

            const sendAttempt = (n) => {
                nativeTick(() => tasuProxy.callMethod('sendTasuRequest', {
                    sourceAddress: 0xF2, targetAddress: ecu, serviceID: sid, subroutineID: 0,
                    udsDataLength: reqBytes.length, udsData: Buffer.from(reqBytes), deadlockTime: 0,
                }, 2200)).then((r) => {
                    const verdict = r && typeof r === 'object' ? String(r.TasuErrorEnum || '') : '';
                    if (/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) && n < 2 && !done) {
                        setTimeout(() => { if (!done) sendAttempt(n + 1); }, 220 * (n + 1));
                    }
                }).catch(() => finish(null));
            };
            sendAttempt(0);
        });
    }

    let vinChecked = false;

    /** Read accurate 12V Voltage, Fuel %, Odometer km, VIN/Chassis, Ambient °C, Coolant °C via ISO UDS 0x22 / OBD 0x01 on demand. */
    async function readVitalsUDS() {
        if (!tasuProxy) return;
        const patch = {};

        // 0. Once per session: Read true un-spoofed 17-char VIN (0x22 F190) & VCM FA (0x22 3002) from BDC (0x40) / DME (0x12)
        if (!vinChecked) {
            vinChecked = true;
            let vu = (await udsQuery(0x40, 0x22, [0xF1, 0x90], 1600)) || (await udsQuery(0x12, 0x22, [0xF1, 0x90], 1600));
            let vinStr = '';
            if (vu && vu.length >= 20) {
                vinStr = Buffer.from(vu.slice(3, 20)).toString('ascii').replace(/[^A-Z0-9]/gi, '').toUpperCase();
                if (vinStr.length === 17) patch.vin = vinStr;
            }
            let faStr = '';
            const fu = await udsQuery(0x40, 0x22, [0x30, 0x02], 1500);
            if (fu && fu.length >= 10) {
                faStr = Buffer.from(fu.slice(3)).toString('latin1');
            }
            const info = decodeChassisFromVinOrFa(vinStr, faStr);
            if (info.trueChassis) patch.trueChassis = info.trueChassis;
            if (info.notMCar) patch.kombiSpoofed = true;
        }

        // 1. 12V Control Module Voltage (0x22 F442 on DME 0x12 / BDC 0x40, fallback OBD 0x01 42)
        let u = (await udsQuery(0x12, 0x22, [0xF4, 0x42], 1800)) || (await udsQuery(0x40, 0x22, [0xF4, 0x42], 1800));
        if (u && u.length >= 5) {
            const v = +(((u[3] << 8) | u[4]) * 0.001).toFixed(2);
            if (v >= 8.5 && v <= 16.5) patch.battery12v = v;
        } else {
            u = await udsQuery(0x12, 0x01, [0x42], 1500);
            if (u && u.length >= 4) {
                const v = +(((u[2] << 8) | u[3]) * 0.001).toFixed(2);
                if (v >= 8.5 && v <= 16.5) patch.battery12v = v;
            }
        }

        // 2. Fuel Tank Level % (0x22 F42F or OBD 0x01 2F on DME 0x12)
        u = await udsQuery(0x12, 0x22, [0xF4, 0x2F], 1600);
        let rawFuel = (u && u.length >= 4) ? u[3] : null;
        if (rawFuel === null) {
            u = await udsQuery(0x12, 0x01, [0x2F], 1500);
            if (u && u.length >= 3) rawFuel = u[2];
        }
        if (rawFuel !== null && rawFuel >= 0 && rawFuel <= 255) {
            const pct = Math.round((rawFuel * 100) / 255);
            if (pct >= 0 && pct <= 100) {
                patch.fuelPct = pct;
                // Provide realistic chassis-calibrated range estimate whenever live KOMBI range hasn't arrived yet
                if (tracker.state.rangeKm === null || tracker.state.rangeEstimated) {
                    const ch = patch.trueChassis || tracker.state.trueChassis || '';
                    patch.rangeKm = estimateRangeFromFuel(pct, ch);
                    patch.rangeEstimated = true;
                }
            }
        }

        // 3. Odometer km (0x22 F4A6 or OBD 0x01 A6 on DME 0x12: 4-byte unsigned * 0.1 km)
        u = await udsQuery(0x12, 0x22, [0xF4, 0xA6], 1600);
        let odoAt = (u && u.length >= 7) ? 3 : -1;
        if (odoAt < 0) {
            u = await udsQuery(0x12, 0x01, [0xA6], 1500);
            if (u && u.length >= 6) odoAt = 2;
        }
        if (odoAt >= 0) {
            const rawOdo = u[odoAt] * 16777216 + (u[odoAt + 1] << 16) + (u[odoAt + 2] << 8) + u[odoAt + 3];
            const km = Math.round(rawOdo * 0.1);
            if (km > 0 && km < 1500000) patch.odometerKm = km;
        }

        // 4. Ambient Air Temp (0x22 F446 / 0x01 46) & Coolant Temp (0x22 F405 / 0x01 05) if missing
        if (tracker.state.ambientC === null) {
            u = (await udsQuery(0x12, 0x22, [0xF4, 0x46], 1400)) || (await udsQuery(0x12, 0x01, [0x46], 1400));
            const idx = u && (u[0] === 0x62 ? 3 : 2);
            if (u && u.length > idx && u[idx] !== 255) {
                const amb = u[idx] - 40;
                if (amb >= -40 && amb <= 60) patch.ambientC = amb;
            }
        }
        if (tracker.state.coolantC === null) {
            u = (await udsQuery(0x12, 0x22, [0xF4, 0x05], 1400)) || (await udsQuery(0x12, 0x01, [0x05], 1400));
            const idx = u && (u[0] === 0x62 ? 3 : 2);
            if (u && u.length > idx && u[idx] !== 255) {
                const cl = u[idx] - 40;
                if (cl >= -40 && cl <= 150) patch.coolantC = cl;
            }
        }

        if (Object.keys(patch).length) pushPatch(patch);
    }

    /** Execute 1CR Start / Stop / Schedule or Raw Inspector test across all live instances & both enum encodings */
    async function execute1CR(action, params) {
        params = params || {};
        const trace = [];
        const savedProfile = readJsonSafe(PROFILE_PATH);

        const callOne = async (iface, kind, name, payload) => {
            const holder = climateProxies[iface];
            if (!holder || !holder.list || !holder.list.length) throw new Error('Proxy not open: ' + iface);
            // Sort available instances first
            const sorted = holder.list.slice().sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0));
            let lastErr = null;
            for (let i = 0; i < sorted.length; i++) {
                const inst = sorted[i];
                try {
                    if (kind === 'setter') {
                        await nativeTick(() => within(inst.proxy.setValue(name, payload, 3500), 4000, iface + '.' + name));
                        return { ok: true, iface, inst: inst.inst, kind, name, payload };
                    }
                    const res = await nativeTick(() => within(inst.proxy.callMethod(name, payload || {}, 3500), 4000, iface + '.' + name));
                    return { ok: true, iface, inst: inst.inst, kind, name, payload, response: res };
                } catch (e) {
                    lastErr = e;
                }
            }
            throw lastErr || new Error('No instance answered for ' + iface + '.' + name);
        };

        const callSmart = async (iface, kind, meta, buildFn) => {
            const pStr = buildFn(false);
            try {
                return await callOne(iface, kind, meta.name, pStr);
            } catch (e1) {
                const pNum = buildFn(true);
                if (JSON.stringify(pNum) !== JSON.stringify(pStr)) {
                    return await callOne(iface, kind, meta.name, pNum);
                }
                throw e1;
            }
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

            if (savedProfile && savedProfile[roleKey]) {
                const p = savedProfile[roleKey];
                try {
                    const r = await callOne(p.iface, p.kind, p.name, p.payload);
                    trace.push(r);
                    tracker.state.climate1cr.active = wantOn;
                    tracker.state.climate1cr.lastAction = wantOn ? 'Kích nổ 1CR (Ghim)' : 'Tắt 1CR (Ghim)';
                    tracker.state.climate1cr.lastResult = 'Đã gửi tới ' + p.iface.split('.').pop() + '.' + p.name;
                    pushPatch({});
                    return { ok: true, method: p.iface.split('.').pop() + '.' + p.name, trace };
                } catch (e) {
                    trace.push({ ok: false, step: 'pinned', error: e.message });
                }
            }

            // Enable 1CR Remote Engine Start consent flag first when starting
            if (wantOn) {
                for (let i = 0; i < climateCatalog.interfaces.length; i++) {
                    const d = climateCatalog.interfaces[i];
                    if (!climateProxies[d.iface]) continue;
                    for (let k = 0; k < d.fields.length; k++) {
                        const f = d.fields[k];
                        if (f.setter && f.roles.indexOf('consent_write') >= 0) {
                            const sample = climateLive[d.iface + '.' + f.name];
                            try { trace.push(await callSmart(d.iface, 'setter', f, (num) => buildDirectPayload(f, true, sample, num))); } catch (e) {
                                trace.push({ ok: false, iface: d.iface, name: f.name, error: e.message });
                            }
                        }
                    }
                }
            }

            // Try all discovered direct-operation setters & methods first, then master_candidate switches on ClimateMaster
            let succeeded = null;
            const attemptedCalls = [];
            const rolePasses = ['direct_write', 'master_candidate'];
            for (let rp = 0; rp < rolePasses.length && !succeeded; rp++) {
                const targetRole = rolePasses[rp];
                for (let i = 0; i < climateCatalog.interfaces.length; i++) {
                    const d = climateCatalog.interfaces[i];
                    const pStrSetter = (f) => buildDirectPayload(f, wantOn, climateLive[d.iface + '.' + f.name], false);
                    const pNumSetter = (f) => buildDirectPayload(f, wantOn, climateLive[d.iface + '.' + f.name], true);
                    for (let k = 0; k < d.fields.length; k++) {
                        const f = d.fields[k];
                        if (!f.setter || f.roles.indexOf(targetRole) < 0) continue;
                        attemptedCalls.push({ iface: d.iface, kind: 'setter', name: f.name, payload: pStrSetter(f), altPayload: pNumSetter(f) });
                        if (!climateProxies[d.iface]) continue;
                        try {
                            const r = await callSmart(d.iface, 'setter', f, (num) => buildDirectPayload(f, wantOn, climateLive[d.iface + '.' + f.name], num));
                            trace.push(r);
                            if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + f.name;
                        } catch (e) {
                            trace.push({ ok: false, iface: d.iface, name: f.name, error: e.message });
                        }
                    }
                    for (let k = 0; k < d.methods.length; k++) {
                        const m = d.methods[k];
                        if (m.roles.indexOf(targetRole) < 0) continue;
                        const makeArgs = (num) => {
                            const argObj = {};
                            m.inArgs.forEach((a) => {
                                if (a && a.name) argObj[a.name] = buildDirectPayload(a, wantOn, undefined, num);
                            });
                            return argObj;
                        };
                        attemptedCalls.push({ iface: d.iface, kind: 'method', name: m.name, payload: makeArgs(false), altPayload: makeArgs(true) });
                        if (!climateProxies[d.iface]) continue;
                        try {
                            const r = await callSmart(d.iface, 'method', m, makeArgs);
                            trace.push(r);
                            if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + m.name + '()';
                        } catch (e) {
                            trace.push({ ok: false, iface: d.iface, name: m.name, error: e.message });
                        }
                    }
                }
            }

            tracker.state.climate1cr.lastAction = wantOn ? 'Kích nổ / Làm mát 1CR' : 'Tắt làm mát 1CR';
            if (succeeded) {
                tracker.state.climate1cr.active = wantOn;
                const lockHint = (wantOn && (tracker.state.locked === false || (tracker.state.condition && tracker.state.condition >= 5)))
                    ? ' (Lưu ý: đang ngồi trong xe / chưa khoá ngoài nên quạt làm mát chạy; muốn đề nổ động cơ 1CR hãy ra ngoài bấm Khoá xe)'
                    : '';
                tracker.state.climate1cr.lastResult = 'Đã kích qua ' + succeeded + lockHint;
                pushPatch({});
                return { ok: true, method: succeeded + lockHint, trace };
            }
            const openNames = Object.keys(climateProxies).map((x) => x.split('.').pop());
            const discoveredMembers = {};
            Object.keys(climateProxies).forEach((ifn) => {
                const d = climateProxies[ifn].desc;
                discoveredMembers[ifn] = {
                    setters: (d.fields || []).filter((f) => f.setter).map((f) => f.name),
                    methods: (d.methods || []).map((m) => m.name),
                    getters: (d.fields || []).filter((f) => !f.setter).map((f) => f.name),
                };
            });
            tracker.state.climate1cr.lastResult = !climateCatalog.interfaces.length
                ? 'Không tìm thấy giao diện Climate trong catalog xe'
                : ('Đã mở ' + openNames.length + '/' + climateCatalog.interfaces.length + ' cổng (' + openNames.slice(0, 5).join(', ') + ') — mở tab Dò 1CR để bấm thử 1 chạm');
            pushPatch({});
            return { ok: false, error: tracker.state.climate1cr.lastResult, trace, openInterfaces: openNames, discoveredMembers, candidates: attemptedCalls };
        }

        if (action === 'schedule1cr') {
            const h = Number(params.hour) | 0, m = Number(params.minute) | 0, en = params.enabled !== false;
            const hhmm = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
            if (savedProfile && savedProfile.timer) {
                const p = savedProfile.timer;
                const payload = buildTimerPayload({ typeDef: null }, h, m, en, p.payload, false);
                try {
                    const r = await callOne(p.iface, p.kind, p.name, payload);
                    tracker.state.climate1cr.timerText = en ? hhmm : 'Tắt';
                    tracker.state.climate1cr.lastAction = 'Hẹn giờ BDC/IHKA ' + hhmm;
                    tracker.state.climate1cr.lastResult = 'Đã nạp vào hộp ' + p.iface.split('.').pop();
                    pushPatch({});
                    return { ok: true, method: p.iface.split('.').pop() + '.' + p.name, trace: [r] };
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
                    try {
                        const r = await callSmart(d.iface, 'setter', f, (num) => buildTimerPayload(f, h, m, en, sample, num));
                        trace.push(r);
                        if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + f.name;
                    } catch (e) { trace.push({ ok: false, iface: d.iface, name: f.name, error: e.message }); }
                }
                for (let k = 0; k < d.methods.length; k++) {
                    const mt = d.methods[k];
                    if (mt.roles.indexOf('timer_write') < 0) continue;
                    try {
                        const r = await callSmart(d.iface, 'method', mt, (num) => {
                            const argObj = {};
                            mt.inArgs.forEach((a) => {
                                if (a && a.name) argObj[a.name] = buildTimerPayload(a, h, m, en, undefined, num);
                            });
                            return argObj;
                        });
                        trace.push(r);
                        if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + mt.name + '()';
                    } catch (e) { trace.push({ ok: false, iface: d.iface, name: mt.name, error: e.message }); }
                }
            }
            if (succeeded || params.userInitiated) {
                tracker.state.climate1cr.timerText = en ? hhmm : 'Tắt';
            }
            tracker.state.climate1cr.lastAction = (en ? 'Đặt hẹn giờ 1CR ' : 'Huỷ hẹn giờ 1CR ') + hhmm;
            tracker.state.climate1cr.lastResult = succeeded ? ('Đã lưu vào BDC/IHKA qua ' + succeeded) : 'Đã lưu lịch chờ đồng bộ xuống xe';
            pushPatch({});
            return { ok: !!succeeded, method: succeeded || 'queued', trace };
        }

        return { ok: false, error: 'unknown 1CR action: ' + action };
    }

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

    async function openWildcardProxy(ifaceName) {
        if (!db || !gen || !someip || !db.interfaces || !db.interfaces[ifaceName]) return null;
        const proxies = {};
        proxies[ifaceName] = '*';
        const generated = gen.generate(db, { proxies, services: {} });
        const cfg = generated && generated[ifaceName];
        if (!cfg) return null;
        const inst = Object.keys(cfg.instances || { '1': 1 })[0] || '1';
        return nativeTick(() => within(someip.buildProxy(cfg, String(inst)).then((p) => p.init().then(() => p)), 4500, ifaceName));
    }

    async function releaseCam360() {
        if (camHolders.timer) {
            clearTimeout(camHolders.timer);
            camHolders.timer = null;
        }
        if (camHolders.cookie === null || camHolders.cookie === undefined) return { ok: true, released: false };
        const c = camHolders.cookie;
        camHolders.cookie = null;
        const target = camHolders.icam || camHolders.cam;
        if (!target) return { ok: true, released: false };
        try {
            await nativeTick(() => within(target.callMethod('clientDetach', { cookie: c }, 3000), 3500, 'clientDetach'));
        } catch (e) {
            if (camHolders.cam && target !== camHolders.cam) {
                try { await nativeTick(() => within(camHolders.cam.callMethod('clientDetach', { cookie: c }, 3000), 3500, 'clientDetach')); } catch (e2) {}
            }
        }
        return { ok: true, released: true };
    }

    async function wakeCam360() {
        if (!db || !gen || !someip) return { ok: false, note: 'someip unavailable' };
        const ICAM_IF = 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy';
        const CAM_IF = 'de.bmw.infotainment.video.cameraproxy.CameraProxy';
        const XV_IF = 'de.bmw.dass.XView3D';
        if (!db.interfaces || !db.interfaces[ICAM_IF]) return { ok: false, note: 'no ICAM2Proxy on car' };
        try {
            if (!camHolders.icam) camHolders.icam = await openWildcardProxy(ICAM_IF);
        } catch (e) {
            return { ok: false, note: 'ICAM2 open: ' + e.message };
        }
        if (!camHolders.icam) return { ok: false, note: 'ICAM2 null' };
        if (!camHolders.xv && db.interfaces[XV_IF]) {
            try { camHolders.xv = await openWildcardProxy(XV_IF); } catch (e) {}
        }

        // Check if Parking View or another Drive Recorder / Turn-Cam client already has 4-camera stream active
        try {
            const xvVal = camHolders.xv ? await nativeTick(() => within(camHolders.xv.getValue('CurrentState', 1500), 1800, 'xv')).catch(() => null) : null;
            const icVal = await nativeTick(() => within(camHolders.icam.getValue('currentState', 1500), 1800, 'icam')).catch(() => null);
            const raw = JSON.stringify({ xv: xvVal, icam: icVal });
            if (/PDC|PARK|RVC|TOP_VIEW|PANORAMA/i.test(raw)) {
                return { ok: true, alreadyOn: true, note: 'parking view active' };
            }
            if ((/DR_ACTIVE|"application":51\b/i.test(raw)) && (/MOSAIK|"mode":50\b/i.test(raw)) && /"perspective":7\b/.test(raw)) {
                return { ok: true, alreadyOn: true, note: 'all4 mosaic already active' };
            }
        } catch (e) {}

        const callAttach = async (px, arg) => nativeTick(() => within(px.callMethod('clientAttach', arg, 3000), 3500, 'clientAttach'));
        let cookie = camHolders.cookie;
        if (cookie === null || cookie === undefined) {
            let att = null;
            try {
                att = await callAttach(camHolders.icam, { type: 'CLIENT_INDIRECT' }).catch(() => callAttach(camHolders.icam, { type: 1 }));
            } catch (e) {
                if (!camHolders.cam && db.interfaces[CAM_IF]) {
                    try { camHolders.cam = await openWildcardProxy(CAM_IF); } catch (e2) {}
                }
                if (!camHolders.cam) return { ok: false, note: 'clientAttach: ' + e.message };
                try {
                    att = await callAttach(camHolders.cam, { type: 'CLIENT_INDIRECT' }).catch(() => callAttach(camHolders.cam, { type: 1 }));
                } catch (e3) {
                    return { ok: false, note: 'clientAttach: ' + e3.message };
                }
            }
            cookie = (att && typeof att === 'object' && att.cookie !== undefined) ? att.cookie : att;
            camHolders.cookie = cookie;
        }

        const stName = { cookie, desiredState: { application: 'DR_ACTIVE', mode: 'MODE_MOSAIK', perspective: 7 } };
        const stWire = { cookie, desiredState: { application: 51, mode: 50, perspective: 7 } };
        try {
            await nativeTick(() => within(camHolders.icam.callMethod('changeState', stName, 3500), 4000, 'changeState'))
                .catch(() => nativeTick(() => within(camHolders.icam.callMethod('changeState', stWire, 3500), 4000, 'changeState')));
        } catch (e) {
            await releaseCam360();
            return { ok: false, note: 'changeState: ' + e.message };
        }

        if (camHolders.timer) clearTimeout(camHolders.timer);
        camHolders.timer = setTimeout(() => { releaseCam360().catch(() => {}); }, 12000);
        return { ok: true, attached: true, cookie, note: 'DR_ACTIVE mosaic 7' };
    }

    async function handleParentCmd(cmd) {
        const reqId = cmd.reqId;
        if (cmd.op === 'refresh_vitals') {
            await readVitalsUDS();
            emit({ ev: 'reply', reqId, ok: true, state: tracker.state });
        } else if (cmd.op === 'cam_wake') {
            const r = await wakeCam360();
            emit({ ev: 'reply', reqId, ok: !!r.ok, result: r });
        } else if (cmd.op === 'cam_release') {
            const r = await releaseCam360();
            emit({ ev: 'reply', reqId, ok: true, result: r });
        } else if (cmd.op === 'start1cr' || cmd.op === 'stop1cr' || cmd.op === 'schedule1cr' || cmd.op === 'invoke_raw') {
            const res = await execute1CR(cmd.op, cmd.params);
            emit({ ev: 'reply', reqId, ok: res.ok, result: res, state: tracker.state });
        } else if (cmd.op === 'schema') {
            const cfgMap = {};
            Object.keys(climateProxies).forEach((k) => { cfgMap[k] = climateProxies[k].cfgSummary; });
            emit({
                ev: 'reply',
                reqId,
                ok: true,
                schema: {
                    interfaces: climateCatalog.interfaces,
                    openConfigs: cfgMap,
                    live: climateLive,
                    pinnedProfile: readJsonSafe(PROFILE_PATH),
                },
            });
        }
    }

    emit({ ev: 'ready', discoveredClimate: climateCatalog.interfaces.length });
    emit({ ev: 'telemetry', state: tracker.state, activeTrip: null, lastTrip: null });
    // Read accurate Fuel %, 12V Voltage, Odometer & Temps once shortly after startup
    setTimeout(() => { readVitalsUDS().catch(() => {}); }, 2500);
}

/* ---------------- VIN / VCM FA Chassis Decoder & Strict Field Interpreters ---------------- */

function decodeChassisFromVinOrFa(vin, faStr) {
    const out = { trueChassis: '', notMCar: false };
    const v = String(vin || '').trim().toUpperCase();
    if (v.length === 17) {
        const wmi = v.slice(0, 3);
        if (!/^(WBS|5YM)$/.test(wmi)) out.notMCar = true;
    }
    const faMatch = /(?:^|[^A-Z0-9])(G01LCI|G02LCI|G07LCI|G20LCI|G28LCI|G30LCI|G31LCI|G32LCI|G38LCI|G01|G02|G05|G06|G07|G08|G11|G12|G14|G15|G16|G20|G21|G22|G23|G26|G28|G29|G30|G31|G32|G38|G42|G60|G70|G80|G82|G87|F40|F44|F90|F95|F96|F97|F98)(?:[^A-Z0-9]|$)/.exec(String(faStr || '').toUpperCase());
    if (faMatch) {
        out.trueChassis = faMatch[1];
        return out;
    }
    if (v.length === 17) {
        const tc = v.slice(3, 7);
        if (/^(TR|TX|TY|UZ)\d\d$|^\d\d(DP|BG|BZ)$/.test(tc)) out.trueChassis = 'G01';
        else if (/^UJ\d\d$|^[234]\dDT$|^\d\dCA$/.test(tc)) out.trueChassis = 'G02';
        else if (/^(CR|CV|TA|JU)\d\d$|^\d\dE[UV]$/.test(tc)) out.trueChassis = 'G05';
        else if (/^(CY|GT)\d\d$|^\d\dE[XY]$/.test(tc)) out.trueChassis = 'G06';
        else if (/^(CW|TB)\d\d$|^\d\dE[MN]$/.test(tc)) out.trueChassis = 'G07';
        else if (/^(5F|5V|5U|6K)\d\d$|^\d\d(DY|DZ|FF|FG)$/.test(tc)) out.trueChassis = 'G20';
        else if (/^J[A-T]\d\d$|^\d\dB[J-N]$/.test(tc)) out.trueChassis = 'G30';
        else if (/^7[A-W]\d\d$|^\d\dE[A-D]$/.test(tc)) out.trueChassis = 'G12';
        else if (/^\d\dA[PRTV]$/.test(tc)) out.trueChassis = 'G22';
        else if (/^JF0\d$|^8\dCH$/.test(tc)) out.trueChassis = 'F90';
    }
    return out;
}

function estimateRangeFromFuel(fuelPct, chassis) {
    if (fuelPct === null || fuelPct === undefined || !isFinite(fuelPct)) return null;
    const ch = String(chassis || '').toUpperCase();
    let fullKm = 650;
    if (/^G0[567]/.test(ch)) fullKm = 690;
    else if (/^G0[12]/.test(ch)) fullKm = 620;
    else if (/^G2[01236]/.test(ch)) fullKm = 610;
    else if (/^F9[05678]|^G8[02]/.test(ch)) fullKm = 520;
    return Math.max(0, Math.round((Math.max(0, Math.min(100, fuelPct)) / 100) * fullKm));
}

function pickNamedNum(v, propRe, invalids, depth) {
    if (typeof v === 'number' && isFinite(v)) {
        return invalids && invalids.indexOf(v) >= 0 ? null : v;
    }
    if (!v || typeof v !== 'object' || (depth || 0) > 3) return null;
    const keys = Object.keys(v);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const x = v[k];
        if (typeof x === 'number' && isFinite(x)) {
            if (propRe && !propRe.test(k)) continue;
            if (!invalids || invalids.indexOf(x) < 0) return x;
        } else if (x && typeof x === 'object') {
            const sub = pickNamedNum(x, propRe, invalids, (depth || 0) + 1);
            if (sub !== null) return sub;
        }
    }
    return null;
}

function interpretBodyField(iface, fname, val, pushPatch, curState) {
    if (val === undefined || val === null) return;
    const key = iface + '.' + fname;

    // Remaining driving range (exclude dynamicRange, speedRange, scaleRange, freqRange, etc.)
    if ((/(^|status|_)(range|drivingRange|displayRange|combustionRange|cruisingRange|remainingRange|residualRange|tankRange|totalRange|electricRange|reichweite)$/i.test(fname) || /^statusRange/i.test(fname)) && !/dynamic|speed|scale|freq|audio/i.test(fname)) {
        const n = pickNamedNum(val, /range|reichweite|combustion|display|total|remaining|cruising|distance|km|value/i, [0, 255, 4094, 4095, 65534, 65535]);
        if (n !== null && n >= 5 && n <= 1600) pushPatch({ rangeKm: Math.round(n), rangeEstimated: false });
        return;
    }

    // Fuel percentage / tank level
    if (/tank|fuel|kraftstoff|fuellstand/i.test(fname) && !/consumption|verbrauch|cap|flap/i.test(fname)) {
        const pct = pickNamedNum(val, /percent|pct|relativ|level/i, [255, 4095, 65535]);
        if (pct !== null && pct >= 0 && pct <= 100) {
            const patch = { fuelPct: Math.round(pct) };
            if (curState.rangeKm === null || curState.rangeEstimated) {
                patch.rangeKm = estimateRangeFromFuel(patch.fuelPct, curState.trueChassis);
                patch.rangeEstimated = true;
            }
            pushPatch(patch);
            return;
        }
        const lit = pickNamedNum(val, /liter|volume|inhalt|content|quantity/i, [255, 4095, 65535]);
        if (lit !== null && lit >= 0 && lit <= 120) {
            pushPatch({ fuelLiters: +lit.toFixed(1) });
        }
        return;
    }

    // Total odometer (exclude trip / service / CBS distance!)
    if (/(kilometerstand|odometer|totalDistance|gesamtkilometer)/i.test(fname) && !/trip|reise|service|cbs|reset/i.test(fname)) {
        const n = pickNamedNum(val, /kilometer|odometer|distance|mileage|total|value/i, [65535, 16777215, 4294967295]);
        if (n !== null && n >= 1 && n < 1500000) pushPatch({ odometerKm: Math.round(n) });
        return;
    }

    if (/outsideTemp|exteriorTemp|ambientTemp/i.test(fname)) {
        let n = pickNamedNum(val, /temp|value/i, [255, 65535]);
        if (n !== null) {
            if (n > 65 && n < 220) n = n * 0.5 - 40;
            if (n >= -45 && n <= 60) pushPatch({ ambientC: +n.toFixed(1) });
        }
        return;
    }

    if (/centralLock|lockState|^statusLock/i.test(fname)) {
        const s = JSON.stringify(val).toUpperCase();
        if (/LOCKED|SECURED/.test(s) && !/UNLOCKED/.test(s)) pushPatch({ locked: true });
        else if (/UNLOCKED/.test(s)) pushPatch({ locked: false });
        return;
    }

    if (/door|tailgate|trunk|bonnet|hood/i.test(key) && !/mirror|light|handle|heating/i.test(fname)) {
        const s = JSON.stringify(val).toUpperCase();
        const isOpen = /\"OPEN\"|_OPEN|AJAR/.test(s) && !/CLOSED|NOT_OPEN/.test(s);
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
        if (/\"ON\"|\"ACTIVE\"|\"RUNNING\"|\"START\"|_ON\"|_ACTIVE\"/i.test(s) && !/OFF|INACTIVE|STOP/i.test(s)) c1.active = true;
        else if (/OFF|INACTIVE|STOP/i.test(s)) c1.active = false;
    }
    if (fieldDesc.roles.indexOf('temp_read') >= 0 && /interior|cabin|innen/i.test(fieldDesc.name)) {
        const n = pickNamedNum(val, /temp|value/i, [255, 65535]);
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
    resolveTypeDef,
    pickEnumOrBool,
    buildDirectPayload,
    buildTimerPayload,
    decodeChassisFromVinOrFa,
    estimateRangeFromFuel,
    TelemetryTracker,
    loadIFConfigGeneratorFromText,
};
