'use strict';
/**
 * main.js - in-car iDrive 7 UI for MyBMW & 1CR (`apps/bimmer_link`).
 *
 * Reads live state from `/run/bimmer-link/status.json` (written in RAM by `bimmer-link.service`)
 * and sends user commands to `/run/bimmer-link/app/command.json` (zero flash writes; falls back to `<dataDir>/command.json`).
 *
 * Node 8 compatible.
 */
const fs = require('fs');
const path = require('path');
const mgu = require('./kit/mgu');
const G = require('./kit/gauges');
const { Recorder } = require('./kit/record');
const UI = require('./ui');

const RUN = process.env.BL_RUN || '/run/bimmer-link';
const STALE_MS = 7000;
const ARM_MS = 6000;
const NOTE_MS = 8000;
const TIMER_PRESETS = ['07:30', '17:15', '12:00', 'off'];

mgu.run({
    async start(ctx) {
        const { ui, log } = ctx;
        const version = (ctx.spec && ctx.spec.version) ? ('Bản ' + ctx.spec.version) : 'Bản 0.1.0';
        let status = null, readAt = 0, cmdId = Date.now(), lastKey = '', shown = false;
        let armed = '', armedAt = 0, note = '', noteKind = 'dim', noteAt = 0, noteBaseMsg = '';
        let presetIdx = 0, viewMode = 'main', qrMode = 'app';

        function readStatus(now) {
            if (now - readAt < 650) return;
            readAt = now;
            let s = null;
            try { s = JSON.parse(fs.readFileSync(path.join(RUN, 'status.json'), 'utf8')); } catch (e) { s = null; }
            status = (s && typeof s.at === 'number' && Math.abs(now - s.at) < STALE_MS) ? s : null;
        }

        function send(cmd, arg) {
            const payload = JSON.stringify({ id: ++cmdId, cmd, arg: arg || {} });
            const ramCmd = path.join(RUN, 'app', 'command.json');
            let wroteRam = false;
            try {
                fs.writeFileSync(ramCmd + '.tmp', payload);
                fs.renameSync(ramCmd + '.tmp', ramCmd);
                wroteRam = true;
            } catch (e) { /* RAM folder not chowned yet; fallback to app dataDir */ }
            if (!wroteRam) {
                try {
                    const f = path.join(ctx.dataDir, 'command.json');
                    fs.writeFileSync(f + '.tmp', payload);
                    fs.renameSync(f + '.tmp', f);
                } catch (e) { log.warn('command ' + cmd + ': ' + (e && e.message)); }
            }
            readAt = 0;
        }

        function tell(text, kind) {
            note = text;
            noteKind = kind || 'go';
            noteAt = Date.now();
            noteBaseMsg = status ? String(status.message || '') : '';
        }

        const acts = {
            toggle1cr: () => {
                const now = Date.now();
                const isRunning = !!(status && status.telemetry && status.telemetry.climate1cr && status.telemetry.climate1cr.active);
                if (isRunning) {
                    armed = '';
                    send('stop1cr', {});
                    tell('Đã gửi lệnh tắt làm mát / nổ máy 1CR…', 'go');
                    return repaint();
                }
                if (armed === '1cr' && now - armedAt < ARM_MS) {
                    armed = '';
                    send('start1cr', {});
                    tell('Đang gửi lệnh kích hoạt đề nổ / làm mát 1CR…', 'go');
                    return repaint();
                }
                armed = '1cr';
                armedAt = now;
                tell('Bấm Đề nổ 1CR thêm lần nữa trong 6 giây để xác nhận.', 'warn');
                setTimeout(() => { if (armed === '1cr' && Date.now() - armedAt >= ARM_MS) { armed = ''; repaint(); } }, ARM_MS + 60);
                return repaint();
            },
            toggleValet: () => {
                armed = '';
                send('valet_toggle', {});
                const cur = !!(status && status.valet && status.valet.enabled);
                tell(cur ? 'Đang tắt chế độ giám sát Valet…' : 'Đang bật chế độ Valet & ghim toạ độ đỗ…', cur ? 'go' : 'warn');
                return repaint();
            },
            snapNow: () => {
                armed = '';
                send('snap_now', {});
                tell('Đang chụp trạng thái xe & đồng bộ lên App MyBMW…', 'go');
                return repaint();
            },
            cycleTimer: () => {
                armed = '';
                const pick = TIMER_PRESETS[presetIdx % TIMER_PRESETS.length];
                presetIdx++;
                if (pick === 'off') {
                    send('timer_off', {});
                    tell('Đang huỷ hẹn giờ nổ máy 1CR…', 'go');
                } else {
                    const p = pick.split(':');
                    send('timer_set', { hour: Number(p[0]), minute: Number(p[1]) });
                    tell('Đang nạp hẹn giờ nổ máy 1CR lúc ' + pick + ' vào hộp BDC/IHKA…', 'go');
                }
                return repaint();
            },
            nextIp: () => {
                send('next_ip', {});
                tell('Đã đổi sang địa chỉ mạng tiếp theo.', 'dim');
                return repaint();
            },
            toggleTrips: () => {
                viewMode = viewMode === 'trips' ? 'main' : 'trips';
                return repaint();
            },
            toggleQrMode: () => {
                qrMode = qrMode === 'app' ? 'local' : 'app';
                return repaint();
            },
        };

        function model() {
            const now = Date.now();
            readStatus(now);
            if (armed && now - armedAt >= ARM_MS) armed = '';
            if (note && !armed && (now - noteAt > NOTE_MS || (status && String(status.message || '') !== noteBaseMsg))) note = '';
            const s = status;
            const hostOf = (u) => String(u || '').replace(/^http:\/\//, '').replace(/\/\?pin=\d+$/, '');
            return {
                state: s ? 'ok' : 'down',
                version,
                viewMode,
                qrMode,
                url: s && s.url,
                cloudUrl: s && s.cloudUrl,
                cloudOk: !!(s && s.cloudOk),
                host: s && hostOf(s.url),
                pin: s && s.pin,
                ipCount: s && Array.isArray(s.ips) ? s.ips.length : 0,
                telegramOk: !!(s && s.telegramOk),
                ownerName: (s && s.ownerName) || '',
                tgError: (s && s.tgError) || '',
                vehicleProfile: (s && s.vehicleProfile) || null,
                valet: (s && s.valet) || { enabled: false, maxSpeed: 45, maxRpm: 3500, radiusM: 500 },
                destination: (s && s.destination) || null,
                telemetry: (s && s.telemetry) || {},
                lastTrip: (s && s.lastTrip) || null,
                trips: (s && s.trips) || [],
                message: note || (s && s.message) || '',
                messageKind: note ? noteKind : ((s && s.messageKind) || 'dim'),
                armed,
            };
        }

        const render = async () => {
            const m = model();
            const vis = ui.isVisible('MAIN');
            const key = JSON.stringify([
                m.state, m.viewMode, m.qrMode, m.url, m.cloudUrl, m.cloudOk, m.pin, m.telegramOk, m.ownerName, m.tgError,
                m.vehicleProfile, m.valet, m.destination, m.telemetry, m.lastTrip, m.trips.length, m.message, m.messageKind, m.armed, vis,
            ]);
            if (key === lastKey && shown) return;
            lastKey = key;
            shown = true;
            const cv = ctx.canvas(UI.W, UI.H) || new Recorder(UI.W, UI.H);
            UI.draw(cv, G, ctx.theme(), m, acts);
            await ui.image('MAIN_GFX', cv);
        };

        const loop = ctx.loop('MAIN', 4, render);
        function repaint() { lastKey = ''; return loop && loop.kick ? loop.kick() : render(); }
        if (ctx.onLayout) ctx.onLayout(repaint);

        ['BTN_1CR', 'BTN_VALET', 'BTN_SNAP', 'BTN_TIMER'].forEach((b) => { if (ctx.hideButton) ctx.hideButton(b); });
        ui.onClick('BTN_1CR', acts.toggle1cr);
        ui.onClick('BTN_VALET', acts.toggleValet);
        ui.onClick('BTN_SNAP', acts.snapNow);
        ui.onClick('BTN_TIMER', acts.cycleTimer);

        /* ---- Official OAP ACL bridge for ICAM2 360 camera wakeup & ClimateMaster 1CR calls ---- */
        const signals = ctx.signals;
        const oapProxies = {};
        let camCookie = null, camDetachTimer = null, lastOapSeq = 0;

        function writeAppFile(name, obj) {
            const txt = JSON.stringify(obj);
            const ramFile = path.join(RUN, 'app', name);
            try {
                fs.writeFileSync(ramFile + '.tmp', txt);
                fs.renameSync(ramFile + '.tmp', ramFile);
                return;
            } catch (e) {}
            try {
                const f = path.join(ctx.dataDir, name);
                fs.writeFileSync(f + '.tmp', txt);
                fs.renameSync(f + '.tmp', f);
            } catch (e) {}
        }

        async function getOapInstances(iface) {
            if (!signals || !signals.hasNative || !signals.hasNative()) return [];
            if (oapProxies[iface]) return oapProxies[iface];
            let cfg = null;
            try { cfg = signals.loadConfig(iface); } catch (e) { return []; }
            const instNames = Object.keys((cfg && cfg.instances) || { '1': 1 }).slice(0, 4);
            const list = [];
            for (let i = 0; i < instNames.length; i++) {
                try {
                    const px = await signals.proxy(iface, instNames[i]);
                    list.push({ inst: instNames[i], px });
                } catch (e) {}
            }
            if (list.length) oapProxies[iface] = list;
            return list;
        }

        // Pre-warm camera & primary climate proxies right at startup so zero discovery delay happens on snap/1CR
        [
            'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy',
            'de.bmw.infotainment.video.cameraproxy.CameraProxy',
            'de.bmw.dass.XView3D',
            'de.bmw.infotainment.climate.Climate2',
            'de.bmw.infotainment.climate.Climate',
            'de.bmw.infotainment.climate.climatemaster.ClimateMaster',
            'de.bmw.infotainment.lsc.LSCDataSink',
        ].forEach((ifn) => { getOapInstances(ifn).catch(() => {}); });

        const sleepOap = (ms) => new Promise((r) => setTimeout(r, ms));
        function oapGet(px, field, timeoutMs) {
            return new Promise((resolve, reject) => setImmediate(() => {
                try { Promise.resolve(px.getValue(field, timeoutMs || 1200)).then(resolve, reject); } catch (e) { reject(e); }
            }));
        }

        /* ---- OAP-ACL Live Closure (Doors / Hood / Trunk / Lock / CheckControl) & TPMS Watcher ---- */
        const oapBodyLive = {};
        let oapBodySeq = 0;
        let oapBodyFlushTimer = null;

        function decodeWireBySchema(val, sc) {
            if (val === null || val === undefined || !sc || typeof sc !== 'object') return val;
            const tp = String(sc.t || '');
            if (/^typedef$/i.test(tp) && sc.e && typeof sc.e === 'object') {
                return decodeWireBySchema(val, sc.e);
            }
            if (/^enum$/i.test(tp) && sc.e && typeof sc.e === 'object' && typeof val === 'number') {
                const names = Object.keys(sc.e);
                for (let i = 0; i < names.length; i++) {
                    if (sc.e[names[i]] === val) return names[i];
                }
                return val;
            }
            if (/^array$/i.test(tp) && sc.e && Array.isArray(val)) {
                return val.map((item) => decodeWireBySchema(item, sc.e));
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
                    out[k] = fSc ? decodeWireBySchema(val[k], fSc) : val[k];
                }
                return out;
            }
            return val;
        }

        function scheduleOapBodyFlush() {
            if (oapBodyFlushTimer) return;
            oapBodyFlushTimer = setTimeout(() => {
                oapBodyFlushTimer = null;
                writeAppFile('oap-body.json', { seq: ++oapBodySeq, at: Date.now(), fields: oapBodyLive });
            }, 180);
        }

        function recordOapField(ifn, fname, rawVal) {
            if (rawVal === undefined || rawVal === null) return;
            let decoded = rawVal;
            try {
                const cfg = signals && signals.loadConfig ? signals.loadConfig(ifn) : null;
                const fSc = cfg && cfg.fields && cfg.fields[fname] && cfg.fields[fname].schema;
                if (fSc) decoded = decodeWireBySchema(rawVal, fSc);
            } catch (e) {}
            oapBodyLive[ifn + '.' + fname] = decoded;
            scheduleOapBodyFlush();
        }

        // Direct verified OAP subscriptions matching mgu_diagnostics, car_vitals & service on G30 iDrive 7
        function firstOapInst(ifn) {
            try {
                const cfg = signals && signals.loadConfig ? signals.loadConfig(ifn) : null;
                const ks = Object.keys((cfg && cfg.instances) || {});
                if (ks.length) return ks[0];
            } catch (e) {}
            return '1';
        }
        const heldWatches = [];
        if (signals && signals.watch && signals.hasNative && signals.hasNative()) {
            let kombi2Sub = null;
            const keepWatch = (iface, handlers, pollMs, onSub) => {
                signals.watch(iface, firstOapInst(iface), handlers, log, pollMs ? { pollMs } : undefined)
                    .then((s) => { heldWatches.push(s); if (onSub) onSub(s); })
                    .catch(() => {});
            };

            keepWatch('de.bmw.body.DoorsWindowsRoofMirrors', {
                CentralLockingSystemAndPanelStatus: (v) => recordOapField('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus', v),
                CentralLockingSystemAndPanelStatus2: (v) => recordOapField('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus2', v),
                CentralLockingAndDoorLock: (v) => recordOapField('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingAndDoorLock', v),
                PositionSHD: (v) => recordOapField('de.bmw.body.DoorsWindowsRoofMirrors', 'PositionSHD', v),
            }, 3500);

            keepWatch('de.bmw.infotainment.vehicle.Vehicle2', {
                statusZVStatus: (v) => recordOapField('de.bmw.infotainment.vehicle.Vehicle2', 'statusZVStatus', v),
                statusDisplayedCCMessage: (v) => recordOapField('de.bmw.infotainment.vehicle.Vehicle2', 'statusDisplayedCCMessage', v),
                statusOperationBootLidTrigger: (v) => recordOapField('de.bmw.infotainment.vehicle.Vehicle2', 'statusOperationBootLidTrigger', v),
                statusSHD: (v) => recordOapField('de.bmw.infotainment.vehicle.Vehicle2', 'statusSHD', v),
            }, 4000);

            keepWatch('de.bmw.infotainment.vehicle.A4A', {
                statusA4ALids: (v) => recordOapField('de.bmw.infotainment.vehicle.A4A', 'statusA4ALids', v),
                statusA4AWindowRegulatorDRD: (v) => recordOapField('de.bmw.infotainment.vehicle.A4A', 'statusA4AWindowRegulatorDRD', v),
                statusA4AWindowRegulatorPSD: (v) => recordOapField('de.bmw.infotainment.vehicle.A4A', 'statusA4AWindowRegulatorPSD', v),
                statusA4AWindowRegulatorDRDR: (v) => recordOapField('de.bmw.infotainment.vehicle.A4A', 'statusA4AWindowRegulatorDRDR', v),
                statusA4AWindowRegulatorPSDR: (v) => recordOapField('de.bmw.infotainment.vehicle.A4A', 'statusA4AWindowRegulatorPSDR', v),
                statusSunroof2: (v) => recordOapField('de.bmw.infotainment.vehicle.A4A', 'statusSunroof2', v),
            }, 4000);

            keepWatch('de.bmw.body.AntiTheft', {
                statusDwa: (v) => recordOapField('de.bmw.body.AntiTheft', 'statusDwa', v),
                dWAAlarm: (v) => recordOapField('de.bmw.body.AntiTheft', 'dWAAlarm', v),
            }, 4500);

            keepWatch('de.bmw.body.doorsandwindows.WindowsRoofMaster', {
                statusWindowsRoofMasterDRD: (v) => recordOapField('de.bmw.body.doorsandwindows.WindowsRoofMaster', 'statusWindowsRoofMasterDRD', v),
                statusWindowsRoofMasterPSD: (v) => recordOapField('de.bmw.body.doorsandwindows.WindowsRoofMaster', 'statusWindowsRoofMasterPSD', v),
                statusWindowsRoofMasterDVDR: (v) => recordOapField('de.bmw.body.doorsandwindows.WindowsRoofMaster', 'statusWindowsRoofMasterDVDR', v),
                statusWindowsRoofMasterPSDR: (v) => recordOapField('de.bmw.body.doorsandwindows.WindowsRoofMaster', 'statusWindowsRoofMasterPSDR', v),
            }, 6000);

            keepWatch('de.bmw.infrastructure.VehicleCondition', {
                VehicleCondition: (v) => recordOapField('de.bmw.infrastructure.VehicleCondition', 'VehicleCondition', v),
            }, 8000);

            keepWatch('de.bmw.infotainment.KombiInterface_2', {
                ccList: (v) => recordOapField('de.bmw.infotainment.KombiInterface_2', 'ccList', v),
                newCCMessage: (v) => recordOapField('de.bmw.infotainment.KombiInterface_2', 'newCCMessage', v),
                cbsDataServiceList: (v) => recordOapField('de.bmw.infotainment.KombiInterface_2', 'cbsDataServiceList', v),
            }, 12000, (s) => { kombi2Sub = s; });

            keepWatch('de.bmw.infotainment.checkcontrol.CheckControlMaster', {
                basicList: (v) => {
                    recordOapField('de.bmw.infotainment.checkcontrol.CheckControlMaster', 'basicList', v);
                    if (kombi2Sub && kombi2Sub.proxy) {
                        oapGet(kombi2Sub.proxy, 'ccList', 1500)
                            .then((cc) => recordOapField('de.bmw.infotainment.KombiInterface_2', 'ccList', cc))
                            .catch(() => {});
                    }
                },
            }, 4500);

            keepWatch('de.bmw.infotainment.KombiIF', {
                statusRangeTankStatus: (v) => recordOapField('de.bmw.infotainment.KombiIF', 'statusRangeTankStatus', v),
                statusShowTimeDate: (v) => recordOapField('de.bmw.infotainment.KombiIF', 'statusShowTimeDate', v),
                statusTimeDate: (v) => recordOapField('de.bmw.infotainment.KombiIF', 'statusTimeDate', v),
            }, 10000);

            keepWatch('de.bmw.infotainment.lsc.LSCDataSink', {
                dWAStatus: (v) => recordOapField('de.bmw.infotainment.lsc.LSCDataSink', 'dWAStatus', v),
                positionWindowRegulatorDRD: (v) => recordOapField('de.bmw.infotainment.lsc.LSCDataSink', 'positionWindowRegulatorDRD', v),
                positionWindowRegulatorPSD: (v) => recordOapField('de.bmw.infotainment.lsc.LSCDataSink', 'positionWindowRegulatorPSD', v),
                positionWindowRegulatorDRDR: (v) => recordOapField('de.bmw.infotainment.lsc.LSCDataSink', 'positionWindowRegulatorDRDR', v),
                positionWindowRegulatorPSDR: (v) => recordOapField('de.bmw.infotainment.lsc.LSCDataSink', 'positionWindowRegulatorPSDR', v),
                positionSHD: (v) => recordOapField('de.bmw.infotainment.lsc.LSCDataSink', 'positionSHD', v),
                statusExtendedControlsTrunk: (v) => recordOapField('de.bmw.infotainment.lsc.LSCDataSink', 'statusExtendedControlsTrunk', v),
            }, 4500);

            keepWatch('de.bmw.infotainment.vehicle.TPMS', {
                statusTyrePressure: (v) => recordOapField('de.bmw.infotainment.vehicle.TPMS', 'statusTyrePressure', v),
                statusTargetTyrePressure: (v) => recordOapField('de.bmw.infotainment.vehicle.TPMS', 'statusTargetTyrePressure', v),
                statusTyreTemperature: (v) => recordOapField('de.bmw.infotainment.vehicle.TPMS', 'statusTyreTemperature', v),
            }, 12000);

            keepWatch('de.bmw.infotainment.navigation.positioning.Positioning', {
                rawPositionData: (v) => recordOapField('de.bmw.infotainment.navigation.positioning.Positioning', 'rawPositionData', v),
            }, 15000);
        }

        async function startOapBodyWatchers() {
            if (!signals || !signals.hasNative || !signals.hasNative()) return;
            const dirs = [
                path.resolve(__dirname, '..', '..', 'someipInterfaces'),
                path.resolve(__dirname, '..', '..', '..', 'someipInterfaces'),
                path.resolve(__dirname, '..', 'someipInterfaces'),
                path.resolve(__dirname, 'someipdefs'),
            ];
            let files = [], chosenDir = '';
            for (let d = 0; d < dirs.length; d++) {
                try {
                    const list = fs.readdirSync(dirs[d]).filter((f) => /\.json$/i.test(f) && !/^acl\.json$/i.test(f));
                    if (list.length) { files = list; chosenDir = dirs[d]; break; }
                } catch (e) {}
            }
            if (!files.length) return;

            const skipIfaceRe = /(^|\.)(hmi|oap|oapcontroller|cameraproxy|xview|climate|steeringwheel|personalization|dataprivacy|lifecycle|provisioning|nodestatemanager|tasu|telephone|conntelesync|connectivity|telematic|esim|esimproxy|rollsroyce|fondccu|visionaccess|doormenubutton|resetlogic|centrallockingsystemgw|caraccess|remoteservices|controlhmi)(\.|$)/i;
            const wantFieldRe = /(CentralLockingSystemAndPanelStatus|CentralLockingAndDoorLock|statusZVStatus|statusA4ALids|statusA4AWindowRegulator|statusSunroof|statusWindowsRoofMaster|windowStatus|statusDwa\b|dWAAlarm|statusDisplayedCCMessage|statusActiveCCMessage|basicList|ccList|newCCMessage|cbsDataServiceList|cbsDataSBA|statusRangeTankStatus|statusShowTimeDate|statusTimeDate|statusTyrePressure|statusTyreTemperature|statusNewCurrentUnitsStatusExt|ExteriorTemperature|currentLocation|rawPositionData|door|tuer|flap|klappe|bonnet|hood|motorhaube|haube|tailgate|trunk|bootLid|heckklappe|kofferraum|centralLock|doorLock|verriegel|zentralverriegel|checkControl|pressureTyre|tyrePressure|tirePressure|positionWindow|positionSHD|dWAStatus|mileageRange|^range$|dataRangeDisplay|fuelSupply|VehicleCondition|parkingFunctionIncident)/i;
            const skipFieldRe = /(^request|^remoteControl|windowControl|DriveRequest|windowAvailable|windowComfort|ckm|keyMemory|setting|config|quittier|autoLock|verriegelnBei|dynamicRange|speedRange|scaleRange|freqRange|audio|exhaust|abgas|radiator|kuehler|jalousie|airFlap|climate|tankFlap|charge|charging|lade|mirror|spiegel|handle|griff|light|licht|heating)/i;
            const pollTargets = [];

            for (let fi = 0; fi < files.length; fi++) {
                let cfg = null;
                try { cfg = JSON.parse(fs.readFileSync(path.join(chosenDir, files[fi]), 'utf8')); } catch (e) { continue; }
                const stem = files[fi].replace(/\.json$/i, '');
                const ifn = (cfg && cfg.interfaceName ? String(cfg.interfaceName).replace(/\//g, '.') : '') || stem.replace(/_/g, '.');
                if (skipIfaceRe.test(ifn)) continue;
                const fieldsObj = (cfg && cfg.fields) || {};
                const matched = Object.keys(fieldsObj).filter((fn) => wantFieldRe.test(fn) && !skipFieldRe.test(fn));
                if (!matched.length) continue;

                let list = await getOapInstances(ifn);
                if (!list.length && ifn !== stem) list = await getOapInstances(stem);
                if (!list.length) continue;

                for (let li = 0; li < list.length; li++) {
                    const px = list[li].px;
                    const gettersOnPx = [];
                    for (let mi = 0; mi < matched.length; mi++) {
                        const fname = matched[mi];
                        const fMeta = fieldsObj[fname] || {};
                        const fullKey = ifn + '.' + fname;
                        const onVal = (rawVal) => {
                            if (rawVal === undefined || rawVal === null) return;
                            oapBodyLive[fullKey] = fMeta.schema ? decodeWireBySchema(rawVal, fMeta.schema) : rawVal;
                            scheduleOapBodyFlush();
                        };
                        if (fMeta.event || fMeta.notifier) {
                            try { await signals.on(px, fname, onVal, log); } catch (e) {}
                        }
                        if (fMeta.getter) {
                            const readNow = () => { oapGet(px, fname, 1800).then(onVal).catch(() => {}); };
                            gettersOnPx.push(readNow);
                            readNow();
                            if (li === 0) {
                                pollTargets.push({
                                    px, fname, onVal,
                                    fast: /^(CentralLockingSystemAndPanelStatus|CentralLockingAndDoorLock|statusZVStatus|statusA4ALids|statusDwa|dWAStatus|basicList|centralLockingStatus|statusCentralLocking)/i.test(fname),
                                });
                            }
                        }
                    }
                    if (gettersOnPx.length) {
                        if (signals.onAvailable) {
                            signals.onAvailable(px, (avail) => { if (avail) gettersOnPx.forEach((fn) => fn()); }).catch(() => {});
                        }
                        setTimeout(() => { gettersOnPx.forEach((fn) => fn()); }, 900);
                    }
                }
            }

            // Read-only trunk lid status method on MultiConsumerTrunkLidAction (if available)
            getOapInstances('de.bmw.body.MultiConsumerTrunkLidAction').then((tList) => {
                if (!tList.length) return;
                const tPx = tList[0].px;
                let outSc = null;
                try {
                    const tCfg = signals.loadConfig('de.bmw.body.MultiConsumerTrunkLidAction');
                    outSc = tCfg && tCfg.methods && tCfg.methods.getTrunkLidStatus && (tCfg.methods.getTrunkLidStatus.outSchema || tCfg.methods.getTrunkLidStatus.schema);
                } catch (e) {}
                const pollTrunk = () => {
                    signals.call(tPx, 'getTrunkLidStatus', {}, 1500).then((r) => {
                        if (r !== undefined && r !== null) {
                            oapBodyLive['de.bmw.body.MultiConsumerTrunkLidAction.getTrunkLidStatus'] = outSc ? decodeWireBySchema(r, outSc) : r;
                            scheduleOapBodyFlush();
                        }
                    }).catch(() => {});
                };
                if (signals.onAvailable) signals.onAvailable(tPx, (a) => { if (a) pollTrunk(); }).catch(() => {});
                setTimeout(pollTrunk, 950);
                setInterval(pollTrunk, 4000);
            }).catch(() => {});

            if (pollTargets.length) {
                setInterval(() => {
                    for (let i = 0; i < pollTargets.length; i++) {
                        const pt = pollTargets[i];
                        oapGet(pt.px, pt.fname, 1500).then(pt.onVal).catch(() => {});
                    }
                }, 20000);
                const fastTargets = pollTargets.filter((pt) => pt.fast);
                if (fastTargets.length) {
                    setInterval(() => {
                        for (let i = 0; i < fastTargets.length; i++) {
                            const pt = fastTargets[i];
                            oapGet(pt.px, pt.fname, 1200).then(pt.onVal).catch(() => {});
                        }
                    }, 3500);
                }
            }
        }
        startOapBodyWatchers().catch(() => {});

        async function readOap1crLive() {
            const out = {};
            const probes = [
                ['de.bmw.infotainment.lsc.LSCDataSink', 'statusAirConditioningParkFunctions'],
                ['de.bmw.infotainment.lsc.LSCDataSink', 'dWAStatus'],
                ['de.bmw.infotainment.climate.Climate2', 'statusAirConditionParkFunctions'],
                ['de.bmw.infotainment.climate.climatemaster.ClimateMaster', 'statusParkingFunctionsOn'],
                ['de.bmw.infotainment.climate.climatemaster.ClimateMaster', 'parkingFunctionsRES'],
                ['de.bmw.infotainment.climate.climatemaster.ClimateMaster', 'statusAvailableParkingFunctionsRES'],
            ];
            for (let i = 0; i < probes.length; i++) {
                const ifn = probes[i][0], fn = probes[i][1];
                try {
                    const list = await getOapInstances(ifn);
                    if (!list.length) continue;
                    let cfg = null;
                    try { cfg = signals.loadConfig(ifn); } catch (e) {}
                    const fSc = cfg && cfg.fields && cfg.fields[fn] && cfg.fields[fn].schema;
                    const rawVal = await oapGet(list[0].px, fn, 650).catch(() => null);
                    if (rawVal !== null && rawVal !== undefined) {
                        out[ifn + '.' + fn] = fSc ? decodeWireBySchema(rawVal, fSc) : rawVal;
                    }
                } catch (e) {}
            }
            out._oapBodyLive = oapBodyLive;
            return out;
        }

        async function attachOrDetachCam(wantOn) {
            if (!signals || !signals.hasNative || !signals.hasNative()) {
                return { ok: false, error: 'no native signals' };
            }
            const icamList = await getOapInstances('de.bmw.infotainment.video.cameraproxy.ICAM2Proxy');
            const camList = await getOapInstances('de.bmw.infotainment.video.cameraproxy.CameraProxy');
            const icam = icamList[0] && icamList[0].px;
            const cam = camList[0] && camList[0].px;
            if (!icam && !cam) return { ok: false, error: 'no ICAM2Proxy/CameraProxy' };

            const callBase = (method, arg) => {
                const first = icam || cam;
                return signals.call(first, method, arg, 6000).catch((e) => {
                    if (cam && first !== cam) return signals.call(cam, method, arg, 6000);
                    throw e;
                });
            };

            if (!wantOn) {
                if (camDetachTimer) { clearTimeout(camDetachTimer); camDetachTimer = null; }
                if (camCookie === null) return { ok: true, released: false };
                const c = camCookie;
                camCookie = null;
                await callBase('clientDetach', { cookie: c }).catch(() => {});
                return { ok: true, released: true };
            }

            if (icam) {
                const xvList = await getOapInstances('de.bmw.dass.XView3D');
                const xv = xvList[0] && xvList[0].px;
                const xvSt = xv ? await oapGet(xv, 'CurrentState', 1500).catch(() => null) : null;
                const icSt = await oapGet(icam, 'currentState', 1500).catch(() => null);
                const raw = JSON.stringify({ xv: xvSt, ic: icSt });
                if (/PDC|PARK|RVC|TOP_VIEW|PANORAMA/i.test(raw) || (/DR_ACTIVE|"application":51\b/i.test(raw) && /"perspective":7\b/.test(raw))) {
                    return { ok: true, alreadyOn: true };
                }
            }

            if (camCookie === null) {
                const att = await callBase('clientAttach', { type: 'CLIENT_INDIRECT' })
                    .catch(() => callBase('clientAttach', { type: 1 }));
                camCookie = (att && typeof att === 'object' && att.cookie !== undefined) ? att.cookie : att;
            }
            if (icam) {
                await signals.call(icam, 'changeState', { cookie: camCookie, desiredState: { application: 'DR_ACTIVE', mode: 'MODE_MOSAIK', perspective: 7 } }, 6000)
                    .catch(() => signals.call(icam, 'changeState', { cookie: camCookie, desiredState: { application: 51, mode: 50, perspective: 7 } }, 6000));
            }
            if (camDetachTimer) clearTimeout(camDetachTimer);
            camDetachTimer = setTimeout(() => { attachOrDetachCam(false).catch(() => {}); }, 12000);
            log.info('360 cam attached via OAP cookie=' + camCookie);
            return { ok: true, cookie: camCookie };
        }

        async function callSmartParkingMethod(px, name, basePayload, altPayload) {
            const invoke = (pl) => signals.call(px, name, pl, 3000);
            let res = await invoke(basePayload).catch((e) => {
                if (altPayload !== undefined) return invoke(altPayload);
                throw e;
            });
            if (name !== 'requestParkingFunctionsOn' || !res || !res.accepted || !/NOT_ACCEPTED/.test(String(res.accepted))) {
                return res;
            }
            const acc = String(res.accepted);
            if (/LOW_PRIORITY/i.test(acc)) {
                const gids = [0, 1, 2, 3];
                for (let i = 0; i < gids.length; i++) {
                    if (basePayload && basePayload.clientGroupId === gids[i]) continue;
                    const pTry = Object.assign({}, basePayload, { clientGroupId: gids[i] });
                    const rTry = await invoke(pTry).catch(() => null);
                    if (rTry && (!rTry.accepted || !/NOT_ACCEPTED/.test(String(rTry.accepted)))) return rTry;
                    if (rTry) res = rTry;
                }
            }
            if (res && res.accepted && /MIN_VALUE|MAX_VALUE/i.test(String(res.accepted))) {
                const times = [15, 30, 5, 1];
                for (let i = 0; i < times.length; i++) {
                    const pTry = Object.assign({}, basePayload, { timeParkingFunctionsAutoMode: times[i] });
                    const rTry = await invoke(pTry).catch(() => null);
                    if (rTry && (!rTry.accepted || !/NOT_ACCEPTED/.test(String(rTry.accepted)))) return rTry;
                    if (rTry) res = rTry;
                }
            }
            return res;
        }

        async function handleOapReq(req) {
            if (!req || !req.seq || req.seq === lastOapSeq) return;
            lastOapSeq = req.seq;
            try {
                if (req.kind === 'read_1cr_live') {
                    const liveAfter = await readOap1crLive();
                    writeAppFile('oap-reply.json', { seq: req.seq, ok: true, liveAfter });
                    return;
                }
                if (req.kind === 'cam_attach' || req.kind === 'cam_detach') {
                    const camRes = await attachOrDetachCam(req.kind === 'cam_attach');
                    writeAppFile('oap-reply.json', Object.assign({ seq: req.seq }, camRes));
                    return;
                }
                const list = await getOapInstances(req.iface);
                if (!list.length) {
                    writeAppFile('oap-reply.json', { seq: req.seq, ok: false, error: 'no OAP config for ' + req.iface });
                    return;
                }
                let lastErr = null;
                for (let i = 0; i < list.length; i++) {
                    const it = list[i];
                    try {
                        let res;
                        if (req.kind === 'getter') {
                            res = await oapGet(it.px, req.name, 2200);
                        } else if (req.kind === 'setter') {
                            res = await signals.set(it.px, req.name, req.payload, 3200).catch((e) => {
                                if (req.altPayload !== undefined) return signals.set(it.px, req.name, req.altPayload, 3200);
                                throw e;
                            });
                        } else {
                            res = await callSmartParkingMethod(it.px, req.name, req.payload, req.altPayload);
                        }
                        let liveAfter = null;
                        if (req.kind !== 'getter' && /climate|lsc|lock|door|vehicle|body/i.test(req.iface)) {
                            await sleepOap(650);
                            liveAfter = await readOap1crLive();
                        }
                        writeAppFile('oap-reply.json', { seq: req.seq, ok: true, inst: it.inst, response: res === undefined ? null : res, liveAfter });
                        return;
                    } catch (e) {
                        lastErr = e;
                    }
                }
                writeAppFile('oap-reply.json', { seq: req.seq, ok: false, error: String(lastErr && lastErr.message || lastErr || 'call failed') });
            } catch (e) {
                writeAppFile('oap-reply.json', { seq: req.seq, ok: false, error: String(e && e.message || e) });
            }
        }

        setInterval(() => {
            const now = Date.now();
            if (now - readAt >= 180) {
                readAt = 0;
                readStatus(now);
            }
            if (status && status.oapReq && status.oapReq.seq && Math.abs(now - (status.oapReq.at || now)) < 12000) {
                handleOapReq(status.oapReq);
            }
        }, 180);

        await render();
        log.info('bimmer_link ready');
    },
});
