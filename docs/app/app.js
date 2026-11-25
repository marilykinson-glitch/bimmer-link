'use strict';
/**
 * app.js - MyBMW Dark Luxury Client for iPhone Fullscreen PWA & Android Native APK (v0.6.7).
 *
 * Syncs with `tools/bimmer-link/cloud.js` using standard WebCrypto (SHA-256 + AES-GCM) over `ntfy.sh`
 * WebSocket + 12-hour cached history + instant `cmd_ack` bidirectional command feedback + BMW Factory Paint Studio.
 */
const RELAY_HOST = 'ntfy.sh';
const MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
];
let identity = null;        // { pairCode, cryptoKey, topicId, mqttTopics, topics }
let mqttWs = null;
let mqttReady = false;
let mqttBrokerIdx = 0;
let mqttPrimaryFails = 0;
let mqttLastPrimaryTry = 0;
let lastMqttRxAt = 0;
let mqttPingTimer = null;
let mqttReconnTimer = null;
let mqttWaiters = [];
let pendingAckTimers = {};
let stateWs = null;
let diagWs = null;
let vehicleData = loadLocal('mybmw_state') || null;
let latestSnap = loadLocal('mybmw_snap') || null;   // { id, dataUrl, at, rxAt, title, camMeta }
let factoryHero = loadLocal('mybmw_hero') || null;  // { dataUrl, at, title, paint }
let activeCamView = 'all';
let snapCropCache = { id: '', loadingId: '', has2x2: false, camRatioPct: 88.235, crops: {} };
let snapDecodeSeq = 0;
const CAM_VIEW_LABELS = {
  all: '4 Camera 360°',
  front: 'Cam Trước',
  rear: 'Cam Sau',
  left: 'Gương Trái',
  right: 'Gương Phải',
};
let localAppearance = loadLocal('mybmw_appearance') || { chassis: '', trimLine: '', colour: '' };
if (localAppearance && localAppearance.chassis === 'F90' && (!localAppearance.trimLine || localAppearance.trimLine === 'clubsport')) {
  localAppearance.chassis = 'F90LCI';
  saveLocal('mybmw_appearance', localAppearance);
}
let healthScanBusy = false;
let lastSchema = null;
let photoBuckets = {};
let heroBuckets = {};
let diagBuckets = {};
let arm1crUntil = 0, armUnlockUntil = 0, armHornUntil = 0;
let mapInstance = null, mapMarker = null, mapCircle = null, mapDestMarker = null;
let userGeoPos = null, mapUserMarker = null, mapWalkLine = null;
let reverseAddrCache = loadLocal('mybmw_rev_addr') || {};
let reverseAddrInFlight = {};
let tireUnit = localStorage.getItem('mybmw_tire_unit') === 'psi' ? 'psi' : 'bar';
let lastDestHits = [];

const SERIES_TITLES = {
  G20: 'BMW 3 Series', G20LCI: 'BMW 3 Series LCI', G21: 'BMW 3 Series Touring', G28: 'BMW 3 Series Li',
  G80: 'BMW M3', G81: 'BMW M3 Touring', G22: 'BMW 4 Series Coupé', G26: 'BMW 4 Series Gran Coupé', G82: 'BMW M4',
  G30: 'BMW 5 Series', G30LCI: 'BMW 5 Series LCI', G31: 'BMW 5 Series Touring', G38: 'BMW 5 Series Li',
  F90: 'BMW M5', F90LCI: 'BMW M5 LCI', G32: 'BMW 6 Series GT', G11: 'BMW 7 Series', G12: 'BMW 7 Series', G70: 'BMW 7 Series',
  G15: 'BMW 8 Series', G16: 'BMW 8 Series Gran Coupé', G01: 'BMW X3', G02: 'BMW X4', G05: 'BMW X5', G06: 'BMW X6', G07: 'BMW X7',
};
const TRIM_LABELS = {
  base: '', m_sportpaket: 'M Sport', luxury_line: 'Luxury Line', sport_line: 'Sport Line', xline: 'xLine', clubsport: 'CS',
};

const BMW_SWATCHES = [
  { id: 'alpin_white', label: 'Alpine White', hex: '#eef2f7', rgb: [232, 236, 242] },
  { id: 'mineralweiss_metallic', label: 'Mineral White', hex: '#dfe5ee', rgb: [218, 224, 234] },
  { id: 'black_sapphire_metallic', label: 'Black Sapphire', hex: '#141820', rgb: [24, 28, 36] },
  { id: 'carbonschwarz_metallic', label: 'Carbon Black', hex: '#121d33', rgb: [22, 36, 68] },
  { id: 'sophistograu_brillianteffekt_metallic', label: 'Sophisto Grey', hex: '#3a404a', rgb: [68, 74, 86] },
  { id: 'skyscraper_grey', label: 'Skyscraper Grey', hex: '#7c8490', rgb: [132, 140, 152] },
  { id: 'brooklyn_grau_metallic', label: 'Brooklyn Grey', hex: '#8c949e', rgb: [148, 156, 166] },
  { id: 'berningrau_bernsteineffekt_metallic', label: 'Bernina Grey', hex: '#66625d', rgb: [112, 106, 98] },
  { id: 'glaciersilber_metallic', label: 'Glacier Silver', hex: '#aeb6c2', rgb: [182, 190, 202] },
  { id: 'phytonicblau_metallic', label: 'Phytonic Blue', hex: '#1d569e', rgb: [30, 92, 172] },
  { id: 'portimao_blau_metallic', label: 'Portimao Blue', hex: '#1748a6', rgb: [24, 76, 182] },
  { id: 'marina_bay_blau_metallic', label: 'Marina Bay Blue', hex: '#1646b8', rgb: [24, 74, 196] },
  { id: 'tansanitblau_2_metallic', label: 'Tanzanite Blue', hex: '#132a5e', rgb: [22, 46, 104] },
  { id: 'melbournerot_metallic', label: 'Melbourne Red', hex: '#9e1b22', rgb: [176, 28, 36] },
  { id: 'aventurinrot_2_metallic', label: 'Aventurin Red', hex: '#6e121f', rgb: [122, 20, 34] },
  { id: 'toronto_rot_metallic', label: 'Toronto Red', hex: '#bd241e', rgb: [204, 38, 30] },
  { id: 'isle_of_man_green_metallic', label: 'Isle of Man Green', hex: '#116e50', rgb: [18, 120, 86] },
  { id: 'sanremo_green_metallic', label: 'Sanremo Green', hex: '#23523b', rgb: [38, 90, 64] },
];

let baseStudioImg = null;
let baseStudioLoading = false;
let heroPendingOverride = false;
let shadedCacheKey = '';
let shadedCacheUrl = '';

function loadLocal(k) {
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
}
function saveLocal(k, v) {
  const txt = JSON.stringify(v);
  try {
    localStorage.setItem(k, txt);
  } catch (e) {
    if (k === 'mybmw_snap') {
      try {
        localStorage.removeItem('mybmw_snap');
        localStorage.setItem(k, txt);
      } catch (e2) {}
    }
  }
}

function isCam360Snap(dataOrB64, camMeta) {
  if (camMeta && camMeta.grid === '2x2') return true;
  const s = String(dataOrB64 || '');
  return s.indexOf('/9j/') === 0 || s.indexOf('data:image/jpeg') === 0;
}

function showToast(msg, color, durationMs) {
  const el = document.getElementById('toastBar');
  el.textContent = msg;
  el.style.borderLeftColor = color || '#38bdf8';
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), durationMs || 7500);
}

function toggleEl(id) {
  document.getElementById(id).classList.toggle('hidden');
}

function switchView(name, btn) {
  ['home', 'map', '1cr', 'settings'].forEach((v) => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== name);
  });
  Array.prototype.forEach.call(document.querySelectorAll('.nav-tab'), (b) => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (name === 'map') {
    setTimeout(refreshMap, 60);
    setTimeout(() => { if (mapInstance) mapInstance.invalidateSize(); }, 220);
  }
}

/* ---------------- Photorealistic Studio Bodywork Carpaint Shader (Fallback & Instant Preview) ---------------- */

function ensureBaseStudioImage() {
  if (baseStudioImg || baseStudioLoading) return;
  baseStudioLoading = true;
  const im = new Image();
  im.onload = () => {
    const finish = () => {
      if (im.naturalWidth >= 200 && im.naturalHeight >= 100) {
        baseStudioImg = im;
        shadedCacheKey = '';
        shadedCacheUrl = '';
      }
      baseStudioLoading = false;
      renderAll();
    };
    if (typeof im.decode === 'function') {
      im.decode().then(finish, finish);
    } else {
      finish();
    }
  };
  im.onerror = () => {
    baseStudioLoading = false;
  };
  im.src = 'car-studio.jpg';
}

function validateHeroDataUrl(dataUrl, cb) {
  if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.indexOf('data:image/') !== 0) {
    return cb(false);
  }
  const im = new Image();
  im.onload = () => {
    const checkPixels = () => {
      if (im.naturalWidth < 80 || im.naturalHeight < 30) return cb(false);
      try {
        const cw = 64, ch = 32;
        const cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        const ctx = cv.getContext('2d');
        ctx.drawImage(im, 0, 0, cw, ch);
        const d = ctx.getImageData(0, 0, cw, ch).data;
        let vis = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 35 && (d[i] + d[i + 1] + d[i + 2]) > 36) vis++;
        }
        cb(vis >= 18);
      } catch (e) {
        cb(true);
      }
    };
    if (typeof im.decode === 'function') {
      im.decode().then(checkPixels, checkPixels);
    } else {
      checkPixels();
    }
  };
  im.onerror = () => cb(false);
  im.src = dataUrl;
}

function findSwatchByColourOrLabel(colourCode, paintLabel) {
  if (colourCode) {
    const exact = BMW_SWATCHES.find((s) => s.id === colourCode);
    if (exact) return exact;
  }
  const low = String(paintLabel || colourCode || '').toLowerCase().replace(/\s+/g, '');
  if (!low) return null;
  for (let i = 0; i < BMW_SWATCHES.length; i++) {
    const sw = BMW_SWATCHES[i];
    const k1 = sw.label.toLowerCase().replace(/\s+/g, '');
    const k2 = sw.id.toLowerCase().replace(/_/g, '');
    if (low.indexOf(k1) >= 0 || k1.indexOf(low) >= 0 || low.indexOf(k2.slice(0, 8)) >= 0) return sw;
  }
  return null;
}

function smoothstep(e0, e1, x) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function shadeFallbackStudioCar(rgb) {
  if (!baseStudioImg || !baseStudioImg.naturalWidth || !rgb) return 'car-studio.jpg';
  const key = rgb.join(',');
  if (key === shadedCacheKey && shadedCacheUrl) return shadedCacheUrl;

  const w = baseStudioImg.naturalWidth, h = baseStudioImg.naturalHeight;
  let cv, ctx, img, d;
  try {
    cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    ctx = cv.getContext('2d');
    ctx.drawImage(baseStudioImg, 0, 0);
    img = ctx.getImageData(0, 0, w, h);
    d = img.data;
  } catch (e) {
    return 'car-studio.jpg';
  }

  // Guard against iOS Safari WebKit async-decode empty/black canvas frames so a black JPEG is NEVER cached!
  let srcBright = 0;
  for (let s = 0; s < d.length; s += 64) {
    if (d[s] + d[s + 1] + d[s + 2] > 90) srcBright++;
  }
  if (srcBright < 80) {
    baseStudioImg = null;
    baseStudioLoading = false;
    setTimeout(ensureBaseStudioImage, 250);
    return 'car-studio.jpg';
  }

  const tr = rgb[0] / 255, tg = rgb[1] / 255, tb = rgb[2] / 255;
  const tLum = 0.299 * tr + 0.587 * tg + 0.114 * tb;
  const isLightPaint = tLum > 0.65;
  const isDarkPaint = tLum < 0.14;

  // Preserve 3/4-perspective elliptical alloy wheel rims & blue brake calipers without eating into fenders!
  const w1x = 0.496 * w, w1y = 0.635 * h, w1rx = 0.033 * w, w1ry = 0.105 * h;
  const w2x = 0.766 * w, w2y = 0.594 * h, w2rx = 0.023 * w, w2ry = 0.082 * h;

  for (let y = 0; y < h; y++) {
    const ny = y / h;
    if (ny < 0.22 || ny > 0.80) continue;
    const vyMask = smoothstep(0.23, 0.28, ny) * (1 - smoothstep(0.73, 0.79, ny));
    if (vyMask <= 0.001) continue;

    for (let x = 0; x < w; x++) {
      const nx = x / w;
      if (nx < 0.17 || nx > 0.83) continue;
      const vxMask = smoothstep(0.175, 0.21, nx) * (1 - smoothstep(0.79, 0.825, nx));

      // Skip elliptical wheel openings smoothly
      const e1 = Math.pow((x - w1x) / w1rx, 2) + Math.pow((y - w1y) / w1ry, 2);
      if (e1 < 1.0) continue;
      const e2 = Math.pow((x - w2x) / w2rx, 2) + Math.pow((y - w2y) / w2ry, 2);
      if (e2 < 1.0) continue;

      // Skip upper greenhouse window glass area
      let glassPenalty = 1;
      if (nx > 0.36 && nx < 0.74 && ny > 0.26 && ny < 0.435) {
        const i = (y * w + x) * 4;
        const lumG = (d[i] + d[i + 1] + d[i + 2]) / (3 * 255);
        if (lumG < 0.32) glassPenalty = 0.08;
      }

      const idx = (y * w + x) * 4;
      const r = d[idx] / 255, g = d[idx + 1] / 255, b = d[idx + 2] / 255;
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = maxC > 0.02 ? (maxC - minC) / maxC : 0;

      // Paint all shadowed lower bodywork down to lum 0.055 while keeping pitch-black grille/intakes/tires & DRL white untouched
      const lowKeep = smoothstep(0.052, 0.105, lum);
      const highKeep = 1 - smoothstep(0.76, 0.86, lum);
      const neutralKeep = 1 - smoothstep(0.13, 0.24, sat);
      const mask = vxMask * vyMask * lowKeep * highKeep * neutralKeep * glassPenalty;
      if (mask <= 0.01) continue;

      // Metallic automotive shader curve preserving studio reflections & crease highlights
      let nr, ng, nb;
      if (isLightPaint) {
        const lift = Math.pow(lum, 0.72) * 1.28;
        const spec = Math.pow(lum, 3.2) * 0.22;
        nr = Math.min(1, tr * lift + spec);
        ng = Math.min(1, tg * lift + spec);
        nb = Math.min(1, tb * lift + spec);
      } else if (isDarkPaint) {
        const deep = Math.pow(lum, 1.55) * 0.95;
        const spec = Math.pow(lum, 3.8) * 0.55;
        nr = Math.min(1, tr * deep * 2.2 + spec);
        ng = Math.min(1, tg * deep * 2.2 + spec);
        nb = Math.min(1, tb * deep * 2.2 + spec);
      } else {
        const diff = Math.pow(lum, 1.05) * 1.48;
        const spec = Math.pow(lum, 3.6) * 0.38;
        nr = Math.min(1, tr * diff + spec);
        ng = Math.min(1, tg * diff + spec);
        nb = Math.min(1, tb * diff + spec);
      }

      d[idx] = Math.round((r * (1 - mask) + nr * mask) * 255);
      d[idx + 1] = Math.round((g * (1 - mask) + ng * mask) * 255);
      d[idx + 2] = Math.round((b * (1 - mask) + nb * mask) * 255);
    }
  }

  ctx.putImageData(img, 0, 0);
  shadedCacheKey = key;
  shadedCacheUrl = cv.toDataURL('image/jpeg', 0.9);
  return shadedCacheUrl;
}

function initSwatches() {
  const grid = document.getElementById('swatchGrid');
  if (!grid) return;
  grid.innerHTML = BMW_SWATCHES.map((sw) =>
    '<button type="button" class="swatch-item" data-colour="' + sw.id + '" onclick="pickSwatch(\'' + sw.id + '\')">' +
    '<span class="swatch-dot" style="background:' + sw.hex + '"></span>' +
    '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + sw.label + '</span></button>'
  ).join('');
  highlightSelectedSwatch();
}

function highlightSelectedSwatch() {
  const activeCol = localAppearance.colour || ((vehicleData && vehicleData.vehicleProfile && vehicleData.vehicleProfile.colour) || '');
  Array.prototype.forEach.call(document.querySelectorAll('.swatch-item'), (el) => {
    el.classList.toggle('selected', el.getAttribute('data-colour') === activeCol);
  });
}

function pickSwatch(colourId) {
  localAppearance.colour = colourId;
  saveLocal('mybmw_appearance', localAppearance);
  highlightSelectedSwatch();
  renderAll();
  // Automatically push to car if paired!
  if (identity) {
    applyAppearanceToCar(false);
  }
}

function previewAppearanceLocal() {
  localAppearance.chassis = document.getElementById('selChassis').value || '';
  localAppearance.trimLine = document.getElementById('selTrim').value || '';
  saveLocal('mybmw_appearance', localAppearance);
  renderAll();
}

function applyAppearanceToCar(resetDefault) {
  if (resetDefault) {
    localAppearance = { chassis: '', trimLine: '', colour: '' };
    document.getElementById('selChassis').value = '';
    document.getElementById('selTrim').value = '';
    saveLocal('mybmw_appearance', localAppearance);
    heroPendingOverride = true;
    highlightSelectedSwatch();
    renderAll();
    sendCmd('set_appearance', { reset: true }, true);
    return;
  }
  localAppearance.chassis = document.getElementById('selChassis').value || localAppearance.chassis || '';
  localAppearance.trimLine = document.getElementById('selTrim').value || localAppearance.trimLine || '';
  saveLocal('mybmw_appearance', localAppearance);
  // Show instant shaded studio preview while MGU renders & uploads the new factory PNG
  heroPendingOverride = true;
  renderAll();
  sendCmd('set_appearance', {
    chassis: localAppearance.chassis,
    trimLine: localAppearance.trimLine,
    colour: localAppearance.colour,
  }, true);
}

/* ---------------- WebCrypto derivation & packet codec ---------------- */

function fromBase64Url(str) {
  let s = String(str || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += ('0' + bytes[i].toString(16)).slice(-2);
  return s;
}

async function buildIdentity(pairCode) {
  const clean = extractPairCode(pairCode);
  if (!clean) return null;
  const seed = fromBase64Url(clean);
  if (seed.length < 16) return null;
  const enc = new TextEncoder();
  const keyHash = new Uint8Array(await crypto.subtle.digest('SHA-256', concatBytes(enc.encode('BL-AES-KEY:'), seed)));
  const topicHash = new Uint8Array(await crypto.subtle.digest('SHA-256', concatBytes(enc.encode('BL-TOPIC:'), seed)));
  const topicId = bytesToHex(topicHash).slice(0, 20);
  const cryptoKey = await crypto.subtle.importKey('raw', keyHash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const mqttBase = 'bl2/' + topicId;
  return {
    pairCode: clean,
    cryptoKey,
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

async function encryptJson(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(obj));
  const ctAndTag = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, identity.cryptoKey, plain));
  return 'BL2:' + bytesToBase64(concatBytes(iv, ctAndTag));
}

async function decryptJson(wire) {
  if (typeof wire !== 'string' || wire.slice(0, 4) !== 'BL2:') return null;
  try {
    const raw = base64ToBytes(wire.slice(4));
    if (raw.length < 28) return null;
    const iv = raw.slice(0, 12);
    const body = raw.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, identity.cryptoKey, body);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    return null;
  }
}

function extractPairCode(input) {
  const s = String(input || '').trim();
  if (!s) return '';
  const mHash = /#([A-Za-z0-9_-]{22,64})/.exec(s);
  if (mHash) return mHash[1];
  const mQuery = /[?&]k=([A-Za-z0-9_-]{22,64})/.exec(s);
  if (mQuery) return mQuery[1];
  if (/^[A-Za-z0-9_-]{22,64}$/.test(s)) return s;
  return '';
}

/* ---------------- MQTT 3.1.1 over WebSocket Codec & Real-time Subscriptions ---------------- */

function mqttVarLen(x) {
  const out = [];
  let n = x >>> 0;
  do {
    let b = n & 0x7f;
    n = Math.floor(n / 128);
    if (n > 0) b |= 0x80;
    out.push(b);
  } while (n > 0);
  return new Uint8Array(out);
}

function mqttDecVarLen(u8, off) {
  let mul = 1, val = 0, pos = off;
  for (let i = 0; i < 4; i++) {
    if (pos >= u8.length) return null;
    const b = u8[pos++];
    val += (b & 0x7f) * mul;
    if ((b & 0x80) === 0) return { value: val, next: pos };
    mul *= 128;
  }
  return { error: true, next: pos };
}

function mqttStr(s) {
  const b = new TextEncoder().encode(String(s));
  const out = new Uint8Array(2 + b.length);
  out[0] = (b.length >> 8) & 0xff;
  out[1] = b.length & 0xff;
  out.set(b, 2);
  return out;
}

function mqttJoin(list) {
  let total = 0;
  for (let i = 0; i < list.length; i++) total += list[i].length;
  const out = new Uint8Array(total);
  let off = 0;
  for (let i = 0; i < list.length; i++) { out.set(list[i], off); off += list[i].length; }
  return out;
}

function mqttBuildConnect(cid) {
  const vh = new Uint8Array([0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 45]);
  const pl = mqttStr(cid);
  return mqttJoin([new Uint8Array([0x10]), mqttVarLen(vh.length + pl.length), vh, pl]);
}

function mqttBuildSubscribeMulti(pktId, topics) {
  const parts = [new Uint8Array([(pktId >> 8) & 0xff, pktId & 0xff])];
  for (let i = 0; i < topics.length; i++) {
    parts.push(mqttStr(topics[i]));
    parts.push(new Uint8Array([0x00]));
  }
  const body = mqttJoin(parts);
  return mqttJoin([new Uint8Array([0x82]), mqttVarLen(body.length), body]);
}

function mqttBuildPublish(topic, payloadStr, retain) {
  const t = mqttStr(topic);
  const p = new TextEncoder().encode(String(payloadStr));
  const hdr = new Uint8Array([0x30 | (retain ? 0x01 : 0x00)]);
  return mqttJoin([hdr, mqttVarLen(t.length + p.length), t, p]);
}

function mqttParse(rx) {
  const frames = [];
  let off = 0;
  const dec = new TextDecoder();
  while (off < rx.length) {
    const hdr = rx[off];
    const dl = mqttDecVarLen(rx, off + 1);
    if (!dl) break;
    if (dl.error) { off = rx.length; break; }
    const end = dl.next + dl.value;
    if (end > rx.length) break;
    const body = rx.slice(dl.next, end);
    off = end;
    const type = hdr >> 4;
    if (type === 2) {
      frames.push({ type: 'connack', rc: body.length >= 2 ? body[1] : 255 });
    } else if (type === 13) {
      frames.push({ type: 'pingresp' });
    } else if (type === 3 && body.length >= 2) {
      const tLen = (body[0] << 8) | body[1];
      const qos = (hdr >> 1) & 0x03;
      const pOff = 2 + tLen + (qos > 0 ? 2 : 0);
      if (pOff <= body.length) {
        frames.push({
          type: 'publish',
          retain: !!(hdr & 0x01),
          topic: dec.decode(body.slice(2, 2 + tLen)),
          payload: dec.decode(body.slice(pOff)),
        });
      }
    }
  }
  return { frames, rest: off > 0 ? rx.slice(off) : rx };
}

function notifyMqttWaiters(ok) {
  const list = mqttWaiters.splice(0, mqttWaiters.length);
  for (let i = 0; i < list.length; i++) list[i](ok);
}

function waitForMqttReady(timeoutMs) {
  if (mqttReady && mqttWs && mqttWs.readyState === 1) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const fn = (ok) => { if (!done) { done = true; clearTimeout(t); resolve(!!ok); } };
    const t = setTimeout(() => fn(false), timeoutMs || 1800);
    mqttWaiters.push(fn);
  });
}

function bumpMqttBrokerOnFail() {
  if (mqttBrokerIdx === 0) {
    mqttPrimaryFails++;
    if (mqttPrimaryFails >= 3) {
      mqttBrokerIdx = 1;
      mqttPrimaryFails = 0;
    }
  } else {
    mqttBrokerIdx = (mqttBrokerIdx + 1) % MQTT_BROKERS.length;
  }
}

function openMqttSocket() {
  if (!identity) return;
  if (mqttWs && (mqttWs.readyState === 0 || mqttWs.readyState === 1)) return;
  if (mqttReconnTimer) { clearTimeout(mqttReconnTimer); mqttReconnTimer = null; }
  if (mqttPingTimer) { clearInterval(mqttPingTimer); mqttPingTimer = null; }
  mqttReady = false;

  if (mqttBrokerIdx !== 0 && Date.now() - mqttLastPrimaryTry > 120000) {
    mqttBrokerIdx = 0;
    mqttLastPrimaryTry = Date.now();
  }
  const url = MQTT_BROKERS[mqttBrokerIdx % MQTT_BROKERS.length];
  let ws;
  try {
    ws = new WebSocket(url, 'mqtt');
  } catch (e) {
    bumpMqttBrokerOnFail();
    mqttReconnTimer = setTimeout(openMqttSocket, 2000);
    return;
  }
  ws.binaryType = 'arraybuffer';
  mqttWs = ws;
  let rx = new Uint8Array(0);

  const connTimer = setTimeout(() => {
    if (mqttWs === ws && !mqttReady) {
      bumpMqttBrokerOnFail();
      try { ws.close(); } catch (e) {}
    }
  }, 6000);

  ws.onopen = () => {
    if (mqttWs !== ws) return;
    lastMqttRxAt = Date.now();
    const cid = 'blapp_' + Math.random().toString(36).slice(2, 10);
    try { ws.send(mqttBuildConnect(cid)); } catch (e) {}
  };

  ws.onmessage = async (ev) => {
    if (mqttWs !== ws || !(ev.data instanceof ArrayBuffer)) return;
    lastMqttRxAt = Date.now();
    const chunk = new Uint8Array(ev.data);
    rx = rx.length ? concatBytes(rx, chunk) : chunk;
    const parsed = mqttParse(rx);
    rx = parsed.rest;
    for (let i = 0; i < parsed.frames.length; i++) {
      const f = parsed.frames[i];
      if (f.type === 'connack') {
        clearTimeout(connTimer);
        if (f.rc === 0 && identity) {
          mqttReady = true;
          mqttPrimaryFails = 0;
          mqttLastPrimaryTry = Date.now();
          const mt = identity.mqttTopics;
          try { ws.send(mqttBuildSubscribeMulti(1, [mt.state, mt.photo, mt.hero, mt.diag])); } catch (e) {}
          notifyMqttWaiters(true);
          if (mqttPingTimer) clearInterval(mqttPingTimer);
          mqttPingTimer = setInterval(() => {
            if (mqttWs === ws && ws.readyState === 1) {
              if (Date.now() - lastMqttRxAt > 48000) {
                try { ws.close(); } catch (e) {}
                return;
              }
              try { ws.send(new Uint8Array([0xc0, 0x00])); } catch (e) {}
            }
          }, 20000);
          renderAll();
        } else {
          bumpMqttBrokerOnFail();
          try { ws.close(); } catch (e) {}
        }
      } else if (f.type === 'publish' && identity) {
        const decObj = await decryptJson(f.payload);
        if (!decObj) continue;
        const mt = identity.mqttTopics;
        const isLive = !f.retain;
        if (f.topic === mt.state) onStatePacket(decObj, Date.now(), isLive);
        else if (f.topic === mt.photo) onPhotoPacket(decObj, Date.now(), isLive);
        else if (f.topic === mt.hero) onHeroPacket(decObj, Date.now(), isLive);
        else if (f.topic === mt.diag) onDiagPacket(decObj);
        renderAll();
      }
    }
  };

  const onDead = () => {
    clearTimeout(connTimer);
    if (mqttWs !== ws) return;
    mqttWs = null;
    mqttReady = false;
    if (mqttPingTimer) { clearInterval(mqttPingTimer); mqttPingTimer = null; }
    bumpMqttBrokerOnFail();
    if (identity && !mqttReconnTimer) {
      mqttReconnTimer = setTimeout(openMqttSocket, 2200);
    }
  };
  ws.onerror = onDead;
  ws.onclose = onDead;
}

async function connectCar(code) {
  const id = await buildIdentity(code);
  if (!id) {
    showToast('Mã ghép nối chưa hợp lệ. Hãy quét lại mã QR trên màn hình xe.', '#ef4444');
    return false;
  }
  identity = id;
  localStorage.setItem('mybmw_pair', id.pairCode);
  document.getElementById('inpPairCode').value = id.pairCode;

  try {
    if (location.protocol.indexOf('http') === 0) {
      history.replaceState(null, '', '?k=' + encodeURIComponent(id.pairCode));
    }
  } catch (e) {}

  if (window.AndroidBridge && window.AndroidBridge.onPairCodeChanged) {
    try { window.AndroidBridge.onPairCodeChanged(id.pairCode); } catch (e) {}
  }

  closeSockets();
  setConnBadge('sleep', 'Đang đồng bộ…');
  openMqttSocket();
  renderAll();

  // Cross-check 12h ntfy sleep cache & standby MQTT broker so iPhone/Web always recovers the newest real 360° camera photo!
  setTimeout(() => {
    if (identity === id) syncCloudMediaCaches(id);
  }, 900);
  return true;
}

async function syncCloudMediaCaches(id) {
  if (!id || identity !== id) return;
  let touched = false;
  if (!mqttReady || !vehicleData) {
    await fetchCachedTopic(id.topics.state, onStatePacket, false);
    touched = true;
  }
  const hasReal360 = !!(latestSnap && isCam360Snap(latestSnap.dataUrl, latestSnap.camMeta));
  if (!hasReal360 || (Date.now() - (latestSnap.rxAt || latestSnap.at || 0) > 120000)) {
    await fetchCachedTopic(id.topics.photo, onPhotoPacket, true);
    touched = true;
  }
  if (!factoryHero && (!vehicleData || vehicleData.hasFactoryHero !== false)) {
    await fetchCachedTopic(id.topics.hero, onHeroPacket, true);
    touched = true;
  }
  if (!(latestSnap && isCam360Snap(latestSnap.dataUrl, latestSnap.camMeta))) {
    await probeStandbyMqttRetained(id);
    touched = true;
  }
  if (!mqttReady) openFallbackNtfySockets();
  if (touched) renderAll();
}

function probeStandbyMqttRetained(id) {
  return new Promise((resolve) => {
    if (!id || identity !== id || MQTT_BROKERS.length < 2 || typeof WebSocket === 'undefined') return resolve(false);
    const altIdx = (mqttBrokerIdx % MQTT_BROKERS.length) === 0 ? 1 : 0;
    const altUrl = MQTT_BROKERS[altIdx];
    let pws = null, done = false, prx = new Uint8Array(0);
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (pws) { try { pws.close(); } catch (e) {} pws = null; }
      resolve(!!ok);
    };
    const timer = setTimeout(() => finish(false), 2800);
    try {
      pws = new WebSocket(altUrl, 'mqtt');
      pws.binaryType = 'arraybuffer';
    } catch (e) {
      return finish(false);
    }
    pws.onopen = () => {
      if (done) return;
      const cid = 'blprb_' + Math.random().toString(36).slice(2, 9);
      try { pws.send(mqttBuildConnect(cid)); } catch (e) { finish(false); }
    };
    pws.onmessage = async (ev) => {
      if (done || !(ev.data instanceof ArrayBuffer)) return;
      prx = prx.length ? concatBytes(prx, new Uint8Array(ev.data)) : new Uint8Array(ev.data);
      const parsed = mqttParse(prx);
      prx = parsed.rest;
      for (let i = 0; i < parsed.frames.length; i++) {
        const f = parsed.frames[i];
        if (f.type === 'connack' && f.rc === 0) {
          const mt = id.mqttTopics;
          try { pws.send(mqttBuildSubscribeMulti(2, [mt.photo, mt.hero, mt.state])); } catch (e) {}
        } else if (f.type === 'publish' && identity === id) {
          const decObj = await decryptJson(f.payload);
          if (!decObj) continue;
          const mt = id.mqttTopics;
          if (f.topic === mt.photo) {
            onPhotoPacket(decObj, Date.now(), false);
            if (latestSnap && isCam360Snap(latestSnap.dataUrl, latestSnap.camMeta)) {
              renderAll();
              finish(true);
              return;
            }
          } else if (f.topic === mt.hero) {
            onHeroPacket(decObj, Date.now(), false);
          } else if (f.topic === mt.state && !vehicleData) {
            onStatePacket(decObj, Date.now(), false);
          }
        }
      }
    };
    pws.onerror = () => finish(false);
    pws.onclose = () => finish(false);
  });
}

function closeSockets() {
  if (mqttReconnTimer) { clearTimeout(mqttReconnTimer); mqttReconnTimer = null; }
  if (mqttPingTimer) { clearInterval(mqttPingTimer); mqttPingTimer = null; }
  if (mqttWs) { try { mqttWs.close(); } catch (e) {} mqttWs = null; }
  mqttReady = false;
  notifyMqttWaiters(false);
  [stateWs, diagWs].forEach((ws) => { if (ws) { try { ws.close(); } catch (e) {} } });
  stateWs = diagWs = null;
}

async function resolveEventWire(ev) {
  if (!ev || ev.event !== 'message') return '';
  if (ev.message && ev.message.indexOf('BL2:') === 0) return ev.message;
  if (ev.attachment && ev.attachment.url) {
    try {
      const r = await fetch(ev.attachment.url);
      const t = (await r.text()).trim();
      if (t.indexOf('BL2:') === 0) return t;
    } catch (e) {}
  }
  return '';
}

async function fetchCachedTopic(topic, handler, newestFirstMedia) {
  try {
    const r = await fetch('https://' + RELAY_HOST + '/' + topic + '/json?poll=1&since=all');
    if (!r.ok) return;
    const txt = await r.text();
    const lines = txt.split('\n').filter(Boolean);
    if (newestFirstMedia) {
      let fallbackNewest = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        let ev = null;
        try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
        const wire = await resolveEventWire(ev);
        if (!wire) continue;
        const dec = await decryptJson(wire);
        if (!dec) continue;
        const tsMs = ev.time ? ev.time * 1000 : Date.now();
        if (handler === onPhotoPacket) {
          if (dec.b64 && isCam360Snap(dec.b64, dec.camMeta)) {
            handler(dec, tsMs, false);
            return;
          }
          if (!fallbackNewest) fallbackNewest = { dec, tsMs };
        } else {
          handler(dec, tsMs, false);
          return;
        }
      }
      if (fallbackNewest && !latestSnap) {
        handler(fallbackNewest.dec, fallbackNewest.tsMs, false);
      }
      return;
    }
    for (let i = 0; i < lines.length; i++) {
      let ev = null;
      try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
      const wire = await resolveEventWire(ev);
      if (wire) {
        const dec = await decryptJson(wire);
        if (dec) handler(dec, ev.time ? ev.time * 1000 : Date.now(), false);
      }
    }
  } catch (e) {}
}

function openFallbackNtfySockets() {
  if (!identity || stateWs) return;
  const sub = (topic, handler) => {
    const ws = new WebSocket('wss://' + RELAY_HOST + '/' + topic + '/ws');
    ws.onmessage = async (e) => {
      let ev = null;
      try { ev = JSON.parse(e.data); } catch (x) { return; }
      const wire = await resolveEventWire(ev);
      if (wire) {
        const dec = await decryptJson(wire);
        if (dec) {
          handler(dec, Date.now(), true);
          renderAll();
        }
      }
    };
    return ws;
  };
  stateWs = sub(identity.topics.state, onStatePacket);
  diagWs = sub(identity.topics.diag, onDiagPacket);
}

function normalizeCarTime(rawMs, fallbackMs, isLive) {
  const now = Date.now();
  if (isLive) return now;
  const n = Number(rawMs) || 0;
  if (!n || Math.abs(now - n) > 14 * 86400000) return fallbackMs || now;
  return n;
}

function onStatePacket(pkt, ts, isLive) {
  if (!pkt || pkt.t !== 'state') return;
  if (!isLive && vehicleData && vehicleData.at && pkt.at && pkt.at < vehicleData.at && Math.abs(Date.now() - vehicleData.at) < 3600000) {
    return;
  }
  vehicleData = pkt;
  vehicleData.rxAt = normalizeCarTime(pkt.at, ts, isLive);
  if (!vehicleData.at) vehicleData.at = vehicleData.rxAt;
  saveLocal('mybmw_state', vehicleData);

  if (!heroPendingOverride && pkt.appearanceOverride && typeof pkt.appearanceOverride === 'object') {
    const ao = Object.assign({ chassis: '', trimLine: '', colour: '' }, pkt.appearanceOverride);
    const codedCh = pkt.vehicleProfile && pkt.vehicleProfile.codedChassis;
    if (ao.chassis === 'F90' && (ao.trimLine === 'clubsport' || codedCh === 'F90LCI')) {
      ao.chassis = 'F90LCI';
    }
    if (ao.chassis || ao.colour || ao.trimLine || (pkt.version && pkt.version >= '0.6.1')) {
      localAppearance = ao;
      saveLocal('mybmw_appearance', localAppearance);
    }
  }
  if (healthScanBusy && pkt.telemetry && pkt.telemetry.health && pkt.telemetry.health.checkedAt) {
    setHealthScanBusy(false);
  }

  if (pkt.alert && pkt.alert.reason) {
    const prefix = pkt.alert.kind === 'dwa_alarm' ? '🚨 BÁO ĐỘNG CHỐNG TRỘM DWA: ' : '🚨 CẢNH BÁO VALET: ';
    showToast(prefix + pkt.alert.reason, '#ef4444', 11000);
  }

  if (window.AndroidBridge && window.AndroidBridge.onVehicleSummary) {
    try {
      const tel = pkt.telemetry || {};
      const c1 = tel.climate1cr || {};
      const prof = pkt.vehicleProfile || {};
      const stAge = Date.now() - (vehicleData.rxAt || vehicleData.at || 0);
      const isAwakeNow = stAge >= -300000 && stAge < 95000;
      const live1cr = !!(c1.active && isAwakeNow && stAge < 16 * 60000);
      const liveEng = !!(tel.engineRunning && isAwakeNow);
      window.AndroidBridge.onVehicleSummary(JSON.stringify({
        carName: localStorage.getItem('mybmw_car_name') || prof.modelTitle || 'BMW iDrive 7',
        status: !isAwakeNow ? 'Đã ngủ 0W' : (live1cr ? 'Đang chạy làm mát' : (liveEng ? 'Đang nổ máy' : 'Đã đỗ')),
        fuelPct: tel.fuelPct,
        rangeKm: tel.rangeKm,
        battery12v: tel.battery12v,
        active1cr: live1cr,
        timer1cr: c1.timerText || '',
        location: tel.pos ? ([tel.pos.street, tel.pos.district, tel.pos.city].filter(Boolean).join(', ')) : '',
        updatedAt: pkt.at || Date.now(),
      }));
    } catch (e) {}
  }
}

function commitReceivedPhoto(fullB64, at, title, id, isLive, camMeta) {
  if (!fullB64) return;
  const incomingIsCam = isCam360Snap(fullB64, camMeta);
  const existingIsCam = !!(latestSnap && isCam360Snap(latestSnap.dataUrl, latestSnap.camMeta));
  // Never allow a non-camera fallback PNG card to erase an existing real 4-camera 360° JPEG!
  if (!incomingIsCam && existingIsCam) return;
  const mime = fullB64.indexOf('/9j/') === 0 ? 'image/jpeg' : 'image/png';
  const isNewId = !latestSnap || !id || latestSnap.id !== id;
  const dispAt = normalizeCarTime(at, Date.now(), isLive);
  if (!latestSnap || (incomingIsCam && !existingIsCam) || dispAt >= (latestSnap.rxAt || latestSnap.at || 0) || isLive) {
    latestSnap = {
      id: id || String(dispAt),
      dataUrl: 'data:' + mime + ';base64,' + fullB64,
      at: at || dispAt,
      rxAt: dispAt,
      title: title || '',
      camMeta: camMeta || null,
    };
    snapCropCache = { id: '', loadingId: '', has2x2: false, camRatioPct: 88.235, crops: {} };
    saveLocal('mybmw_snap', latestSnap);
    ensureSnapCrops();
    if (isLive && isNewId) {
      showToast('📸 Đã nhận ảnh sắc nét từ xe — chạm từng góc hoặc tab để xem riêng từng cam!', '#2fd27a', 6500);
      setTimeout(() => {
        const card = document.getElementById('latestSnapCard');
        if (card && !document.getElementById('view-home').classList.contains('hidden')) {
          card.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }, 120);
    }
  }
}

function onPhotoPacket(pkt, ts, isLive) {
  if (!pkt) return;
  if (pkt.t === 'photo_full' && pkt.b64) {
    commitReceivedPhoto(pkt.b64, pkt.at || ts, pkt.title || '', pkt.id || '', isLive, pkt.camMeta || null);
    return;
  }
  if (pkt.t !== 'photo_chunk' || !pkt.id) return;
  let b = photoBuckets[pkt.id];
  if (!b) b = photoBuckets[pkt.id] = { total: pkt.total || 1, parts: {}, got: 0, at: pkt.at || Date.now(), title: pkt.title || '' };
  if (b.parts[pkt.idx] === undefined) {
    b.parts[pkt.idx] = pkt.b64 || '';
    b.got++;
  }
  if (isLive && b.got < b.total) {
    const st = document.getElementById('snapTime');
    if (st) st.textContent = 'Đang tải ảnh (' + b.got + '/' + b.total + ')…';
  }
  if (b.got >= b.total) {
    let fullB64 = '';
    for (let i = 0; i < b.total; i++) fullB64 += (b.parts[i] || '');
    delete photoBuckets[pkt.id];
    commitReceivedPhoto(fullB64, b.at, b.title, pkt.id, isLive, null);
  }
}

function ensureSnapCrops() {
  if (!latestSnap || !latestSnap.dataUrl) return;
  const targetSnap = latestSnap;
  const sid = targetSnap.id || targetSnap.dataUrl.slice(-32);
  if (snapCropCache.id === sid || snapCropCache.loadingId === sid) return;
  const mySeq = ++snapDecodeSeq;
  snapCropCache.loadingId = sid;
  const im = new Image();
  im.onload = () => {
    const build = () => {
      if (mySeq !== snapDecodeSeq) return;
      snapCropCache.loadingId = '';
      const nw = im.naturalWidth || 0;
      const nh = im.naturalHeight || 0;
      const cm = targetSnap.camMeta;
      const is2x2 = !!(
        (cm && cm.grid === '2x2') ||
        (nw === 960 && nh === 816) ||
        (nw === 960 && nh === 600) ||
        (nw === 640 && nh === 416)
      );
      const crops = { all: targetSnap.dataUrl };
      let ratioPct = 88.235;
      if (is2x2 && nw >= 320 && nh >= 240) {
        const cw = (cm && cm.camW) ? Math.min(nw, cm.camW) : nw;
        const ch = (cm && cm.camH) ? Math.min(nh, cm.camH) : (nh === 816 ? 720 : (nh === 600 ? 440 : (nh === 416 ? 288 : Math.round(nw * 0.75))));
        ratioPct = +((ch / nh) * 100).toFixed(3);
        const qw = cw >> 1;
        const qh = ch >> 1;
        const defs = [
          ['front', 0, 0],
          ['rear', qw, 0],
          ['left', 0, qh],
          ['right', qw, qh],
        ];
        try {
          const cv = document.createElement('canvas');
          cv.width = qw;
          cv.height = qh;
          const ctx = cv.getContext('2d');
          ctx.imageSmoothingEnabled = true;
          for (let i = 0; i < defs.length; i++) {
            ctx.clearRect(0, 0, qw, qh);
            ctx.drawImage(im, defs[i][1], defs[i][2], qw, qh, 0, 0, qw, qh);
            crops[defs[i][0]] = cv.toDataURL('image/jpeg', 0.95);
          }
        } catch (e) {}
      }
      snapCropCache = { id: sid, loadingId: '', has2x2: is2x2 && !!crops.front, camRatioPct: ratioPct, crops };
      if (!snapCropCache.has2x2) activeCamView = 'all';
      updateSnapDisplay();
    };
    if (typeof im.decode === 'function') im.decode().then(build, build);
    else build();
  };
  im.onerror = () => { if (mySeq === snapDecodeSeq) snapCropCache.loadingId = ''; };
  im.src = targetSnap.dataUrl;
}

function selectCamView(view) {
  activeCamView = CAM_VIEW_LABELS[view] ? view : 'all';
  const mImg = document.getElementById('snapModalImg');
  if (mImg) mImg.classList.remove('zoomed');
  updateSnapDisplay();
}

function updateSnapDisplay() {
  if (!latestSnap || !latestSnap.dataUrl) return;
  document.getElementById('noSnapHint').classList.add('hidden');
  const zoomBtn = document.getElementById('btnZoomSnap');
  if (zoomBtn) zoomBtn.classList.remove('hidden');

  const has2x2 = !!snapCropCache.has2x2;
  const view = has2x2 && snapCropCache.crops[activeCamView] ? activeCamView : 'all';
  const shownUrl = (has2x2 && snapCropCache.crops[view]) ? snapCropCache.crops[view] : latestSnap.dataUrl;

  const img = document.getElementById('latestSnapImg');
  if (img.src !== shownUrl) img.src = shownUrl;
  img.classList.remove('hidden');

  const tabs = document.getElementById('camViewTabs');
  const modalTabs = document.getElementById('snapModalTabs');
  const quadOverlay = document.getElementById('camQuadOverlay');
  const singleBadge = document.getElementById('camSingleBadge');

  if (tabs) tabs.classList.toggle('hidden', !has2x2);
  if (modalTabs) modalTabs.classList.toggle('hidden', !has2x2);

  Array.prototype.forEach.call(document.querySelectorAll('.cam-tab'), (btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-cam') === view);
  });

  if (quadOverlay) {
    quadOverlay.style.height = snapCropCache.camRatioPct + '%';
    quadOverlay.classList.toggle('hidden', !(has2x2 && view === 'all'));
  }
  if (singleBadge) {
    singleBadge.textContent = (CAM_VIEW_LABELS[view] || view) + ' · Chạm ảnh để phóng to 🔍';
    singleBadge.classList.toggle('hidden', !(has2x2 && view !== 'all'));
  }

  const mModal = document.getElementById('snapModal');
  if (mModal && !mModal.classList.contains('hidden')) {
    const mImg = document.getElementById('snapModalImg');
    if (mImg && mImg.src !== shownUrl) mImg.src = shownUrl;
    const mTitle = document.getElementById('snapModalTitle');
    if (mTitle) mTitle.textContent = has2x2 ? (CAM_VIEW_LABELS[view] || 'Ảnh Camera 360°') : (latestSnap.title || 'Ảnh chụp từ xe');
  }
}

function openSnapModal() {
  if (!latestSnap || !latestSnap.dataUrl) return;
  ensureSnapCrops();
  const mImg = document.getElementById('snapModalImg');
  if (mImg) mImg.classList.remove('zoomed');
  document.getElementById('snapModal').classList.remove('hidden');
  updateSnapDisplay();
}

function toggleModalZoom(ev) {
  if (ev) ev.stopPropagation();
  const mImg = document.getElementById('snapModalImg');
  if (mImg) mImg.classList.toggle('zoomed');
}

function closeSnapModal() {
  const mImg = document.getElementById('snapModalImg');
  if (mImg) mImg.classList.remove('zoomed');
  document.getElementById('snapModal').classList.add('hidden');
}

function commitHeroBase64(fullB64, at, title, paint, isLive) {
  if (!fullB64) return;
  if (!factoryHero || (at || 0) >= (factoryHero.at || 0) || isLive) {
    const candidateUrl = 'data:image/png;base64,' + fullB64;
    const snapMeta = { dataUrl: candidateUrl, at: at || Date.now(), title: title || '', paint: paint || '' };
    validateHeroDataUrl(candidateUrl, (ok) => {
      if (!ok) return;
      factoryHero = snapMeta;
      if (isLive) heroPendingOverride = false;
      saveLocal('mybmw_hero', factoryHero);
      renderAll();
    });
  }
}

function onHeroPacket(pkt, ts, isLive) {
  if (!pkt) return;
  if (pkt.t === 'photo_full' && pkt.b64) {
    commitHeroBase64(pkt.b64, pkt.at || ts, pkt.title || '', pkt.paint || '', isLive);
    return;
  }
  if (pkt.t !== 'photo_chunk') return;
  const hid = pkt.id || 'hero';
  let b = heroBuckets[hid];
  if (!b) b = heroBuckets[hid] = { total: pkt.total || 1, parts: {}, got: 0, at: pkt.at || Date.now(), title: pkt.title || '', paint: pkt.paint || '' };
  if (b.parts[pkt.idx] === undefined) {
    b.parts[pkt.idx] = pkt.b64 || '';
    b.got++;
  }
  if (b.got >= b.total) {
    let fullB64 = '';
    for (let i = 0; i < b.total; i++) fullB64 += (b.parts[i] || '');
    delete heroBuckets[hid];
    commitHeroBase64(fullB64, b.at, b.title, b.paint, isLive);
  }
}

function onDiagPacket(pkt) {
  if (!pkt) return;
  if (pkt.t === 'diag_chunk') {
    let b = diagBuckets[pkt.id];
    if (!b) b = diagBuckets[pkt.id] = { total: pkt.total, parts: {}, isB64: !!pkt.b64, got: 0 };
    const piece = pkt.b64 !== undefined ? pkt.b64 : pkt.part;
    if (b.parts[pkt.idx] === undefined) { b.parts[pkt.idx] = piece; b.got++; }
    if (b.got >= b.total) {
      let str = '';
      if (b.isB64) {
        const chunks = [];
        let len = 0;
        for (let i = 0; i < b.total; i++) {
          const bytes = base64ToBytes(b.parts[i] || '');
          chunks.push(bytes);
          len += bytes.length;
        }
        const merged = new Uint8Array(len);
        let off = 0;
        for (let i = 0; i < chunks.length; i++) { merged.set(chunks[i], off); off += chunks[i].length; }
        str = new TextDecoder().decode(merged);
      } else {
        for (let i = 0; i < b.total; i++) str += (b.parts[i] || '');
      }
      delete diagBuckets[pkt.id];
      try { onDiagPacket(JSON.parse(str)); } catch (e) {}
    }
    return;
  }
  if (pkt.t === 'cmd_ack') {
    if (pkt.id && pendingAckTimers[pkt.id]) {
      clearTimeout(pendingAckTimers[pkt.id]);
      delete pendingAckTimers[pkt.id];
    }
    if (pkt.cmd === 'scan_health') setHealthScanBusy(false);
    const prefix = pkt.ok ? '✅ ' : '⚠️ ';
    showToast(prefix + (pkt.message || 'Xe đã xử lý lệnh.'), pkt.ok ? '#2fd27a' : '#ffb020', 8500);
    if (pkt.detail) {
      document.getElementById('diagOutput').textContent = JSON.stringify(pkt.detail, null, 2);
    }
    return;
  }
  if (pkt.t === 'schema') {
    if (pkt.reqId && pendingAckTimers[pkt.reqId]) {
      clearTimeout(pendingAckTimers[pkt.reqId]);
      delete pendingAckTimers[pkt.reqId];
    }
    lastSchema = pkt;
    renderSchemaCards(pkt.schema);
    document.getElementById('diagOutput').textContent = JSON.stringify({
      pinned: pkt.schema && pkt.schema.pinnedProfile,
      openConfigs: pkt.schema && pkt.schema.openConfigs,
      remoteBodyInterfaces: pkt.schema && pkt.schema.remoteBodyInterfaces,
      live: pkt.schema && pkt.schema.live,
      bodyLive: pkt.schema && pkt.schema.bodyLive,
      logs: pkt.logs,
    }, null, 2);
    showToast('✅ Đã nhận danh sách ' + (((pkt.schema && pkt.schema.interfaces) || []).length) + ' giao diện Climate/1CR từ xe!', '#2fd27a');
  } else if (pkt.t === 'raw_result') {
    if (pkt.reqId && pendingAckTimers[pkt.reqId]) {
      clearTimeout(pendingAckTimers[pkt.reqId]);
      delete pendingAckTimers[pkt.reqId];
    }
    document.getElementById('diagOutput').textContent = JSON.stringify(pkt.result, null, 2);
    const ok = pkt.result && pkt.result.ok;
    showToast(ok ? '✅ Thực thi lệnh 1CR thành công!' : ('⚠️ Chưa thành công: ' + ((pkt.result && pkt.result.error) || '')), ok ? '#2fd27a' : '#ffb020');
  }
}

/* ---------------- Sending Remote Commands ---------------- */

async function sendCmd(cmd, arg, queueIfAsleep) {
  if (!identity) {
    switchView('settings', document.querySelectorAll('.nav-tab')[3]);
    showToast('Hãy quét mã QR trên màn hình xe để ghép nối trước.', '#ffb020');
    return;
  }
  const device = window.AndroidBridge ? 'Android App' : (/iPhone|iPad|iPod/.test(navigator.userAgent) ? 'iPhone' : 'MyBMW Web');
  const cmdId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const pkt = await encryptJson({
    id: cmdId,
    cmd,
    arg: arg || {},
    at: Date.now(),
    tzOffsetMin: -(new Date().getTimezoneOffset()),
    queueIfAsleep: !!queueIfAsleep,
    device,
  });
  showToast('Đang gửi lệnh tới xe…', '#38bdf8', 5000);

  if (!mqttReady) {
    openMqttSocket();
    await waitForMqttReady(1800);
  }
  if (mqttReady && mqttWs && mqttWs.readyState === 1) {
    try {
      mqttWs.send(mqttBuildPublish(identity.mqttTopics.cmd, pkt, false));
      const ackWaitMs = cmd === 'scan_health' ? 16000 : 4800;
      pendingAckTimers[cmdId] = setTimeout(() => {
        if (!pendingAckTimers[cmdId]) return;
        delete pendingAckTimers[cmdId];
        if (!identity) return;
        openFallbackNtfySockets();
        fetch('https://' + RELAY_HOST + '/' + identity.topics.cmd, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: pkt,
        }).catch(() => {});
        if (!queueIfAsleep && !isVehicleAwakeNow()) {
          showToast('💤 Đầu xe MGU hiện đang ngủ sâu 0W (đã ngắt nguồn sau khi khoá xe) — để tự nổ máy khi xe ngủ hãy đặt Hẹn giờ BDC trước khi tắt máy, hoặc gắn thêm bộ đánh thức MGU-ATM2.', '#ffb020', 9500);
        }
      }, ackWaitMs);
      showToast('Đã gửi tức thì tới xe — đang chờ phản hồi…', '#38bdf8', 8000);
      return;
    } catch (e) {}
  }

  try {
    const r = await fetch('https://' + RELAY_HOST + '/' + identity.topics.cmd, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: pkt,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    showToast('Đã gửi tới xe — đang chờ xe phản hồi (~2 giây)…', '#38bdf8', 8000);
  } catch (e) {
    showToast('Lỗi mạng khi gửi lệnh: ' + e.message, '#ef4444');
  }
}

function isVehicleAwakeNow() {
  if (!vehicleData) return false;
  const effectiveAt = vehicleData.rxAt || vehicleData.at || 0;
  const ageMs = Date.now() - effectiveAt;
  return ageMs >= -300000 && ageMs < 95000;
}

function handle1crTap() {
  const tel = (vehicleData && vehicleData.telemetry) || {};
  const effectiveAt = (vehicleData && (vehicleData.rxAt || vehicleData.at)) || 0;
  const ageMs = Date.now() - effectiveAt;
  const active = isVehicleAwakeNow() && ageMs < 16 * 60000 && !!(tel.climate1cr && tel.climate1cr.active);
  if (active) {
    sendCmd('stop1cr', {});
    return;
  }
  const now = Date.now();
  if (now < arm1crUntil) {
    arm1crUntil = 0;
    sendCmd('start1cr', {});
    return;
  }
  arm1crUntil = now + 5000;
  document.getElementById('lbl1cr').textContent = 'Bấm lần 2!';
  showToast('Bấm nút Đề nổ 1CR thêm 1 lần nữa để xác nhận khởi động làm mát từ xa.', '#ffb020', 5000);
  setTimeout(() => { if (Date.now() >= arm1crUntil) renderAll(); }, 5100);
}

function handleLockTap() {
  sendCmd('lock', {});
}

function handleUnlockTap() {
  const now = Date.now();
  if (now < armUnlockUntil) {
    armUnlockUntil = 0;
    sendCmd('unlock', {});
    return;
  }
  armUnlockUntil = now + 5000;
  const lbl = document.getElementById('lblUnlock');
  if (lbl) lbl.textContent = 'Bấm lần 2!';
  showToast('Bấm Mở khoá thêm 1 lần nữa để xác nhận mở chốt cửa từ xa.', '#ffb020', 5000);
  setTimeout(() => { if (Date.now() >= armUnlockUntil) renderAll(); }, 5100);
}

function handleHornTap() {
  const now = Date.now();
  if (now < armHornUntil) {
    armHornUntil = 0;
    sendCmd('horn', {});
    return;
  }
  armHornUntil = now + 5000;
  const lbl = document.getElementById('lblHorn');
  if (lbl) lbl.textContent = 'Bấm lần 2!';
  showToast('Bấm Bấm còi thêm 1 lần nữa để xác nhận phát còi tìm xe.', '#ffb020', 5000);
  setTimeout(() => { if (Date.now() >= armHornUntil) renderAll(); }, 5100);
}

function saveParkingMemo() {
  const el = document.getElementById('inpParkMemo');
  const note = (el && el.value || '').trim();
  sendCmd('parking_memo', { note }, true);
}

function locateUserOnMap() {
  if (!navigator.geolocation || !navigator.geolocation.getCurrentPosition) {
    showToast('Thiết bị không hỗ trợ định vị GPS trình duyệt.', '#ffb020');
    return;
  }
  showToast('📍 Đang lấy vị trí hiện tại của bạn…', '#38bdf8', 4000);
  navigator.geolocation.getCurrentPosition((gp) => {
    userGeoPos = { lat: gp.coords.latitude, lon: gp.coords.longitude, at: Date.now() };
    renderAll();
    refreshMap();
    const carPos = vehicleData && vehicleData.telemetry && vehicleData.telemetry.pos;
    if (carPos && carPos.lat != null && carPos.lon != null) {
      const dKm = haversineClientKm(userGeoPos.lat, userGeoPos.lon, carPos.lat, carPos.lon);
      const distTxt = dKm < 1 ? (Math.round(dKm * 1000) + ' mét') : (dKm.toFixed(2) + ' km');
      showToast('📍 Đã đo khoảng cách: xe cách bạn ' + distTxt + '!', '#2fd27a', 6000);
    } else {
      showToast('📍 Đã lấy vị trí của bạn — đang chờ toạ độ xe.', '#38bdf8', 5000);
    }
  }, (err) => {
    showToast('Không lấy được vị trí GPS điện thoại: ' + (err && err.message || 'Từ chối quyền'), '#ffb020', 6000);
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
}

function openTimerSheet() {
  document.getElementById('timerSheet').classList.toggle('hidden');
}

function applyTimer() {
  const val = (document.getElementById('timerInput').value || '07:30').split(':');
  sendCmd('timer_set', { hour: Number(val[0]), minute: Number(val[1]) }, true);
}

function cancelTimer() {
  sendCmd('timer_off', {}, true);
}

function saveTimerPrefs() {
  sendCmd('timer_prefs', {
    autoSyncTimer: document.getElementById('chkAutoSync').checked,
    dailyTimer: document.getElementById('timerInput').value || '07:30',
  }, true);
}

function saveValetPrefs() {
  sendCmd('valet_prefs', {
    maxSpeed: Number(document.getElementById('valetSpeed').value) || 45,
    maxRpm: Number(document.getElementById('valetRpm').value) || 3500,
    radiusM: Number(document.getElementById('valetRadius').value) || 500,
  }, true);
}

function requestSchema() {
  sendCmd('schema', {});
}

function sendRaw1cr(saveAsDefault, role) {
  const iface = document.getElementById('inpIface').value.trim();
  const kind = document.getElementById('inpKind').value.trim() || 'setter';
  const name = document.getElementById('inpMember').value.trim();
  if (!iface || !name) {
    requestSchema();
    showToast('Đang tải danh sách hàm Climate từ xe — hãy bấm thẳng nút ⚡ Bật trên thẻ hiện ra bên trên!', '#ffb020', 6000);
    return;
  }
  let payload = null;
  try { payload = JSON.parse(document.getElementById('inpPayload').value); } catch (e) {
    showToast('Payload JSON không hợp lệ', '#ef4444');
    return;
  }
  sendCmd('invoke_raw', {
    iface,
    kind,
    name,
    payload,
    saveAsDefault: !!saveAsDefault,
    role: role || 'start',
  });
}

function quickInvoke1cr(iface, kind, name, payload, saveRole) {
  document.getElementById('inpIface').value = iface;
  document.getElementById('inpKind').value = kind;
  document.getElementById('inpMember').value = name;
  document.getElementById('inpPayload').value = JSON.stringify(payload);
  sendCmd('invoke_raw', {
    iface,
    kind,
    name,
    payload,
    saveAsDefault: !!saveRole,
    role: saveRole || 'start',
  });
}

function exportSchemaJson() {
  if (!lastSchema) return showToast('Hãy bấm Tải danh sách hàm từ xe trước.', '#ffb020');
  const exportObj = {
    ok: true,
    schema: lastSchema.schema || lastSchema,
    telemetry: (vehicleData && vehicleData.telemetry) || null,
    logs: lastSchema.logs || [],
  };
  const jsonText = JSON.stringify(exportObj, null, 2);
  let copied = false;
  if (window.AndroidBridge && window.AndroidBridge.copyToClipboard) {
    try {
      window.AndroidBridge.copyToClipboard(jsonText);
      copied = true;
    } catch (e) {}
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(jsonText).then(() => {
      showToast('📋 Đã copy toàn bộ JSON chẩn đoán vào bộ nhớ tạm — dán gửi thẳng được ngay!', '#2fd27a', 7500);
    }).catch(() => {});
  } else if (copied) {
    showToast('📋 Đã copy toàn bộ JSON chẩn đoán vào bộ nhớ tạm — dán gửi thẳng được ngay!', '#2fd27a', 7500);
  }
  if (!window.AndroidBridge) {
    try {
      const blob = new Blob([jsonText], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'bimmer-link-1cr-diag.json';
      a.click();
    } catch (e) {}
  }
}

/* ---------------- Rendering UI & Map ---------------- */

function setConnBadge(kind, text) {
  const dot = document.getElementById('connDot');
  dot.className = 'dot ' + (kind || '');
  document.getElementById('connLabel').textContent = text;
}

function relTime(ms) {
  if (!ms) return '';
  const sec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (sec < 30) return 'Vừa cập nhật tức thì';
  if (sec < 3600) return 'Cập nhật ' + Math.round(sec / 60) + ' phút trước';
  if (sec < 86400) return 'Cập nhật ' + Math.round(sec / 3600) + ' giờ trước (ngủ 0W)';
  const d = new Date(ms);
  return 'Đỗ lúc ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' ' + d.getDate() + '/' + (d.getMonth() + 1);
}

function syncAvailableModelsDropdown(models) {
  if (!Array.isArray(models) || !models.length) return;
  const sel = document.getElementById('selChassis');
  if (!sel) return;
  const existing = {};
  Array.prototype.forEach.call(sel.options, (o) => { existing[o.value] = true; });
  models.forEach((code) => {
    if (!code || existing[code]) return;
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code + (SERIES_TITLES[code] ? (' — ' + SERIES_TITLES[code]) : '');
    sel.appendChild(opt);
    existing[code] = true;
  });
}

function renderAll() {
  ensureBaseStudioImage();
  const customName = localStorage.getItem('mybmw_car_name') || '';
  const prof = (vehicleData && vehicleData.vehicleProfile) || {};
  syncAvailableModelsDropdown(prof.availableModels);

  if (localAppearance.chassis === 'F90' && (localAppearance.trimLine === 'clubsport' || prof.codedChassis === 'F90LCI' || prof.chassis === 'F90LCI')) {
    localAppearance.chassis = 'F90LCI';
    saveLocal('mybmw_appearance', localAppearance);
  }
  const effChassis = localAppearance.chassis || prof.chassis || '';
  const effTrim = localAppearance.trimLine || prof.trimLine || '';
  const effColour = localAppearance.colour || prof.colour || '';
  const chosenSwatch = findSwatchByColourOrLabel(effColour, localAppearance.colour ? '' : prof.paintLabel);

  const isM5Cs = (effChassis === 'F90LCI' || effChassis === 'F90') && effTrim === 'clubsport';
  const computedSeries = isM5Cs ? 'BMW M5 CS' : (effChassis ? (SERIES_TITLES[effChassis] || ('BMW ' + effChassis)) : (prof.series || 'BMW 5 Series'));
  const computedTrim = isM5Cs ? 'CS' : (effTrim ? (TRIM_LABELS[effTrim] !== undefined ? TRIM_LABELS[effTrim] : '') : (prof.trimLabel || 'M Sport'));
  const autoTitle = (localAppearance.chassis || localAppearance.trimLine)
    ? (isM5Cs ? 'BMW M5 CS' : (computedSeries + (computedTrim && computedSeries.indexOf(computedTrim) < 0 ? (' · ' + computedTrim) : '')))
    : (prof.modelTitle || 'BMW 5 Series · M Sport');

  document.getElementById('carTitle').textContent = customName || autoTitle;
  if (document.activeElement !== document.getElementById('inpCarName')) {
    document.getElementById('inpCarName').value = customName;
  }
  if (document.activeElement !== document.getElementById('selChassis') && localAppearance.chassis) {
    document.getElementById('selChassis').value = localAppearance.chassis;
  }
  if (document.activeElement !== document.getElementById('selTrim') && localAppearance.trimLine) {
    document.getElementById('selTrim').value = localAppearance.trimLine;
  }
  highlightSelectedSwatch();

  const paintLabel = (localAppearance.colour && chosenSwatch) ? chosenSwatch.label : (prof.paintLabel || (chosenSwatch ? chosenSwatch.label : ''));
  const paintChip = document.getElementById('paintBadge');
  const chipParts = [effChassis, paintLabel].filter(Boolean);
  paintChip.textContent = (chipParts.length ? chipParts.join(' · ') : 'Chọn màu & dòng xe') + ' ✎';

  // Render Hero Car: 1) Genuine MGU factory 2D PNG if present, else 2) Real-time carpaint-shaded 3D studio render!
  const useFactory = localStorage.getItem('mybmw_use_factory_hero') !== '0';
  const chkHero = document.getElementById('chkUseFactoryHero');
  if (chkHero) chkHero.checked = useFactory;
  const heroEl = document.getElementById('heroCarImg');
  const targetRgb = (localAppearance.colour && chosenSwatch)
    ? chosenSwatch.rgb
    : ((prof.paintRgb && prof.paintRgb.length === 3) ? prof.paintRgb : (chosenSwatch ? chosenSwatch.rgb : null));

  if (heroEl) {
    if (useFactory && !heroPendingOverride && factoryHero && factoryHero.dataUrl) {
      if (heroEl.src !== factoryHero.dataUrl) heroEl.src = factoryHero.dataUrl;
      heroEl.classList.add('factory-png');
    } else {
      const shadedSrc = targetRgb ? shadeFallbackStudioCar(targetRgb) : 'car-studio.jpg';
      if (heroEl.src !== shadedSrc) heroEl.src = shadedSrc;
      heroEl.classList.remove('factory-png');
    }
  }

  // Tint ambient studio glow subtly to match vehicle paint when parked normally
  const glow = document.getElementById('studioGlow');
  if (glow && targetRgb) {
    glow.style.setProperty('--car-glow', 'rgba(' + targetRgb[0] + ',' + targetRgb[1] + ',' + targetRgb[2] + ',0.42)');
  }

  if (window.AndroidBridge) document.getElementById('androidDownloadCard').classList.add('hidden');
  const unp = document.getElementById('unpairedBanner');
  if (unp) unp.classList.toggle('hidden', !!identity);

  if (!identity) {
    setConnBadge('warn', '📷 Bấm quét QR');
    document.getElementById('updatedLabel').textContent = '📷 Chạm để mở camera quét QR xe';
    return;
  }

  if (!vehicleData) {
    setConnBadge('sleep', 'Đã ghép nối');
    document.getElementById('updatedLabel').textContent = 'Đang chờ bản tin từ đầu xe MGU…';
    return;
  }

  const effectiveStateAt = vehicleData.rxAt || vehicleData.at || 0;
  const ageMs = Date.now() - effectiveStateAt;
  const awake = ageMs >= -300000 && ageMs < 95000;
  const sleepStale = !awake || ageMs >= 16 * 60000;
  const tel = vehicleData.telemetry || {};
  const c1 = tel.climate1cr || {};
  const valet = vehicleData.valet || {};
  const isLegacy03 = !vehicleData.version || vehicleData.version < '0.4.0';

  // Ground-truth transient states: once MGU cuts power to 0W (`!awake`) or exceeds BMW's 15-min 1CR cutoff, NEVER show ghost running state!
  const live1crActive = !!(c1.active && !sleepStale);
  const liveEngineRunning = !!(tel.engineRunning && !sleepStale);
  // If Option 302 DWA is armed (`DWA_GESCHAERFT`), central locking is physically locked even if CKM settings reported unlocked!
  const effectiveLocked = tel.dwaArmed === true ? true : tel.locked;

  setConnBadge(awake ? 'live' : 'sleep', awake ? 'Trực tuyến' : 'Đang ngủ (Lưu đệm)');
  document.getElementById('updatedLabel').textContent = relTime(effectiveStateAt);

  const atm2Dock = document.getElementById('atm2Dock');
  if (atm2Dock) atm2Dock.classList.toggle('hidden', !vehicleData.atm2Online);

  const hasWinWarn = !!(tel.windowsOpen && tel.windowsOpen.length);
  const parkedUnlocked = effectiveLocked === false && !liveEngineRunning && (tel.condition == null || tel.condition < 7);
  const hasDoorWarn = !!(tel.dwaAlarmActive || (tel.doorsOpen && tel.doorsOpen.length) || hasWinWarn || tel.trunkOpen || tel.hoodOpen || parkedUnlocked);
  glow.className = 'studio-glow' + (hasDoorWarn ? ' alert-on' : (live1crActive ? ' climate-on' : ''));

  const sec = document.getElementById('securityBanner');
  if (hasDoorWarn) {
    sec.className = 'lock-banner warn';
    if (tel.dwaAlarmActive) {
      sec.textContent = '🚨 BÁO ĐỘNG CHỐNG TRỘM DWA ĐANG KÍCH HOẠT!';
    } else if (tel.trunkOpen && tel.hoodOpen) {
      sec.textContent = '⚠️ NẮP CAPO & CỐP SAU ĐANG MỞ';
    } else if (tel.trunkOpen) {
      sec.textContent = '⚠️ CỐP SAU ĐANG MỞ';
    } else if (tel.hoodOpen) {
      sec.textContent = '⚠️ NẮP CAPO ĐANG MỞ';
    } else if (tel.doorsOpen && tel.doorsOpen.length) {
      sec.textContent = '⚠️ CỬA XE ĐANG MỞ (' + tel.doorsOpen.join(', ').toUpperCase() + ')';
    } else if (hasWinWarn) {
      sec.textContent = '⚠️ KÍNH CHƯA ĐÓNG KÍN (' + tel.windowsOpen.join(', ').toUpperCase() + ')';
    } else {
      sec.textContent = '🔓 XE CHƯA KHOÁ (KHOÁ CỬA ĐỂ ĐỀ NỔ 1CR)';
    }
  } else {
    sec.className = 'lock-banner';
    const c1Banner = c1.mode === 'engine_1cr'
      ? '🔥 ĐỘNG CƠ 1CR ĐANG NỔ LÀM MÁT'
      : (c1.mode === 'vent_only' ? '🌬️ QUẠT THÔNG GIÓ CABIN ĐANG CHẠY' : '❄️ ĐIỀU HOÀ ĐỖ XE ĐANG CHẠY (CHƯA NỔ MÁY)');
    sec.textContent = live1crActive
      ? c1Banner
      : (liveEngineRunning ? ('🟢 ĐANG VẬN HÀNH (' + (tel.speed || 0) + ' KM/H)') : (!awake ? '🔒 ĐÃ ĐỖ & NGỦ SÂU 0W AN TOÀN' : (effectiveLocked === true ? '🔒 ĐÃ ĐỖ & KHOÁ AN TOÀN' : '🅿️ ĐANG ĐỖ TRONG XE')));
  }

  renderSecurityPills(Object.assign({}, tel, { locked: effectiveLocked, _liveEngineRunning: liveEngineRunning }));
  renderCheckControlAlerts(tel);

  const kombiHint = document.getElementById('kombiHint');
  if (kombiHint) {
    kombiHint.classList.add('hidden');
  }

  // Fuel & Range (with client-side tank estimation fallback if car hasn't broadcast KOMBI range yet)
  let dispRange = (tel.rangeKm != null && !(isLegacy03 && tel.fuelPct == null && tel.rangeKm === 20)) ? tel.rangeKm : null;
  let isEstRange = !!tel.rangeEstimated;
  if (dispRange == null && tel.fuelPct != null && tel.fuelPct > 0) {
    const fullTankKm = /^G0[567]/.test(effChassis) ? 690 : (/^G0[12]/.test(effChassis) ? 620 : (/^G2/.test(effChassis) ? 610 : 650));
    dispRange = Math.round((tel.fuelPct / 100) * fullTankKm);
    isEstRange = true;
  }
  document.getElementById('rangeKm').innerHTML = (dispRange != null ? ((isEstRange ? '~' : '') + dispRange) : '--') + ' <span>km</span>';
  const fuelLabel = tel.fuelPct != null
    ? (tel.fuelPct + '%' + (tel.fuelLiters != null ? (' · ' + tel.fuelLiters + 'L') : ''))
    : (tel.fuelLiters != null ? (tel.fuelLiters + ' L') : '--%');
  document.getElementById('fuelPct').textContent = fuelLabel;
  document.getElementById('fuelFill').style.width = Math.max(0, Math.min(100, tel.fuelPct || 0)) + '%';

  const btnLock = document.getElementById('btnLock');
  if (btnLock) btnLock.className = 'act-btn' + (effectiveLocked === true ? ' active-go' : '');
  const lblLock = document.getElementById('lblLock');
  if (lblLock) lblLock.textContent = effectiveLocked === true ? 'Đã khoá' : 'Khoá xe';

  const btnUnlock = document.getElementById('btnUnlock');
  if (btnUnlock) btnUnlock.className = 'act-btn' + (effectiveLocked === false ? ' active-warn' : '');
  if (Date.now() >= armUnlockUntil) {
    const lblUnlock = document.getElementById('lblUnlock');
    if (lblUnlock) lblUnlock.textContent = 'Mở khoá';
  }
  if (Date.now() >= armHornUntil) {
    const lblHorn = document.getElementById('lblHorn');
    if (lblHorn) lblHorn.textContent = 'Bấm còi';
  }

  const btn1 = document.getElementById('btn1cr');
  const fan = document.getElementById('fanIcon');
  btn1.className = 'act-btn' + (live1crActive && c1.mode !== 'vent_only' ? ' active-go' : '');
  fan.classList.toggle('fan-spin', !!(live1crActive && c1.mode !== 'vent_only'));
  if (Date.now() >= arm1crUntil) {
    document.getElementById('lbl1cr').textContent = (live1crActive && c1.mode !== 'vent_only') ? 'Tắt 1CR' : 'Đề nổ 1CR';
  }

  const btnVent = document.getElementById('btnVent');
  const lblVent = document.getElementById('lblVent');
  const ventOn = !!(live1crActive && c1.mode === 'vent_only');
  if (btnVent) btnVent.className = 'act-btn' + (ventOn ? ' active-go' : '');
  if (lblVent) lblVent.textContent = ventOn ? 'Tắt quạt' : 'Thông gió';

  const btnV = document.getElementById('btnValet');
  btnV.className = 'sub-act-btn' + (valet.enabled ? ' active-warn' : '');
  document.getElementById('lblValet').textContent = valet.enabled ? '🛡️ Chế độ Valet: Đang Bật' : '🛡️ Chế độ Valet: Tắt';

  const hasTimer = vehicleData.timerEnabled !== false && c1.timerText && c1.timerText !== 'Tắt';
  document.getElementById('btnTimerQuick').className = 'act-btn' + (hasTimer ? ' active-go' : '');
  document.getElementById('lblTimer').textContent = hasTimer ? ('Hẹn ' + c1.timerText) : 'Hẹn giờ 1CR';

  const pm = (vehicleData && vehicleData.parkingMemo) || {};
  const homeMemoEl = document.getElementById('homeParkMemoBadge');
  if (homeMemoEl) {
    if (pm.note) {
      homeMemoEl.textContent = '📌 Chỗ đỗ: ' + pm.note;
      homeMemoEl.classList.remove('hidden');
    } else {
      homeMemoEl.classList.add('hidden');
    }
  }
  const inpMemo = document.getElementById('inpParkMemo');
  if (inpMemo && document.activeElement !== inpMemo) {
    inpMemo.value = pm.note || '';
  }
  const parkBadge = document.getElementById('parkTimerBadge');
  if (parkBadge) {
    const parkedSince = pm.parkedAt || (!liveEngineRunning && vehicleData.at ? vehicleData.at : 0);
    if (!liveEngineRunning && parkedSince > 0 && Date.now() >= parkedSince - 60000) {
      const mins = Math.max(1, Math.round((Date.now() - parkedSince) / 60000));
      const durTxt = mins >= 1440
        ? (Math.floor(mins / 1440) + ' ngày ' + Math.floor((mins % 1440) / 60) + ' giờ')
        : (mins >= 60 ? (Math.floor(mins / 60) + ' giờ ' + (mins % 60) + ' phút') : (mins + ' phút'));
      parkBadge.textContent = '⏱️ Đã đỗ ' + durTxt;
      parkBadge.classList.remove('hidden');
    } else {
      parkBadge.classList.add('hidden');
    }
  }
  const walkBadge = document.getElementById('walkDistBadge');
  if (walkBadge) {
    if (userGeoPos && tel.pos && tel.pos.lat != null && tel.pos.lon != null) {
      const dKm = haversineClientKm(userGeoPos.lat, userGeoPos.lon, tel.pos.lat, tel.pos.lon);
      walkBadge.textContent = dKm < 1 ? ('📏 Cách bạn ' + Math.round(dKm * 1000) + ' m') : ('📏 Cách bạn ' + dKm.toFixed(1) + ' km');
      walkBadge.classList.remove('hidden');
    } else {
      walkBadge.classList.add('hidden');
    }
  }

  // Vitals
  const validOdo = (tel.odometerKm != null && !(isLegacy03 && tel.fuelPct == null && tel.odometerKm < 300)) ? tel.odometerKm : null;
  document.getElementById('odoText').textContent = 'ODO: ' + (validOdo != null ? validOdo.toLocaleString('vi-VN') : '--') + ' km';
  document.getElementById('mBat').textContent = tel.battery12v != null ? (tel.battery12v + ' V') : 'Ổn định';
  document.getElementById('mTemp').textContent = (tel.ambientC != null ? tel.ambientC + '°C' : '--') + (tel.cabinC != null ? (' / ' + tel.cabinC + '°C') : '');
  document.getElementById('mEngTemp').textContent = (tel.coolantC != null ? tel.coolantC + '°C' : '--') + (tel.oilC != null ? (' / ' + tel.oilC + '°C') : '');
  const c1BoxText = live1crActive
    ? (c1.mode === 'engine_1cr' ? 'Đang nổ 1CR' : (c1.mode === 'vent_only' ? 'Quạt cabin' : 'Đang bật AC'))
    : (hasTimer ? ('Hẹn ' + c1.timerText) : (!awake ? 'Đã ngủ 0W' : (c1.discoveredCount ? ('Sẵn sàng (' + c1.discoveredCount + ' cổng)') : 'Sẵn sàng')));
  document.getElementById('m1cr').textContent = c1BoxText;

  if (latestSnap && latestSnap.dataUrl) {
    ensureSnapCrops();
    updateSnapDisplay();
    document.getElementById('snapTime').textContent = relTime(latestSnap.rxAt || latestSnap.at);
  }

  if (document.activeElement.tagName !== 'INPUT') {
    if (vehicleData.dailyTimer) document.getElementById('timerInput').value = vehicleData.dailyTimer;
    document.getElementById('chkAutoSync').checked = !!vehicleData.autoSyncTimer;
    if (valet.maxSpeed) document.getElementById('valetSpeed').value = valet.maxSpeed;
    if (valet.maxRpm) document.getElementById('valetRpm').value = valet.maxRpm;
    if (valet.radiusM) document.getElementById('valetRadius').value = valet.radiusM;
  }

  const trips = vehicleData.trips || (vehicleData.lastTrip ? [vehicleData.lastTrip] : []);
  renderTpmsCard(tel);
  renderHealthAndService(tel, validOdo);
  renderActiveDestination(tel);
  renderTripAnalytics(trips, effChassis);
  if (mapInstance && !document.getElementById('view-map').classList.contains('hidden')) {
    refreshMap();
  }

  const tBox = document.getElementById('tripList');
  if (trips.length) {
    tBox.innerHTML = trips.map((tr) => {
      const d = new Date(tr.endedAt || Date.now());
      const when = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' · ' + d.getDate() + '/' + (d.getMonth() + 1);
      return '<div class="trip-item"><div><b>' + tr.distanceKm + ' km</b> <span style="color:var(--dim)">(' + tr.durationMin + ' phút · TB ' + (tr.avgSpeed || 0) + ' km/h)</span><div style="font-size:11.5px;color:var(--dim)">' + when + '</div></div>' +
        '<div style="text-align:right;color:var(--cyan);font-weight:700">Max ' + tr.maxSpeed + ' km/h' + (tr.fuelUsedPct != null ? '<div style="font-size:11px;color:var(--dim)">-' + tr.fuelUsedPct + '% xăng</div>' : '') + '</div></div>';
    }).join('');
  } else {
    tBox.textContent = 'Chưa có chuyến đi nào.';
  }
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderSecurityPills(tel) {
  const box = document.getElementById('securityPills');
  if (!box) return;
  const pills = [];
  const dList = Array.isArray(tel.doorsOpen) ? tel.doorsOpen : [];
  pills.push({
    cls: dList.length ? 'warn' : 'ok',
    txt: dList.length ? ('⚠️ Mở: ' + dList.join(', ')) : '✓ 4 Cửa kín',
  });
  const wOpen = tel.windowsOpen || [];
  const wd = tel.windowDetails || {};
  const hasKnownClosedWin = wd.fl === 'closed' || wd.fr === 'closed' || wd.rl === 'closed' || wd.rr === 'closed';
  if (wOpen.length) {
    pills.push({ cls: 'warn', txt: '⚠️ Mở: ' + wOpen.join(', ') });
  } else if (hasKnownClosedWin) {
    pills.push({ cls: 'ok', txt: '✓ 4 Kính kín' + (wd.sunroof === 'closed' ? ' · Cửa trời kín' : '') });
  } else {
    pills.push({ cls: 'ok', txt: '✓ Kính đóng kín' });
  }
  if (tel.trunkOpen && tel.hoodOpen) {
    pills.push({ cls: 'warn', txt: '⚠️ Cốp & Capo mở' });
  } else if (tel.trunkOpen || tel.hoodOpen) {
    pills.push({ cls: 'warn', txt: tel.trunkOpen ? '⚠️ Cốp sau mở' : '⚠️ Capo mở' });
  } else {
    pills.push({ cls: 'ok', txt: '✓ Cốp & Capo kín' });
  }
  if (tel.dwaAlarmActive) {
    pills.push({ cls: 'crit', txt: '🚨 Báo động DWA!' });
  } else if (tel.dwaArmed === true) {
    pills.push({ cls: 'ok', txt: '🛡️ Chống trộm DWA' });
  } else if (tel.locked === true) {
    pills.push({ cls: 'ok', txt: '🔒 Đã chốt khoá' });
  } else if (tel.locked === false) {
    pills.push({ cls: (!tel._liveEngineRunning && (tel.condition == null || tel.condition < 7)) ? 'warn' : 'ok', txt: '🔓 Chưa khoá' });
  }
  box.innerHTML = pills.map((p) => '<span class="sec-pill ' + p.cls + '">' + escHtml(p.txt) + '</span>').join('');
}

function renderCheckControlAlerts(tel) {
  const cc = (tel && Array.isArray(tel.checkControl)) ? tel.checkControl : [];
  const html = cc.map((it) => {
    const isCrit = it.severity === 'crit';
    const icon = isCrit ? '🔴' : '⚠️';
    return '<div class="cc-alert-row' + (isCrit ? ' crit' : '') + '"><span>' + icon + ' Check-Control: ' + escHtml(it.name) + '</span></div>';
  }).join('');
  const homeBox = document.getElementById('homeCcList');
  if (homeBox) homeBox.innerHTML = html;
  const healthBox = document.getElementById('healthCcList');
  if (healthBox) healthBox.innerHTML = html;
}

function formatTirePressure(bar) {
  if (bar == null || typeof bar !== 'number' || !isFinite(bar)) return '--';
  if (tireUnit === 'psi') return Math.round(bar * 14.5038) + ' PSI';
  return bar.toFixed(1) + ' bar';
}

function toggleTireUnit() {
  tireUnit = tireUnit === 'bar' ? 'psi' : 'bar';
  localStorage.setItem('mybmw_tire_unit', tireUnit);
  renderAll();
}

function renderTpmsCard(tel) {
  const btn = document.getElementById('btnTireUnit');
  if (btn) btn.textContent = 'Đơn vị: ' + (tireUnit === 'psi' ? 'PSI' : 'bar');
  const tr = (tel && tel.tires) || {};
  const defs = [
    ['Fl', 'fl', 'targetFl', 'tempFl', false],
    ['Fr', 'fr', 'targetFr', 'tempFr', true],
    ['Rl', 'rl', 'targetRl', 'tempRl', false],
    ['Rr', 'rr', 'targetRr', 'tempRr', true],
  ];
  let anyActual = false;
  let anyTarget = false;
  let lowCount = 0;
  for (let i = 0; i < defs.length; i++) {
    const suf = defs[i][0], ak = defs[i][1], tk = defs[i][2], tmk = defs[i][3], isRight = defs[i][4];
    const actual = tr[ak];
    const tgt = tr[tk];
    const tempC = tr[tmk];
    if (typeof actual === 'number') anyActual = true;
    if (typeof tgt === 'number') anyTarget = true;
    const isLow = typeof actual === 'number' && (actual < 1.85 || (typeof tgt === 'number' && actual < tgt - 0.3));
    if (isLow) lowCount++;
    const valEl = document.getElementById('tpms' + suf);
    const tgtEl = document.getElementById('tpmsTgt' + suf);
    const boxEl = document.getElementById('tpmsBox' + suf);
    if (valEl) valEl.textContent = formatTirePressure(actual);
    const tempSuffix = (typeof tempC === 'number' && isFinite(tempC)) ? (' · ' + tempC + '°C') : '';
    if (tgtEl) tgtEl.textContent = 'Chuẩn: ' + (typeof tgt === 'number' ? formatTirePressure(tgt) : formatTirePressure(2.4)) + tempSuffix;
    if (boxEl) {
      boxEl.className = 'tpms-wheel' + (isRight ? ' right' : '') + (typeof actual === 'number' ? (isLow ? ' warn' : ' ok') : '');
    }
  }
  const noteEl = document.getElementById('tpmsNote');
  if (noteEl) {
    if (lowCount > 0) {
      noteEl.style.color = 'var(--warn)';
      noteEl.textContent = '⚠️ Phát hiện ' + lowCount + ' lốp non hơi so với áp suất tiêu chuẩn BMW!';
    } else if (anyActual) {
      noteEl.style.color = 'var(--go)';
      noteEl.textContent = '✅ Áp suất 4 lốp đạt chuẩn · Đọc trực tiếp từ cảm biến RDC của xe.';
    } else if (anyTarget) {
      noteEl.style.color = 'var(--dim)';
      noteEl.textContent = 'Mức chuẩn xe: ' + formatTirePressure(tr.targetFl || 2.5) + ' (trước) / ' + formatTirePressure(tr.targetRl || 2.5) + ' (sau) · Cảm biến RDC cập nhật áp suất thực khi bánh lăn.';
    } else {
      noteEl.style.color = 'var(--dim)';
      noteEl.textContent = 'Đọc trực tiếp từ bộ thu RDC / TPMS của xe.';
    }
  }
}

const DEFAULT_ECU_LIST = [
  { name: 'DME (Động cơ)', ok: null },
  { name: 'EGS (Hộp số ZF)', ok: null },
  { name: 'BDC (Thân vỏ & Chìa)', ok: null },
  { name: 'DSC (Phanh DSC)', ok: null },
  { name: 'IHKA (Điều hoà)', ok: null },
  { name: 'KOMBI (Đồng hồ)', ok: null },
  { name: 'HU_MGU (Màn hình)', ok: null },
  { name: 'ICAM (Cam 360°)', ok: null },
];

function setHealthScanBusy(on) {
  healthScanBusy = !!on;
  const btn = document.getElementById('btnScanHealth');
  if (!btn) return;
  btn.disabled = !!on;
  btn.style.opacity = on ? '0.72' : '1';
  btn.textContent = on ? '⏳ Đang quét các hộp ECU trên xe…' : '🩺 Quét sức khoẻ các hộp ECU ngay';
}

function triggerHealthScan() {
  if (healthScanBusy) return;
  setHealthScanBusy(true);
  setTimeout(() => { if (healthScanBusy) setHealthScanBusy(false); }, 25000);
  sendCmd('scan_health', {});
}

function renderHealthAndService(tel, validOdo) {
  const h = tel && tel.health;
  const hBanner = document.getElementById('healthBanner');
  const hBadge = document.getElementById('healthTimeBadge');
  const grid = document.getElementById('ecuHealthGrid');
  const faultBox = document.getElementById('dtcFaultList');

  if (h && h.checkedAt) {
    if (hBadge) hBadge.textContent = relTime(h.checkedAt);
    const ans = Number(h.ecusAnswered) || 0;
    const scanned = Number(h.ecusScanned) || 8;
    const clean = ans > 0 && h.activeFaultCount === 0 && h.storedFaultCount === 0;
    if (hBanner) {
      if (ans === 0) {
        hBanner.className = 'health-banner warn';
        hBanner.textContent = '⚠️ Chưa nhận được phản hồi UDS (0 hộp ECU trả lời) — hãy bật khoá điện / nổ máy xe rồi bấm Quét lại.';
      } else {
        hBanner.className = 'health-banner ' + (h.activeFaultCount > 0 ? 'warn' : 'ok');
        hBanner.textContent = clean
          ? ('✅ TẤT CẢ HỆ THỐNG HOÀN HẢO · Đã quét ' + ans + ' hộp ECU: 0 mã lỗi!')
          : ('⚠️ Đã quét ' + ans + '/' + scanned + ' hộp ECU: ' + h.activeFaultCount + ' lỗi hiện hữu · ' + h.storedFaultCount + ' mã lưu bộ nhớ.');
      }
    }
    if (grid) {
      const mods = (h.modules && h.modules.length) ? h.modules : DEFAULT_ECU_LIST;
      grid.innerHTML = mods.map((m) => {
        const cls = m.ok === true ? 'ok' : (m.ok === false ? 'warn' : 'dim');
        const st = m.ok === true ? '✓ 0 lỗi' : (m.ok === false ? ('⚠️ ' + m.faultCount + ' mã') : 'Ngủ/Chờ');
        return '<div class="ecu-pill ' + cls + '"><span class="nm">' + escHtml(m.name) + '</span><span class="st">' + escHtml(st) + '</span></div>';
      }).join('');
    }
    if (faultBox) {
      const fl = h.faults || [];
      faultBox.innerHTML = fl.map((f) =>
        '<div class="dtc-item"><div><b>0x' + escHtml(f.code) + '</b> · <span style="color:var(--dim)">' + escHtml(f.ecuName) + '</span></div>' +
        '<span style="font-weight:700;color:' + (f.severity === 'crit' ? 'var(--crit)' : 'var(--warn)') + '">' + escHtml(f.statusLabel) + '</span></div>'
      ).join('');
    }
  } else {
    if (grid && !grid.innerHTML) {
      grid.innerHTML = DEFAULT_ECU_LIST.map((m) =>
        '<div class="ecu-pill dim"><span class="nm">' + escHtml(m.name) + '</span><span class="st">Chờ quét</span></div>'
      ).join('');
    }
  }

  // Native KOMBI CBS Service Items (`KombiInterface_2.cbsDataServiceList`)
  const kombiCbsBox = document.getElementById('kombiCbsBox');
  if (kombiCbsBox) {
    const cbsList = (tel && Array.isArray(tel.cbsList)) ? tel.cbsList : [];
    if (cbsList.length) {
      kombiCbsBox.innerHTML =
        '<div style="font-size:11px;font-weight:700;color:var(--dim);text-transform:uppercase;margin-bottom:6px">Trạng thái CBS gốc trên đồng hồ xe</div>' +
        cbsList.map((it) => {
          const rightParts = [it.way, it.date].filter(Boolean).join(' · ') || 'OK';
          const col = it.severity === 'crit' ? 'var(--crit)' : (it.severity === 'warn' ? 'var(--warn)' : 'var(--go)');
          return '<div class="cbs-native-row ' + escHtml(it.severity || 'ok') + '">' +
            '<span style="font-weight:700;color:#e2e8f0">' + escHtml(it.name) + '</span>' +
            '<span style="font-weight:700;color:' + col + '">' + escHtml(rightParts) + '</span></div>';
        }).join('');
    } else {
      kombiCbsBox.innerHTML = '';
    }
  }

  // Service Plan (ODO-based)
  const sp = (vehicleData && vehicleData.servicePlan) || { oilDueKm: 0, oilIntervalKm: 8000, checkDueKm: 0, brakeFluidDue: '' };
  const odoBadge = document.getElementById('svcOdoBadge');
  if (odoBadge) odoBadge.textContent = 'ODO: ' + (validOdo != null ? validOdo.toLocaleString('vi-VN') : '--') + ' km';

  const selInt = document.getElementById('selOilInterval');
  if (selInt && document.activeElement !== selInt && sp.oilIntervalKm) {
    selInt.value = String(sp.oilIntervalKm);
  }
  const inpBrake = document.getElementById('inpBrakeFluidDue');
  if (inpBrake && document.activeElement !== inpBrake) {
    inpBrake.value = sp.brakeFluidDue || '';
  }
  const brakeBadge = document.getElementById('svcBrakeBadge');
  if (brakeBadge) {
    brakeBadge.textContent = sp.brakeFluidDue ? ('Hạn: ' + sp.brakeFluidDue) : 'Chưa đặt';
    brakeBadge.style.color = sp.brakeFluidDue ? 'var(--go)' : 'var(--dim)';
  }

  // Oil progress
  const oilRemEl = document.getElementById('svcOilRemain');
  const oilFillEl = document.getElementById('svcOilFill');
  const oilSubEl = document.getElementById('svcOilSub');
  if (oilRemEl && oilFillEl && oilSubEl) {
    if (sp.oilDueKm > 0 && validOdo != null) {
      const rem = sp.oilDueKm - validOdo;
      const span = sp.oilIntervalKm || 8000;
      const pct = Math.max(4, Math.min(100, Math.round((rem / span) * 100)));
      oilRemEl.textContent = rem >= 0 ? ('Còn ' + rem.toLocaleString('vi-VN') + ' km') : ('Quá hạn ' + Math.abs(rem).toLocaleString('vi-VN') + ' km!');
      oilRemEl.style.color = rem <= 0 ? 'var(--crit)' : (rem <= 1200 ? 'var(--warn)' : 'var(--go)');
      oilFillEl.style.width = (rem <= 0 ? 100 : pct) + '%';
      oilFillEl.className = 'svc-fill' + (rem <= 0 ? ' crit' : (rem <= 1200 ? ' warn' : ''));
      oilSubEl.textContent = 'Mốc thay dầu tiếp theo: ' + sp.oilDueKm.toLocaleString('vi-VN') + ' km (chu kỳ ' + span.toLocaleString('vi-VN') + ' km).';
    } else {
      oilRemEl.textContent = 'Chưa đặt mốc';
      oilRemEl.style.color = 'var(--dim)';
      oilFillEl.style.width = '100%';
      oilFillEl.className = 'svc-fill';
      oilSubEl.textContent = validOdo != null
        ? ('ODO hiện tại ' + validOdo.toLocaleString('vi-VN') + ' km — bấm "Vừa thay dầu xong" để đếm lùi tự động!')
        : 'Đang chờ ODO thực tế từ xe…';
    }
  }

  // Vehicle Check progress
  const chkRemEl = document.getElementById('svcCheckRemain');
  const chkFillEl = document.getElementById('svcCheckFill');
  const chkSubEl = document.getElementById('svcCheckSub');
  if (chkRemEl && chkFillEl && chkSubEl) {
    if (sp.checkDueKm > 0 && validOdo != null) {
      const rem = sp.checkDueKm - validOdo;
      const pct = Math.max(4, Math.min(100, Math.round((rem / 15000) * 100)));
      chkRemEl.textContent = rem >= 0 ? ('Còn ' + rem.toLocaleString('vi-VN') + ' km') : ('Quá hạn ' + Math.abs(rem).toLocaleString('vi-VN') + ' km!');
      chkRemEl.style.color = rem <= 0 ? 'var(--crit)' : (rem <= 1500 ? 'var(--warn)' : 'var(--go)');
      chkFillEl.style.width = (rem <= 0 ? 100 : pct) + '%';
      chkFillEl.className = 'svc-fill' + (rem <= 0 ? ' crit' : (rem <= 1500 ? ' warn' : ''));
      chkSubEl.textContent = 'Mốc kiểm tra tiếp theo: ' + sp.checkDueKm.toLocaleString('vi-VN') + ' km.';
    } else {
      chkRemEl.textContent = 'Chưa đặt mốc';
      chkRemEl.style.color = 'var(--dim)';
      chkFillEl.style.width = '100%';
      chkFillEl.className = 'svc-fill';
    }
  }
}

function saveOilInterval() {
  const interval = Number(document.getElementById('selOilInterval').value) || 8000;
  sendCmd('service_prefs', { oilIntervalKm: interval }, true);
}

function resetServiceItem(kind) {
  if (kind === 'oil') {
    const interval = Number(document.getElementById('selOilInterval').value) || 8000;
    sendCmd('service_prefs', { oilIntervalKm: interval, resetOilNow: true }, true);
  } else if (kind === 'check') {
    sendCmd('service_prefs', { resetCheckNow: true }, true);
  }
}

function saveBrakeFluidDate() {
  const due = (document.getElementById('inpBrakeFluidDue').value || '').trim();
  sendCmd('service_prefs', { brakeFluidDue: due }, true);
}

/* ---------------- Send Destination to Car & Trip Analytics ---------------- */

function haversineClientKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function parseInputCoords(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const mAt = /@(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/.exec(s);
  const mParam = /[?&](?:q|ll|destination|daddr|query)=(-?\d{1,2}\.\d{3,}),\s*(-?\d{1,3}\.\d{3,})/.exec(s);
  const mPair = /^\s*(-?\d{1,2}\.\d{3,})\s*[,;\s]\s*(-?\d{1,3}\.\d{3,})\s*$/.exec(s);
  const hit = mAt || mParam || mPair;
  if (!hit) return null;
  const lat = Number(hit[1]), lon = Number(hit[2]);
  if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

function dedupeAddressParts(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = String(parts[i] || '').trim();
    if (!p) continue;
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  return out;
}

function formatPhotonFeature(f, fallbackName) {
  const p = (f && f.properties) || {};
  const g = (f && f.geometry && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : null;
  if (!g || g.length < 2) return null;
  const lon = Number(g[0]), lat = Number(g[1]);
  if (!isFinite(lat) || !isFinite(lon)) return null;
  const streetFull = [p.housenumber, p.street].filter(Boolean).join(' ');
  const title = p.name || streetFull || p.district || p.city || fallbackName || 'Địa điểm';
  const addrParts = dedupeAddressParts([
    p.name ? streetFull : '',
    p.district || p.suburb || p.locality || p.county || '',
    p.city || p.state || '',
  ]).filter((x) => x.toLowerCase() !== String(title).toLowerCase());
  return {
    name: title,
    address: addrParts.join(', ') || (lat.toFixed(5) + ', ' + lon.toFixed(5)),
    lat,
    lon,
  };
}

async function searchDestination() {
  const qEl = document.getElementById('inpDestQuery');
  const box = document.getElementById('destResults');
  const q = (qEl && qEl.value || '').trim();
  if (!q) return showToast('Hãy nhập tên địa điểm hoặc dán toạ độ trước.', '#ffb020');

  const direct = parseInputCoords(q);
  if (direct) {
    lastDestHits = [{
      name: 'Toạ độ ghim (' + direct.lat.toFixed(4) + ', ' + direct.lon.toFixed(4) + ')',
      address: direct.lat.toFixed(6) + ', ' + direct.lon.toFixed(6),
      lat: direct.lat,
      lon: direct.lon,
    }];
    renderDestHits();
    return;
  }

  box.innerHTML = '<div style="color:var(--dim);padding:6px 0">Đang tìm địa điểm…</div>';
  const carPos = vehicleData && vehicleData.telemetry && vehicleData.telemetry.pos;
  const bias = (carPos && isFinite(carPos.lat) && isFinite(carPos.lon))
    ? ('&lat=' + encodeURIComponent(carPos.lat.toFixed(4)) + '&lon=' + encodeURIComponent(carPos.lon.toFixed(4)))
    : '&lat=10.7769&lon=106.7009';

  try {
    // Primary CORS-enabled geocoder (`Access-Control-Allow-Origin: *`, works inside Android WebView `app.mybmw.local` & iOS PWA)
    let hits = [];
    try {
      const pUrl = 'https://photon.komoot.io/api/?limit=5' + bias + '&q=' + encodeURIComponent(q);
      const pr = await fetch(pUrl, { headers: { Accept: 'application/json' } });
      if (pr.ok) {
        const pj = await pr.json();
        hits = ((pj && pj.features) || []).map((f) => formatPhotonFeature(f, q)).filter(Boolean);
      }
    } catch (ePhoton) {}

    if (!hits.length) {
      const nUrl = 'https://nominatim.openstreetmap.org/search?format=json&limit=4&accept-language=vi&q=' + encodeURIComponent(q);
      const nr = await fetch(nUrl, { headers: { Accept: 'application/json' } });
      if (nr.ok) {
        const arr = await nr.json();
        if (Array.isArray(arr)) {
          hits = arr.slice(0, 4).map((it) => {
            const parts = String(it.display_name || '').split(',').map((s) => s.trim()).filter(Boolean);
            return {
              name: it.name || parts[0] || q,
              address: parts.slice(1, 4).join(', '),
              lat: Number(it.lat),
              lon: Number(it.lon),
            };
          }).filter((x) => isFinite(x.lat) && isFinite(x.lon));
        }
      }
    }

    if (!hits.length) {
      box.innerHTML = '<div style="color:var(--warn);padding:6px 0">Không tìm thấy địa điểm khớp — hãy thử gõ rõ hơn (VD: "Sân bay Tân Sơn Nhất") hoặc dán toạ độ lat,lon từ Google Maps.</div>';
      return;
    }
    lastDestHits = hits.slice(0, 5);
    renderDestHits();
  } catch (e) {
    box.innerHTML = '<div style="color:var(--crit);padding:6px 0">Không kết nối được máy chủ bản đồ (' + escHtml(e.message) + ') — hãy kiểm tra mạng 4G/Wi-Fi hoặc dán trực tiếp toạ độ lat,lon.</div>';
  }
}

function renderDestHits() {
  const box = document.getElementById('destResults');
  if (!box) return;
  const carPos = vehicleData && vehicleData.telemetry && vehicleData.telemetry.pos;
  box.innerHTML = lastDestHits.map((h, idx) => {
    const dist = carPos ? (' · Cách xe ' + haversineClientKm(carPos.lat, carPos.lon, h.lat, h.lon).toFixed(1) + ' km') : '';
    return '<div class="dest-item">' +
      '<div style="min-width:0;flex:1"><div style="font-weight:700;color:#f8fafc">' + escHtml(h.name) + '</div>' +
      '<div style="font-size:11.5px;color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(h.address) + escHtml(dist) + '</div></div>' +
      '<button type="button" class="btn blue" style="flex:0 0 auto;min-width:86px;padding:7px 11px;font-size:12px" onclick="pickDestResult(' + idx + ')">🚀 Gửi xe</button>' +
      '</div>';
  }).join('');
}

function pickDestResult(idx) {
  const h = lastDestHits[idx];
  if (!h) return;
  sendCmd('send_destination', { name: h.name, address: h.address, lat: h.lat, lon: h.lon }, true);
  document.getElementById('destResults').innerHTML = '';
}

function clearCarDestination() {
  sendCmd('clear_destination', {}, true);
}

function openSentDestinationMaps() {
  const dst = vehicleData && vehicleData.destination;
  if (!dst || dst.lat == null || dst.lon == null) return showToast('Chưa có điểm đến đã ghim.', '#ffb020');
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const url = isIOS
    ? ('http://maps.apple.com/?daddr=' + dst.lat + ',' + dst.lon + '&dirflg=d')
    : ('https://www.google.com/maps/dir/?api=1&destination=' + dst.lat + ',' + dst.lon + '&travelmode=driving');
  window.open(url, '_blank');
}

function renderActiveDestination(tel) {
  const box = document.getElementById('sentDestBox');
  if (!box) return;
  const dst = vehicleData && vehicleData.destination;
  if (!dst || !dst.name) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const distTxt = (tel && tel.pos && dst.lat != null && dst.lon != null)
    ? (' · Cách xe ' + haversineClientKm(tel.pos.lat, tel.pos.lon, dst.lat, dst.lon).toFixed(1) + ' km')
    : '';
  const navTag = dst.navSynced ? '🧭 Đã đẩy vào Dẫn đường xe: ' : '📌 Đang ghim trên màn hình xe: ';
  document.getElementById('sentDestTitle').textContent = navTag + dst.name;
  document.getElementById('sentDestSub').textContent = (dst.address || (dst.lat.toFixed(4) + ', ' + dst.lon.toFixed(4))) + distTxt;
}

function renderTripAnalytics(trips, effChassis) {
  const badge = document.getElementById('tripCountBadge');
  const grid = document.getElementById('tripSummaryGrid');
  if (badge) badge.textContent = trips.length + ' chuyến';
  if (!grid) return;
  if (!trips.length) {
    grid.classList.add('hidden');
    return;
  }
  grid.classList.remove('hidden');
  let sumKm = 0, sumMin = 0, sumFuelPct = 0, hasFuel = false, penalty = 0;
  for (let i = 0; i < trips.length; i++) {
    const tr = trips[i];
    sumKm += Number(tr.distanceKm) || 0;
    sumMin += Number(tr.durationMin) || 0;
    if (tr.fuelUsedPct != null && tr.fuelUsedPct > 0) {
      sumFuelPct += Number(tr.fuelUsedPct);
      hasFuel = true;
    }
    if ((tr.maxRpm || 0) > 4200) penalty += 4;
    else if ((tr.maxRpm || 0) > 3400) penalty += 1.5;
    if ((tr.maxSpeed || 0) > 125) penalty += 3;
  }
  const tankL = /^G0[567]/.test(effChassis) ? 83 : (/^G0[12]/.test(effChassis) ? 65 : 68);
  const estLiters = (sumFuelPct / 100) * tankL;
  const score = Math.max(68, Math.min(100, Math.round(98 - (penalty / Math.max(1, trips.length)) * 3)));
  document.getElementById('tsDist').textContent = sumKm.toFixed(1) + ' km';
  document.getElementById('tsTime').textContent = sumMin >= 60 ? (Math.floor(sumMin / 60) + 'g ' + (sumMin % 60) + 'p') : (sumMin + ' phút');
  document.getElementById('tsFuel').textContent = hasFuel ? ('~' + estLiters.toFixed(1) + ' L') : 'Ít hao';
  const scEl = document.getElementById('tsScore');
  scEl.textContent = score + ' / 100';
  scEl.style.color = score >= 88 ? 'var(--go)' : 'var(--warn)';
}

function ensureReverseAddress(pos) {
  if (!pos || !isFinite(pos.lat) || !isFinite(pos.lon)) return '';
  const nativePlace = dedupeAddressParts([pos.street, pos.district, pos.city]).join(', ');
  if (nativePlace) return nativePlace;
  const key = pos.lat.toFixed(4) + ',' + pos.lon.toFixed(4);
  if (reverseAddrCache[key]) return reverseAddrCache[key];
  if (reverseAddrInFlight[key]) return '';
  reverseAddrInFlight[key] = true;
  fetch('https://photon.komoot.io/reverse?lat=' + encodeURIComponent(pos.lat.toFixed(5)) + '&lon=' + encodeURIComponent(pos.lon.toFixed(5)), {
    headers: { Accept: 'application/json' },
  }).then((r) => (r.ok ? r.json() : null)).then((j) => {
    delete reverseAddrInFlight[key];
    const f = j && Array.isArray(j.features) && j.features[0];
    if (!f || !f.properties) return;
    const p = f.properties;
    const streetFull = [p.housenumber, p.street].filter(Boolean).join(' ');
    const resolved = dedupeAddressParts([
      p.name || '',
      streetFull,
      p.district || p.suburb || p.locality || '',
      p.city || p.state || '',
    ]).slice(0, 3).join(', ');
    if (resolved) {
      reverseAddrCache[key] = resolved;
      const keys = Object.keys(reverseAddrCache);
      if (keys.length > 40) delete reverseAddrCache[keys[0]];
      saveLocal('mybmw_rev_addr', reverseAddrCache);
      const addrEl = document.getElementById('addrText');
      if (addrEl) {
        addrEl.textContent = resolved + ' · (' + pos.lat.toFixed(5) + ', ' + pos.lon.toFixed(5) + ')';
      }
    }
  }).catch(() => { delete reverseAddrInFlight[key]; });
  return '';
}

function refreshMap() {
  const tel = (vehicleData && vehicleData.telemetry) || {};
  const pos = tel.pos;
  if (pos && isFinite(pos.lat) && isFinite(pos.lon)) {
    const place = ensureReverseAddress(pos);
    document.getElementById('addrText').textContent = (place ? place + ' · ' : '') + '(' + pos.lat.toFixed(5) + ', ' + pos.lon.toFixed(5) + ')';
    document.getElementById('posSourceBadge').textContent = String(pos.source || 'NAV').toUpperCase();
  } else {
    document.getElementById('addrText').textContent = 'Chưa nhận được toạ độ đỗ xe — hãy bấm "🔄 Cập nhật thông số" khi xe đang bật điện.';
  }
  if (!window.L || !pos || !isFinite(pos.lat) || !isFinite(pos.lon)) return;
  if (!mapInstance) {
    mapInstance = L.map('mapBox', { zoomControl: false }).setView([pos.lat, pos.lon], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(mapInstance);
  } else {
    mapInstance.setView([pos.lat, pos.lon], 16);
    mapInstance.invalidateSize();
  }
  if (mapMarker) mapInstance.removeLayer(mapMarker);
  if (mapCircle) mapInstance.removeLayer(mapCircle);
  if (mapDestMarker) { mapInstance.removeLayer(mapDestMarker); mapDestMarker = null; }
  if (mapUserMarker) { mapInstance.removeLayer(mapUserMarker); mapUserMarker = null; }
  if (mapWalkLine) { mapInstance.removeLayer(mapWalkLine); mapWalkLine = null; }
  mapMarker = L.circleMarker([pos.lat, pos.lon], { radius: 9, color: '#ffffff', weight: 2, fillColor: '#1c69d4', fillOpacity: 1 }).addTo(mapInstance);
  if (userGeoPos && userGeoPos.lat != null && userGeoPos.lon != null) {
    mapUserMarker = L.circleMarker([userGeoPos.lat, userGeoPos.lon], { radius: 7, color: '#ffffff', weight: 2, fillColor: '#38bdf8', fillOpacity: 0.95 }).addTo(mapInstance);
    mapWalkLine = L.polyline([[userGeoPos.lat, userGeoPos.lon], [pos.lat, pos.lon]], { color: '#38bdf8', weight: 2, dashArray: '5,6', opacity: 0.85 }).addTo(mapInstance);
    const dKm = haversineClientKm(userGeoPos.lat, userGeoPos.lon, pos.lat, pos.lon);
    if (dKm > 0.03 && dKm < 25 && mapInstance.fitBounds) {
      try { mapInstance.fitBounds([[userGeoPos.lat, userGeoPos.lon], [pos.lat, pos.lon]], { padding: [28, 28], maxZoom: 17 }); } catch (e) {}
    }
  }
  const dst = vehicleData && vehicleData.destination;
  if (dst && dst.lat != null && dst.lon != null) {
    mapDestMarker = L.circleMarker([dst.lat, dst.lon], { radius: 8, color: '#ffffff', weight: 2, fillColor: '#2fd27a', fillOpacity: 0.95 }).addTo(mapInstance);
  }
  const valet = (vehicleData && vehicleData.valet) || {};
  if (valet.enabled && valet.radiusM) {
    mapCircle = L.circle([pos.lat, pos.lon], { radius: valet.radiusM, color: '#ffb020', weight: 1.5, fillOpacity: 0.12 }).addTo(mapInstance);
  }
}

function openExternalMaps() {
  const pos = vehicleData && vehicleData.telemetry && vehicleData.telemetry.pos;
  if (!pos) return showToast('Chưa có toạ độ xe.', '#ffb020');
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const url = isIOS
    ? ('http://maps.apple.com/?daddr=' + pos.lat + ',' + pos.lon + '&dirflg=w')
    : ('https://www.google.com/maps/dir/?api=1&destination=' + pos.lat + ',' + pos.lon + '&travelmode=walking');
  window.open(url, '_blank');
}

function pickCardEnum(td, wantOn, sample, preferNoop) {
  const invRe = /INVALID|UNKNOWN|ERROR|UNGUELTIG|UNBEFUELLT|KEINE_AKTION|KEINE_AENDERUNG|KEINE_ANGABE|NO_ACTION|NO_CHANGE|INIT/i;
  const offRe = /(^|_)(OFF|AUS|AUSSCHALTEN|INACTIVE|INAKTIV|NICHT_AKTIV|DEACTIVATE|STOP|DISABLE|FALSE)(_|$)/i;
  const onRe = /(^|_)(ON|EIN|AN|EINSCHALTEN|ACTIVE|AKTIV|ACTIVATE|START|ENABLE|TRUE|RUN)(_|$)/i;
  if (td && td.kind === 'enum' && Array.isArray(td.values) && td.values.length) {
    const vals = td.values.map(String);
    if (preferNoop) {
      const noop = vals.find((v) => /KEINE_AKTION|KEINE_AENDERUNG|NO_ACTION|NO_CHANGE|SIGNAL_UNBEFUELLT/i.test(v));
      if (noop !== undefined) return noop;
    }
    const clean = vals.filter((v) => !invRe.test(v));
    const hit = clean.find((v) => wantOn ? (onRe.test(v) && !offRe.test(v)) : offRe.test(v));
    if (hit !== undefined) return hit;
    if (clean.length >= 2) return wantOn ? clean[1] : clean[0];
  }
  if (typeof sample === 'boolean') return !!wantOn;
  if (typeof sample === 'string') {
    if (preferNoop && /SIGNAL_UNGUELTIG|SIGNAL_UNBEFUELLT|KEINE_AKTION|KEINE_ANGABE/i.test(sample)) return sample;
    if (wantOn && offRe.test(sample)) {
      return sample.replace(/NICHT_AKTIV/ig, 'AKTIV').replace(/AUSSCHALTEN/ig, 'EINSCHALTEN').replace(/(^|_)AUS(_|$)/ig, '$1EIN$2').replace(/INACTIVE/ig, 'ACTIVE').replace(/(^|_)OFF(_|$)/ig, '$1ON$2');
    }
    if (!wantOn && onRe.test(sample) && !offRe.test(sample)) {
      return sample.replace(/(^|_)AKTIV(_|$)/ig, '$1NICHT_AKTIV$2').replace(/EINSCHALTEN/ig, 'AUSSCHALTEN').replace(/(^|_)EIN(_|$)/ig, '$1AUS$2').replace(/ACTIVE/ig, 'INACTIVE').replace(/(^|_)ON(_|$)/ig, '$1OFF$2');
    }
  }
  return wantOn ? 1 : 0;
}

function buildSmartCardPayload(iface, w, liveMap, wantOn) {
  const exactSample = liveMap && liveMap[iface + '.' + w.name];
  const bare = String(w.name || '').replace(/^(operation|control|request|set)/i, '');
  const stSample = exactSample !== undefined ? exactSample : (bare && liveMap ? liveMap[iface + '.status' + bare[0].toUpperCase() + bare.slice(1)] : undefined);
  if (w.kind === 'method' && Array.isArray(w.inArgs)) {
    const obj = {};
    w.inArgs.forEach((a) => {
      if (!a || !a.name) return;
      if (/clientGroupId/i.test(a.name)) obj[a.name] = 0;
      else if (/^timeParking|duration/i.test(a.name)) obj[a.name] = wantOn ? 15 : 0;
      else obj[a.name] = pickCardEnum(a.typeDef, wantOn, undefined, false);
    });
    return obj;
  }
  const td = w.typeDef;
  if (td && td.kind === 'struct' && Array.isArray(td.fields) && td.fields.length) {
    const out = {};
    const hasParkAc = td.fields.some((f) => f && /parkAirCond|standklima/i.test(f.name || ''));
    const hasAutoMode = td.fields.some((f) => f && /autoMode|automatik/i.test(f.name || ''));
    td.fields.forEach((f) => {
      if (!f || !f.name) return;
      const fb = f.name.replace(/^(operation|control|request|set|status)/i, '');
      const cur = (stSample && typeof stSample === 'object') ? (stSample[f.name] !== undefined ? stSample[f.name] : stSample['status' + (fb ? fb[0].toUpperCase() + fb.slice(1) : '')]) : undefined;
      if (/parkHeat|heater|standheiz|zuheiz|extraHeat|blower|geblaese/i.test(f.name)) out[f.name] = pickCardEnum(f.typeDef, false, cur, true);
      else if (/remoteStart|motorstart|res$/i.test(f.name)) out[f.name] = wantOn ? pickCardEnum(f.typeDef, true, cur, false) : pickCardEnum(f.typeDef, true, cur, true);
      else if (/autoMode|automatik/i.test(f.name)) out[f.name] = pickCardEnum(f.typeDef, wantOn, cur, false);
      else if (/parkAirCond|standklima/i.test(f.name) && hasAutoMode && wantOn) out[f.name] = pickCardEnum(f.typeDef, false, cur, true);
      else if (/ventilat|standlueft/i.test(f.name) && (hasParkAc || hasAutoMode) && wantOn) out[f.name] = pickCardEnum(f.typeDef, false, cur, true);
      else out[f.name] = pickCardEnum(f.typeDef, wantOn, cur, false);
    });
    return out;
  }
  if (stSample && typeof stSample === 'object' && !Array.isArray(stSample)) {
    const out = {};
    const keys = Object.keys(stSample);
    const hasParkAc = keys.some((k) => /parkAirCond|standklima/i.test(k));
    const hasAutoMode = keys.some((k) => /autoMode|automatik/i.test(k));
    keys.forEach((k) => {
      const ok = /^status[A-Z]/.test(k) ? ('operation' + k.slice(6)) : k;
      if (/parkHeat|heater|standheiz|zuheiz|extraHeat|blower|geblaese/i.test(k)) out[ok] = pickCardEnum(null, false, stSample[k], true);
      else if (/remoteStart|motorstart|res$/i.test(k)) out[ok] = pickCardEnum(null, true, stSample[k], !wantOn);
      else if (/autoMode|automatik/i.test(k)) out[ok] = pickCardEnum(null, wantOn, stSample[k], false);
      else if (/parkAirCond|standklima/i.test(k) && hasAutoMode && wantOn) out[ok] = pickCardEnum(null, false, stSample[k], true);
      else if (/ventilat|standlueft/i.test(k) && (hasParkAc || hasAutoMode) && wantOn) out[ok] = pickCardEnum(null, false, stSample[k], true);
      else out[ok] = pickCardEnum(null, wantOn, stSample[k], false);
    });
    return out;
  }
  return pickCardEnum(td, wantOn, stSample, false);
}

function renderSchemaCards(schema) {
  const box = document.getElementById('schemaCards');
  box.innerHTML = '';
  const seenIf = {};
  const ifs = [];
  (((schema && schema.interfaces) || []).concat((schema && schema.remoteBodyInterfaces) || [])).forEach((iv) => {
    if (iv && iv.iface && !seenIf[iv.iface]) {
      seenIf[iv.iface] = true;
      ifs.push(iv);
    }
  });
  if (!ifs.length) {
    box.innerHTML = '<div style="font-size:12.5px;color:var(--warn)">Chưa tìm thấy giao diện Climate nào từ phản hồi của xe.</div>';
    return;
  }
  ifs.forEach((iv) => {
    const writables = (iv.fields || []).filter((f) => f.setter).map((f) => ({ kind: 'setter', name: f.name, roles: f.roles || [], typeDef: f.typeDef }))
      .concat((iv.methods || []).map((m) => ({ kind: 'method', name: m.name, roles: m.roles || [], inArgs: m.inArgs })));
    const readables = (iv.fields || []).filter((f) => !f.setter).slice(0, 6);
    const card = document.createElement('div');
    card.style.cssText = 'padding:10px;border:1px solid var(--border);border-radius:11px;margin-bottom:8px;background:#080d18;overflow:hidden';
    card.innerHTML = '<div style="font-size:12px;font-weight:700;color:var(--cyan);margin-bottom:6px;overflow-wrap:anywhere">' + iv.iface + '</div>' +
      (writables.length ? writables.map((w) => {
        const onPayload = buildSmartCardPayload(iv.iface, w, schema.live, true);
        const offPayload = buildSmartCardPayload(iv.iface, w, schema.live, false);
        return '<div style="padding:8px;background:#0f172a;border-radius:9px;margin-bottom:6px;font-size:12px;overflow:hidden">' +
          '<div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:6px">' +
          '<div style="min-width:0;overflow:hidden;text-overflow:ellipsis"><b>' + w.name + '</b> <span style="color:var(--dim)">(' + w.kind + (w.roles && w.roles.length ? ' · ' + w.roles.join(',') : '') + ')</span></div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="btn warn" style="padding:5px 8px;font-size:11px" onclick=\'quickInvoke1cr(' + JSON.stringify(iv.iface) + ',' + JSON.stringify(w.kind) + ',' + JSON.stringify(w.name) + ',' + JSON.stringify(onPayload) + ',null)\'>⚡ Thử Bật</button>' +
          '<button class="btn" style="padding:5px 8px;font-size:11px" onclick=\'quickInvoke1cr(' + JSON.stringify(iv.iface) + ',' + JSON.stringify(w.kind) + ',' + JSON.stringify(w.name) + ',' + JSON.stringify(offPayload) + ',null)\'>⏹ Thử Tắt</button>' +
          '<button class="btn go" style="padding:5px 8px;font-size:11px" onclick=\'quickInvoke1cr(' + JSON.stringify(iv.iface) + ',' + JSON.stringify(w.kind) + ',' + JSON.stringify(w.name) + ',' + JSON.stringify(onPayload) + ',"start")\'>📌 Ghim 1CR</button>' +
          '</div></div>';
      }).join('') : '<div style="font-size:11.5px;color:var(--dim)">Chỉ đọc (' + readables.map((r) => r.name).join(', ') + ')</div>');
    box.appendChild(card);
  });
}

function fillRaw(iface, kind, name, sample) {
  document.getElementById('inpIface').value = iface;
  document.getElementById('inpKind').value = kind;
  document.getElementById('inpMember').value = name;
  document.getElementById('inpPayload').value = JSON.stringify(sample);
}

function saveCarName() {
  const v = document.getElementById('inpCarName').value.trim();
  localStorage.setItem('mybmw_car_name', v);
  renderAll();
}

function toggleHeroPref() {
  const on = document.getElementById('chkUseFactoryHero').checked;
  localStorage.setItem('mybmw_use_factory_hero', on ? '1' : '0');
  renderAll();
}

function applyPairInput() {
  connectCar(document.getElementById('inpPairCode').value).then((ok) => {
    if (ok) {
      showToast('Đã ghép nối xe thành công!', '#2fd27a');
      switchView('home', document.querySelectorAll('.nav-tab')[0]);
    }
  });
}

function copyShareLink() {
  if (!identity) return showToast('Chưa có mã ghép nối xe.', '#ffb020');
  const url = 'https://marilykinson-glitch.github.io/bimmer-link/app/#' + identity.pairCode;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => showToast('Đã sao chép link ghép nối cho máy thứ 2!', '#2fd27a'));
  } else {
    document.getElementById('inpPairCode').value = url;
    showToast('Hãy copy đường dẫn trong ô Mã ghép nối.', '#38bdf8');
  }
}

let webQrStream = null, webQrTimer = null;

function handleHeaderPairTap() {
  if (!identity) {
    startQrScan();
  } else {
    switchView('settings', document.querySelectorAll('.nav-tab')[3]);
  }
}

async function startQrScan() {
  if (window.AndroidBridge && window.AndroidBridge.openQrScanner) {
    window.AndroidBridge.openQrScanner();
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof window.BarcodeDetector === 'undefined') {
    switchView('settings', document.querySelectorAll('.nav-tab')[3]);
    showToast('Hãy mở ứng dụng Camera mặc định của điện thoại quét thẳng mã QR trên màn hình xe, hoặc dán link vào ô Mã ghép nối!', '#38bdf8', 7000);
    return;
  }
  try {
    const modal = document.getElementById('qrWebModal');
    const vid = document.getElementById('qrVideo');
    modal.classList.remove('hidden');
    webQrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    vid.srcObject = webQrStream;
    await vid.play();
    const det = new window.BarcodeDetector({ formats: ['qr_code'] });
    webQrTimer = setInterval(async () => {
      try {
        const codes = await det.detect(vid);
        if (codes && codes.length && codes[0].rawValue) {
          const val = codes[0].rawValue;
          stopWebQrScan();
          window.injectPairCodeFromNative(val);
        }
      } catch (e) {}
    }, 250);
  } catch (e) {
    stopWebQrScan();
    showToast('Không mở được camera: ' + e.message, '#ef4444');
  }
}

function stopWebQrScan() {
  if (webQrTimer) { clearInterval(webQrTimer); webQrTimer = null; }
  if (webQrStream) {
    try { webQrStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    webQrStream = null;
  }
  const modal = document.getElementById('qrWebModal');
  if (modal) modal.classList.add('hidden');
}

window.injectPairCodeFromNative = async function (raw) {
  const s = String(raw || '').trim();
  const code = extractPairCode(s);
  if (code) {
    const ok = await connectCar(code);
    if (ok) {
      showToast('✅ Đã quét mã QR & ghép nối xe thành công!', '#2fd27a', 6000);
      switchView('home', document.querySelectorAll('.nav-tab')[0]);
    }
    return;
  }
  // If user scanned the local Wi-Fi portal QR (http://<ip>:8139/?pin=XXXX), auto-fetch pairCode from local car server!
  if (/^http:\/\/[\d.]+:\d+\/\?pin=\d+/i.test(s)) {
    try {
      const apiUrl = s.replace(/\/\?pin=/i, '/api/state?pin=');
      const r = await fetch(apiUrl);
      const j = await r.json();
      if (j && j.pairCode) {
        const ok = await connectCar(j.pairCode);
        if (ok) {
          showToast('✅ Đã ghép nối xe qua Wi-Fi nội bộ thành công!', '#2fd27a', 6000);
          switchView('home', document.querySelectorAll('.nav-tab')[0]);
          return;
        }
      }
    } catch (e) {}
    showToast('Bạn vừa quét QR Wi-Fi nội bộ — hãy chạm vào mã QR trên màn hình xe để chuyển sang QR App MyBMW (màu xanh)!', '#ffb020', 7500);
    return;
  }
  showToast('Mã QR chưa khớp định dạng MyBMW: ' + s.slice(0, 48), '#ffb020', 6000);
};

/* ---------------- Boot ---------------- */
(function init() {
  initSwatches();
  const advDet = document.getElementById('adv1crDetails');
  if (advDet) {
    advDet.addEventListener('toggle', () => {
      if (advDet.open && identity && !lastSchema) requestSchema();
    });
  }
  const heroEl = document.getElementById('heroCarImg');
  if (heroEl) {
    heroEl.onerror = () => {
      if (factoryHero) {
        factoryHero = null;
        localStorage.removeItem('mybmw_hero');
      }
      heroEl.classList.remove('factory-png');
      if (heroEl.getAttribute('src') !== 'car-studio.jpg') {
        heroEl.src = 'car-studio.jpg';
      }
    };
  }
  if (factoryHero && factoryHero.dataUrl) {
    validateHeroDataUrl(factoryHero.dataUrl, (ok) => {
      if (!ok) {
        factoryHero = null;
        localStorage.removeItem('mybmw_hero');
        renderAll();
      }
    });
  }
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    if (window.AndroidBridge || /\.local$/i.test(location.hostname)) {
      navigator.serviceWorker.getRegistrations().then((regs) => {
        regs.forEach((r) => { r.unregister().catch(() => {}); });
      }).catch(() => {});
    } else {
      navigator.serviceWorker.register('./sw.js?v=0.6.6').then((reg) => {
        try { reg.update(); } catch (e) {}
      }).catch(() => {});
    }
  }
  const healConnection = () => {
    if (!identity) return;
    if (!mqttWs || mqttWs.readyState > 1 || (Date.now() - lastMqttRxAt > 25000)) {
      if (mqttWs) { try { mqttWs.close(); } catch (e) {} mqttWs = null; mqttReady = false; }
      openMqttSocket();
    }
    if (!(latestSnap && isCam360Snap(latestSnap.dataUrl, latestSnap.camMeta))) {
      syncCloudMediaCaches(identity);
    }
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') healConnection();
  });
  window.addEventListener('online', healConnection);
  renderAll();
  const initialCode = extractPairCode(location.hash) || extractPairCode(location.search) || localStorage.getItem('mybmw_pair') || '';
  if (initialCode) connectCar(initialCode);
  setInterval(renderAll, 15000);
})();
