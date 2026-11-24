'use strict';
/**
 * bimmer_link_test.js - unit & integration tests for MyBMW & 1CR (`bimmer_link` + `bimmer-link`).
 * Runs on Node 8+ with zero external dependencies.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CarLink = require('../tools/bimmer-link/car-link');
const Snap = require('../tools/bimmer-link/snapshot');
const Tg = require('../tools/bimmer-link/telegram');
const Up = require('../tools/bimmer-link/uplink');
const Svc = require('../tools/bimmer-link/bimmer-link');
const UI = require('../apps/bimmer_link/ui');
const { Canvas } = require('../kit/runtime/canvas');
const G = require('../kit/runtime/gauges');
const themes = require('../kit/runtime/themes');

async function runTests() {
    // 1. Positioning & underground garage coordinate extraction
    const navSample = {
        coordinatesValid: true,
        baseLocation: {
            coordinates: { latitude: 107768890, longitude: 1067008060 },
            textDescription: {
                textDescriptorList: [
                    [14, { orthography: 'Lê Thánh Tôn' }],
                    [33, { orthography: 'Quận 1' }],
                    [13, { orthography: 'TP. Hồ Chí Minh' }],
                ],
            },
        },
    };
    const coords = CarLink.extractCoords(navSample, 0);
    assert(coords && Math.abs(coords.lat - 10.776889) < 1e-5 && Math.abs(coords.lon - 106.700806) < 1e-5, 'micro-degree WGS84 extraction');
    const place = CarLink.extractPlaceText(navSample);
    assert.strictEqual(place.street, 'Lê Thánh Tôn');
    assert.strictEqual(place.district, 'Quận 1');
    assert.strictEqual(place.city, 'TP. Hồ Chí Minh');

    // 2. Climate & 1CR catalog discovery + payload synthesis
    const fakeCatalog = {
        interfaces: {
            'de.bmw.infotainment.climate.Climate': {
                serviceId: 1234,
                fields: {
                    remoteEngineStartConsent: { getter: true, setter: true, notifier: true, type: 'ConsentEnum' },
                    directOperationAuxiliaryClimate: { getter: true, setter: true, notifier: true, type: 'AuxModeEnum' },
                    departureTimer1: { getter: true, setter: true, notifier: true, type: 'TimerStruct' },
                    interiorTemperature: { getter: true, setter: false, notifier: true, type: 'Int16' },
                },
                methods: {
                    startPreconditioning: { inArgs: [{ name: 'mode', type: 'AuxModeEnum' }] },
                },
            },
        },
        enumerations: {
            ConsentEnum: { values: ['INVALID', 'OFF', 'ON'] },
            AuxModeEnum: { values: ['INACTIVE', 'ACTIVE', 'ERROR'] },
        },
        structs: {
            TimerStruct: {
                fields: [
                    { name: 'slotId', type: 'UInt8' },
                    { name: 'operationHour', type: 'UInt8' },
                    { name: 'operationMinute', type: 'UInt8' },
                    { name: 'active', type: 'Boolean' },
                ],
            },
        },
    };
    const disc = CarLink.discoverClimateCatalog(fakeCatalog);
    assert.strictEqual(disc.interfaces.length, 1);
    const fields = disc.interfaces[0].fields;
    const directField = fields.find((f) => f.name === 'directOperationAuxiliaryClimate');
    assert(directField.roles.indexOf('direct_write') >= 0, 'classified direct_write');
    assert.strictEqual(CarLink.buildDirectPayload(directField, true), 'ACTIVE');
    assert.strictEqual(CarLink.buildDirectPayload(directField, false), 'INACTIVE');

    const timerField = fields.find((f) => f.name === 'departureTimer1');
    const timerPayload = CarLink.buildTimerPayload(timerField, 17, 15, true);
    assert.strictEqual(timerPayload.operationHour, 17);
    assert.strictEqual(timerPayload.operationMinute, 15);
    assert.strictEqual(timerPayload.active, true);

    // 3. TelemetryTracker: drive -> shutdown emits `parked` with Trip summary
    const trk = new CarLink.TelemetryTracker();
    const t0 = 1700000000000;
    trk.update({ condition: 10, rpm: 1450, speed: 42, odometerKm: 12000, fuelPct: 70, pos: { lat: 10.77, lon: 106.70 } }, t0);
    trk.update({ speed: 68, rpm: 2800, odometerKm: 12012.4, fuelPct: 68.5, pos: { lat: 10.80, lon: 106.75 } }, t0 + 18 * 60000);
    const evs = trk.update({ condition: 12, rpm: 0, speed: 0, stage: 'P' }, t0 + 20 * 60000);
    assert.strictEqual(evs.length, 1);
    assert.strictEqual(evs[0].type, 'parked');
    assert.strictEqual(evs[0].trip.distanceKm, 12.4);
    assert.strictEqual(evs[0].trip.maxSpeed, 68);
    assert.strictEqual(evs[0].trip.durationMin, 20);

    // 4. Snapshot PNG generator (both pure telemetry card & 4-camera RGBA composite)
    const cardSnap = Snap.renderSnapshotPng(trk.state, { title: 'DA DO XE', trip: evs[0].trip });
    assert(Buffer.isBuffer(cardSnap.png) && cardSnap.png.slice(0, 4).toString('hex') === '89504e47', 'valid PNG header');
    assert.strictEqual(cardSnap.hasCamera, false);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-test-'));
    const rawCam = path.join(tmpDir, 'cam4.rgba');
    fs.writeFileSync(rawCam, Buffer.alloc(960 * 440 * 4, 120));
    const camSnap = Snap.renderSnapshotPng(trk.state, { title: '360 CAM' }, { rawCamFile: rawCam });
    assert.strictEqual(camSnap.hasCamera, true);
    assert(camSnap.png.length > 2000);

    // 5. End-to-end Service + Mock Telegram Server + Valet Violation + Phone HTTP API
    const tgCalls = [];
    const mockTg = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            tgCalls.push({ url: req.url, bodyLen: raw.length, text: raw.toString('utf8', 0, Math.min(raw.length, 600)) });
            if (/\/getUpdates$/.test(req.url)) {
                res.end(JSON.stringify({ ok: true, result: [{ update_id: 10, message: { chat: { id: 889900, first_name: 'Dragon' }, text: 'hi' } }] }));
            } else {
                res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
            }
        });
    });
    await new Promise((r) => mockTg.listen(0, '127.0.0.1', r));
    const tgPort = mockTg.address().port;

    const svc = Svc.createService({
        run: path.join(tmpDir, 'run'),
        state: path.join(tmpDir, 'state'),
        oap: path.join(tmpDir, 'oap'),
        noWorker: true,
        port: 0,
        ips: '192.168.1.50',
        tgBaseUrl: 'http://127.0.0.1:' + tgPort,
    });
    const running = svc.start();
    await new Promise((r) => setTimeout(r, 80));

    // Phone API: detect chat ID & trigger Valet overspeed alert
    const portalPort = svc.S.port;
    const pin = svc.S.pin;
    const postPortal = (p, obj) => new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify(obj), 'utf8');
        const req = http.request({
            host: '127.0.0.1', port: portalPort, path: p + '?pin=' + pin, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
        }, (res) => {
            const ch = []; res.on('data', (c) => ch.push(c));
            res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(ch).toString('utf8')) }));
        });
        req.on('error', reject);
        req.end(data);
    });

    const det = await postPortal('/api/detect-chat', { botToken: '111:FAKE_TOKEN' });
    assert.strictEqual(det.json.ok, true);
    assert.strictEqual(det.json.chatId, '889900');

    await postPortal('/api/action', { action: 'valet_set', arg: { mode: 'on' } });
    const beforeAlerts = tgCalls.filter((x) => /sendPhoto/.test(x.url)).length;
    svc.onWorkerEvent({ ev: 'telemetry', state: Object.assign({}, trk.state, { speed: 75, rpm: 4100 }) });
    await new Promise((r) => setTimeout(r, 120));
    const afterAlerts = tgCalls.filter((x) => /sendPhoto/.test(x.url)).length;
    assert(afterAlerts > beforeAlerts, 'Valet violation sent photo alert to Telegram');

    // 6. In-car iDrive 7 UI draw verification
    const cv = new Canvas(UI.W, UI.H);
    UI.draw(cv, G, themes.id7 || themes.bmw || { text: '#ffffff', dim: '#94a3b8', accent: '#38bdf8', accent2: '#4da6ff', go: '#2fd27a', warn: '#ffb020', crit: '#ef2b2d' }, {
        state: 'ok',
        version: 'Bản 0.1.0',
        url: 'http://192.168.1.50:8139/?pin=1234',
        host: '192.168.1.50:8139',
        pin: '1234',
        ipCount: 1,
        telegramOk: true,
        ownerName: 'Dragon',
        valet: { enabled: true, maxSpeed: 45, maxRpm: 3500, radiusM: 500 },
        telemetry: trk.state,
        lastTrip: evs[0].trip,
        trips: [evs[0].trip],
        message: 'Đã gửi ảnh & vị trí đỗ xe về Telegram.',
        messageKind: 'go',
    }, {});
    assert(cv.png().length > 5000, 'in-car UI canvas renders valid PNG');

    running.stop();
    mockTg.close();
    console.log('ALL bimmer_link_test checks passed!');
}

runTests().catch((e) => {
    console.error(e);
    process.exit(1);
});
