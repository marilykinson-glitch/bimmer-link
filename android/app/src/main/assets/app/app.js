'use strict';
/**
 * app.js - MyBMW Dark Luxury Client for iPhone Fullscreen PWA & Android Native APK.
 *
 * Syncs with `tools/bimmer-link/cloud.js` using standard WebCrypto (SHA-256 + AES-GCM) over `ntfy.sh`
 * WebSocket + 12-hour cached history + infinite local device persistence (`localStorage` + `AndroidBridge`).
 */
const RELAY_HOST = 'ntfy.sh';
let identity = null;        // { pairCode, cryptoKey, topicId, topics }
let stateWs = null;
let photoWs = null;
let diagWs = null;
let vehicleData = loadLocal('mybmw_state') || null;
let latestSnap = loadLocal('mybmw_snap') || null;   // { dataUrl, at, title }
let lastSchema = null;
let photoBuckets = {};
let diagBuckets = {};
let arm1crUntil = 0;
let mapInstance = null, mapMarker = null, mapCircle = null;

function loadLocal(k) {
  try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; }
}
function saveLocal(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
}

function showToast(msg, color) {
  const el = document.getElementById('toastBar');
  el.textContent = msg;
  el.style.borderLeftColor = color || '#38bdf8';
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 6500);
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

/* ---------------- WebCrypto derivation & packetcodec ---------------- */

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

  // Keep `?k=<pairCode>` in browser URL so iOS "Add to Home Screen" bookmarks the paired state directly!
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
  ]);
  openLiveSockets();
  renderAll();
  return true;
}

function closeSockets() {
  [stateWs, photoWs, diagWs].forEach((ws) => { if (ws) { try { ws.close(); } catch (e) {} } });
  stateWs = photoWs = diagWs = null;
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
  diagWs = sub(identity.topics.diag, onDiagPacket);
}

function onStatePacket(pkt, ts) {
  if (!pkt || pkt.t !== 'state') return;
  if (vehicleData && vehicleData.at && pkt.at && pkt.at < vehicleData.at) return;
  vehicleData = pkt;
  if (!vehicleData.at) vehicleData.at = ts;
  saveLocal('mybmw_state', vehicleData);

  if (pkt.alert && pkt.alert.reason) {
    showToast('🚨 CẢNH BÁO VALET: ' + pkt.alert.reason, '#ef4444');
  }

  if (window.AndroidBridge && window.AndroidBridge.onVehicleSummary) {
    try {
      const tel = pkt.telemetry || {};
      const c1 = tel.climate1cr || {};
      window.AndroidBridge.onVehicleSummary(JSON.stringify({
        carName: localStorage.getItem('mybmw_car_name') || 'BMW iDrive 7',
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
  if (pkt.t === 'schema') {
    lastSchema = pkt;
    renderSchemaCards(pkt.schema);
    document.getElementById('diagOutput').textContent = JSON.stringify({ pinned: pkt.schema && pkt.schema.pinnedProfile, live: pkt.schema && pkt.schema.live, logs: pkt.logs }, null, 2);
    showToast('Đã nhận danh sách hàm Climate/1CR từ xe!', '#2fd27a');
  } else if (pkt.t === 'raw_result') {
    document.getElementById('diagOutput').textContent = JSON.stringify(pkt.result, null, 2);
    const ok = pkt.result && pkt.result.ok;
    showToast(ok ? 'Thực thi lệnh 1CR thành công!' : ('Chưa thành công: ' + ((pkt.result && pkt.result.error) || '')), ok ? '#2fd27a' : '#ffb020');
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
  showToast('Đang gửi lệnh tới xe…', '#38bdf8');
  try {
    const r = await fetch('https://' + RELAY_HOST + '/' + identity.topics.cmd, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: pkt,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    showToast(queueIfAsleep
      ? 'Đã gửi lệnh (nếu đầu xe đang ngủ 0W, xe sẽ đồng bộ ngay khi thức dậy).'
      : 'Đã gửi lệnh tới xe — đang chờ phản hồi…', '#2fd27a');
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
  showToast('Bấm nút Đề nổ 1CR thêm 1 lần nữa để xác nhận khởi động máy từ xa.', '#ffb020');
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
  if (sec < 86400) return 'Cập nhật ' + Math.round(sec / 3600) + ' giờ trước (xe đang ngủ 0W)';
  const d = new Date(ms);
  return 'Đỗ lúc ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ' ' + d.getDate() + '/' + (d.getMonth() + 1);
}

function renderAll() {
  const carName = localStorage.getItem('mybmw_car_name') || 'BMW iDrive 7';
  document.getElementById('carTitle').textContent = carName;
  document.getElementById('inpCarName').value = carName;
  if (window.AndroidBridge) document.getElementById('androidDownloadCard').classList.add('hidden');

  if (!identity) {
    setConnBadge('warn', 'Chưa ghép xe');
    document.getElementById('updatedLabel').textContent = 'Vào mục Kết nối hoặc quét QR trên màn hình xe';
    return;
  }

  if (!vehicleData) {
    setConnBadge('sleep', 'Đã ghép nối');
    document.getElementById('updatedLabel').textContent = 'Đang chờ bản tin đầu tiên từ đầu xe MGU…';
    return;
  }

  const ageMs = Date.now() - (vehicleData.at || 0);
  const awake = ageMs < 90000;
  const tel = vehicleData.telemetry || {};
  const c1 = tel.climate1cr || {};
  const valet = vehicleData.valet || {};

  setConnBadge(awake ? 'live' : 'sleep', awake ? 'Trực tuyến' : 'Đang ngủ (Lưu đệm)');
  document.getElementById('updatedLabel').textContent = relTime(vehicleData.at);

  // Studio glow & security banner
  const hasDoorWarn = (tel.doorsOpen && tel.doorsOpen.length) || tel.trunkOpen || tel.hoodOpen || tel.locked === false;
  const glow = document.getElementById('studioGlow');
  glow.className = 'studio-glow' + (hasDoorWarn ? ' alert-on' : (c1.active ? ' climate-on' : ''));

  const sec = document.getElementById('securityBanner');
  if (hasDoorWarn) {
    sec.className = 'lock-banner warn';
    sec.textContent = tel.trunkOpen ? '⚠️ CỐP SAU ĐANG MỞ' : (tel.locked === false ? '🔓 XE CHƯA KHOÁ' : '⚠️ CÓ CỬA CHƯA ĐÓNG KÍN');
  } else {
    sec.className = 'lock-banner';
    sec.textContent = c1.active ? '❄️ ĐANG NỔ MÁY LÀM MÁT 1CR' : (tel.engineRunning ? ('🟢 ĐANG VẬN HÀNH (' + (tel.speed || 0) + ' KM/H)') : '🔒 ĐÃ ĐỖ & KHOÁ AN TOÀN');
  }

  // Fuel & Range
  document.getElementById('rangeKm').innerHTML = (tel.rangeKm != null ? tel.rangeKm : '--') + ' <span>km</span>';
  document.getElementById('fuelPct').textContent = tel.fuelPct != null ? (tel.fuelPct + '%') : '--%';
  document.getElementById('fuelFill').style.width = Math.max(0, Math.min(100, tel.fuelPct || 0)) + '%';

  // Action buttons
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
  document.getElementById('odoText').textContent = 'ODO: ' + (tel.odometerKm != null ? tel.odometerKm.toLocaleString('vi-VN') : '--') + ' km';
  document.getElementById('mBat').textContent = tel.battery12v != null ? (tel.battery12v + ' V') : 'Ổn định';
  document.getElementById('mTemp').textContent = (tel.ambientC != null ? tel.ambientC + '°C' : '--') + (tel.cabinC != null ? (' / ' + tel.cabinC + '°C') : '');
  document.getElementById('mEngTemp').textContent = (tel.coolantC != null ? tel.coolantC + '°C' : '--') + (tel.oilC != null ? (' / ' + tel.oilC + '°C') : '');
  document.getElementById('m1cr').textContent = c1.active ? 'Đang chạy' : (hasTimer ? ('Hẹn ' + c1.timerText) : 'Sẵn sàng');

  // Snapshot
  if (latestSnap && latestSnap.dataUrl) {
    document.getElementById('noSnapHint').classList.add('hidden');
    const img = document.getElementById('latestSnapImg');
    img.src = latestSnap.dataUrl;
    img.classList.remove('hidden');
    document.getElementById('snapTime').textContent = relTime(latestSnap.at);
  }

  // Trips & Valet inputs
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
  ifs.forEach((iv) => {
    const writables = (iv.fields || []).filter((f) => f.setter).map((f) => ({ kind: 'setter', name: f.name, roles: f.roles || [] }))
      .concat((iv.methods || []).map((m) => ({ kind: 'method', name: m.name, roles: m.roles || [] })));
    if (!writables.length) return;
    const card = document.createElement('div');
    card.style.cssText = 'padding:10px;border:1px solid var(--border);border-radius:11px;margin-bottom:8px;background:#080d18';
    card.innerHTML = '<div style="font-size:12px;font-weight:700;color:var(--cyan);margin-bottom:6px">' + iv.iface + '</div>' +
      writables.map((w) => {
        const liveVal = schema.live && schema.live[iv.iface + '.' + w.name];
        return '<div style="padding:6px;background:#0f172a;border-radius:8px;margin-bottom:5px;font-size:12px;display:flex;justify-content:space-between;align-items:center">' +
          '<div><b>' + w.name + '</b> <span style="color:var(--dim)">(' + w.kind + ')</span></div>' +
          '<button class="btn" style="flex:0;min-width:64px;padding:5px 10px;font-size:11px" onclick=\'fillRaw(' +
          JSON.stringify(iv.iface) + ',' + JSON.stringify(w.kind) + ',' + JSON.stringify(w.name) + ',' + JSON.stringify(liveVal !== undefined ? liveVal : 1) +
          ')\'>Chọn</button></div>';
      }).join('');
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
  const v = document.getElementById('inpCarName').value.trim() || 'BMW iDrive 7';
  localStorage.setItem('mybmw_car_name', v);
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

/* Exposed hook so Native Android QR/Intent handler can inject a scanned pairCode immediately */
window.injectPairCodeFromNative = function (raw) {
  const code = extractPairCode(raw);
  if (code) connectCar(code);
};

/* ---------------- Boot ---------------- */
(function init() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  renderAll();
  const initialCode = extractPairCode(location.hash) || extractPairCode(location.search) || localStorage.getItem('mybmw_pair') || '';
  if (initialCode) connectCar(initialCode);
  setInterval(renderAll, 15000);
})();
