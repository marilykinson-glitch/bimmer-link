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

const CLIMATE_IFACE_RE = /climate|climatis|climatiz|aircond|hvac|heating|ventilat|thermal|auxiliary|standheiz|standklima|standfunktion|stationary|precond|parkheat|parkclim|remotestart|independent|departure|abfahrt|timer|zeitvorwahl|zeitschalt|zeitplan|timeswitch|\.lsc\.|\.rcn\./i;
const NON_CLIMATE_IFACE_RE = /^de\.bmw\.(dass\.parking|parking|infotainment\.(video|navigation|media|audio|tuner|speech|map))\./i;
const CLIMATE_MEMBER_HINT_RE = /standheiz|standklima|standlueft|standfunktion|parkheat|parkklima|parkclim|airCondition(?:ing)?ParkFunctions|parkingFunctions(?:On|RES)|parkFunction|precond|remotestart|remote.*engine|engine.*start.*clim|auxiliary.*clim|aux.*heat|aux.*vent|independent.*vent|independent.*clim|stationary.*clim|climatis.*now|climatiz.*now|climate.*now|direct.*oper|sofort|departurePlan|departureTime|departureSchedule|departure.*timer|abfahrt|einschaltzeit|switchontime|zeitvorwahl|zeitschalt|zeitplan|timeswitch|timerList|timerSlot|weeklyTimer|standTimer|preconditioningTimer|climatisationTimer|climatizationTimer|timer.*park|park.*timer/i;
const BODY_IFACE_RE = /(^|\.)(Door|Window|Lock|CentralLock|Tailgate|Trunk|Bonnet|Hood|Flap|Body|Kombi|Vehicle|CDS|Fuel|Tank)/i;
const NON_1CR_MEMBER_RE = /steeringwheel|lenkrad|seatheat|seatclim|seatvent|seatAuto|sitzheiz|sitzklima|armSupport|massage|fragrance|scent|ionis|ioniz|aura|acFond|climateFond|2Tier|3Tier|rearClimate|rearWindow|heckscheib|defrost|stratification|surfaceHeating|airDistribution|airBlow|airQuality|sync|functionECO|climateEco|climateSystemOn|intelligentPassenger|telephone|swipe|residualHeat|restwaerme|acSpecialFunction|extendedClimateFunctionalities/i;

function fieldAttrFlags(fm) {
    if (!fm || typeof fm !== 'object') return { getter: false, setter: false, notifier: false };
    const hasExplicit = fm.getter !== undefined || fm.setter !== undefined || fm.notifier !== undefined || fm.dataRef !== undefined;
    if (!hasExplicit) return { getter: true, setter: false, notifier: true };
    const isPresent = (x) => x === true || (!!x && typeof x === 'object');
    return {
        getter: fm.getter === false ? false : isPresent(fm.getter),
        setter: fm.setter === false ? false : isPresent(fm.setter),
        notifier: fm.notifier === false ? false : isPresent(fm.notifier),
    };
}

/** Classify a Climate / 1CR field or method into semantic roles for automatic invocation. */
function classifyClimateMember(ifaceName, memberName, kind, meta) {
    if (NON_CLIMATE_IFACE_RE.test(ifaceName)) return [];
    const full = ifaceName + '.' + memberName;
    const roles = [];
    const flags = fieldAttrFlags(meta);
    const writable = kind === 'method' || flags.setter;
    if (NON_1CR_MEMBER_RE.test(full)) {
        if (/status|state|active|on|mode/i.test(memberName) && !writable) roles.push('state_read');
        return roles;
    }
    if (!/^statusAvailable/i.test(memberName) && /remote.*engine.*start|engine.*start.*climat|allow.*engine.*start|setupRemoteStart|parkingFunctionsRES|motorstart|climatis.*engine|climatiz.*engine|1cr/i.test(full)) {
        roles.push(writable ? 'consent_write' : 'consent_read');
    }
    if (/airCondition(?:ing)?ParkFunctions|parkingFunctionsOn|requestParkingFunctionsOn|parkAirCond|park.*heat|park.*clim|parkklima|stationary.*clim|standheiz|standklima|standlueft|independent.*vent|independent.*clim|precond|direct.*oper|immediate|sofort|adhoc|ad_hoc|activate.*now|start.*now|climate.*now|climatis.*now|climatiz.*now|instant.*clim|activate.*aux|start.*aux|aux.*clim|aux.*vent|aux.*heat|ventilat.*now|cooling.*now|set.*climatis|set.*climatiz|switch.*climat|activate.*clim|start.*clim|stop.*clim/i.test(full)) {
        if (!/timer|schedule|weekly|abfahrt|departure|zeitplan|einschaltzeit|switchontime|zeitvorwahl|^statusAvailable|controlClimateCompressor/i.test(memberName)) {
            roles.push(writable ? 'direct_write' : 'direct_read');
        }
    }
    if (/timer|departure|abfahrt|schedule|weekly|zeitplan|startzeit|einschaltzeit|switchontime|zeitvorwahl/i.test(full)) {
        roles.push(writable ? 'timer_write' : 'timer_read');
    }
    if (/temp/i.test(memberName) && !writable) roles.push('temp_read');
    if (/status|state|active|on|mode/i.test(memberName) && !writable && !roles.length) roles.push('state_read');
    if (writable && !roles.length && /Auxiliary|Stand|PreCond|ParkClim|Independent|Remote/i.test(ifaceName)) {
        if (!/temp|setpoint|soll|fan|blower|geblaese|intensity|flap|distribution|defrost|recirc|sync|auto.*program|filter|style|front$/i.test(memberName)) {
            roles.push('master_candidate');
        }
    }
    return roles;
}

const META_SKIP_KEYS = {
    name: 1, id: 1, methodId: 1, fieldId: 1, eventId: 1, eventgroup: 1, eventGroup: 1,
    notifierId: 1, getterId: 1, setterId: 1, reliable: 1, fireAndForget: 1,
    version: 1, major: 1, minor: 1, serviceId: 1, instances: 1,
};

function lookupRawType(db, iv, typeName) {
    if (typeName === null || typeName === undefined || (typeof typeName !== 'string' && typeof typeName !== 'number')) return null;
    const keyStr = String(typeName);
    if (!keyStr) return null;
    const pools = [
        iv && iv.datatypes, db && db.datatypes,
        iv && iv.someipDatatypes, db && db.someipDatatypes,
        iv && iv.types, iv && iv.enumerations, iv && iv.structs, iv && iv.typeDefinitions,
        db && db.types, db && db.enumerations, db && db.structs, db && db.typeDefinitions, db && db.typeCollections,
    ];
    const shortName = keyStr.split('.').pop();
    const slashName = keyStr.split('/').pop();
    for (let i = 0; i < pools.length; i++) {
        const p = pools[i];
        if (!p || typeof p !== 'object') continue;
        if (p[keyStr]) return p[keyStr];
        if (p[shortName]) return p[shortName];
        if (p[slashName]) return p[slashName];
    }
    return null;
}

function extractTypeRef(db, iv, entry, depth) {
    if (entry === null || entry === undefined || (depth || 0) > 4) return null;
    if (typeof entry === 'string' || typeof entry === 'number') {
        const s = String(entry);
        if (lookupRawType(db, iv, s) || (typeof entry === 'string' && /^(UInt\d+|Int\d+|Boolean|Float|Double|String|ByteBuffer)$/i.test(s))) {
            return s;
        }
        return null;
    }
    if (Array.isArray(entry)) {
        if (entry.length === 1) return extractTypeRef(db, iv, entry[0], (depth || 0) + 1);
        if (entry.length > 1 && entry[0] && typeof entry[0] === 'object' && entry[0].name) {
            return { type: 'struct', fields: entry };
        }
        return null;
    }
    if (typeof entry !== 'object') return null;
    if (entry.type === 'enum' || entry.type === 'struct' || entry.type === 'union' || entry.enumerators || entry.enumValues || (entry.fields && typeof entry.fields === 'object')) {
        return entry;
    }
    const directKeys = ['type', 'datatype', 'dataType', 'typeId', 'attributeType', 'valueType', 'elementType', 'argType'];
    for (let i = 0; i < directKeys.length; i++) {
        const v = entry[directKeys[i]];
        if ((typeof v === 'string' || typeof v === 'number') && String(v)) return String(v);
        if (v && typeof v === 'object') {
            const sub = extractTypeRef(db, iv, v, (depth || 0) + 1);
            if (sub) return sub;
        }
    }
    const nestedPriority = ['setter', 'getter', 'notifier', 'in', 'out', 'args', 'input', 'parameters'];
    for (let i = 0; i < nestedPriority.length; i++) {
        const subObj = entry[nestedPriority[i]];
        if (subObj && typeof subObj === 'object') {
            const hit = extractTypeRef(db, iv, subObj, (depth || 0) + 1);
            if (hit) return hit;
        }
    }
    const keys = Object.keys(entry);
    for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (META_SKIP_KEYS[k]) continue;
        const val = entry[k];
        if (typeof val === 'string' || typeof val === 'number') {
            const sv = String(val);
            if (lookupRawType(db, iv, sv) || (typeof val === 'string' && /^(UInt\d+|Int\d+|Boolean|Float|Double|String|ByteBuffer)$/i.test(sv))) {
                return sv;
            }
        } else if (val && typeof val === 'object') {
            const sub = extractTypeRef(db, iv, val, (depth || 0) + 1);
            if (sub) return sub;
        }
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

    if (t.type === 'struct' || t.fields || t.members || (t.elements && t.type !== 'union' && !Array.isArray(t.elements))) {
        const fl = t.fields || t.members || t.elements || {};
        const fields = Array.isArray(fl)
            ? fl.map((x) => {
                const ftype = extractTypeRef(db, iv, x, 0);
                return { name: x && x.name, type: typeof ftype === 'string' ? ftype : null, typeDef: resolveTypeDef(db, iv, ftype, depth) };
            })
            : Object.keys(fl).map((k) => {
                const entry = fl[k];
                const ftype = typeof entry === 'string' ? entry : extractTypeRef(db, iv, entry, 0);
                return { name: k, type: typeof ftype === 'string' ? ftype : null, typeDef: resolveTypeDef(db, iv, ftype, depth) };
            });
        return { kind: 'struct', fields };
    }

    if (t.type === 'union' && (t.elements || t.fields || t.items)) {
        const ul = t.elements || t.fields || t.items || {};
        const branches = Array.isArray(ul)
            ? ul.map((x) => {
                const btype = extractTypeRef(db, iv, x, 0);
                return { name: x && x.name, type: typeof btype === 'string' ? btype : null, typeDef: resolveTypeDef(db, iv, btype, depth) };
            })
            : Object.keys(ul).map((k) => {
                const btype = typeof ul[k] === 'string' ? ul[k] : extractTypeRef(db, iv, ul[k], 0);
                return { name: k, type: typeof btype === 'string' ? btype : null, typeDef: resolveTypeDef(db, iv, btype, depth) };
            });
        return { kind: 'union', branches };
    }

    const ref = extractTypeRef(db, iv, t, 1);
    if (typeof ref === 'string' && !/^(UInt\d+|Int\d+|Boolean|Float|Double|String|ByteBuffer|primitive|array|map)$/i.test(ref)) {
        const target = resolveTypeDef(db, iv, ref, depth);
        if (target) return target;
    }

    return { kind: String(t.kind || t.type || (typeof ref === 'string' ? ref : 'primitive')) };
}

/** Parse IFConfigGenerator compact wire schema (`{ t: 'Struct'|'Enum'|'Union'|'UInt8'|'Bool', e: ... }`). */
function parseCompactSchema(s, depth) {
    if (!s || typeof s !== 'object' || (depth || 0) > 6) return null;
    const tp = String(s.t || '');
    if (!tp) return null;
    if (/^enum$/i.test(tp) && s.e && typeof s.e === 'object') {
        const values = [];
        const valueMap = {};
        Object.keys(s.e).forEach((nm) => {
            values.push(nm);
            valueMap[nm] = typeof s.e[nm] === 'number' ? s.e[nm] : Number(s.e[nm]) || 0;
        });
        return { kind: 'enum', values, valueMap };
    }
    if (/^struct$/i.test(tp) && Array.isArray(s.e)) {
        return {
            kind: 'struct',
            fields: s.e.map((f) => ({
                name: f && (f.n || f.name),
                type: f && (f.t || f.type || null),
                typeDef: parseCompactSchema(f, (depth || 0) + 1),
            })),
        };
    }
    if (/^union$/i.test(tp) && Array.isArray(s.e)) {
        return {
            kind: 'union',
            branches: s.e.map((b) => ({
                name: b && (b.n || b.name),
                type: b && (b.t || b.type || null),
                typeDef: parseCompactSchema(b, (depth || 0) + 1),
            })),
        };
    }
    if (/^array$/i.test(tp)) {
        return { kind: 'array', elem: s.e ? parseCompactSchema(s.e, (depth || 0) + 1) : null };
    }
    return { kind: 'primitive', name: tp };
}

function parseMethodInArgs(db, iv, mm) {
    if (!mm || typeof mm !== 'object') return [];
    if (mm.schema && typeof mm.schema === 'object') {
        const cs = parseCompactSchema(mm.schema, 0);
        if (cs && cs.kind === 'struct' && Array.isArray(cs.fields)) return cs.fields;
    }
    const rawIn = mm.inArgs || mm.in || mm.parameters || mm.args || mm.input || mm.request;
    if (!rawIn) return [];
    if (Array.isArray(rawIn)) {
        return rawIn.map((a, idx) => {
            const tp = typeof a === 'string' ? a : extractTypeRef(db, iv, a, 0);
            const nm = (a && a.name) || ('arg' + idx);
            return { name: nm, type: typeof tp === 'string' ? tp : null, typeDef: resolveTypeDef(db, iv, tp, 0) };
        });
    }
    if (typeof rawIn === 'object') {
        const directStruct = extractTypeRef(db, iv, rawIn, 0);
        if (directStruct && rawIn.type) {
            const td = resolveTypeDef(db, iv, directStruct, 0);
            if (td && td.kind === 'struct' && Array.isArray(td.fields)) return td.fields;
        }
        return Object.keys(rawIn).filter((k) => !META_SKIP_KEYS[k]).map((k) => {
            const entry = rawIn[k];
            const tp = typeof entry === 'string' ? entry : extractTypeRef(db, iv, entry, 0);
            return { name: k, type: typeof tp === 'string' ? tp : null, typeDef: resolveTypeDef(db, iv, tp, 0) };
        });
    }
    return [];
}

function enrichDescWithGeneratedCfg(db, iv, desc, cfg) {
    if (!desc || !cfg || typeof cfg !== 'object') return;
    const mergedIv = Object.assign({}, iv || {}, {
        datatypes: Object.assign({}, (iv && iv.datatypes) || {}, cfg.datatypes || {}),
        types: Object.assign({}, (iv && iv.types) || {}, cfg.types || {}),
        enumerations: Object.assign({}, (iv && iv.enumerations) || {}, cfg.enumerations || {}),
        structs: Object.assign({}, (iv && iv.structs) || {}, cfg.structs || {}),
    });
    const cfgFields = cfg.fields || cfg.attributes || {};
    (desc.fields || []).forEach((f) => {
        const cf = cfgFields[f.name];
        if (!cf) return;
        if (cf.getter !== undefined || cf.setter !== undefined || cf.event !== undefined) {
            f.getter = !!cf.getter;
            f.setter = !!cf.setter;
            f.notifier = !!(cf.event || cf.notifier);
        }
        if (cf.schema && (!f.typeDef || f.typeDef.kind === 'primitive')) {
            const parsedSchema = parseCompactSchema(cf.schema, 0);
            if (parsedSchema) {
                f.type = f.type || String(cf.schema.t || 'Struct');
                f.typeDef = parsedSchema;
                return;
            }
        }
        if (f.typeDef && f.typeDef.kind !== 'primitive') return;
        const ftype = extractTypeRef(db, mergedIv, cf, 0);
        if (ftype) {
            f.type = typeof ftype === 'string' ? ftype : (f.type || null);
            f.typeDef = resolveTypeDef(db, mergedIv, ftype, 0);
        }
    });
    const cfgMethods = cfg.methods || {};
    (desc.methods || []).forEach((m) => {
        if (m.inArgs && m.inArgs.length && m.inArgs.every((a) => a.typeDef && a.typeDef.kind !== 'primitive')) return;
        const cm = cfgMethods[m.name];
        if (!cm) return;
        const parsed = parseMethodInArgs(db, mergedIv, cm);
        if (parsed.length) m.inArgs = parsed;
    });
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
        if (NON_CLIMATE_IFACE_RE.test(ifaceName)) return;
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
            const flg = fieldAttrFlags(fm);
            const roles = classifyClimateMember(ifaceName, fname, 'field', fm);
            const isLsc = /\.lsc\./i.test(ifaceName);
            if (!ifaceMatches && !isLsc && !roles.length && !CLIMATE_MEMBER_HINT_RE.test(fname)) return;
            const ftype = extractTypeRef(db, iv, fm, 0);
            item.fields.push({
                name: fname,
                getter: flg.getter,
                setter: flg.setter,
                notifier: flg.notifier,
                type: typeof ftype === 'string' ? ftype : null,
                typeDef: resolveTypeDef(db, iv, ftype, 0),
                roles: roles.length ? roles : (isLsc && !flg.setter ? ['lsc_read'] : roles),
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

const ENUM_INVALID_RE = /INVALID|UNKNOWN|ERROR|SIGNAL_UNAVAILABLE|SIGNAL_UNGUELTIG|SIGNAL_UNBEFUELLT|NO_ACTION|NO_CHANGE|KEINE_AKTION|KEINE_AENDERUNG|KEINE_ANGABE|KEINE_ANZEIGE|NICHT_VERFUEGBAR|INIT|NOT_AVAILABLE/i;
const ENUM_OFF_TOKEN_RE = /(^|_)(OFF|AUS|AUSSCHALTEN|INACTIVE|INAKTIV|NICHT_AKTIV|DEACTIVATE|DEACTIVATED|DEAKTIVIEREN|STOP|STOPPED|STOPPEN|DISABLE|DISABLED|NEIN|FALSE|STANDBY|IDLE)(_|$)/i;
const ENUM_ON_TOKEN_RE = /(^|_)(ON|EIN|AN|EINSCHALTEN|ACTIVE|AKTIV|ACTIVATE|ACTIVATED|AKTIVIEREN|START|STARTED|STARTEN|ENABLE|ENABLED|JA|TRUE|RUN|RUNNING|IMMEDIATE|SOFORT)(_|$)/i;

/**
 * Pick an enum/boolean/numeric value for turning a feature ON or OFF based on its Franca type definition
 * or its last observed live value on the bus (`sample`). Supports both English and German BMW Franca enums.
 */
function pickEnumOrBool(typeDef, wantOn, sample, numericEnum) {
    if (typeDef && typeDef.kind === 'enum' && Array.isArray(typeDef.values) && typeDef.values.length) {
        const vals = typeDef.values.map(String);
        const exactRe = wantOn
            ? /^(ON|EIN|AN|EINSCHALTEN|ACTIVE|AKTIV|ACTIVATE|ACTIVATED|AKTIVIEREN|START|STARTED|STARTEN|ENABLE|ENABLED|TRUE|IMMEDIATE|SOFORT|DIRECT_ON|CLIMATE_ON|STANDKLIMATISIERUNG_EIN|STANDLUEFTEN_EIN|REMOTE_ENGINE_START_EIN|AUTO_MINUS_MODUS_EIN|RUN|RUNNING|1)$/i
            : /^(OFF|AUS|AUSSCHALTEN|INACTIVE|INAKTIV|NICHT_AKTIV|DEACTIVATE|DEACTIVATED|DEAKTIVIEREN|STOP|STOPPED|DISABLE|DISABLED|FALSE|DIRECT_OFF|CLIMATE_OFF|STANDKLIMATISIERUNG_AUS|STANDLUEFTEN_AUS|STANDHEIZUNG_AUS|AUTO_MINUS_MODUS_AUS|STANDBY|0)$/i;
        const noInvalid = vals.filter((v) => !ENUM_INVALID_RE.test(v));
        let chosen = noInvalid.find((v) => exactRe.test(v));
        if (chosen === undefined) {
            chosen = noInvalid.find((v) => wantOn
                ? (ENUM_ON_TOKEN_RE.test(v) && !ENUM_OFF_TOKEN_RE.test(v))
                : ENUM_OFF_TOKEN_RE.test(v));
        }
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
        if (ENUM_OFF_TOKEN_RE.test(sample) && wantOn) {
            return sample
                .replace(/NICHT_AKTIV/ig, 'AKTIV')
                .replace(/AUSSCHALTEN/ig, 'EINSCHALTEN')
                .replace(/(^|_)AUS(_|$)/ig, '$1EIN$2')
                .replace(/INACTIVE/ig, 'ACTIVE')
                .replace(/DISABLE[D]?/ig, 'ENABLED')
                .replace(/STOP/ig, 'START')
                .replace(/(^|_)OFF(_|$)/ig, '$1ON$2');
        }
        if (ENUM_ON_TOKEN_RE.test(sample) && !ENUM_OFF_TOKEN_RE.test(sample) && !wantOn) {
            return sample
                .replace(/(^|_)AKTIV(_|$)/ig, '$1NICHT_AKTIV$2')
                .replace(/EINSCHALTEN/ig, 'AUSSCHALTEN')
                .replace(/(^|_)EIN(_|$)/ig, '$1AUS$2')
                .replace(/ACTIVE/ig, 'INACTIVE')
                .replace(/ENABLE[D]?/ig, 'DISABLED')
                .replace(/START/ig, 'STOP')
                .replace(/(^|_)ON(_|$)/ig, '$1OFF$2');
        }
    }
    if (typeDef && typeDef.kind && /bool/i.test(typeDef.kind + ' ' + (typeDef.name || ''))) return !!wantOn;
    return wantOn ? 1 : 0;
}

function pickNoActionOrOff(typeDef, sample, numericEnum) {
    if (typeDef && typeDef.kind === 'enum' && Array.isArray(typeDef.values) && typeDef.values.length) {
        const vals = typeDef.values.map(String);
        const noop = vals.find((v) => /KEINE_AKTION|KEINE_AENDERUNG|NO_ACTION|NO_CHANGE|UNCHANGED/i.test(v)) ||
            vals.find((v) => /SIGNAL_UNBEFUELLT|KEINE_ANGABE/i.test(v));
        if (noop !== undefined) {
            return (numericEnum && typeDef.valueMap && typeDef.valueMap[noop] !== undefined) ? typeDef.valueMap[noop] : noop;
        }
        return pickEnumOrBool(typeDef, false, sample, numericEnum);
    }
    if (typeof sample === 'string' && /SIGNAL_UNGUELTIG|SIGNAL_UNBEFUELLT|KEINE_AKTION|KEINE_ANGABE/i.test(sample)) {
        return numericEnum ? 0 : 'KEINE_AKTION';
    }
    return pickEnumOrBool(typeDef, false, sample, numericEnum);
}

function pickConsentKeepOrOn(typeDef, wantOn, sample, numericEnum) {
    if (wantOn) return pickEnumOrBool(typeDef, true, sample, numericEnum);
    if (typeDef && typeDef.kind === 'enum' && Array.isArray(typeDef.values)) {
        const vals = typeDef.values.map(String);
        const noop = vals.find((v) => /KEINE_AKTION|KEINE_AENDERUNG|NO_ACTION|NO_CHANGE|SIGNAL_UNBEFUELLT/i.test(v));
        if (noop !== undefined) {
            return (numericEnum && typeDef.valueMap && typeDef.valueMap[noop] !== undefined) ? typeDef.valueMap[noop] : noop;
        }
    }
    // Never uncheck the owner's Remote Engine Start consent in iDrive when stopping park AC!
    return pickEnumOrBool(typeDef, true, sample, numericEnum);
}

function lookupSampleField(sample, fname) {
    if (!sample || typeof sample !== 'object') return undefined;
    if (sample[fname] !== undefined) return sample[fname];
    const bare = String(fname || '').replace(/^(operation|control|request|set|status)/i, '');
    if (!bare) return undefined;
    const statusKey = 'status' + bare[0].toUpperCase() + bare.slice(1);
    if (sample[statusKey] !== undefined) return sample[statusKey];
    const keys = Object.keys(sample);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase().slice(-bare.length) === bare.toLowerCase()) return sample[keys[i]];
    }
    return undefined;
}

/**
 * Build a payload for a direct Start/Stop setter or method, guided by `typeDef`, any live `sample` struct,
 * and optional `opts` (`{ mode: 'auto_1cr' | 'auto_res_phev' | 'vent_only', clientGroupId, durationMin }`).
 */
function buildDirectPayload(meta, wantOn, sample, numericEnum, opts) {
    opts = opts || {};
    const mode = opts.mode || 'auto_1cr';
    const fnameSelf = (meta && meta.name) || '';
    const td = meta && meta.typeDef;
    if (/clientGroupId/i.test(fnameSelf)) {
        return opts.clientGroupId !== undefined ? opts.clientGroupId : 0;
    }
    if (/^timeParking|duration/i.test(fnameSelf)) {
        return wantOn ? (opts.durationMin || 15) : 0;
    }
    if (td && td.kind === 'struct' && Array.isArray(td.fields) && td.fields.length) {
        const out = {};
        const hasParkAc = td.fields.some((x) => x && /parkAirCond|standklima|precond/i.test(x.name || ''));
        const hasAutoMode = td.fields.some((x) => x && /autoMode|automatik/i.test(x.name || ''));
        const isLiveEin = (v) => typeof v === 'string' && ENUM_ON_TOKEN_RE.test(v) && !ENUM_OFF_TOKEN_RE.test(v) && !ENUM_INVALID_RE.test(v);
        const anySampleActive = !wantOn && td.fields.some((x) => {
            if (!x || !x.name || /remoteStart|motorstart|res$/i.test(x.name)) return false;
            return isLiveEin(lookupSampleField(sample, x.name));
        });
        td.fields.forEach((f) => {
            if (!f || !f.name) return;
            const cur = lookupSampleField(sample, f.name);
            if (/clientGroupId/i.test(f.name)) {
                out[f.name] = opts.clientGroupId !== undefined ? opts.clientGroupId : 0;
            } else if (/^timeParking|duration/i.test(f.name)) {
                out[f.name] = opts.durationMin !== undefined ? opts.durationMin : (wantOn ? 15 : 0);
            } else if (/zone|id|index|slot|seat/i.test(f.name)) {
                out[f.name] = cur !== undefined ? cur : (f.typeDef && f.typeDef.kind === 'enum' && f.typeDef.values[0] ? (numericEnum ? 0 : f.typeDef.values[0]) : 0);
            } else if (/parkHeat|heater|standheiz|zuheiz|extraHeat|blower|geblaese/i.test(f.name)) {
                out[f.name] = (!wantOn && isLiveEin(cur)) ? pickEnumOrBool(f.typeDef, false, cur, numericEnum) : pickNoActionOrOff(f.typeDef, cur, numericEnum);
            } else if (/remoteStart|motorstart|res$/i.test(f.name)) {
                if (!wantOn) {
                    out[f.name] = pickConsentKeepOrOn(f.typeDef, false, cur, numericEnum);
                } else if (mode === 'vent_only') {
                    out[f.name] = pickConsentKeepOrOn(f.typeDef, false, cur, numericEnum);
                } else if (mode === 'auto_1cr' && hasAutoMode && isLiveEin(cur)) {
                    // Consent is already active in iDrive (`REMOTE_ENGINE_START_EIN`); send clean NO_ACTION on settings bit in pure AutoMode command
                    out[f.name] = pickConsentKeepOrOn(f.typeDef, false, cur, numericEnum);
                } else {
                    out[f.name] = pickEnumOrBool(f.typeDef, true, cur, numericEnum);
                }
            } else if (/autoMode|automatik/i.test(f.name)) {
                if (!wantOn) out[f.name] = (!anySampleActive || isLiveEin(cur)) ? pickEnumOrBool(f.typeDef, false, cur, numericEnum) : pickNoActionOrOff(f.typeDef, cur, numericEnum);
                else if (mode === 'vent_only') out[f.name] = pickNoActionOrOff(f.typeDef, cur, numericEnum);
                else out[f.name] = pickEnumOrBool(f.typeDef, true, cur, numericEnum);
            } else if (/parkAirCond|standklima|precond/i.test(f.name)) {
                if (!wantOn) out[f.name] = (!anySampleActive || isLiveEin(cur)) ? pickEnumOrBool(f.typeDef, false, cur, numericEnum) : pickNoActionOrOff(f.typeDef, cur, numericEnum);
                else if (hasAutoMode && mode !== 'auto_res_phev') out[f.name] = pickNoActionOrOff(f.typeDef, cur, numericEnum);
                else out[f.name] = pickEnumOrBool(f.typeDef, true, cur, numericEnum);
            } else if (/ventilat|standlueft/i.test(f.name)) {
                if (!wantOn) out[f.name] = (!anySampleActive || isLiveEin(cur)) ? pickEnumOrBool(f.typeDef, false, cur, numericEnum) : pickNoActionOrOff(f.typeDef, cur, numericEnum);
                else if (mode === 'vent_only') out[f.name] = pickEnumOrBool(f.typeDef, true, cur, numericEnum);
                else if (hasParkAc || hasAutoMode) out[f.name] = pickNoActionOrOff(f.typeDef, cur, numericEnum);
                else out[f.name] = pickEnumOrBool(f.typeDef, true, cur, numericEnum);
            } else {
                out[f.name] = buildDirectPayload(f, wantOn, cur, numericEnum, opts);
            }
        });
        return out;
    }
    if (td && td.kind === 'union' && Array.isArray(td.branches) && td.branches.length) {
        const br = td.branches[0];
        const inner = buildDirectPayload(br, wantOn, undefined, numericEnum, opts);
        const uObj = {};
        if (br && br.name) uObj[br.name] = inner;
        return uObj;
    }
    if (td && /array/i.test(td.kind)) {
        return [wantOn ? 1 : 0];
    }
    if (sample && typeof sample === 'object' && !Array.isArray(sample)) {
        const out = {};
        const keys = Object.keys(sample);
        const hasParkAc = keys.some((k) => /parkAirCond|standklima|precond/i.test(k));
        const hasAutoMode = keys.some((k) => /autoMode|automatik/i.test(k));
        keys.forEach((k) => {
            const outKey = /^status[A-Z]/.test(k) ? ('operation' + k.slice(6)) : k;
            if (/zone|slot|id|index/i.test(k)) out[outKey] = sample[k];
            else if (/parkHeat|heater|standheiz|zuheiz|extraHeat|blower|geblaese/i.test(k)) out[outKey] = pickNoActionOrOff(null, sample[k], numericEnum);
            else if (/remoteStart|motorstart|res$/i.test(k)) out[outKey] = pickConsentKeepOrOn(null, wantOn && mode !== 'vent_only', sample[k], numericEnum);
            else if (/autoMode|automatik/i.test(k)) out[outKey] = mode === 'vent_only' ? pickNoActionOrOff(null, sample[k], numericEnum) : pickEnumOrBool(null, wantOn, sample[k], numericEnum);
            else if (/parkAirCond|standklima|precond/i.test(k)) out[outKey] = (wantOn && hasAutoMode && mode !== 'auto_res_phev') ? pickNoActionOrOff(null, sample[k], numericEnum) : pickEnumOrBool(null, wantOn, sample[k], numericEnum);
            else if (/ventilat|standlueft/i.test(k) && (hasParkAc || hasAutoMode) && wantOn && mode !== 'vent_only') out[outKey] = pickNoActionOrOff(null, sample[k], numericEnum);
            else out[outKey] = pickEnumOrBool(null, wantOn, sample[k], numericEnum);
        });
        return out;
    }
    return pickEnumOrBool(td, wantOn, sample, numericEnum);
}

/**
 * Evaluate ground-truth 1CR / Park Climate state from live SOME/IP status structs (`LSCDataSink`, `Climate2`, `ClimateMaster`).
 * Never guesses `active: true` unless an actual BMW ECU status field confirms activation.
 */
function evaluate1crVerdict(liveMap, telState) {
    const lv = liveMap || {};
    const tel = telState || {};
    const lscPf = lv['de.bmw.infotainment.lsc.LSCDataSink.statusAirConditioningParkFunctions'] || {};
    const c2Pf = lv['de.bmw.infotainment.climate.Climate2.statusAirConditionParkFunctions'] || {};
    const cmPf = lv['de.bmw.infotainment.climate.climatemaster.ClimateMaster.statusParkingFunctionsOn'] || {};
    const cmRes = lv['de.bmw.infotainment.climate.climatemaster.ClimateMaster.parkingFunctionsRES'] || {};
    const dwa = lv['de.bmw.infotainment.lsc.LSCDataSink.dWAStatus'] || {};

    const isEin = (v) => {
        if (v === true || v === 2) return true;
        if (typeof v === 'string') return ENUM_ON_TOKEN_RE.test(v) && !ENUM_OFF_TOKEN_RE.test(v) && !ENUM_INVALID_RE.test(v);
        return false;
    };

    const engRunRaw = String(lscPf.statusEngineRunParkFunction !== undefined ? lscPf.statusEngineRunParkFunction : '');
    const rcStatus = String(lscPf.statusParkFunctionRemoteControl !== undefined ? lscPf.statusParkFunctionRemoteControl : '');
    const autoModeActive = isEin(c2Pf.statusParkFunctionAutoMode) || isEin(lscPf.statusParkFunctionAutoMode) ||
        rcStatus === 'KEIN_FEHLER_AUTOMODE_AKTIV' || lscPf.statusParkFunctionRemoteControl === 8 ||
        cmPf.parkingFunctionsAutoMode === 'AUTO_MODE_ON' || cmPf.parkingFunctionsAutoMode === 2;
    const parkAcActive = isEin(c2Pf.statusParkAirConditioning) || isEin(lscPf.statusParkAirConditioning);
    const ventActive = isEin(c2Pf.statusIndependentVentilate) || isEin(lscPf.statusIndependentVentilate) || isEin(c2Pf.statusBlower);
    const heaterActive = isEin(c2Pf.statusParkHeater) || isEin(lscPf.statusParkHeater);
    // Ground-truth ONLY: NEVER use `tel.condition === 3` (`STANDFUNKTIONEN`), which stays 3 even when engine is OFF or after climate stops!
    const engineRemoteActive = engRunRaw === 'REMOTE_START_AKTIV' || lscPf.statusEngineRunParkFunction === 2 ||
        ((autoModeActive || parkAcActive) && typeof tel.rpm === 'number' && tel.rpm >= 450);
    const duration = typeof lscPf.actualValueDurationParkFunction === 'number' && lscPf.actualValueDurationParkFunction < 250
        ? lscPf.actualValueDurationParkFunction : 0;

    let consentEnabled = null;
    const resVal = c2Pf.statusSetupRemoteStart !== undefined ? c2Pf.statusSetupRemoteStart : lscPf.statusSetupRemoteStart;
    if (resVal !== undefined && resVal !== null) {
        if (isEin(resVal)) consentEnabled = true;
        else if (resVal === 1 || ENUM_OFF_TOKEN_RE.test(String(resVal))) consentEnabled = false;
    } else if (typeof cmRes.remoteEngineStartEnabled === 'boolean') {
        consentEnabled = cmRes.remoteEngineStartEnabled;
    }

    // Also inspect any other custom direct_read status field in liveMap (for non-G30 I-Steps)
    let customActive = false;
    Object.keys(lv).forEach((k) => {
        if (/directOperationPark|statusPreconditioningParkAirConditioning/i.test(k)) {
            const sv = lv[k];
            if (typeof sv === 'string' && isEin(sv)) customActive = true;
            else if (sv && typeof sv === 'object') {
                Object.keys(sv).forEach((sk) => { if (isEin(sv[sk])) customActive = true; });
            }
        }
    });

    const active = !!(engineRemoteActive || autoModeActive || parkAcActive || ventActive || heaterActive || customActive);
    let mode = 'off';
    if (engineRemoteActive) mode = 'engine_1cr';
    else if (autoModeActive || parkAcActive || heaterActive || customActive) mode = 'auto_precond';
    else if (ventActive) mode = 'vent_only';

    const dwaDisarmed = dwa.statusDWAArming === 'DWA_ENTSCHAERFT';
    const hasRejectionCode = /^(BEDINGUNGEN_FAHRZEUG_NICHT_ERFUELLT|TANKRESERVE|BATTERIE|SPERRE_NACHLAUFZEIT|HEIZGERAETESTOERUNG|KOMPONENTENFEHLER)$/.test(rcStatus);

    return {
        active,
        mode,
        engineRemoteActive,
        autoModeActive,
        parkAcActive,
        ventActive,
        heaterActive,
        duration,
        consentEnabled,
        remoteControlStatus: rcStatus,
        hasRejectionCode,
        dwaDisarmed,
    };
}

function explain1crError(verdict, telState) {
    const v = verdict || {};
    const t = telState || {};
    const rc = String(v.remoteControlStatus || '');
    if (rc === 'TANKRESERVE') {
        return 'Xe đang báo mức xăng dự trữ (TANKRESERVE) — BMW tự khoá đề nổ từ xa 1CR khi ít xăng.';
    }
    if (rc === 'BATTERIE') {
        return 'Điện áp ắc quy 12V thấp (BATTERIE) — BMW tạm khoá 1CR để giữ điện đề máy.';
    }
    if (rc === 'SPERRE_NACHLAUFZEIT') {
        return 'Đã chạy tối đa 2 chu kỳ đề nổ 1CR liên tiếp (SPERRE_NACHLAUFZEIT) — hãy bấm nổ máy trong xe 1 lần để reset.';
    }
    if (rc === 'HEIZGERAETESTOERUNG' || rc === 'KOMPONENTENFEHLER') {
        return 'Hộp điều hoà IHKA báo lỗi phần cứng (' + rc + ').';
    }
    if (rc === 'BEDINGUNGEN_FAHRZEUG_NICHT_ERFUELLT') {
        return 'Hộp BDC từ chối nổ máy (BEDINGUNGEN_FAHRZEUG_NICHT_ERFUELLT): hãy đóng kín 4 cửa/capo/cốp, cần số P, mang chìa ra ngoài và bấm KHOÁ XE trước!';
    }
    if (t.engineRunning) {
        return 'Động cơ đang nổ máy sẵn — để dùng đề nổ từ xa 1CR hãy tắt máy, ra ngoài và bấm Khoá xe.';
    }
    if ((t.doorsOpen && t.doorsOpen.length) || t.trunkOpen || t.hoodOpen) {
        return 'Cửa / cốp / nắp capo đang mở — BMW yêu cầu đóng kín và bấm Khoá xe từ bên ngoài mới cho kích 1CR.';
    }
    if (t.locked === false || v.dwaDisarmed) {
        return 'Xe chưa khoá từ bên ngoài (đang ngồi trong xe / mở khoá) nên hộp IHKA/BDC giữ trạng thái AUS. Hãy tắt điện, ra ngoài đóng cửa & bấm KHOÁ XE rồi thử lại!';
    }
    return 'Hộp IHKA/BDC giữ trạng thái AUS (chưa kích hoạt). Hãy chắc chắn xe đã khoá từ bên ngoài (chìa ở ngoài xe) và đã có FSC 1CR trong DME/BDC.';
}

function explainVentError(verdict, telState) {
    const v = verdict || {};
    const t = telState || {};
    if (t.engineRunning) {
        return 'Xe đang nổ máy sẵn — điều hoà chính đang chạy trực tiếp (Thông gió đỗ xe chỉ dùng khi đã tắt máy).';
    }
    const rc = String(v.remoteControlStatus || '');
    if (rc === 'BATTERIE') {
        return 'Điện áp ắc quy 12V thấp (BATTERIE) — BMW tạm ngắt quạt thông gió đỗ xe để giữ điện đề máy.';
    }
    if (v.consentEnabled === true && (t.locked === true || !v.dwaDisarmed)) {
        return 'Trên xe có Option 1CR đang tích chọn "Khởi động máy từ xa": khi xe đã khoá ngoài, BMW gộp làm mát vào nút "Đề nổ 1CR" (nổ máy chạy lốc lạnh); quạt gió tươi không nổ máy chỉ bật khi ngồi trong xe tắt máy ("Khởi động ngay").';
    }
    return 'Hộp điều hoà IHKA giữ trạng thái tắt (AUS) — hãy kiểm tra xe đã tắt máy hoàn toàn và bình 12V đủ điện.';
}

/**
 * Build prioritized, non-destructive candidate calls for `start1cr` / `stop1cr` across SP15 (`Climate2`) & SP18 (`ClimateMaster`).
 */
function build1crOrderedCandidates(climateCatalog, liveMap, wantOn, opts) {
    opts = opts || {};
    const onlyVent = !!opts.ventOnly;
    const ifs = (climateCatalog && climateCatalog.interfaces) || [];
    const lv = liveMap || {};
    const out = [];
    const consent = [];

    const sampleFor = (iface, fname) => {
        if (lv[iface + '.' + fname] !== undefined) return lv[iface + '.' + fname];
        const bare = String(fname || '').replace(/^(operation|control|request|set)/i, '');
        if (bare && lv[iface + '.status' + bare[0].toUpperCase() + bare.slice(1)] !== undefined) {
            return lv[iface + '.status' + bare[0].toUpperCase() + bare.slice(1)];
        }
        return undefined;
    };

    const ifaceHasLive = (iface) => {
        const p = iface + '.';
        return Object.keys(lv).some((k) => k.indexOf(p) === 0);
    };

    // Sort live interfaces first (e.g. Climate2 on SP15 G30, ClimateMaster on SP18 G20/G05)
    const sorted = ifs.slice().sort((a, b) => (ifaceHasLive(b.iface) ? 1 : 0) - (ifaceHasLive(a.iface) ? 1 : 0));

    // Consent candidates (only if Remote Engine Start checkbox was unchecked)
    if (wantOn) {
        sorted.forEach((d) => {
            (d.fields || []).forEach((f) => {
                if (f.setter && f.roles.indexOf('consent_write') >= 0) {
                    const sm = sampleFor(d.iface, f.name);
                    consent.push({
                        iface: d.iface, kind: 'setter', name: f.name, stage: 'consent',
                        payload: buildDirectPayload(f, true, sm, false),
                        altPayload: buildDirectPayload(f, true, sm, true),
                    });
                }
            });
            (d.methods || []).forEach((m) => {
                if (m.roles.indexOf('consent_write') >= 0 && m.inArgs && m.inArgs.length) {
                    const mk = (num) => {
                        const o = {};
                        m.inArgs.forEach((a) => { if (a && a.name) o[a.name] = buildDirectPayload(a, true, undefined, num, { clientGroupId: 0 }); });
                        return o;
                    };
                    consent.push({
                        iface: d.iface, kind: 'method', name: m.name, stage: 'consent',
                        payload: mk(false), altPayload: mk(true),
                    });
                }
            });
        });
    }

    const livePrimary = [];
    const secondary = [];
    const ventFallbacks = [];
    const availRes = lv['de.bmw.infotainment.climate.climatemaster.ClimateMaster.statusAvailableParkingFunctionsRES'];
    const prefGid = (availRes && typeof availRes.priorityClientID === 'number') ? availRes.priorityClientID : 1;

    sorted.forEach((d) => {
        const isLive = ifaceHasLive(d.iface);
        const bucket = isLive ? livePrimary : secondary;

        (d.fields || []).forEach((f) => {
            if (!f.setter || f.roles.indexOf('direct_write') < 0) return;
            const sm = sampleFor(d.iface, f.name);
            const td = f.typeDef;
            const hasAuto = td && td.kind === 'struct' && Array.isArray(td.fields) && td.fields.some((x) => x && /autoMode|automatik/i.test(x.name || ''));
            const hasVent = td && td.kind === 'struct' && Array.isArray(td.fields) && td.fields.some((x) => x && /ventilat|standlueft/i.test(x.name || ''));

            if (!wantOn) {
                bucket.push({
                    iface: d.iface, kind: 'setter', name: f.name, stage: 'stop',
                    hasLiveProvider: isLive,
                    payload: buildDirectPayload(f, false, sm, false),
                    altPayload: buildDirectPayload(f, false, sm, true),
                });
                return;
            }

            if (onlyVent) {
                if (hasVent) {
                    bucket.push({
                        iface: d.iface, kind: 'setter', name: f.name, stage: 'vent_only',
                        hasLiveProvider: isLive,
                        payload: buildDirectPayload(f, true, sm, false, { mode: 'vent_only' }),
                        altPayload: buildDirectPayload(f, true, sm, true, { mode: 'vent_only' }),
                    });
                }
                if (hasAuto && opts.allowUnlockedAutoVent) {
                    bucket.push({
                        iface: d.iface, kind: 'setter', name: f.name, stage: 'vent_cabin_auto',
                        hasLiveProvider: isLive,
                        payload: buildDirectPayload(f, true, sm, false, { mode: 'auto_1cr' }),
                        altPayload: buildDirectPayload(f, true, sm, true, { mode: 'auto_1cr' }),
                    });
                }
                return;
            }

            // Stage 1: Clean single-flag AutoMode ON (exact BMW iDrive / RCN 1CR trigger)
            const p1 = buildDirectPayload(f, true, sm, false, { mode: 'auto_1cr' });
            bucket.push({
                iface: d.iface, kind: 'setter', name: f.name, stage: 'auto_1cr',
                hasLiveProvider: isLive,
                payload: p1,
                altPayload: buildDirectPayload(f, true, sm, true, { mode: 'auto_1cr' }),
            });

            // Stage 2: Combined AutoMode ON + RemoteStart EIN + ParkAC EIN (covers explicit consent + PHEV 530e/330e)
            if (hasAuto) {
                const p2 = buildDirectPayload(f, true, sm, false, { mode: 'auto_res_phev' });
                if (JSON.stringify(p2) !== JSON.stringify(p1)) {
                    bucket.push({
                        iface: d.iface, kind: 'setter', name: f.name, stage: 'auto_res_phev',
                        hasLiveProvider: isLive,
                        payload: p2,
                        altPayload: buildDirectPayload(f, true, sm, true, { mode: 'auto_res_phev' }),
                    });
                }
            }
        });

        (d.methods || []).forEach((m) => {
            if (onlyVent || m.roles.indexOf('direct_write') < 0) return;
            const dur = wantOn ? 15 : 0;
            const mk = (num) => {
                const o = {};
                (m.inArgs || []).forEach((a) => {
                    if (a && a.name) o[a.name] = buildDirectPayload(a, wantOn, undefined, num, { clientGroupId: prefGid, durationMin: dur });
                });
                return o;
            };
            bucket.push({
                iface: d.iface, kind: 'method', name: m.name,
                stage: wantOn ? 'climatemaster' : 'stop',
                hasLiveProvider: isLive,
                payload: mk(false),
                altPayload: mk(true),
            });
        });
    });

    return { consentCandidates: consent, candidates: livePrimary.concat(secondary) };
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
            windowDetails: { fl: null, fr: null, rl: null, rr: null, sunroof: null },
            tires: {
                fl: null, fr: null, rl: null, rr: null,
                targetFl: null, targetFr: null, targetRl: null, targetRr: null,
                tempFl: null, tempFr: null, tempRl: null, tempRr: null,
                updatedAt: 0,
            },
            locked: null,
            dwaArmed: null,
            dwaAlarmActive: false,
            dwaAlarmReason: '',
            trunkOpen: false,
            hoodOpen: false,
            checkControl: [],
            cbsList: [],
            pos: null,
            health: null,
            climate1cr: {
                consentEnabled: null,
                active: false,
                mode: 'off',
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
        const prevDwaAlarm = !!s.dwaAlarmActive;

        Object.keys(patch || {}).forEach((k) => {
            if (patch[k] !== undefined && patch[k] !== null) s[k] = patch[k];
        });
        if (!prevDwaAlarm && s.dwaAlarmActive) {
            events.push({ type: 'dwa_alarm', reason: s.dwaAlarmReason || 'DWA_ALARM' });
        }
        if (patch && patch.condition !== undefined && patch.condition !== null) {
            s.conditionLabel = CONDITION_LABELS[patch.condition] || ('Trạng thái ' + patch.condition);
        }
        s.engineRunning = (typeof s.rpm === 'number' && s.rpm >= 400) || s.condition === 10;
        s.updatedAt = now;

        // Stationary 1CR Remote Engine Start (`climate1cr.active`, speed < 2, stage === 'P', condition !== 10) must NOT create a fake 0 km trip or fire `parked` when 1CR finishes!
        const isStationary1cr = !!(s.climate1cr && s.climate1cr.active) && (s.speed || 0) < 2 && (!s.stage || s.stage === 'P') && s.condition !== 10;
        const movingOrRunning = (!isStationary1cr && s.engineRunning) || (typeof s.speed === 'number' && s.speed > 2);
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
            if ((s.speed || 0) > 3 || (s.stage && s.stage !== 'P') || s.condition === 10) this._wasDriving = true;
        }

        const shuttingDown = !isStationary1cr && !(s.climate1cr && s.climate1cr.active && (s.speed || 0) < 2) && (
            (prevCond === 10 && s.condition != null && s.condition !== 10 && s.condition !== 8) ||
            (prevEngine && !s.engineRunning && (s.speed || 0) < 1 && s.stage === 'P')
        );

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

function decodeWireVal(val, sc) {
    if (val === null || val === undefined || !sc || typeof sc !== 'object') return val;
    const tp = String(sc.t || '');
    if (/^enum$/i.test(tp) && sc.e && typeof sc.e === 'object' && typeof val === 'number') {
        const names = Object.keys(sc.e);
        for (let i = 0; i < names.length; i++) {
            if (sc.e[names[i]] === val) return names[i];
        }
        return val;
    }
    if (/^array$/i.test(tp) && sc.e && Array.isArray(val)) {
        return val.map((item) => decodeWireVal(item, sc.e));
    }
    if (/^struct$/i.test(tp) && Array.isArray(sc.e) && typeof val === 'object' && !Array.isArray(val)) {
        const out = {};
        const keys = Object.keys(val);
        for (let i = 0; i < keys.length; i++) {
            const k = keys[i];
            let fSc = null;
            for (let j = 0; j < sc.e.length; j++) {
                if (sc.e[j] && (sc.e[j].n === k || sc.e[j].name === k)) { fSc = sc.e[j]; break; }
            }
            out[k] = fSc ? decodeWireVal(val[k], fSc) : val[k];
        }
        return out;
    }
    return val;
}

async function runWorker() {
    const emit = (msg) => {
        try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) {}
    };

    const tracker = new TelemetryTracker();
    const ccTracker = new CheckControlTracker();
    const carUnits = { press: null, temp: null };
    const climateLive = {};        // "iface.field" -> latest value
    const bodyLive = {};           // "iface.field" -> latest body/closure value
    const bodyPollers = [];        // [() => void] re-read on refresh_vitals
    const fastSecurityPollers = []; // [() => void] 4.5s poll for DWA / CentralLock responsiveness
    const climateProxies = {};     // iface -> { list: [{ inst, proxy, available }], desc, cfgSummary }
    const remoteBodyProxies = {};  // iface -> { list: [{ inst, proxy, available }], desc }
    let climateCatalog = { interfaces: [] };
    let remoteBodyCatalog = { interfaces: [] };
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
        const buildCfg = (am, ml, bl) => {
            const spec = { instances: '*' };
            if (am && Object.keys(am).length) spec.attributes = am;
            if (ml && ml.length) spec.methods = ml;
            if (bl && bl.length) spec.broadcasts = bl;
            const proxies = {};
            proxies[ifaceName] = spec;
            const generated = gen.generate(db, { proxies, services: {} });
            return generated && generated[ifaceName];
        };
        let cfg = null;
        try {
            cfg = buildCfg(attrMap, methods, broadcasts);
        } catch (e) {
            // One ungeneratable field/method must never spoil the rest of the interface (as seen on G30 Vehicle/ADAS)
            const cleanAttrs = {};
            Object.keys(attrMap || {}).forEach((fn) => {
                const want = attrMap[fn];
                const tries = want === 'rs' ? ['rs', 's', 'r'] : [want];
                for (let ti = 0; ti < tries.length; ti++) {
                    try {
                        const sub = {};
                        sub[fn] = tries[ti];
                        if (buildCfg(sub, [], [])) { cleanAttrs[fn] = tries[ti]; break; }
                    } catch (e2) {}
                }
            });
            const cleanMethods = (methods || []).filter((mn) => {
                try { return !!buildCfg({}, [mn], []); } catch (e3) { return false; }
            });
            const cleanBroadcasts = (broadcasts || []).filter((bn) => {
                try { return !!buildCfg({}, [], [bn]); } catch (e4) { return false; }
            });
            if (Object.keys(cleanAttrs).length || cleanMethods.length || cleanBroadcasts.length) {
                try { cfg = buildCfg(cleanAttrs, cleanMethods, cleanBroadcasts); } catch (e5) { cfg = null; }
            }
        }
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
        evs.forEach((e) => emit({ ev: e.type, trip: e.trip, reason: e.reason, state: tracker.state }));
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
        const kombiCcPollers = [];
        let carTzMin = null;
        const coreMap = {
            'de.bmw.infotainment.vehicle.CDS': {
                fields: ['statusEngineSpeed2', 'statusEngineTemperature', 'statusEngineStatus'],
                onField: (f, v) => {
                    if (!v) return;
                    if (f === 'statusEngineSpeed2' && v.actualValueRPMEngineCrankshaft !== undefined && v.actualValueRPMEngineCrankshaft !== 65535) {
                        const rpm = v.actualValueRPMEngineCrankshaft * 0.25;
                        pushPatch({ rpm: rpm < 400 ? 0 : Math.round(rpm) });
                    } else if (f === 'statusEngineStatus' && v.statusEngineRunDrive !== undefined) {
                        const st = v.statusEngineRunDrive;
                        if ((st === 'MOTOR_AUS' || st === 0) && (tracker.state.rpm || 0) >= 400) {
                            pushPatch({ rpm: 0 });
                        }
                    } else if (f === 'statusEngineTemperature') {
                        const patch = {};
                        if (v.temperatureEngineDrive !== undefined && v.temperatureEngineDrive < 250 && v.temperatureEngineDrive !== 48) {
                            patch.coolantC = v.temperatureEngineDrive - 48;
                        }
                        if (v.temperatureEngineOilDrive !== undefined && v.temperatureEngineOilDrive < 250 && v.temperatureEngineOilDrive !== 48) {
                            patch.oilC = v.temperatureEngineOilDrive - 48;
                        }
                        if (Object.keys(patch).length) pushPatch(patch);
                    }
                },
            },
            'de.bmw.infotainment.KombiIF': {
                fields: ['statusRangeTankStatus', 'statusTimeDate', 'statusShowTimeDate'],
                onField: (f, v) => {
                    if (!v || typeof v !== 'object') return;
                    if (f === 'statusRangeTankStatus') {
                        const patch = {};
                        const odo = Number(v.mileageKilometre);
                        const rng = Number(v.range);
                        const tankL = Number(v.fluidLevelFuelTank);
                        if (isFinite(odo) && odo > 0 && odo < 16777215) patch.odometerKm = Math.round(odo);
                        if (isFinite(rng) && rng >= 5 && rng < 4095) { patch.rangeKm = Math.round(rng); patch.rangeEstimated = false; }
                        if (isFinite(tankL) && tankL > 0 && tankL < 250) patch.fuelLiters = +tankL.toFixed(1);
                        if (Object.keys(patch).length) pushPatch(patch);
                    } else if (f === 'statusTimeDate') {
                        const raw = Number(v.statusTimeZonesOffset);
                        if (isFinite(raw) && raw >= 0 && raw <= 104) {
                            carTzMin = (raw - 32) * 15;
                            emit({ ev: 'car_clock', tzMin: carTzMin });
                        }
                    } else if (f === 'statusShowTimeDate') {
                        const yr = Number(v.displayDateYear), mo = Number(v.displayDateMonth), dy = Number(v.displayDateDay);
                        const hr = Number(v.displayHour), mi = Number(v.displayMinute), sc = Number(v.displaySecond || 0);
                        if (yr >= 2024 && yr <= 2099 && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31 && hr >= 0 && hr <= 23 && mi >= 0 && mi <= 59) {
                            const tz = carTzMin !== null ? carTzMin : 420;
                            const utcMs = Date.UTC(yr, mo - 1, dy, hr, mi, sc) - tz * 60000;
                            emit({ ev: 'car_clock', utcMs, tzMin: carTzMin });
                        }
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
            'de.bmw.infotainment.vehicle.Vehicle': {
                fields: ['statusNewCurrentUnitsStatusExt'],
                onField: (f, v) => {
                    if (!v || typeof v !== 'object') return;
                    const pm = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' }[v.unitOfMeasurementAirPressure];
                    const tm = { 1: 'C', 2: 'F', C: 'C', F: 'F' }[v.unitOfMeasurementTemperature];
                    if (pm) carUnits.press = pm;
                    if (tm) carUnits.temp = tm;
                },
            },
            'de.bmw.infrastructure.EnvironmentalInformation': {
                fields: ['ExteriorTemperature'],
                onField: (f, v) => {
                    if (v && typeof v.temperatureExterior === 'number' && v.temperatureExterior < 250) {
                        const amb = +(v.temperatureExterior * 0.5 - 40).toFixed(1);
                        if (amb >= -45 && amb <= 60) pushPatch({ ambientC: amb });
                    }
                },
            },
            'de.bmw.infotainment.vehicle.TPMS': {
                fields: ['statusTyrePressure', 'statusTargetTyrePressure', 'statusTyreTemperature'],
                onField: (f, v) => {
                    interpretTpmsField(f, v, carUnits, pushPatch, tracker.state);
                },
            },
            'de.bmw.infotainment.checkcontrol.CheckControlMaster': {
                fields: ['basicList'],
                onField: (f, v) => {
                    ccTracker.feedBasicList(v);
                    ccTracker.applyToState(pushPatch, tracker.state);
                    if (ccTracker.hasUnresolvedActiveIds()) {
                        kombiCcPollers.forEach((fn) => { try { fn(); } catch (e) {} });
                    }
                },
            },
            'de.bmw.infotainment.KombiInterface_2': {
                fields: ['ccList', 'newCCMessage', 'cbsDataServiceList'],
                onField: (f, v) => {
                    if (f === 'cbsDataServiceList') {
                        const list = parseKombiCbsList(v);
                        if (list) pushPatch({ cbsList: list });
                    } else {
                        ccTracker.feedCcNames(v);
                        ccTracker.applyToState(pushPatch, tracker.state);
                    }
                },
            },
        };

        const BODY_SKIP_IFACE_RE = /(\.oap\.|infotainment\.(video|audio|media|tuner|navigation|map|speech|browser|personalization|dataprivacy|climate)|\.lsc\.|steeringwheel|cameraproxy|xview|tasu)/i;
        const BODY_FIELD_RE = /(?:(^|status|position|_)(tank|fuel|kraftstoff|fuellstand|range|drivingRange|displayRange|combustionRange|cruisingRange|remainingRange|residualRange|tankRange|totalRange|electricRange|reichweite|kilometerstand|odometer|totalDistance|outsideTemp|exteriorTemp|ambientTemp|window|fenster|tyrePressure|tirePressure|pressureTyre))|(door|doors|tuer|tueren|flap|flaps|klappe|klappen|centralLock|doorLock|lockState|lockStatus|statusLock|verriegel|zentralverriegel|tailgate|trunk|bootLid|heckklappe|kofferraum|gepaeckraum|bonnet|hood|motorhaube|frontklappe|haube|checkControl|parkingFunctionIncident)/i;
        const BODY_SKIP_FIELD_RE = /(ckm|keyMemory|setting|config|quittier|autoLock|verriegelnBei|dynamicRange|speedRange|scaleRange|freqRange|audio|exhaust|abgas|radiator|kuehler|jalousie|airFlap|climate|tankFlap|charge|charging|lade|mirror|spiegel|handle|griff|light|licht|heating)/i;
        const targetIfaces = {};
        Object.keys(coreMap).forEach((k) => { targetIfaces[k] = true; });
        allIfaces.forEach((k) => {
            if (BODY_SKIP_IFACE_RE.test(k)) return;
            const iv = db.interfaces && db.interfaces[k];
            const fnames = Object.keys((iv && iv.fields) || {});
            if (BODY_IFACE_RE.test(k) || fnames.some((f) => BODY_FIELD_RE.test(f) && !BODY_SKIP_FIELD_RE.test(f))) {
                targetIfaces[k] = true;
            }
        });

        const targetList = Object.keys(targetIfaces);
        for (let i = 0; i < targetList.length; i++) {
            const name = targetList[i];
            const iv = db.interfaces && db.interfaces[name];
            if (!iv || !iv.fields) continue;
            const cs = coreMap[name] || null;
            const fnames = Object.keys(iv.fields);
            const bodyWant = fnames.filter((f) => BODY_FIELD_RE.test(f) && !BODY_SKIP_FIELD_RE.test(f)).slice(0, 40);
            const coreWant = cs ? cs.fields.filter((f) => !!iv.fields[f]) : [];
            const merged = {};
            coreWant.concat(bodyWant).forEach((fname) => {
                const flg = fieldAttrFlags(iv.fields[fname]);
                merged[fname] = (flg.getter ? 'r' : '') + (flg.notifier ? 's' : '') || 's';
            });
            const mergedKeys = Object.keys(merged);
            if (!mergedKeys.length) continue;
            try {
                let opened = await openWildcardProxies(name, 3);
                if (!opened.list.length) opened = await openDynamicProxies(name, merged, [], [], 3);
                if (!opened.list.length) continue;
                const cfgFields = (opened.cfg && opened.cfg.fields) || {};
                opened.list.forEach((instItem, instIdx) => {
                    const px = instItem.proxy;
                    mergedKeys.forEach((fname) => {
                        const cf = cfgFields[fname];
                        if (opened.cfg && opened.cfg.fields && !cf) return;
                        const flg = fieldAttrFlags(iv.fields[fname]);
                        const canGet = cf && cf.getter !== undefined ? !!cf.getter : flg.getter;
                        const canSub = cf && (cf.event !== undefined || cf.notifier !== undefined) ? !!(cf.event || cf.notifier) : flg.notifier;
                        const isCore = cs && cs.fields.indexOf(fname) >= 0;
                        const isBody = bodyWant.indexOf(fname) >= 0;
                        const handler = (rawVal) => {
                            if (rawVal === undefined || rawVal === null) return;
                            const val = (cf && cf.schema) ? decodeWireVal(rawVal, cf.schema) : rawVal;
                            bodyLive[name + '.' + fname] = val;
                            if (isCore) cs.onField(fname, val);
                            if (isBody) interpretBodyField(name, fname, val, pushPatch, tracker.state);
                        };
                        if (canSub) { try { px.subscribe({ name: fname, onReceive: handler }); } catch (e) {} }
                        if (canGet) {
                            try { px.getValue(fname, 2500).then(handler).catch(() => {}); } catch (e) {}
                            if (instIdx === 0 && (isBody || /\.TPMS$|CheckControl|KombiInterface|KombiIF/i.test(name))) {
                                bodyPollers.push(() => { try { px.getValue(fname, 1600).then(handler).catch(() => {}); } catch (e) {} });
                            }
                            if (instIdx === 0 && (/^(basicList|centralLock|doorLock|lockState|lockStatus|statusLock)/i.test(fname) || /centralLock|verriegel/i.test(fname))) {
                                fastSecurityPollers.push(() => { try { px.getValue(fname, 1200).then(handler).catch(() => {}); } catch (e) {} });
                            }
                            if (instIdx === 0 && /KombiInterface_2$/i.test(name) && fname === 'ccList') {
                                kombiCcPollers.push(() => { try { px.getValue('ccList', 1500).then(handler).catch(() => {}); } catch (e) {} });
                            }
                        }
                    });
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
            if (opened.cfg) {
                enrichDescWithGeneratedCfg(db, db.interfaces && db.interfaces[desc.iface], desc, opened.cfg);
            }
            const writableDefs = {};
            if (opened.cfg) {
                (desc.fields || []).forEach((f) => {
                    if (f.setter && opened.cfg.fields && opened.cfg.fields[f.name]) {
                        writableDefs[f.name] = opened.cfg.fields[f.name];
                    }
                });
                (desc.methods || []).forEach((m) => {
                    if (m.roles.length && opened.cfg.methods && opened.cfg.methods[m.name]) {
                        writableDefs[m.name + '()'] = opened.cfg.methods[m.name];
                    }
                });
            }
            const cfgSummary = opened.cfg ? {
                instances: Object.keys(opened.cfg.instances || {}),
                fields: Object.keys(opened.cfg.fields || {}),
                methods: Object.keys(opened.cfg.methods || {}),
                writableDefs,
            } : null;
            climateProxies[desc.iface] = { list: opened.list, desc, cfgSummary, rawCfg: opened.cfg };
            opened.list.forEach((instEntry) => {
                const px = instEntry.proxy;
                desc.fields.forEach((f) => {
                    const key = desc.iface + '.' + f.name;
                    const fSc = opened.cfg && opened.cfg.fields && opened.cfg.fields[f.name] && opened.cfg.fields[f.name].schema;
                    const onVal = (rawVal) => {
                        const val = fSc ? decodeWireVal(rawVal, fSc) : rawVal;
                        climateLive[key] = val;
                        if (/\.lsc\./i.test(desc.iface)) {
                            interpretLscField(f.name, val, pushPatch, tracker.state);
                        }
                        if (f.roles.length && f.roles[0] !== 'lsc_read') {
                            interpretClimateField(desc.iface, f, val, pushPatch, tracker.state, climateLive);
                        }
                    };
                    if (f.notifier) { try { px.subscribe({ name: f.name, onReceive: onVal }); } catch (e) {} }
                    if (f.getter) {
                        try { px.getValue(f.name, 2500).then(onVal).catch(() => {}); } catch (e) {}
                        if (/\.lsc\./i.test(desc.iface) && /pressureTyre|mileageRange|^range$|dataRangeDisplay|fuelSupply|positionWindow|positionSHD|dWAStatus/i.test(f.name)) {
                            bodyPollers.push(() => { try { px.getValue(f.name, 1600).then(onVal).catch(() => {}); } catch (e) {} });
                        }
                        if (/\.lsc\./i.test(desc.iface) && /^dWAStatus$/i.test(f.name)) {
                            fastSecurityPollers.push(() => { try { px.getValue(f.name, 1200).then(onVal).catch(() => {}); } catch (e) {} });
                        }
                    }
                });
            });
        }

        // 4b. Discover optional writable Remote Body endpoints (CentralLock / LightFlash / Horn / LSCDataSource) on MGU
        remoteBodyCatalog = discoverRemoteBodyCatalog(db);
        for (let i = 0; i < remoteBodyCatalog.interfaces.length; i++) {
            const desc = remoteBodyCatalog.interfaces[i];
            let opened = { list: [], cfg: null };
            try { opened = await openWildcardProxies(desc.iface, 2); } catch (e) {}
            if (!opened.list.length) {
                const attrs = {};
                desc.fields.forEach((f) => { attrs[f.name] = (f.getter ? 'r' : '') + (f.setter ? 'w' : '') || 'w'; });
                try { opened = await openDynamicProxies(desc.iface, attrs, desc.methods.map((m) => m.name), [], 2); } catch (e2) {}
            }
            if (!opened.list.length) continue;
            if (opened.cfg) enrichDescWithGeneratedCfg(db, db.interfaces && db.interfaces[desc.iface], desc, opened.cfg);
            remoteBodyProxies[desc.iface] = { list: opened.list, desc };
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

    // Number of request bytes echoed in a positive UDS response (ISO 14229: 0x19 echoes ONLY sub-function [0], NOT statusMask [1]!)
    const UDS_ECHO_LEN = { 0x10: 1, 0x11: 1, 0x19: 1, 0x27: 1, 0x22: 2, 0x01: 1, 0x09: 1 };

    /** Send a single physical UDS/OBD read over InternalTasu with proper echo matching & busy retry. */
    async function udsQuery(ecu, sid, reqBytes, timeoutMs) {
        if (!tasuProxy) return null;
        const echoLen = UDS_ECHO_LEN[sid] !== undefined ? UDS_ECHO_LEN[sid] : reqBytes.length;
        return new Promise((resolve) => {
            let done = false, timer = null;
            const onFrame = (f) => {
                if (f.ecu !== ecu) return;
                const u = f.uds;
                if (u[0] === 0x7F && u[1] === sid && u[2] === 0x78) {
                    clearTimeout(timer);
                    timer = setTimeout(() => finish(null), 6000);
                    return;
                }
                const matchPos = u[0] === sid + 0x40 && reqBytes.slice(0, echoLen).every((b, idx) => u[idx + 1] === b);
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
            timer = setTimeout(() => finish(null), (timeoutMs || 2400) + 3500);

            const sendAttempt = (n) => {
                nativeTick(() => tasuProxy.callMethod('sendTasuRequest', {
                    sourceAddress: 0xF2, targetAddress: ecu, serviceID: sid, subroutineID: 0,
                    udsDataLength: reqBytes.length, udsData: Buffer.from(reqBytes), deadlockTime: 0,
                }, 3500)).then((r) => {
                    const v = r && typeof r === 'object' ? (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
                    const verdict = v === undefined ? 'NO_ERROR' : String(v);
                    if (/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) && n < 4 && !done) {
                        setTimeout(() => { if (!done) sendAttempt(n + 1); }, 350 * (n + 1));
                        return;
                    }
                    if (!done) {
                        clearTimeout(timer);
                        timer = setTimeout(() => finish(null), timeoutMs || 2400);
                    }
                }).catch(() => finish(null));
            };
            sendAttempt(0);
        });
    }

    /** Send a functional UDS broadcast (0xDF) to all awake ECUs at once, matching BMW ts_diagnostic_service. */
    async function udsFunctional(sid, reqBytes, idleMs, maxMs) {
        if (!tasuProxy) return {};
        const echoLen = UDS_ECHO_LEN[sid] !== undefined ? UDS_ECHO_LEN[sid] : reqBytes.length;
        const waitIdle = idleMs || 2500;
        const waitMax = maxMs || 13000;
        return new Promise((resolve) => {
            const replies = {};
            let done = false, idleTimer = null, hardTimer = null;
            const finish = () => {
                if (done) return;
                done = true;
                clearTimeout(idleTimer);
                clearTimeout(hardTimer);
                const idx = tasuListeners.indexOf(onFrame);
                if (idx >= 0) tasuListeners.splice(idx, 1);
                resolve(replies);
            };
            const kick = (ms) => {
                clearTimeout(idleTimer);
                idleTimer = setTimeout(finish, ms);
            };
            const onFrame = (f) => {
                const u = f.uds;
                if (!u || !u.length) return;
                const matchPos = u[0] === sid + 0x40 && reqBytes.slice(0, echoLen).every((b, idx) => u[idx + 1] === b);
                const matchNeg = u[0] === 0x7F && u[1] === sid;
                if (!matchPos && !matchNeg) return;
                const pending = u[0] === 0x7F && u[2] === 0x78;
                if (!pending || !replies[f.ecu]) replies[f.ecu] = u;
                kick(pending ? 8000 : waitIdle);
            };
            tasuListeners.push(onFrame);
            hardTimer = setTimeout(finish, waitMax + 6000);

            const sendAttempt = (n) => {
                nativeTick(() => tasuProxy.callMethod('sendTasuRequest', {
                    sourceAddress: 0xF2, targetAddress: 0xDF, serviceID: sid, subroutineID: 0,
                    udsDataLength: reqBytes.length, udsData: Buffer.from(reqBytes), deadlockTime: 0,
                }, 5000)).then((r) => {
                    const v = r && typeof r === 'object' ? (r.TasuErrorEnum || Object.keys(r).map((k) => r[k]).find((x) => typeof x === 'string')) : r;
                    const verdict = v === undefined ? 'NO_ERROR' : String(v);
                    if (/TEMPORARILY_NOT_ACCEPTED|BUSY/i.test(verdict) && n < 4 && !done) {
                        setTimeout(() => { if (!done) sendAttempt(n + 1); }, 800 * (n + 1));
                        return;
                    }
                    if (!/^(NO_ERROR|REQUEST_PENDING|0|1)$/i.test(verdict)) {
                        finish();
                        return;
                    }
                    clearTimeout(hardTimer);
                    hardTimer = setTimeout(finish, waitMax);
                    if (!done && !idleTimer) kick(waitIdle + 1800);
                }).catch(() => finish());
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
        if (tracker.state.oilC === null) {
            u = (await udsQuery(0x12, 0x22, [0xF4, 0x5C], 1400)) || (await udsQuery(0x12, 0x01, [0x5C], 1400));
            const idx = u && (u[0] === 0x62 ? 3 : 2);
            if (u && u.length > idx && u[idx] !== 255 && u[idx] !== 40) {
                const oil = u[idx] - 40;
                if (oil >= -35 && oil <= 165) patch.oilC = oil;
            }
        }

        if (Object.keys(patch).length) pushPatch(patch);
    }

    const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

    /** Perform fresh SOME/IP getValue reads on all live 1CR status fields and return ground-truth verdict. */
    async function refreshLive1crVerdict(extraLive) {
        if (extraLive && typeof extraLive === 'object') {
            Object.keys(extraLive).forEach((k) => {
                if (extraLive[k] !== undefined && extraLive[k] !== null) climateLive[k] = extraLive[k];
            });
        }
        const probes = [
            ['de.bmw.infotainment.lsc.LSCDataSink', 'statusAirConditioningParkFunctions'],
            ['de.bmw.infotainment.lsc.LSCDataSink', 'dWAStatus'],
            ['de.bmw.infotainment.climate.Climate2', 'statusAirConditionParkFunctions'],
            ['de.bmw.infotainment.climate.climatemaster.ClimateMaster', 'statusParkingFunctionsOn'],
        ];
        for (let i = 0; i < probes.length; i++) {
            const ifn = probes[i][0], fn = probes[i][1];
            const holder = climateProxies[ifn];
            if (!holder || !holder.list || !holder.list.length) continue;
            const hasLive = Object.keys(climateLive).some((k) => k.indexOf(ifn + '.') === 0);
            if (!hasLive && !holder.list[0].available) continue;
            try {
                const rawV = await nativeTick(() => within(holder.list[0].proxy.getValue(fn, 650), 750, fn));
                if (rawV !== undefined && rawV !== null) {
                    const fSc = holder.rawCfg && holder.rawCfg.fields && holder.rawCfg.fields[fn] && holder.rawCfg.fields[fn].schema;
                    climateLive[ifn + '.' + fn] = fSc ? decodeWireVal(rawV, fSc) : rawV;
                }
            } catch (e) {}
        }
        const verdict = evaluate1crVerdict(climateLive, tracker.state);
        tracker.state.climate1cr.active = verdict.active;
        tracker.state.climate1cr.mode = verdict.mode || 'off';
        if (verdict.consentEnabled !== null) tracker.state.climate1cr.consentEnabled = verdict.consentEnabled;
        const lscRaw = climateLive['de.bmw.infotainment.lsc.LSCDataSink.statusAirConditioningParkFunctions'] ||
            climateLive['de.bmw.infotainment.climate.climatemaster.ClimateMaster.statusParkingFunctionsOn'] ||
            climateLive['de.bmw.infotainment.climate.Climate2.statusAirConditionParkFunctions'];
        if (lscRaw) tracker.state.climate1cr.rawState = JSON.stringify(lscRaw).slice(0, 120);
        pushPatch({});
        return verdict;
    }

    /** Execute 1CR Prepare / InvokeOne / Verify / Start / Stop / Schedule or Raw Inspector test */
    async function execute1CR(action, params) {
        params = params || {};
        const trace = [];
        const savedProfile = readJsonSafe(PROFILE_PATH);

        const ifaceHasLive = (iface) => {
            const prefix = iface + '.';
            return Object.keys(climateLive).some((k) => k.indexOf(prefix) === 0);
        };

        const callOne = async (iface, kind, name, payload, customTmo) => {
            const holder = climateProxies[iface];
            if (!holder || !holder.list || !holder.list.length) throw new Error('Proxy not open: ' + iface);
            const hasLive = ifaceHasLive(iface);
            const sorted = holder.list.slice().sort((a, b) => (b.available ? 1 : 0) - (a.available ? 1 : 0));
            let lastErr = null;
            for (let i = 0; i < sorted.length; i++) {
                const inst = sorted[i];
                const tmo = customTmo || ((inst.available || hasLive) ? 2600 : 1100);
                try {
                    if (kind === 'setter') {
                        await nativeTick(() => within(inst.proxy.setValue(name, payload, tmo), tmo + 300, iface + '.' + name));
                        return { ok: true, iface, inst: inst.inst, kind, name, payload };
                    }
                    const res = await nativeTick(() => within(inst.proxy.callMethod(name, payload || {}, tmo), tmo + 300, iface + '.' + name));
                    return { ok: true, iface, inst: inst.inst, kind, name, payload, response: res };
                } catch (e) {
                    lastErr = e;
                }
            }
            throw lastErr || new Error('No instance answered for ' + iface + '.' + name);
        };

        const callWithAlt = async (iface, kind, name, payload, altPayload, customTmo) => {
            try {
                return await callOne(iface, kind, name, payload, customTmo);
            } catch (e1) {
                if (altPayload !== undefined && JSON.stringify(altPayload) !== JSON.stringify(payload)) {
                    return await callOne(iface, kind, name, altPayload, customTmo);
                }
                throw e1;
            }
        };

        const callSmart = async (iface, kind, meta, buildFn) => {
            const pStr = buildFn(false);
            const pNum = buildFn(true);
            return callWithAlt(iface, kind, meta.name, pStr, pNum);
        };

        if (action === 'prepare_1cr') {
            const wantOn = !!params.wantOn;
            const ventOnly = !!params.ventOnly;
            const roleKey = wantOn ? 'start' : 'stop';
            const verdict = await refreshLive1crVerdict(params.oapLive);
            const allowUnlockedAutoVent = !!(ventOnly && wantOn && (tracker.state.locked === false || verdict.dwaDisarmed));
            const built = build1crOrderedCandidates(climateCatalog, climateLive, wantOn, { ventOnly, allowUnlockedAutoVent });
            const rawPin = (!ventOnly && savedProfile) ? savedProfile[roleKey] : null;
            const isLegacyBadPin = wantOn && rawPin && rawPin.payload &&
                rawPin.payload.operationParkAirConditioning === 'STANDKLIMATISIERUNG_EIN' &&
                rawPin.payload.operationParkFunctionAutoMode === 'KEINE_AKTION__S__NICHT_VERFUEGBAR' &&
                rawPin.payload.operationIndependentVentilate === 'KEINE_AKTION__S__NICHT_VERFUEGBAR';
            const pinned = (rawPin && !isLegacyBadPin) ? [Object.assign({ stage: 'pinned' }, rawPin)] : [];
            return {
                ok: true,
                verdict,
                consentCandidates: ventOnly ? [] : built.consentCandidates,
                candidates: pinned.concat(built.candidates),
            };
        }

        if (action === 'verify_1cr') {
            if (params.waitMs > 0) await sleepMs(Math.min(2500, Number(params.waitMs) || 0));
            const verdict = await refreshLive1crVerdict(params.oapLive);
            if (params.lastAction) tracker.state.climate1cr.lastAction = String(params.lastAction);
            if (params.lastResult) tracker.state.climate1cr.lastResult = String(params.lastResult);
            if (params.lastAction || params.lastResult) pushPatch({});
            const isVent = !!params.ventOnly;
            return {
                ok: true,
                verdict,
                explanation: verdict.active ? '' : (isVent ? explainVentError(verdict, tracker.state) : explain1crError(verdict, tracker.state)),
            };
        }

        if (action === 'invoke_one') {
            try {
                const r = await callWithAlt(params.iface, params.kind, params.name, params.payload, params.altPayload, params.timeoutMs || 2200);
                return { ok: true, trace: [r], response: r.response || null };
            } catch (e) {
                return { ok: false, error: e.message };
            }
        }

        if (action === 'invoke_raw') {
            try {
                const r = await callOne(params.iface, params.kind, params.name, params.payload);
                await sleepMs(650);
                const verdict = await refreshLive1crVerdict();
                if (params.saveAsDefault) {
                    const cur = savedProfile || {};
                    cur[params.role || 'start'] = { iface: params.iface, kind: params.kind, name: params.name, payload: params.payload };
                    writeJsonSafe(PROFILE_PATH, cur);
                }
                emit({ ev: 'log', level: 'info', text: '1CR raw sent: ' + params.iface + '.' + params.name + ' -> active=' + verdict.active + ' (' + verdict.mode + ')' });
                return { ok: true, verified: verdict.active, verdict, trace: [r], saved: !!params.saveAsDefault };
            } catch (e) {
                emit({ ev: 'log', level: 'warn', text: '1CR raw err (' + params.iface + '.' + params.name + '): ' + e.message });
                return { ok: false, error: e.message, trace: [{ ok: false, error: e.message }] };
            }
        }

        if (action === 'start1cr' || action === 'stop1cr') {
            const wantOn = action === 'start1cr';
            const prep = await execute1CR('prepare_1cr', { wantOn });
            if (wantOn && prep.verdict.consentEnabled === false) {
                for (let ci = 0; ci < prep.consentCandidates.length; ci++) {
                    const cc = prep.consentCandidates[ci];
                    if (!climateProxies[cc.iface]) continue;
                    try { trace.push(await callWithAlt(cc.iface, cc.kind, cc.name, cc.payload, cc.altPayload, 1800)); } catch (e) {}
                }
            }
            let verifiedMethod = '';
            let finalVerdict = prep.verdict;
            for (let i = 0; i < prep.candidates.length; i++) {
                const cd = prep.candidates[i];
                if (!climateProxies[cd.iface]) continue;
                if (cd.kind === 'method' && cd.hasLiveProvider === false) continue;
                try {
                    const r = await callWithAlt(cd.iface, cd.kind, cd.name, cd.payload, cd.altPayload, 2000);
                    trace.push(r);
                    await sleepMs(750);
                    finalVerdict = await refreshLive1crVerdict();
                    if (wantOn && finalVerdict.active) {
                        verifiedMethod = cd.iface.split('.').pop() + '.' + cd.name + ' (' + cd.stage + ')';
                        break;
                    }
                    if (!wantOn && !finalVerdict.active) {
                        verifiedMethod = cd.iface.split('.').pop() + '.' + cd.name;
                    }
                } catch (e) {
                    trace.push({ ok: false, iface: cd.iface, name: cd.name, error: e.message });
                }
            }
            tracker.state.climate1cr.lastAction = wantOn ? 'Kích nổ / Làm mát 1CR' : 'Tắt làm mát 1CR';
            if ((wantOn && finalVerdict.active) || (!wantOn && !finalVerdict.active)) {
                tracker.state.climate1cr.lastResult = wantOn ? ('Đang chạy: ' + (verifiedMethod || finalVerdict.mode)) : 'Đã tắt 1CR';
                pushPatch({});
                return { ok: true, verified: true, method: verifiedMethod || finalVerdict.mode, verdict: finalVerdict, trace };
            }
            const errMsg = explain1crError(finalVerdict, tracker.state);
            tracker.state.climate1cr.lastResult = errMsg.slice(0, 90);
            pushPatch({});
            return {
                ok: false,
                verified: false,
                error: errMsg,
                verdict: finalVerdict,
                trace,
                consentCandidates: prep.consentCandidates,
                candidates: prep.candidates,
            };
        }

        if (action === 'schedule1cr') {
            const h = Number(params.hour) | 0, m = Number(params.minute) | 0, en = params.enabled !== false;
            const hhmm = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
            const timerCandidates = [];
            if (savedProfile && savedProfile.timer) {
                const p = savedProfile.timer;
                const payload = buildTimerPayload({ typeDef: null }, h, m, en, p.payload, false);
                timerCandidates.push({ iface: p.iface, kind: p.kind, name: p.name, payload });
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
                for (let k = 0; k < d.fields.length; k++) {
                    const f = d.fields[k];
                    if (!f.setter || f.roles.indexOf('timer_write') < 0) continue;
                    const sample = climateLive[d.iface + '.' + f.name];
                    timerCandidates.push({
                        iface: d.iface,
                        kind: 'setter',
                        name: f.name,
                        payload: buildTimerPayload(f, h, m, en, sample, false),
                        altPayload: buildTimerPayload(f, h, m, en, sample, true),
                    });
                    if (!climateProxies[d.iface]) continue;
                    try {
                        const r = await callSmart(d.iface, 'setter', f, (num) => buildTimerPayload(f, h, m, en, sample, num));
                        trace.push(r);
                        if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + f.name;
                    } catch (e) { trace.push({ ok: false, iface: d.iface, name: f.name, error: e.message }); }
                }
                for (let k = 0; k < d.methods.length; k++) {
                    const mt = d.methods[k];
                    if (mt.roles.indexOf('timer_write') < 0) continue;
                    const mkArgs = (num) => {
                        const argObj = {};
                        mt.inArgs.forEach((a) => {
                            if (a && a.name) argObj[a.name] = buildTimerPayload(a, h, m, en, undefined, num);
                        });
                        return argObj;
                    };
                    timerCandidates.push({
                        iface: d.iface,
                        kind: 'method',
                        name: mt.name,
                        payload: mkArgs(false),
                        altPayload: mkArgs(true),
                    });
                    if (!climateProxies[d.iface]) continue;
                    try {
                        const r = await callSmart(d.iface, 'method', mt, mkArgs);
                        trace.push(r);
                        if (!succeeded) succeeded = d.iface.split('.').pop() + '.' + mt.name + '()';
                    } catch (e) { trace.push({ ok: false, iface: d.iface, name: mt.name, error: e.message }); }
                }
            }
            if (succeeded || params.userInitiated) {
                tracker.state.climate1cr.timerText = en ? hhmm : 'Tắt';
            }
            tracker.state.climate1cr.lastAction = (en ? 'Đặt hẹn giờ 1CR ' : 'Huỷ hẹn giờ 1CR ') + hhmm;
            tracker.state.climate1cr.lastResult = en
                ? (succeeded ? ('Đã đồng bộ BDC/IHKA qua ' + succeeded) : ('Hẹn tự kích MGU lúc ' + hhmm))
                : 'Đã tắt hẹn giờ 1CR';
            pushPatch({});
            return { ok: !!succeeded, syncedBdc: !!succeeded, method: succeeded || '', trace, timerCandidates };
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

    /** Perform read-only Multi-ECU Health Scan (ISO 14229 UDS 0x19 02 0C — zero erase/write) over InternalTasu. */
    async function scanVehicleHealth() {
        await readVitalsUDS();
        bodyPollers.forEach((fn) => { try { fn(); } catch (e) {} });

        const coreTargets = [0x12, 0x18, 0x40, 0x29, 0x78, 0x60, 0x63, 0x06];
        const funcMap = tasuProxy ? await udsFunctional(0x19, [0x02, 0x0C], 1600, 9000) : {};

        // Physical fallback for any of the 8 core ECUs not yet in the 0xDF broadcast map
        if (tasuProxy) {
            for (let i = 0; i < coreTargets.length; i++) {
                const addr = coreTargets[i];
                if (funcMap[addr] && funcMap[addr][0] === 0x59) continue;
                const u = await udsQuery(addr, 0x19, [0x02, 0x0C], 1600);
                if (u) funcMap[addr] = u;
                else if (addr === 0x06 && !funcMap[0x57]) {
                    const u57 = await udsQuery(0x57, 0x19, [0x02, 0x0C], 1200);
                    if (u57) funcMap[0x57] = u57;
                }
            }
        }

        // Order: 8 core ECUs first, followed by any additional awake ECUs discovered via 0xDF
        const seenAddr = {};
        const orderedAddrs = [];
        coreTargets.forEach((a) => {
            const actualAddr = (a === 0x06 && !funcMap[0x06] && funcMap[0x57]) ? 0x57 : a;
            if (!seenAddr[actualAddr]) { seenAddr[actualAddr] = true; orderedAddrs.push(actualAddr); }
        });
        Object.keys(funcMap).map(Number).sort((a, b) => a - b).forEach((a) => {
            if (!seenAddr[a] && funcMap[a] && funcMap[a][0] === 0x59) {
                seenAddr[a] = true;
                orderedAddrs.push(a);
            }
        });

        const modules = [];
        const faults = [];
        let answered = 0;
        let activeFaultCount = 0;
        let storedFaultCount = 0;

        for (let i = 0; i < orderedAddrs.length; i++) {
            const addr = orderedAddrs[i];
            const ecuHex = (addr < 16 ? '0' : '') + addr.toString(16).toUpperCase();
            const ecuName = ECU_NAMES[addr] || ('ECU 0x' + ecuHex);
            const u = funcMap[addr];
            if (!u || u[0] !== 0x59) {
                modules.push({ ecu: ecuHex, name: ecuName, ok: null, faultCount: 0 });
                continue;
            }
            answered++;
            const parsed = parseDtcResponse(u);
            modules.push({ ecu: ecuHex, name: ecuName, ok: parsed.dtcs.length === 0, faultCount: parsed.dtcs.length });
            parsed.dtcs.forEach((d) => {
                if (d.severity === 'crit') activeFaultCount++;
                else storedFaultCount++;
                faults.push({
                    ecu: ecuHex,
                    ecuName,
                    code: d.code,
                    status: d.status,
                    severity: d.severity,
                    statusLabel: d.statusLabel,
                });
            });
        }

        const s = tracker.state;
        const bat = s.battery12v;
        const batteryStatus = bat === null ? 'unknown' : (bat < 11.85 ? 'low' : (bat < 12.2 ? 'fair' : 'good'));
        const tr = s.tires || {};
        const lowTires = [];
        [['fl', 'targetFl', 'Trước trái'], ['fr', 'targetFr', 'Trước phải'], ['rl', 'targetRl', 'Sau trái'], ['rr', 'targetRr', 'Sau phải']].forEach((pair) => {
            const actual = tr[pair[0]], tgt = tr[pair[1]] || 2.3;
            if (typeof actual === 'number' && (actual < 1.85 || actual < tgt - 0.3)) lowTires.push(pair[2]);
        });
        const openEntries = (s.doorsOpen || []).concat(s.windowsOpen || []);
        if (s.trunkOpen) openEntries.push('Cốp sau');
        if (s.hoodOpen) openEntries.push('Capo');

        const needsAttention = activeFaultCount > 0 || batteryStatus === 'low' || lowTires.length > 0;
        const report = {
            checkedAt: Date.now(),
            tasuReady: !!tasuProxy,
            ecusScanned: orderedAddrs.length,
            ecusAnswered: answered,
            activeFaultCount,
            storedFaultCount,
            faults: faults.slice(0, 24),
            modules,
            batteryStatus,
            lowTires,
            openEntries,
            overall: answered === 0 ? 'no_link' : (needsAttention ? 'attention' : 'all_good'),
        };
        pushPatch({ health: report });
        return report;
    }

    async function handleParentCmd(cmd) {
        const reqId = cmd.reqId;
        if (cmd.op === 'refresh_vitals') {
            bodyPollers.forEach((fn) => { try { fn(); } catch (e) {} });
            await readVitalsUDS();
            emit({ ev: 'reply', reqId, ok: true, state: tracker.state });
        } else if (cmd.op === 'ingest_oap_body') {
            const fMap = (cmd.params && cmd.params.fields) || {};
            Object.keys(fMap).forEach((fullKey) => {
                const val = fMap[fullKey];
                if (val === undefined || val === null) return;
                bodyLive[fullKey] = val;
                const dot = fullKey.lastIndexOf('.');
                const ifn = dot > 0 ? fullKey.slice(0, dot) : '';
                const fname = dot > 0 ? fullKey.slice(dot + 1) : fullKey;
                if (fname === 'VehicleCondition') {
                    const c = parseCondition(val && val.statusConditionVehicle !== undefined ? val.statusConditionVehicle : val);
                    if (c !== null) pushPatch({ condition: c });
                } else if (fname === 'statusNewCurrentUnitsStatusExt' && val && typeof val === 'object') {
                    const pm = { 1: 'BAR', 2: 'KPA', 3: 'PSI', BAR: 'BAR', KPA: 'KPA', PSI: 'PSI' }[val.unitOfMeasurementAirPressure];
                    const tm = { 1: 'C', 2: 'F', C: 'C', F: 'F' }[val.unitOfMeasurementTemperature];
                    if (pm) carUnits.press = pm;
                    if (tm) carUnits.temp = tm;
                } else if (fname === 'ExteriorTemperature' && val && typeof val.temperatureExterior === 'number' && val.temperatureExterior < 250) {
                    const amb = +(val.temperatureExterior * 0.5 - 40).toFixed(1);
                    if (amb >= -45 && amb <= 60) pushPatch({ ambientC: amb });
                } else if (fname === 'basicList') {
                    ccTracker.feedBasicList(val);
                    ccTracker.applyToState(pushPatch, tracker.state);
                } else if (fname === 'ccList' || fname === 'newCCMessage') {
                    ccTracker.feedCcNames(val);
                    ccTracker.applyToState(pushPatch, tracker.state);
                } else if (fname === 'cbsDataServiceList') {
                    const cbs = parseKombiCbsList(val);
                    if (cbs) pushPatch({ cbsList: cbs });
                } else if (fname === 'statusRangeTankStatus' && val && typeof val === 'object') {
                    const patch = {};
                    const odo = Number(val.mileageKilometre);
                    const rng = Number(val.range);
                    const tankL = Number(val.fluidLevelFuelTank);
                    if (isFinite(odo) && odo > 0 && odo < 16777215) patch.odometerKm = Math.round(odo);
                    if (isFinite(rng) && rng >= 5 && rng < 4095) { patch.rangeKm = Math.round(rng); patch.rangeEstimated = false; }
                    if (isFinite(tankL) && tankL > 0 && tankL < 250) patch.fuelLiters = +tankL.toFixed(1);
                    if (Object.keys(patch).length) pushPatch(patch);
                } else if (fname === 'statusTimeDate' && val && typeof val === 'object') {
                    const raw = Number(val.statusTimeZonesOffset);
                    if (isFinite(raw) && raw >= 0 && raw <= 104) {
                        carTzMin = (raw - 32) * 15;
                        emit({ ev: 'car_clock', tzMin: carTzMin });
                    }
                } else if (fname === 'statusShowTimeDate' && val && typeof val === 'object') {
                    const yr = Number(val.displayDateYear), mo = Number(val.displayDateMonth), dy = Number(val.displayDateDay);
                    const hr = Number(val.displayHour), mi = Number(val.displayMinute), sc = Number(val.displaySecond || 0);
                    if (yr >= 2024 && yr <= 2099 && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31 && hr >= 0 && hr <= 23 && mi >= 0 && mi <= 59) {
                        const tz = carTzMin !== null ? carTzMin : 420;
                        const utcMs = Date.UTC(yr, mo - 1, dy, hr, mi, sc) - tz * 60000;
                        emit({ ev: 'car_clock', utcMs, tzMin: carTzMin });
                    }
                } else if ((fname === 'currentLocation' || fname === 'rawPositionData') && val && typeof val === 'object') {
                    const c = extractCoords(val, 0);
                    if (c) {
                        const pl = fname === 'currentLocation' ? extractPlaceText(val) : { street: '', district: '', city: '' };
                        if (!(fname === 'rawPositionData' && tracker.state.pos && tracker.state.pos.source === 'nav' && (Date.now() - tracker.state.pos.at < 60000))) {
                            pushPatch({ pos: { lat: c.lat, lon: c.lon, street: pl.street, district: pl.district, city: pl.city, source: fname === 'currentLocation' ? 'nav' : 'gnss', at: Date.now() } });
                        }
                    }
                } else if (/^status(Target)?Tyre(Pressure|Temperature)$/i.test(fname)) {
                    interpretTpmsField(fname, val, carUnits, pushPatch, tracker.state);
                }
                if (/\.lsc\./i.test(ifn) || /positionWindow|positionSHD|dWAStatus|mileageRange|^range$|dataRangeDisplay|fuelSupply|pressureTyre|tyrePressure/i.test(fname)) {
                    interpretLscField(fname, val, pushPatch, tracker.state, carUnits);
                }
                interpretBodyField(ifn, fname, val, pushPatch, tracker.state);
            });
            emit({ ev: 'reply', reqId, ok: true, state: tracker.state });
        } else if (cmd.op === 'set_prefs') {
            if (cmd.params && cmd.params.hasDwa302) {
                tracker.state._sawDwaArmed = true;
            }
            emit({ ev: 'reply', reqId, ok: true, state: tracker.state });
        } else if (cmd.op === 'prepare_body_cmd') {
            const role = String((cmd.params && cmd.params.role) || '');
            fastSecurityPollers.forEach((fn) => { try { fn(); } catch (e) {} });
            const cands = buildBodyCandidates(remoteBodyCatalog, role);
            emit({
                ev: 'reply',
                reqId,
                ok: true,
                result: {
                    role,
                    beforeLocked: tracker.state.locked,
                    beforeDwaArmed: tracker.state.dwaArmed,
                    candidates: cands,
                    discoveredInterfaces: remoteBodyCatalog.interfaces.map((x) => x.iface),
                },
                state: tracker.state,
            });
        } else if (cmd.op === 'invoke_body_one') {
            const p = cmd.params || {};
            const holder = remoteBodyProxies[p.iface] || climateProxies[p.iface];
            if (!holder || !holder.list || !holder.list.length) {
                emit({ ev: 'reply', reqId, ok: false, error: 'Proxy not open: ' + p.iface });
            } else {
                try {
                    const inst = holder.list[0];
                    let resp = null;
                    if (p.kind === 'setter') {
                        await nativeTick(() => within(inst.proxy.setValue(p.name, p.payload, 2200), 2500, p.name))
                            .catch((e1) => {
                                if (p.altPayload !== undefined) return nativeTick(() => within(inst.proxy.setValue(p.name, p.altPayload, 2200), 2500, p.name));
                                throw e1;
                            });
                    } else {
                        resp = await nativeTick(() => within(inst.proxy.callMethod(p.name, p.payload || {}, 2200), 2500, p.name))
                            .catch((e1) => {
                                if (p.altPayload !== undefined) return nativeTick(() => within(inst.proxy.callMethod(p.name, p.altPayload || {}, 2200), 2500, p.name));
                                throw e1;
                            });
                    }
                    emit({ ev: 'reply', reqId, ok: true, result: { ok: true, response: resp } });
                } catch (e) {
                    emit({ ev: 'reply', reqId, ok: false, error: e.message });
                }
            }
        } else if (cmd.op === 'verify_body_cmd') {
            const waitMs = Math.min(2500, Number(cmd.params && cmd.params.waitMs) || 850);
            if (waitMs > 0) await sleepMs(waitMs);
            fastSecurityPollers.forEach((fn) => { try { fn(); } catch (e) {} });
            await refreshLive1crVerdict(cmd.params && cmd.params.oapLive);
            const dwa = climateLive['de.bmw.infotainment.lsc.LSCDataSink.dWAStatus'];
            if (dwa) interpretLscField('dWAStatus', dwa, pushPatch, tracker.state, carUnits);
            emit({
                ev: 'reply',
                reqId,
                ok: true,
                result: {
                    locked: tracker.state.locked,
                    dwaArmed: tracker.state.dwaArmed,
                },
                state: tracker.state,
            });
        } else if (cmd.op === 'send_nav_dest') {
            const p = cmd.params || {};
            const navRes = await trySendNavigationDestination(db, gen, someip, nativeTick, p.lat, p.lon, p.name, p.address);
            emit({ ev: 'reply', reqId, ok: !!navRes.ok, result: navRes, state: tracker.state });
        } else if (cmd.op === 'scan_health') {
            const report = await scanVehicleHealth();
            emit({ ev: 'reply', reqId, ok: true, result: report, state: tracker.state });
        } else if (cmd.op === 'cam_wake') {
            const r = await wakeCam360();
            emit({ ev: 'reply', reqId, ok: !!r.ok, result: r });
        } else if (cmd.op === 'cam_release') {
            const r = await releaseCam360();
            emit({ ev: 'reply', reqId, ok: true, result: r });
        } else if (cmd.op === 'start1cr' || cmd.op === 'stop1cr' || cmd.op === 'schedule1cr' || cmd.op === 'invoke_raw' || cmd.op === 'prepare_1cr' || cmd.op === 'verify_1cr' || cmd.op === 'invoke_one') {
            const res = await execute1CR(cmd.op, cmd.params);
            emit({ ev: 'reply', reqId, ok: res.ok, result: res, state: tracker.state });
        } else if (cmd.op === 'schema') {
            if (cmd.params && cmd.params.oapLive) await refreshLive1crVerdict(cmd.params.oapLive);
            const cfgMap = {};
            Object.keys(climateProxies).forEach((k) => { cfgMap[k] = climateProxies[k].cfgSummary; });
            const relatedInterfaces = Object.keys((db && db.interfaces) || {}).filter((n) =>
                !NON_CLIMATE_IFACE_RE.test(n) && /lsc|timer|zeitschalt|stand|park|remote|rcn|precon|climate|charge|teleservice|door|flap|klappe|checkcontrol|cbs/i.test(n)
            ).sort();
            emit({
                ev: 'reply',
                reqId,
                ok: true,
                schema: {
                    interfaces: climateCatalog.interfaces,
                    remoteBodyInterfaces: remoteBodyCatalog.interfaces,
                    relatedInterfaces,
                    openConfigs: cfgMap,
                    live: climateLive,
                    bodyLive,
                    pinnedProfile: readJsonSafe(PROFILE_PATH),
                },
            });
        }
    }

    emit({ ev: 'ready', discoveredClimate: climateCatalog.interfaces.length });
    emit({ ev: 'telemetry', state: tracker.state, activeTrip: null, lastTrip: null });
    // Read accurate Fuel %, 12V Voltage, Odometer & Temps once shortly after startup, and refresh non-notifying SOME/IP getters gently
    setTimeout(() => { readVitalsUDS().catch(() => {}); }, 2500);
    if (bodyPollers.length) {
        setInterval(() => {
            for (let i = 0; i < bodyPollers.length; i++) bodyPollers[i]();
        }, 15000);
    }
    if (fastSecurityPollers.length) {
        setInterval(() => {
            for (let i = 0; i < fastSecurityPollers.length; i++) fastSecurityPollers[i]();
        }, 4500);
    }
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
        else if (/^\d\dF[H-Z]$/.test(tc)) out.trueChassis = 'G20LCI';
        else if (/^(5F|5V|5U|6K)\d\d$|^\d\d(DY|DZ|FF|FG)$/.test(tc)) out.trueChassis = 'G20';
        else if (/^\d\dA[G-N]$|^\d\dB[A-H]$/.test(tc)) out.trueChassis = 'G30LCI';
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

    if (/centralLock|doorLock|lockState|lockStatus|^statusLock|zentralverriegelung|verriegelung/i.test(fname) &&
        !/ckm|keyMemory|setting|config|quittier|autoLock|verriegelnBei|available|bootLid|trunk|tailgate|tank|charge/i.test(fname)) {
        const s = JSON.stringify(val).toUpperCase();
        if (/(^|_|")(LOCKED|SECURED|VERRIEGELT|GESICHERT|ZENTRAL_VERRIEGELT|ZENTRALVERRIEGELT)(_|$|")/.test(s) && !/UNLOCKED|ENTRIEGELT/.test(s)) {
            pushPatch({ locked: true, _centralLockLocked: true });
        } else if (/(^|_|")(UNLOCKED|ENTRIEGELT)(_|$|")/.test(s) && !/LOCKED|VERRIEGELT/.test(s)) {
            const patch = { _centralLockLocked: false };
            if (!curState.dwaArmed) patch.locked = false;
            pushPatch(patch);
        }
        return;
    }

    if (/parkingFunctionIncident/i.test(fname)) {
        const s = JSON.stringify(val).toUpperCase();
        const patch = {};
        if (/ABORTED_HOOD_OPEN/.test(s)) patch.hoodOpen = true;
        if (/ABORTED_TRUNK_OPEN|PLEASE_CLOSE_TRUNK/.test(s)) patch.trunkOpen = true;
        if (/ABORTED_DOORS_OPEN/.test(s) && !(curState.doorsOpen && curState.doorsOpen.length)) patch.doorsOpen = ['Cửa xe'];
        if (Object.keys(patch).length) pushPatch(patch);
        return;
    }

    if (/tyrePressure|tirePressure|pressureTyre/i.test(fname)) {
        interpretLscField(fname, val, pushPatch, curState);
        return;
    }

    if (/door|tuer|tailgate|trunk|bootLid|heckklappe|kofferraum|gepaeckraum|bonnet|hood|motorhaube|frontklappe|haube|flap|klappe|checkControl/i.test(key) &&
        !/mirror|spiegel|light|licht|handle|griff|heating|exhaust|abgas|radiator|kuehler|jalousie|airFlap|climate|tank|charge|lade/i.test(fname)) {
        interpretClosureLeaves(key, val, pushPatch, curState);
    }
}

const CLOSURE_SKIP_KEY_RE = /exhaust|abgas|radiator|kuehler|jalousie|cooling|climate|airFlap|vent|defrost|charge|charging|lade|tank|fuel|sunroof|shd|window|fenster|mirror|spiegel|handle|griff|light|licht|heating|lock|verriegel|available|verfuegbar|coding|codier/i;
const CLOSURE_INVALID_VAL_RE = /UNGUELTIG|UNBEFUELLT|INVALID|UNKNOWN|UNAVAILABLE|NICHT_VERFUEGBAR|KEINE_ANGABE|NO_VALUE|INIT/i;
const CLOSURE_CLOSED_VAL_RE = /(^|_)(CLOSED|GESCHLOSSEN|ZU|NOT_OPEN|NICHT_OFFEN|NICHT_GEOEFFNET)(_|$)/i;
const CLOSURE_OPEN_VAL_RE = /(^|_)(OPEN|OPENED|OFFEN|GEOEFFNET|AJAR|ZWISCHENSTELLUNG|NOT_CLOSED|NICHT_GESCHLOSSEN)(_|$)/i;

function friendlyDoorLabel(pathKey) {
    if (/DRDR|driverRear|rearLeft|backLeft|HL\b|RL\b/i.test(pathKey)) return 'Cửa Sau Trái';
    if (/PSDR|passengerRear|rearRight|backRight|HR\b|RR\b/i.test(pathKey)) return 'Cửa Sau Phải';
    if (/DRD\b|driver|frontLeft|VL\b|FL\b/i.test(pathKey)) return 'Cửa Tài';
    if (/PSD\b|passenger|frontRight|VR\b|FR\b/i.test(pathKey)) return 'Cửa Phụ';
    return 'Cửa xe';
}

function interpretClosureLeaves(rootKey, val, pushPatch, curState) {
    const doorMap = Object.assign({}, curState._doorMap || {});
    let doorsTouched = false;
    let nextHood = curState.hoodOpen;
    let nextTrunk = curState.trunkOpen;

    const visit = (kPath, v, depth) => {
        if (v === null || v === undefined || depth > 5) return;
        if (typeof v === 'object') {
            if (Array.isArray(v)) {
                for (let i = 0; i < v.length; i++) visit(kPath + '[' + i + ']', v[i], depth + 1);
            } else {
                const ks = Object.keys(v);
                for (let i = 0; i < ks.length; i++) {
                    if (CLOSURE_SKIP_KEY_RE.test(ks[i])) continue;
                    visit(kPath + '.' + ks[i], v[ks[i]], depth + 1);
                }
            }
            return;
        }
        if (CLOSURE_SKIP_KEY_RE.test(kPath)) return;
        const sv = String(v).toUpperCase();
        if (CLOSURE_INVALID_VAL_RE.test(sv)) return;

        // CheckControl explicit text/enum identifiers
        if (/checkControl/i.test(kPath) && typeof v === 'string') {
            if (/FRONTKLAPPE|MOTORHAUBE|BONNET|ENGINE_HOOD|HOOD_OPEN|CA_PO|CAPO/i.test(sv)) nextHood = true;
            if (/HECKKLAPPE|BOOT_LID|TAILGATE_OPEN|TRUNK_OPEN/i.test(sv)) nextTrunk = true;
            return;
        }

        let isClosed = false, isOpen = false;
        if (typeof v === 'string') {
            isClosed = CLOSURE_CLOSED_VAL_RE.test(sv);
            isOpen = !isClosed && CLOSURE_OPEN_VAL_RE.test(sv);
        } else if (typeof v === 'boolean') {
            if (/open|offen|geoeffnet|ajar/i.test(kPath)) { isOpen = v; isClosed = !v; }
            else if (/closed|geschlossen/i.test(kPath)) { isClosed = v; isOpen = !v; }
        }
        if (!isOpen && !isClosed) return;

        if (/frontFlap|engineFlap|engineHood|motorhaube|frontklappe|bonnet|\bhood\b|hoodContact|hoodSwitch/i.test(kPath)) {
            nextHood = isOpen;
        } else if (/rearFlap|tailgate|trunk|bootLid|luggageCompartment|heckklappe|heckdeckel|kofferraum|gepaeckraum|splitDoor/i.test(kPath)) {
            nextTrunk = isOpen;
        } else if (/(door|tuer)/i.test(kPath) && !/garage/i.test(kPath)) {
            const lbl = friendlyDoorLabel(kPath);
            if (doorMap[lbl] !== isOpen) {
                doorMap[lbl] = isOpen;
                doorsTouched = true;
            }
        }
    };

    visit(rootKey, val, 0);
    const patch = {};
    if (nextHood !== curState.hoodOpen) patch.hoodOpen = nextHood;
    if (nextTrunk !== curState.trunkOpen) patch.trunkOpen = nextTrunk;
    if (doorsTouched) {
        patch._doorMap = doorMap;
        patch.doorsOpen = Object.keys(doorMap).filter((k) => doorMap[k]);
    }
    if (Object.keys(patch).length) pushPatch(patch);
}

const ECU_NAMES = {
    0x01: 'ACSM (Túi khí)',
    0x06: 'ICAM (Cam 360°)',
    0x0D: 'HKFM (Cốp điện)',
    0x10: 'BDC-GW (Cổng trung tâm)',
    0x12: 'DME (Động cơ)',
    0x18: 'EGS (Hộp số ZF)',
    0x29: 'DSC (Phanh DSC)',
    0x2C: 'USS (Cảm biến đỗ)',
    0x30: 'EPS (Thước lái)',
    0x37: 'RAM (Âm thanh)',
    0x38: 'VTG (Hộp phụ xDrive)',
    0x39: 'DSC2 (Trợ lực phanh)',
    0x40: 'BDC (Thân vỏ & Chìa)',
    0x43: 'FLM-L (Đèn pha trái)',
    0x44: 'FLM-R (Đèn pha phải)',
    0x56: 'FZD (Trần xe/DWA)',
    0x57: 'TRSVC (Cam 360°)',
    0x5D: 'KAFAS (Cam kính lái)',
    0x5E: 'GWS (Cần số)',
    0x60: 'KOMBI (Đồng hồ)',
    0x61: 'ATM (Viễn thông)',
    0x63: 'HU_MGU (Màn hình)',
    0x64: 'PDC (Đỗ xe)',
    0x67: 'ZBE (Núm iDrive)',
    0x6D: 'SM (Ghế điện)',
    0x78: 'IHKA (Điều hoà)',
};

function parseDtcResponse(uds) {
    if (!uds || uds.length < 3 || uds[0] !== 0x59 || uds[1] !== 0x02) return { ok: false, dtcs: [] };
    const hex2 = (n) => (n < 16 ? '0' : '') + (n & 0xff).toString(16).toUpperCase();
    const out = [];
    for (let i = 3; i + 4 <= uds.length; i += 4) {
        const code = hex2(uds[i]) + hex2(uds[i + 1]) + hex2(uds[i + 2]);
        if (code === '000000' || code === 'FFFFFF') continue;
        const st = uds[i + 3];
        const isActive = !!(st & 0x01) || !!(st & 0x80);
        out.push({
            code,
            status: st,
            severity: isActive ? 'crit' : 'warn',
            statusLabel: (st & 0x80) ? 'ĐÈN CẢNH BÁO' : (isActive ? 'ĐANG HIỆN HỮU' : ((st & 0x08) ? 'LƯU BỘ NHỚ' : 'CHỜ XÁC NHẬN')),
        });
    }
    return { ok: true, dtcs: out };
}

/** Scale BMW TPMS / LSCDataSink raw tire pressure value to bar (0.1 * raw in car unit: bar 0.5..6, psi 7..60, kPa 60..600; >=65532 or 255 invalid). */
function scaleTireBar(raw, pressUnit) {
    if (typeof raw !== 'number' || !isFinite(raw)) return null;
    if (raw <= 0 || raw === 255 || raw >= 65532) return null;
    if (raw >= 0.8 && raw <= 5.5 && Math.floor(raw) !== raw) return +raw.toFixed(2);
    const v = raw * 0.1;
    if (pressUnit === 'BAR') return (v >= 0.5 && v <= 6.0) ? +v.toFixed(2) : null;
    if (pressUnit === 'PSI') return (v >= 7 && v <= 90) ? +(v / 14.5038).toFixed(2) : null;
    if (pressUnit === 'KPA') return (v >= 50 && v <= 600) ? +(v / 100).toFixed(2) : null;
    if (v >= 0.5 && v <= 6.0) return +v.toFixed(2);
    if (v >= 7 && v < 60) return +(v / 14.5038).toFixed(2);
    if (v >= 60 && v <= 600) return +(v / 100).toFixed(2);
    return null;
}

function scaleTireTempC(raw, tempUnit) {
    if (typeof raw !== 'number' || !isFinite(raw) || raw === 255 || raw >= 65532 || raw < 0) return null;
    let t = raw - 40;
    if (tempUnit === 'F') t = (t - 32) * 5 / 9;
    if (t < -40 || t > 150) return null;
    return Math.round(t);
}

function interpretTpmsField(fname, val, units, pushPatch, curState) {
    if (!val || typeof val !== 'object') return;
    const u = units || {};
    if (/Temperature/i.test(fname)) {
        const curTires = Object.assign({
            fl: null, fr: null, rl: null, rr: null,
            targetFl: null, targetFr: null, targetRl: null, targetRr: null,
            tempFl: null, tempFr: null, tempRl: null, tempRr: null,
            updatedAt: 0,
        }, curState.tires || {});
        let changed = false;
        const tSlots = [
            ['actualValueTemperatureTyreFLH', 'tempFl'],
            ['actualValueTemperatureTyreFRH', 'tempFr'],
            ['actualValueTemperatureTyreRLH', 'tempRl'],
            ['actualValueTemperatureTyreRRH', 'tempRr'],
        ];
        for (let i = 0; i < tSlots.length; i++) {
            const tc = scaleTireTempC(val[tSlots[i][0]], u.temp);
            if (tc !== null && curTires[tSlots[i][1]] !== tc) {
                curTires[tSlots[i][1]] = tc;
                changed = true;
            }
        }
        if (changed) {
            curTires.updatedAt = Date.now();
            pushPatch({ tires: curTires });
        }
        return;
    }
    interpretLscField(fname, val, pushPatch, curState, u);
}

function normViCheckText(s) {
    return String(s || '')
        .normalize ? String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase()
        : String(s || '').toLowerCase();
}

/** Stateful tracker combining CheckControlMaster.basicList + KombiInterface_2.ccList / newCCMessage. */
class CheckControlTracker {
    constructor() {
        this.active = {};    // id -> { ecu, reason }
        this.names = {};     // id -> { name, color }
        this.sawList = false;
    }

    hasUnresolvedActiveIds() {
        const ids = Object.keys(this.active);
        for (let i = 0; i < ids.length; i++) {
            if (!this.names[ids[i]] || !this.names[ids[i]].name) return true;
        }
        return false;
    }

    _walk(o, fn, depth) {
        if (!o || typeof o !== 'object' || (depth || 0) > 6) return;
        if (Array.isArray(o)) {
            for (let i = 0; i < o.length; i++) this._walk(o[i], fn, (depth || 0) + 1);
            return;
        }
        fn(o);
        const ks = Object.keys(o);
        for (let i = 0; i < ks.length; i++) {
            if (o[ks[i]] && typeof o[ks[i]] === 'object') this._walk(o[ks[i]], fn, (depth || 0) + 1);
        }
    }

    feedCcNames(v) {
        this._walk(v, (o) => {
            const id = o.cCIdentifer !== undefined ? o.cCIdentifer : o.cCIdentifier;
            const nm = o.cCShortName || o.cCName;
            if (id !== undefined && nm) {
                this.names[String(id)] = {
                    name: String(nm).replace(/[\x00-\x1f\x7f]/g, '').trim(),
                    color: String(o.cCColor !== undefined ? o.cCColor : '').toUpperCase(),
                };
            }
        }, 0);
    }

    feedBasicList(v) {
        this.sawList = true;
        const isFullArray = Array.isArray(v) || (v && typeof v === 'object' && (Array.isArray(v.basicList) || Array.isArray(v.value)));
        const next = isFullArray ? {} : Object.assign({}, this.active);
        this._walk(v, (o) => {
            if (o.ccmId === undefined) return;
            const id = String(o.ccmId);
            const on = o.activeState === 'AKTIV' || o.activeState === 0 || o.activeState === true;
            if (on) next[id] = { ecu: o.requestorDiagAddr, reason: String(o.reason || '') };
            else delete next[id];
        }, 0);
        this.active = next;
    }

    applyToState(pushPatch, curState) {
        if (!this.sawList) return;
        const list = [];
        let ccHood = false;
        let ccTrunk = false;
        const ccDoors = [];
        const ids = Object.keys(this.active);
        for (let i = 0; i < ids.length; i++) {
            const id = ids[i];
            const meta = this.names[id] || {};
            const nm = meta.name || '';
            const nNorm = normViCheckText(nm);
            const col = meta.color || '';
            const sev = (col === 'RED' || col === '1') ? 'crit' : ((col === 'YELLOW' || col === 'ORANGE' || col === '2' || col === '4') ? 'warn' : 'info');
            list.push({
                id: Number(id) || id,
                name: nm || ('Check-Control #' + id),
                severity: sev,
                ecu: this.active[id].ecu,
            });
            if (nm) {
                if (/ca[- ]?po|nap may|m[o?]\s*n[a?]p\s*ca|bonnet|engine hood|\bhood\b|frontklappe|motorhaube/i.test(nNorm)) {
                    ccHood = true;
                } else if (/\bcop\b|c[o?]p\s*(sau|xe|mo)|khoang hanh ly|cua hau|cua sau mo|tailgate|boot lid|\bboot open\b|\btrunk\b|heckklappe|gepaeckraum/i.test(nNorm)) {
                    ccTrunk = true;
                } else if ((/cua.*(mo|chua dong)|mo cua|m[o?]\s*c[u?]a|c[u?]a\s*(tai|phu|truoc|sau|lai|hanh khach)|door open|front door|rear door|driver.*door|passenger.*door|tuer offen|fahrertuer|beifahrertuer/i.test(nNorm)) &&
                    !/ca[- ]?po|cop|so troi|kinh|xang|sac/i.test(nNorm)) {
                    ccDoors.push(nm);
                }
            }
        }
        const patch = { checkControl: list };
        if (ccHood) {
            patch.hoodOpen = true;
            patch._ccHood = true;
        } else if (curState._ccHood) {
            patch.hoodOpen = false;
            patch._ccHood = false;
        }
        if (ccTrunk) {
            patch.trunkOpen = true;
            patch._ccTrunk = true;
        } else if (curState._ccTrunk) {
            patch.trunkOpen = false;
            patch._ccTrunk = false;
        }
        if (ccDoors.length) {
            patch.doorsOpen = ccDoors.slice(0, 4);
            patch._ccDoors = true;
        } else if (curState._ccDoors) {
            patch.doorsOpen = Object.keys(curState._doorMap || {}).filter((k) => curState._doorMap[k]);
            patch._ccDoors = false;
        }
        pushPatch(patch);
    }
}

const CBS_FALLBACK_NAMES = {
    1: 'Dầu động cơ', 2: 'Má phanh trước', 3: 'Dầu phanh',
    6: 'Má phanh sau', 10: 'Bugi đánh lửa', 17: 'Kiểm tra xe định kỳ',
    32: 'Đăng kiểm xe', 100: 'Kiểm tra xe định kỳ',
};

function findSubKey(v, key, depth) {
    if (!v || typeof v !== 'object' || (depth || 0) > 5) return null;
    if (v[key] !== undefined) return v;
    const ks = Object.keys(v);
    for (let i = 0; i < ks.length; i++) {
        const r = findSubKey(v[ks[i]], key, (depth || 0) + 1);
        if (r) return r;
    }
    return null;
}

function parseKombiCbsList(v) {
    const arr = Array.isArray(v) ? v : (v && (v.cbsDataServiceList || v.value));
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (let i = 0; i < arr.length; i++) {
        const s = findSubKey(arr[i], 'cBSIdentifier', 0);
        if (!s || s.cBSIdentifier === undefined) continue;
        const id = Number(s.cBSIdentifier);
        const rawName = String(s.cBSServcieName || s.cBSServiceName || '').replace(/[\x00-\x1f\x7f]/g, '').trim();
        const name = (rawName && !/[?\ufffd]/.test(rawName)) ? rawName : (CBS_FALLBACK_NAMES[id] || ('Bảo dưỡng #' + id));
        const way = String(s.cBSServiceWay || '').replace(/[\x00-\x1f\x7f?]/g, '').trim();
        const date = String(s.cBSServiceDate || '').replace(/[\x00-\x1f\x7f?]/g, '').trim();
        const col = String(s.cBSColor !== undefined ? s.cBSColor : '').toUpperCase();
        const severity = (col === 'RED' || col === '1') ? 'crit' : ((col === 'YELLOW' || col === 'ORANGE' || col === '2' || col === '4') ? 'warn' : 'ok');
        out.push({ id, name, way, date, severity });
    }
    return out;
}

/** Decode BMW ConnectedDrive Last State Call (`LSCDataSink`) TPMS, 4-Window, Sunroof, DWA Alarm & KOMBI Range structs. */
function interpretLscField(fname, val, pushPatch, curState, units) {
    if (val === undefined || val === null) return;
    const pressUnit = units && units.press;

    // 1. 4-Wheel Tire Pressure (`actualValuePressureTyre`, `statusTyrePressure` & `statusTargetTyrePressure`)
    if (/PressureTyre|TyrePressure|TirePressure/i.test(fname) && typeof val === 'object') {
        const isTarget = /target/i.test(fname);
        const curTires = Object.assign({
            fl: null, fr: null, rl: null, rr: null,
            targetFl: null, targetFr: null, targetRl: null, targetRr: null,
            tempFl: null, tempFr: null, tempRl: null, tempRr: null,
            updatedAt: 0,
        }, curState.tires || {});
        let changed = false;
        const slots = [
            [/FLH|FL$|frontLeft|VL$/i, isTarget ? 'targetFl' : 'fl'],
            [/FRH|FR$|frontRight|VR$/i, isTarget ? 'targetFr' : 'fr'],
            [/RLH|RL$|rearLeft|HL$/i, isTarget ? 'targetRl' : 'rl'],
            [/RRH|RR$|rearRight|HR$/i, isTarget ? 'targetRr' : 'rr'],
        ];
        Object.keys(val).forEach((k) => {
            const bar = scaleTireBar(val[k], pressUnit);
            if (bar === null) return;
            const keyTarget = isTarget || /target/i.test(k);
            for (let i = 0; i < slots.length; i++) {
                if (slots[i][0].test(k)) {
                    const prop = keyTarget
                        ? ('target' + slots[i][1].replace(/^target/i, '').replace(/^[a-z]/, (c) => c.toUpperCase()))
                        : slots[i][1].replace(/^target/i, '').toLowerCase();
                    if (curTires[prop] !== bar) {
                        curTires[prop] = bar;
                        changed = true;
                    }
                }
            }
        });
        if (changed) {
            curTires.updatedAt = Date.now();
            pushPatch({ tires: curTires });
        }
        return;
    }

    // 2. 4 Individual Power Windows (`positionWindowRegulatorDRD/PSD/DRDR/PSDR`) & Sunroof (`positionSHD`)
    if (/^positionWindowRegulator(DRD|PSD|DRDR|PSDR)$/i.test(fname) || /^positionSHD$/i.test(fname)) {
        const wd = Object.assign({ fl: null, fr: null, rl: null, rr: null, sunroof: null }, curState.windowDetails || {});
        const s = JSON.stringify(val).toUpperCase();
        if (/^positionSHD$/i.test(fname)) {
            let sr = wd.sunroof;
            if (/SIGNAL_UNGUELTIG|SIGNAL_UNBEFUELLT|INVALID/.test(s) && !/GESCHLOSSEN|GEOEFFNET|AUSGESTELLT|CLOSED|OPEN/.test(s)) {
                sr = null;
            } else if (/GEOEFFNET|OPEN/.test(s) && !/GESCHLOSSEN|CLOSED/.test(s)) {
                sr = 'open';
            } else if (/AUSGESTELLT|HEBEDACH|TILT/.test(s)) {
                sr = 'tilted';
            } else if (/GESCHLOSSEN|CLOSED/.test(s)) {
                sr = 'closed';
            }
            if (sr !== wd.sunroof) {
                wd.sunroof = sr;
                const openList = buildOpenWindowsList(wd);
                pushPatch({ windowDetails: wd, windowsOpen: openList });
            }
            return;
        }
        const mapSlot = { DRD: 'fl', PSD: 'fr', DRDR: 'rl', PSDR: 'rr' };
        const suffix = fname.replace(/^positionWindowRegulator/i, '').toUpperCase();
        const slot = mapSlot[suffix];
        if (!slot) return;
        let st = wd[slot];
        if (/GEOEFFNET|ZWISCHENSTELLUNG|_OPEN|INTERMEDIATE/.test(s) && !/GESCHLOSSEN|CLOSED/.test(s)) st = 'open';
        else if (/GESCHLOSSEN|CLOSED/.test(s)) st = 'closed';
        if (st !== wd[slot]) {
            wd[slot] = st;
            const openList = buildOpenWindowsList(wd);
            pushPatch({ windowDetails: wd, windowsOpen: openList });
        }
        return;
    }

    // 3. DWA Anti-Theft Alarm & Central Lock Arming (`dWAStatus`)
    // Note: Cars without Option 302 DWA permanently report DWA_ENTSCHAERFT even when locked; once DWA_GESCHAERFT or IRS/NG monitoring is seen (or persisted in config.hasDwa302), DWA_ENTSCHAERFT <-> DWA_GESCHAERFT tracks unlock/lock accurately.
    if (/^dWAStatus$/i.test(fname) && typeof val === 'object') {
        const patch = {};
        const arm = String(val.statusDWAArming !== undefined ? val.statusDWAArming : '').toUpperCase();
        const irs = String(val.statu_IRSNGMonitoring !== undefined ? val.statu_IRSNGMonitoring : '').toUpperCase();
        const hasIrsActive = irs === 'IRS_UND_NG_UEBERWACHUNG_AKTIV' || irs === 'IRS_UND_NG_IN_REFERENZIERUNGSPHASE' || val.statu_IRSNGMonitoring === 1 || val.statu_IRSNGMonitoring === 2;
        if (arm === 'DWA_GESCHAERFT' || val.statusDWAArming === 1 || hasIrsActive) {
            patch._sawDwaArmed = true;
            patch.dwaArmed = true;
            patch.locked = true;
        } else if (arm === 'DWA_ENTSCHAERFT' || val.statusDWAArming === 0) {
            if (curState._sawDwaArmed) {
                patch.dwaArmed = false;
                // Only transition `locked = false` on the unlock edge (when DWA was previously armed -> disarmed)
                // so locking doors while sitting inside the cabin (where BMW keeps DWA disarmed) is never overwritten!
                if (curState.dwaArmed === true && !curState._centralLockLocked) {
                    patch.locked = false;
                }
            }
        }
        const cyc = val.statusAlarmArmingCycle;
        const cycStr = String(cyc !== undefined ? cyc : '').toUpperCase();
        const cycleRelevant = cyc === undefined || cycStr === 'RELEVANTER_ALARM' || cyc === 0;
        const rawReason = String(val.statusDWAAlarmReason !== undefined ? val.statusDWAAlarmReason : '');
        const isRealReason = !!rawReason && !/^(KEIN_ALARM|NO_ALARM|SIGNAL_UNGUELTIG|SIGNAL_UNBEFUELLT|FUNKTIONSSCHNITTSTELLE_IST_NICHT_VERFUEGBAR|FUNKTION_MELDET_FEHLER|KEINE_ANGABE|0|61|62|63|252|253|254|255)$/i.test(rawReason);
        const alarmOn = cycleRelevant && isRealReason;
        const DWA_REASON_VI = {
            MOTORHAUBE_BZW_P__FRONTKLAPPE: 'Mở nắp capo', '1': 'Mở nắp capo',
            FAHRERTUER: 'Cửa tài', '2': 'Cửa tài',
            FAHRERTUER_HINTEN: 'Cửa sau trái', '3': 'Cửa sau trái',
            BEIFAHRERTUER: 'Cửa phụ', '4': 'Cửa phụ',
            BEIFAHRERTUER_HINTEN: 'Cửa sau phải', '5': 'Cửa sau phải',
            HECKKLAPPE: 'Cốp sau', '6': 'Cốp sau',
            HECKSCHEIBE: 'Kính hậu', '7': 'Kính hậu',
            INNENRAUMSCHUTZ: 'Chuyển động cabin', '8': 'Chuyển động cabin',
            NEIGUNGSGEBER: 'Nghiêng xe / Kích bánh', '9': 'Nghiêng xe / Kích bánh',
            LEITUNGSUEBERWACHUNG: 'Cắt dây còi DWA', '10': 'Cắt dây còi DWA',
            VERSORGUNGSSPANNUNG: 'Ngắt nguồn ắc quy', '11': 'Ngắt nguồn ắc quy',
            PANIKALARM: 'Báo động khẩn cấp', '12': 'Báo động khẩn cấp',
            OBD_KOMMUNIKATIONSUEBERWACHUNG: 'Cắm cổng OBD', '14': 'Cắm cổng OBD',
        };
        patch.dwaAlarmActive = alarmOn;
        patch.dwaAlarmReason = alarmOn ? (DWA_REASON_VI[rawReason.toUpperCase()] || rawReason) : '';
        if (Object.keys(patch).length) pushPatch(patch);
        return;
    }

    // 4. Genuine KOMBI Range & Fuel Liters (`mileageRange`, `range`, `dataRangeDisplay`, `fuelSupply`)
    if (/^(mileageRange|range|dataRangeDisplay)$/i.test(fname)) {
        const n = pickNamedNum(val, /range|reichweite|combustion|display|total|remaining|distance|km|value/i, [0, 254, 255, 4094, 4095, 65534, 65535]);
        if (n !== null && n >= 5 && n <= 1600) pushPatch({ rangeKm: Math.round(n), rangeEstimated: false });
        return;
    }
    if (/^fuelSupply$/i.test(fname)) {
        const lit = pickNamedNum(val, /liter|volume|inhalt|content|fuel|supply|quantity|value/i, [0, 254, 255, 4094, 4095, 65534, 65535]);
        if (lit !== null && lit >= 1 && lit <= 115) pushPatch({ fuelLiters: +lit.toFixed(1) });
    }
}

function buildOpenWindowsList(wd) {
    const out = [];
    if (wd.fl === 'open') out.push('Kính Tài');
    if (wd.fr === 'open') out.push('Kính Phụ');
    if (wd.rl === 'open') out.push('Kính Sau Trái');
    if (wd.rr === 'open') out.push('Kính Sau Phải');
    if (wd.sunroof === 'open' || wd.sunroof === 'tilted') out.push('Cửa sổ trời');
    return out;
}

function interpretClimateField(iface, fieldDesc, val, pushPatch, curState, liveMap) {
    if (val === undefined || val === null) return;
    const s = JSON.stringify(val);
    const c1 = Object.assign({}, curState.climate1cr);

    // Check embedded 1CR setup consent inside structs such as `statusAirConditionParkFunctions.statusSetupRemoteStart`
    if (val && typeof val === 'object' && !Array.isArray(val)) {
        Object.keys(val).forEach((k) => {
            if (/remoteStart|motorstart|RES$/i.test(k) && !/Available|EngineRun/i.test(k)) {
                const sv = String(val[k]);
                if (ENUM_ON_TOKEN_RE.test(sv) && !ENUM_OFF_TOKEN_RE.test(sv)) c1.consentEnabled = true;
                else if (ENUM_OFF_TOKEN_RE.test(sv)) c1.consentEnabled = false;
            }
        });
    } else if (fieldDesc.roles.indexOf('consent_read') >= 0 || fieldDesc.roles.indexOf('consent_write') >= 0) {
        if (ENUM_ON_TOKEN_RE.test(s) && !ENUM_OFF_TOKEN_RE.test(s)) c1.consentEnabled = true;
        else if (ENUM_OFF_TOKEN_RE.test(s)) c1.consentEnabled = false;
    }

    if (fieldDesc.roles.indexOf('direct_read') >= 0 || fieldDesc.roles.indexOf('direct_write') >= 0) {
        c1.rawState = fieldDesc.name + '=' + s.slice(0, 80);
        if (liveMap && typeof liveMap === 'object') {
            const vd = evaluate1crVerdict(liveMap, curState);
            c1.active = vd.active;
            c1.mode = vd.mode || 'off';
            if (vd.consentEnabled !== null) c1.consentEnabled = vd.consentEnabled;
        } else if (val && typeof val === 'object' && !Array.isArray(val)) {
            const opKeys = Object.keys(val).filter((k) => /parkAirCond|standklima|independentVent|standlueft|parkHeat|standheiz|parkingFunctions|autoMode|EngineRunParkFunction|RemoteControl|precond|blower/i.test(k) && !/setupRemoteStart|Available/i.test(k));
            if (opKeys.length) {
                let anyOn = false;
                let anyOff = false;
                opKeys.forEach((k) => {
                    const sv = String(val[k]);
                    if ((ENUM_ON_TOKEN_RE.test(sv) || sv === 'KEIN_FEHLER_AUTOMODE_AKTIV') && !ENUM_OFF_TOKEN_RE.test(sv) && !ENUM_INVALID_RE.test(sv)) anyOn = true;
                    else if (ENUM_OFF_TOKEN_RE.test(sv)) anyOff = true;
                });
                if (anyOn) c1.active = true;
                else if (anyOff) c1.active = false;
            }
        } else {
            const sv = String(val);
            if ((ENUM_ON_TOKEN_RE.test(sv) || val === true || val === 1) && !ENUM_OFF_TOKEN_RE.test(sv) && !ENUM_INVALID_RE.test(sv)) c1.active = true;
            else if (ENUM_OFF_TOKEN_RE.test(sv) || val === false || val === 0) c1.active = false;
        }
    }
    if (fieldDesc.roles.indexOf('temp_read') >= 0 && /interior|cabin|innen/i.test(fieldDesc.name)) {
        const n = pickNamedNum(val, /temp|value/i, [204, 254, 255, 65535]);
        if (n !== null && n >= -15 && n <= 60) pushPatch({ cabinC: +n.toFixed(1) });
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

/* ---------------- Remote Body Control Discovery (Lock / Unlock / Flash Lights / Horn) ---------------- */

const BODY_CMD_SKIP_IFACE_RE = /(\.oap\.|hmi\.|audio|media|tuner|navigation|map|speech|browser|personalization|dataprivacy|climate|steeringwheel|cameraproxy|xview|nodestatemanager|lifecycle|provisioning)/i;
const BODY_CMD_SKIP_MEMBER_RE = /(ckm|keyMemory|setting|setup|config|memory|personal|autoLock|quittier|verriegelnBei|child|kinder|steering|lenk|display|screen|sim|pin|target|freq|fuel|tank|charge|lade|seat|sitz|mirror|spiegel|window|fenster|shd|ambient|interior|innen|backlight|dtc|fault|checkControl)/i;

function classifyBodyCmdMember(iface, mname) {
    if (BODY_CMD_SKIP_IFACE_RE.test(iface) || BODY_CMD_SKIP_MEMBER_RE.test(mname)) return [];
    const full = iface + '.' + mname;
    const roles = [];
    if (/(remoteUnlock|doorUnlock|unlockVehicle|unlockDoor|entriegel)/i.test(full)) {
        roles.push('unlock');
    } else if (/(remoteLock|doorLock|lockVehicle|lockDoor|centralLock|zentralverriegel|verriegel)/i.test(full)) {
        roles.push('lock');
        if (!/onlyLock/i.test(mname)) roles.push('unlock');
    }
    if (/(lightFlash|flashLight|headlightFlash|exteriorLight.*Flash|lichthupe|remoteLight|warnblink|hazardWarn|findMyCar|vehicleFinder.*light)/i.test(full)) {
        roles.push('flash_lights');
    }
    if (/(remoteHorn|hornBlow|blowHorn|hornSignal|triggerHorn|requestHorn|activateHorn|acousticLocate|signalhorn|hupe)/i.test(full)) {
        roles.push('horn');
    }
    return roles;
}

function discoverRemoteBodyCatalog(db) {
    const out = [];
    const ifs = (db && db.interfaces) || {};
    Object.keys(ifs).sort().forEach((ifn) => {
        if (BODY_CMD_SKIP_IFACE_RE.test(ifn)) return;
        const iv = ifs[ifn] || {};
        const fields = [];
        const methods = [];
        Object.keys(iv.fields || {}).forEach((fn) => {
            const fm = iv.fields[fn] || {};
            const flg = fieldAttrFlags(fm);
            if (!flg.setter) return;
            const roles = classifyBodyCmdMember(ifn, fn);
            if (!roles.length) return;
            const ftype = extractTypeRef(db, iv, fm, 0);
            fields.push({
                name: fn,
                getter: flg.getter,
                setter: true,
                notifier: flg.notifier,
                type: typeof ftype === 'string' ? ftype : null,
                typeDef: resolveTypeDef(db, iv, ftype, 0),
                roles,
            });
        });
        Object.keys(iv.methods || {}).forEach((mn) => {
            const mm = iv.methods[mn] || {};
            const roles = classifyBodyCmdMember(ifn, mn);
            if (!roles.length) return;
            methods.push({
                name: mn,
                inArgs: parseMethodInArgs(db, iv, mm),
                roles,
            });
        });
        if (fields.length || methods.length) {
            out.push({ iface: ifn, serviceId: iv.serviceId || 0, fields, methods, broadcasts: [] });
        }
    });
    return { interfaces: out };
}

function buildNavArgValue(meta, lat, lon, name, address, depth) {
    if (!meta || (depth || 0) > 5) return undefined;
    const k = String(meta.name || '');
    const td = meta.typeDef;
    const tpStr = String((meta.type || '') + ' ' + ((td && td.name) || '') + ' ' + ((td && td.kind) || ''));
    if (/lat(itude)?$/i.test(k)) {
        return /Int32|Int64/i.test(tpStr) ? Math.round(lat * 1e7) : lat;
    }
    if (/lon(gitude)?$/i.test(k)) {
        return /Int32|Int64/i.test(tpStr) ? Math.round(lon * 1e7) : lon;
    }
    if (/coordinatesValid|isValid|valid/i.test(k)) return true;
    if (/^(name|title|label|locationName|orthography|text)$/i.test(k)) return String(name || 'Điểm đến');
    if (/address|street|description/i.test(k) && (!td || td.kind === 'primitive')) return String(address || name || '');
    if (td && td.kind === 'struct' && Array.isArray(td.fields)) {
        const o = {};
        td.fields.forEach((f) => {
            if (f && f.name) {
                const sub = buildNavArgValue(f, lat, lon, name, address, (depth || 0) + 1);
                if (sub !== undefined) o[f.name] = sub;
            }
        });
        return o;
    }
    if (td && td.kind === 'enum' && Array.isArray(td.values) && td.values.length) {
        return td.values[0];
    }
    if (/bool/i.test(tpStr)) return false;
    if (/Int|UInt|Float|Double/i.test(tpStr)) return 0;
    if (/String/i.test(tpStr)) return '';
    return undefined;
}

async function trySendNavigationDestination(db, gen, someip, nativeTick, lat, lon, name, address) {
    if (!db || !gen || !someip || !validCoords(lat, lon)) {
        return { ok: false, reason: 'no_someip' };
    }
    const ifs = db.interfaces || {};
    const navMethodRe = /^(startGuidance|setDestination|addDestination|navigateTo|sendToCar|importDestination|startNavigation|requestGuidance)$/i;
    const navHintRe = /(startGuidance|setDestination|addDestination|destinationInput|sendToCar|importDestination)/i;
    const cands = [];
    Object.keys(ifs).sort().forEach((ifn) => {
        if (!/navigation/i.test(ifn) || /\.oap\./i.test(ifn)) return;
        const iv = ifs[ifn] || {};
        Object.keys(iv.methods || {}).forEach((mn) => {
            if (navMethodRe.test(mn) || navHintRe.test(mn)) {
                cands.push({ iface: ifn, iv, method: mn, mm: iv.methods[mn] });
            }
        });
    });
    if (!cands.length) {
        return { ok: false, reason: 'no_nav_method_in_catalog' };
    }
    const tried = [];
    for (let i = 0; i < cands.length && i < 6; i++) {
        const c = cands[i];
        try {
            const proxies = {};
            proxies[c.iface] = { instances: '*', methods: [c.method] };
            const generated = gen.generate(db, { proxies, services: {} });
            const cfg = generated && generated[c.iface];
            if (!cfg) continue;
            const cm = (cfg.methods && cfg.methods[c.method]) || c.mm;
            const inArgs = parseMethodInArgs(db, c.iv, cm);
            const payload = {};
            inArgs.forEach((a) => {
                if (a && a.name) {
                    const v = buildNavArgValue(a, lat, lon, name, address, 0);
                    if (v !== undefined) payload[a.name] = v;
                }
            });
            const inst = Object.keys(cfg.instances || { '1': 1 })[0] || '1';
            const px = await nativeTick(() => within(someip.buildProxy(cfg, String(inst)).then((p) => p.init().then(() => p)), 3500, c.iface));
            const resp = await nativeTick(() => within(px.callMethod(c.method, payload, 2800), 3200, c.method));
            return { ok: true, method: c.iface.split('.').pop() + '.' + c.method, response: resp || null };
        } catch (e) {
            tried.push(c.iface.split('.').pop() + '.' + c.method + ': ' + e.message);
        }
    }
    return { ok: false, reason: 'rejected', tried };
}

function pickBodyRoleEnum(td, role, numericEnum) {
    if (td && td.kind === 'enum' && Array.isArray(td.values) && td.values.length) {
        const vals = td.values.map(String).filter((v) => !ENUM_INVALID_RE.test(v));
        let re = ENUM_ON_TOKEN_RE;
        if (role === 'lock') re = /(^|_)(LOCK|SECURED|VERRIEGELN|VERRIEGELT|SCHLIESSEN|ON|EIN|ACTIVE|AKTIV|START|ACTIVATE)(_|$)/i;
        else if (role === 'unlock') re = /(^|_)(UNLOCK|ENTRIEGELN|ENTRIEGELT|OEFFNEN|OPEN|OFF|AUS|INACTIVE|INAKTIV)(_|$)/i;
        else if (role === 'flash_lights') re = /(^|_)(FLASH|BLINK|LICHTHUPE|ON|EIN|ACTIVE|AKTIV|START|ACTIVATE)(_|$)/i;
        else if (role === 'horn') re = /(^|_)(HORN|HUPE|SOUND|BLOW|ON|EIN|ACTIVE|AKTIV|START|ACTIVATE)(_|$)/i;
        const hit = vals.find((v) => re.test(v));
        if (hit !== undefined) {
            if (numericEnum && td.valueMap && td.valueMap[hit] !== undefined) return td.valueMap[hit];
            return hit;
        }
    }
    return pickEnumOrBool(td, role !== 'unlock', undefined, numericEnum);
}

function buildBodyCmdPayload(meta, role, numericEnum) {
    const td = meta && meta.typeDef;
    const nm = (meta && meta.name) || '';
    if (/clientGroupId/i.test(nm)) return 0;
    if (/duration|count|repeat|cycles/i.test(nm)) return role === 'horn' ? 1 : 2;
    if (td && td.kind === 'struct' && Array.isArray(td.fields) && td.fields.length) {
        const o = {};
        td.fields.forEach((f) => {
            if (f && f.name) o[f.name] = buildBodyCmdPayload(f, role, numericEnum);
        });
        return o;
    }
    return pickBodyRoleEnum(td, role, numericEnum);
}

function buildBodyCandidates(catalog, role) {
    const out = [];
    const ifs = (catalog && catalog.interfaces) || [];
    ifs.forEach((d) => {
        (d.fields || []).forEach((f) => {
            if (!f.setter || f.roles.indexOf(role) < 0) return;
            out.push({
                iface: d.iface, kind: 'setter', name: f.name, role,
                payload: buildBodyCmdPayload(f, role, false),
                altPayload: buildBodyCmdPayload(f, role, true),
            });
        });
        (d.methods || []).forEach((m) => {
            if (m.roles.indexOf(role) < 0) return;
            const mk = (num) => {
                const o = {};
                (m.inArgs || []).forEach((a) => { if (a && a.name) o[a.name] = buildBodyCmdPayload(a, role, num); });
                return o;
            };
            out.push({
                iface: d.iface, kind: 'method', name: m.name, role,
                payload: mk(false),
                altPayload: mk(true),
            });
        });
    });
    return out;
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
    classifyBodyCmdMember,
    discoverRemoteBodyCatalog,
    buildBodyCmdPayload,
    buildBodyCandidates,
    parseCompactSchema,
    discoverClimateCatalog,
    enrichDescWithGeneratedCfg,
    resolveTypeDef,
    pickEnumOrBool,
    pickNoActionOrOff,
    buildDirectPayload,
    build1crOrderedCandidates,
    evaluate1crVerdict,
    explain1crError,
    explainVentError,
    fieldAttrFlags,
    normViCheckText,
    buildTimerPayload,
    interpretClimateField,
    interpretBodyField,
    interpretClosureLeaves,
    interpretLscField,
    decodeWireVal,
    scaleTireBar,
    scaleTireTempC,
    interpretTpmsField,
    CheckControlTracker,
    parseKombiCbsList,
    parseDtcResponse,
    ECU_NAMES,
    decodeChassisFromVinOrFa,
    estimateRangeFromFuel,
    TelemetryTracker,
    loadIFConfigGeneratorFromText,
};
