'use strict';
/**
 * app.js - MyBMW Dark Luxury Client for iPhone Fullscreen PWA & Android Native APK (v0.4.0).
 *
 * Syncs with `tools/bimmer-link/cloud.js` using standard WebCrypto (SHA-256 + AES-GCM) over `ntfy.sh`
 * WebSocket + 12-hour cached history + instant `cmd_ack` bidirectional command feedback + BMW Factory Paint Studio.
 */
const RELAY_HOST = 'ntfy.sh';
let identity = null;        // { pairCode, cryptoKey, topicId, topics }
let stateWs = null;
let photoWs = null;
let heroWs = null;
let diagWs = null;
let vehicleData = loadLocal('mybmw_state') || null;
let latestSnap = loadLocal('mybmw_snap') || null;   // { dataUrl, at, title }
let factoryHero = loadLocal('mybmw_hero') || null;  // { dataUrl, at, title, paint }
let localAppearance = loadLocal('mybmw_appearance') || { chassis: '', trimLine: '', colour: '' };
let lastSchema = null;
let photoBuckets = {};
let heroBuckets = {};
let diagBuckets = {};
let arm1crUntil = 0;
let mapInstance = null, mapMarker = null, mapCircle = null;

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
let shadedCacheKey = '';
let shadedCacheUrl = '';

function loadLocal(k) {
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
}
function saveLocal(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
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
  if (name === 'map') setTimeout(refreshMap, 80);
}

/* ---------------- Photorealistic Studio Bodywork Carpaint Shader (Fallback & Instant Preview) ---------------- */

function ensureBaseStudioImage() {
  if (baseStudioImg) return;
  const im = new Image();
  im.onload = () => {
    baseStudioImg = im;
    shadedCacheKey = '';
    renderAll();
  };
  im.src = 'car-studio.jpg';
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
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(baseStudioImg, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;

  const tr = rgb[0] / 255, tg = rgb[1] / 255, tb = rgb[2] / 255;
  const tLum = 0.299 * tr + 0.587 * tg + 0.114 * tb;
  const isLightPaint = tLum > 0.65;
  const isDarkPaint = tLum < 0.14;

  // Preserve front & rear alloy wheel circles so rims and blue M brake calipers stay 100% untouched
  const w1x = 0.502 * w, w1y = 0.655 * h, w1r2 = Math.pow(0.082 * w, 2);
  const w2x = 0.768 * w, w2y = 0.608 * h, w2r2 = Math.pow(0.058 * w, 2);

  for (let y = 0; y < h; y++) {
    const ny = y / h;
    if (ny < 0.20 || ny > 0.76) continue;
    const vyMask = smoothstep(0.21, 0.27, ny) * (1 - smoothstep(0.69, 0.75, ny));
    if (vyMask <= 0.001) continue;

    for (let x = 0; x < w; x++) {
      const nx = x / w;
      if (nx < 0.16 || nx > 0.82) continue;
      const vxMask = smoothstep(0.17, 0.22, nx) * (1 - smoothstep(0.78, 0.82, nx));

      // Skip wheel circles
      const dx1 = x - w1x, dy1 = y - w1y;
      if (dx1 * dx1 + dy1 * dy1 < w1r2) continue;
      const dx2 = x - w2x, dy2 = y - w2y;
      if (dx2 * dx2 + dy2 * dy2 < w2r2) continue;

      // Skip upper greenhouse window glass area
      let glassPenalty = 1;
      if (nx > 0.36 && nx < 0.73 && ny > 0.25 && ny < 0.44) {
        const i = (y * w + x) * 4;
        const lumG = (d[i] + d[i + 1] + d[i + 2]) / (3 * 255);
        if (lumG < 0.28) glassPenalty = 0.15;
      }

      const idx = (y * w + x) * 4;
      const r = d[idx] / 255, g = d[idx + 1] / 255, b = d[idx + 2] / 255;
      const maxC = Math.max(r, g, b), minC = Math.min(r, g, b);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      const sat = maxC > 0.02 ? (maxC - minC) / maxC : 0;

      // Keep dark grille/tires/background (lum < 0.11), bright DRL headlights (lum > 0.83), and colored lights/badges (sat > 0.18) untouched
      const lowKeep = smoothstep(0.10, 0.17, lum);
      const highKeep = 1 - smoothstep(0.76, 0.86, lum);
      const neutralKeep = 1 - smoothstep(0.12, 0.22, sat);
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
    factoryHero = null;
    localStorage.removeItem('mybmw_hero');
    highlightSelectedSwatch();
    renderAll();
    sendCmd('set_appearance', { reset: true }, true);
    return;
  }
  localAppearance.chassis = document.getElementById('selChassis').value || localAppearance.chassis || '';
  localAppearance.trimLine = document.getElementById('selTrim').value || localAppearance.trimLine || '';
  saveLocal('mybmw_appearance', localAppearance);
  // Clear old mismatched factoryHero while MGU renders the newly chosen model/paint
  factoryHero = null;
  localStorage.removeItem('mybmw_hero');
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
  return {
    pairCode: clean,
    cryptoKey,
    topicId,
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

/* ---------------- Sync & Real-time Subscriptions ---------------- */

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
  await Promise.all([
    fetchCachedTopic(id.topics.state, onStatePacket),
    fetchCachedTopic(id.topics.photo, onPhotoPacket),
    fetchCachedTopic(id.topics.hero, onHeroPacket),
  ]);
  openLiveSockets();
  renderAll();
  return true;
}

function closeSockets() {
  [stateWs, photoWs, heroWs, diagWs].forEach((ws) => { if (ws) { try { ws.close(); } catch (e) {} } });
  stateWs = photoWs = heroWs = diagWs = null;
}

async function fetchCachedTopic(topic, handler) {
  try {
    const r = await fetch('https://' + RELAY_HOST + '/' + topic + '/json?poll=1&since=all');
    const txt = await r.text();
    const lines = txt.split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      let ev = null;
      try { ev = JSON.parse(lines[i]); } catch (e) { continue; }
      if (ev && ev.event === 'message' && ev.message) {
        const dec = await decryptJson(ev.message);
        if (dec) handler(dec, ev.time ? ev.time * 1000 : Date.now());
      }
    }
  } catch (e) {}
}

function openLiveSockets() {
  if (!identity) return;
  const sub = (topic, handler) => {
    const ws = new WebSocket('wss://' + RELAY_HOST + '/' + topic + '/ws');
    ws.onmessage = async (e) => {
      let ev = null;
      try { ev = JSON.parse(e.data); } catch (x) { return; }
      if (ev && ev.event === 'message' && ev.message) {
        const dec = await decryptJson(ev.message);
        if (dec) {
          handler(dec, Date.now());
          renderAll();
        }
      }
    };
    return ws;
  };
  stateWs = sub(identity.topics.state, onStatePacket);
  photoWs = sub(identity.topics.photo, onPhotoPacket);
  heroWs = sub(identity.topics.hero, onHeroPacket);
  diagWs = sub(identity.topics.diag, onDiagPacket);
}

function onStatePacket(pkt, ts) {
  if (!pkt || pkt.t !== 'state') return;
  if (vehicleData && vehicleData.at && pkt.at && pkt.at < vehicleData.at) return;
  vehicleData = pkt;
  if (!vehicleData.at) vehicleData.at = ts;
  saveLocal('mybmw_state', vehicleData);

  if (pkt.appearanceOverride && (pkt.appearanceOverride.chassis || pkt.appearanceOverride.colour || pkt.appearanceOverride.trimLine)) {
    localAppearance = Object.assign({}, localAppearance, pkt.appearanceOverride);
    saveLocal('mybmw_appearance', localAppearance);
  }

  if (pkt.alert && pkt.alert.reason) {
    showToast('🚨 CẢNH BÁO VALET: ' + pkt.alert.reason, '#ef4444', 10000);
  }

  if (window.AndroidBridge && window.AndroidBridge.onVehicleSummary) {
    try {
      const tel = pkt.telemetry || {};
      const c1 = tel.climate1cr || {};
      const prof = pkt.vehicleProfile || {};
      window.AndroidBridge.onVehicleSummary(JSON.stringify({
        carName: localStorage.getItem('mybmw_car_name') || prof.modelTitle || 'BMW iDrive 7',
        status: tel.conditionLabel || (tel.engineRunning ? 'Đang nổ máy' : 'Đã đỗ'),
        fuelPct: tel.fuelPct,
        rangeKm: tel.rangeKm,
        battery12v: tel.battery12v,
        active1cr: !!c1.active,
        timer1cr: c1.timerText || '',
        location: tel.pos ? ([tel.pos.street, tel.pos.district, tel.pos.city].filter(Boolean).join(', ')) : '',
        updatedAt: pkt.at || Date.now(),
      }));
    } catch (e) {}
  }
}

function onPhotoPacket(pkt) {
  if (!pkt || pkt.t !== 'photo_chunk' || !pkt.id) return;
  let b = photoBuckets[pkt.id];
  if (!b) b = photoBuckets[pkt.id] = { total: pkt.total || 1, parts: {}, got: 0, at: pkt.at || Date.now(), title: pkt.title || '' };
  if (b.parts[pkt.idx] === undefined) {
    b.parts[pkt.idx] = pkt.b64 || '';
    b.got++;
  }
  if (b.got >= b.total) {
    let fullB64 = '';
    for (let i = 0; i < b.total; i++) fullB64 += (b.parts[i] || '');
    delete photoBuckets[pkt.id];
    if (!latestSnap || b.at >= (latestSnap.at || 0)) {
      latestSnap = { dataUrl: 'data:image/png;base64,' + fullB64, at: b.at, title: b.title };
      saveLocal('mybmw_snap', latestSnap);
    }
  }
}

function onHeroPacket(pkt) {
  if (!pkt || pkt.t !== 'photo_chunk') return;
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
    if (!factoryHero || b.at >= (factoryHero.at || 0)) {
      factoryHero = { dataUrl: 'data:image/png;base64,' + fullB64, at: b.at, title: b.title, paint: b.paint };
      saveLocal('mybmw_hero', factoryHero);
    }
  }
}

function onDiagPacket(pkt) {
  if (!pkt) return;
  if (pkt.t === 'diag_chunk') {
    let b = diagBuckets[pkt.id];
    if (!b) b = diagBuckets[pkt.id] = { total: pkt.total, parts: {}, got: 0 };
    if (b.parts[pkt.idx] === undefined) { b.parts[pkt.idx] = pkt.part; b.got++; }
    if (b.got >= b.total) {
      let str = '';
      for (let i = 0; i < b.total; i++) str += (b.parts[i] || '');
      delete diagBuckets[pkt.id];
      try { onDiagPacket(JSON.parse(str)); } catch (e) {}
    }
    return;
  }
  if (pkt.t === 'cmd_ack') {
    const prefix = pkt.ok ? '✅ ' : '⚠️ ';
    showToast(prefix + (pkt.message || 'Xe đã xử lý lệnh.'), pkt.ok ? '#2fd27a' : '#ffb020', 8500);
    if (pkt.detail) {
      document.getElementById('diagOutput').textContent = JSON.stringify(pkt.detail, null, 2);
    }
    return;
  }
  if (pkt.t === 'schema') {
    lastSchema = pkt;
    renderSchemaCards(pkt.schema);
    document.getElementById('diagOutput').textContent = JSON.stringify({
      pinned: pkt.schema && pkt.schema.pinnedProfile,
      openConfigs: pkt.schema && pkt.schema.openConfigs,
      live: pkt.schema && pkt.schema.live,
      logs: pkt.logs,
    }, null, 2);
    showToast('✅ Đã nhận danh sách ' + (((pkt.schema && pkt.schema.interfaces) || []).length) + ' giao diện Climate/1CR từ xe!', '#2fd27a');
  } else if (pkt.t === 'raw_result') {
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
  const pkt = await encryptJson({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    cmd,
    arg: arg || {},
    at: Date.now(),
    queueIfAsleep: !!queueIfAsleep,
    device,
  });
  showToast('Đang gửi lệnh tới xe…', '#38bdf8', 5000);
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

function handle1crTap() {
  const tel = (vehicleData && vehicleData.telemetry) || {};
  const active = !!(tel.climate1cr && tel.climate1cr.active);
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
  let payload = null;
  try { payload = JSON.parse(document.getElementById('inpPayload').value); } catch (e) {
    showToast('Payload JSON không hợp lệ', '#ef4444');
    return;
  }
  sendCmd('invoke_raw', {
    iface: document.getElementById('inpIface').value.trim(),
    kind: document.getElementById('inpKind').value.trim(),
    name: document.getElementById('inpMember').value.trim(),
    payload,
    saveAsDefault: !!saveAsDefault,
    role: role || 'start',
  });
}

function exportSchemaJson() {
  if (!lastSchema) return showToast('Hãy bấm Tải danh sách hàm từ xe trước.', '#ffb020');
  const blob = new Blob([JSON.stringify(lastSchema, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mybmw-1cr-schema.json';
  a.click();
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

  const effChassis = localAppearance.chassis || prof.chassis || '';
  const effTrim = localAppearance.trimLine || prof.trimLine || '';
  const effColour = localAppearance.colour || prof.colour || '';
  const chosenSwatch = findSwatchByColourOrLabel(effColour, localAppearance.colour ? '' : prof.paintLabel);

  const computedSeries = effChassis ? (SERIES_TITLES[effChassis] || ('BMW ' + effChassis)) : (prof.series || 'BMW 5 Series');
  const computedTrim = effTrim ? (TRIM_LABELS[effTrim] !== undefined ? TRIM_LABELS[effTrim] : '') : (prof.trimLabel || 'M Sport');
  const autoTitle = (localAppearance.chassis || localAppearance.trimLine)
    ? (computedSeries + (computedTrim && computedSeries.indexOf(computedTrim) < 0 ? (' · ' + computedTrim) : ''))
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
    if (useFactory && factoryHero && factoryHero.dataUrl) {
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

  if (!identity) {
    setConnBadge('warn', 'Chưa ghép xe');
    document.getElementById('updatedLabel').textContent = 'Quét QR trên màn hình xe';
    return;
  }

  if (!vehicleData) {
    setConnBadge('sleep', 'Đã ghép nối');
    document.getElementById('updatedLabel').textContent = 'Đang chờ bản tin từ đầu xe MGU…';
    return;
  }

  const ageMs = Date.now() - (vehicleData.at || 0);
  const awake = ageMs < 90000;
  const tel = vehicleData.telemetry || {};
  const c1 = tel.climate1cr || {};
  const valet = vehicleData.valet || {};
  const isLegacy03 = !vehicleData.version || vehicleData.version < '0.4.0';

  setConnBadge(awake ? 'live' : 'sleep', awake ? 'Trực tuyến' : 'Đang ngủ (Lưu đệm)');
  document.getElementById('updatedLabel').textContent = relTime(vehicleData.at);

  const hasDoorWarn = (tel.doorsOpen && tel.doorsOpen.length) || tel.trunkOpen || tel.hoodOpen || tel.locked === false;
  glow.className = 'studio-glow' + (hasDoorWarn ? ' alert-on' : (c1.active ? ' climate-on' : ''));

  const sec = document.getElementById('securityBanner');
  if (hasDoorWarn) {
    sec.className = 'lock-banner warn';
    sec.textContent = tel.trunkOpen ? '⚠️ CỐP SAU ĐANG MỞ' : (tel.locked === false ? '🔓 XE CHƯA KHOÁ (KHOÁ CỬA ĐỂ ĐỀ NỔ 1CR)' : '⚠️ CÓ CỬA CHƯA ĐÓNG KÍN');
  } else {
    sec.className = 'lock-banner';
    sec.textContent = c1.active ? '❄️ ĐANG NỔ MÁY / LÀM MÁT 1CR' : (tel.engineRunning ? ('🟢 ĐANG VẬN HÀNH (' + (tel.speed || 0) + ' KM/H)') : '🔒 ĐÃ ĐỖ & KHOÁ AN TOÀN');
  }

  // Fuel & Range (guard against pre-0.4.0 unscaled range/odo artifacts until car updates to 0.4.0)
  const validRange = (tel.rangeKm != null && !(isLegacy03 && tel.fuelPct == null && tel.rangeKm === 20)) ? tel.rangeKm : null;
  document.getElementById('rangeKm').innerHTML = (validRange != null ? validRange : '--') + ' <span>km</span>';
  document.getElementById('fuelPct').textContent = tel.fuelPct != null ? (tel.fuelPct + '%') : (tel.fuelLiters != null ? (tel.fuelLiters + ' L') : '--%');
  document.getElementById('fuelFill').style.width = Math.max(0, Math.min(100, tel.fuelPct || 0)) + '%';

  const btn1 = document.getElementById('btn1cr');
  const fan = document.getElementById('fanIcon');
  btn1.className = 'act-btn' + (c1.active ? ' active-go' : '');
  fan.classList.toggle('fan-spin', !!c1.active);
  if (Date.now() >= arm1crUntil) {
    document.getElementById('lbl1cr').textContent = c1.active ? 'Tắt 1CR' : 'Đề nổ 1CR';
  }

  const btnV = document.getElementById('btnValet');
  btnV.className = 'act-btn' + (valet.enabled ? ' active-warn' : '');
  document.getElementById('lblValet').textContent = valet.enabled ? 'Valet Đang Bật' : 'Valet Off';

  const hasTimer = c1.timerText && c1.timerText !== 'Tắt';
  document.getElementById('btnTimerQuick').className = 'act-btn' + (hasTimer ? ' active-go' : '');
  document.getElementById('lblTimer').textContent = hasTimer ? ('Hẹn ' + c1.timerText) : 'Hẹn giờ BDC';

  // Vitals
  const validOdo = (tel.odometerKm != null && !(isLegacy03 && tel.fuelPct == null && tel.odometerKm < 300)) ? tel.odometerKm : null;
  document.getElementById('odoText').textContent = 'ODO: ' + (validOdo != null ? validOdo.toLocaleString('vi-VN') : '--') + ' km';
  document.getElementById('mBat').textContent = tel.battery12v != null ? (tel.battery12v + ' V') : 'Ổn định';
  document.getElementById('mTemp').textContent = (tel.ambientC != null ? tel.ambientC + '°C' : '--') + (tel.cabinC != null ? (' / ' + tel.cabinC + '°C') : '');
  document.getElementById('mEngTemp').textContent = (tel.coolantC != null ? tel.coolantC + '°C' : '--') + (tel.oilC != null ? (' / ' + tel.oilC + '°C') : '');
  document.getElementById('m1cr').textContent = c1.active ? 'Đang chạy' : (hasTimer ? ('Hẹn ' + c1.timerText) : (c1.discoveredCount ? ('Sẵn sàng (' + c1.discoveredCount + ' cổng)') : 'Sẵn sàng'));

  if (latestSnap && latestSnap.dataUrl) {
    document.getElementById('noSnapHint').classList.add('hidden');
    const img = document.getElementById('latestSnapImg');
    img.src = latestSnap.dataUrl;
    img.classList.remove('hidden');
    document.getElementById('snapTime').textContent = relTime(latestSnap.at);
  }

  if (document.activeElement.tagName !== 'INPUT') {
    if (vehicleData.dailyTimer) document.getElementById('timerInput').value = vehicleData.dailyTimer;
    document.getElementById('chkAutoSync').checked = !!vehicleData.autoSyncTimer;
    if (valet.maxSpeed) document.getElementById('valetSpeed').value = valet.maxSpeed;
    if (valet.maxRpm) document.getElementById('valetRpm').value = valet.maxRpm;
    if (valet.radiusM) document.getElementById('valetRadius').value = valet.radiusM;
  }

  const trips = vehicleData.trips || (vehicleData.lastTrip ? [vehicleData.lastTrip] : []);
  const tBox = document.getElementById('tripList');
  if (trips.length) {
    tBox.innerHTML = trips.map((tr) => {
      const d = new Date(tr.endedAt || Date.now());
      const when = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' · ' + d.getDate() + '/' + (d.getMonth() + 1);
      return '<div class="trip-item"><div><b>' + tr.distanceKm + ' km</b> <span style="color:var(--dim)">(' + tr.durationMin + ' phút)</span><div style="font-size:11.5px;color:var(--dim)">' + when + '</div></div>' +
        '<div style="text-align:right;color:var(--cyan);font-weight:700">Max ' + tr.maxSpeed + ' km/h' + (tr.fuelUsedPct != null ? '<div style="font-size:11px;color:var(--dim)">-' + tr.fuelUsedPct + '% xăng</div>' : '') + '</div></div>';
    }).join('');
  }
}

function refreshMap() {
  const tel = (vehicleData && vehicleData.telemetry) || {};
  const pos = tel.pos;
  if (pos) {
    const place = [pos.street, pos.district, pos.city].filter(Boolean).join(', ');
    document.getElementById('addrText').textContent = (place ? place + ' · ' : '') + '(' + pos.lat.toFixed(5) + ', ' + pos.lon.toFixed(5) + ')';
    document.getElementById('posSourceBadge').textContent = String(pos.source || 'NAV').toUpperCase();
  }
  if (!window.L || !pos) return;
  if (!mapInstance) {
    mapInstance = L.map('mapBox', { zoomControl: false }).setView([pos.lat, pos.lon], 16);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19 }).addTo(mapInstance);
  } else {
    mapInstance.setView([pos.lat, pos.lon], 16);
    mapInstance.invalidateSize();
  }
  if (mapMarker) mapInstance.removeLayer(mapMarker);
  if (mapCircle) mapInstance.removeLayer(mapCircle);
  mapMarker = L.circleMarker([pos.lat, pos.lon], { radius: 9, color: '#ffffff', weight: 2, fillColor: '#1c69d4', fillOpacity: 1 }).addTo(mapInstance);
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

function renderSchemaCards(schema) {
  const box = document.getElementById('schemaCards');
  box.innerHTML = '';
  const ifs = (schema && schema.interfaces) || [];
  if (!ifs.length) {
    box.innerHTML = '<div style="font-size:12.5px;color:var(--warn)">Chưa tìm thấy giao diện Climate nào từ phản hồi của xe.</div>';
    return;
  }
  ifs.forEach((iv) => {
    const writables = (iv.fields || []).filter((f) => f.setter).map((f) => ({ kind: 'setter', name: f.name, roles: f.roles || [], typeDef: f.typeDef }))
      .concat((iv.methods || []).map((m) => ({ kind: 'method', name: m.name, roles: m.roles || [], inArgs: m.inArgs })));
    const readables = (iv.fields || []).filter((f) => !f.setter).slice(0, 6);
    const card = document.createElement('div');
    card.style.cssText = 'padding:10px;border:1px solid var(--border);border-radius:11px;margin-bottom:8px;background:#080d18';
    card.innerHTML = '<div style="font-size:12px;font-weight:700;color:var(--cyan);margin-bottom:6px">' + iv.iface + '</div>' +
      (writables.length ? writables.map((w) => {
        const liveVal = schema.live && schema.live[iv.iface + '.' + w.name];
        let defaultSample = liveVal !== undefined ? liveVal : 1;
        if (liveVal === undefined && w.typeDef && w.typeDef.kind === 'enum' && w.typeDef.values && w.typeDef.values.length > 1) {
          defaultSample = w.typeDef.values[1];
        }
        return '<div style="padding:6px;background:#0f172a;border-radius:8px;margin-bottom:5px;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:6px">' +
          '<div style="min-width:0;overflow:hidden;text-overflow:ellipsis"><b>' + w.name + '</b> <span style="color:var(--dim)">(' + w.kind + (w.roles && w.roles.length ? ' · ' + w.roles.join(',') : '') + ')</span></div>' +
          '<button class="btn" style="flex:0;min-width:64px;padding:5px 10px;font-size:11px" onclick=\'fillRaw(' +
          JSON.stringify(iv.iface) + ',' + JSON.stringify(w.kind) + ',' + JSON.stringify(w.name) + ',' + JSON.stringify(defaultSample) +
          ')\'>Chọn</button></div>';
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

window.injectPairCodeFromNative = function (raw) {
  const code = extractPairCode(raw);
  if (code) connectCar(code);
};

/* ---------------- Boot ---------------- */
(function init() {
  initSwatches();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js?v=0.4.0').catch(() => {});
  }
  renderAll();
  const initialCode = extractPairCode(location.hash) || extractPairCode(location.search) || localStorage.getItem('mybmw_pair') || '';
  if (initialCode) connectCar(initialCode);
  setInterval(renderAll, 15000);
})();
