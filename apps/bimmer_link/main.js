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
                m.vehicleProfile, m.valet, m.telemetry, m.lastTrip, m.trips.length, m.message, m.messageKind, m.armed, vis,
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

        await render();
        log.info('bimmer_link ready');
    },
});
