'use strict';
/**
 * ui.js - pure 1600x520 GPU canvas layout for MyBMW & 1CR (`apps/bimmer_link`).
 *
 * Left pane: QR code + 4-digit PIN + network IP switcher (or recent Trip Log list).
 * Right pane: Telegram connection badge + 3 live status cards (Option 1CR Remote Start, Vehicle & Underground Pos, Valet Guard)
 *             + status message bar + 4 touch/controller action buttons.
 *
 * Node 8 compatible.
 */
const QR = require('./kit/qr');

const W = 1600, H = 520;
const nop = () => {};

function kindColor(t, kind) {
    if (kind === 'go') return t.go || '#2fd27a';
    if (kind === 'warn') return t.warn || '#ffb020';
    if (kind === 'crit') return t.crit || '#ef2b2d';
    return t.dim || '#94a3b8';
}

function fit(cv, str, size, o, max) {
    str = String(str || '');
    if (cv.textWidth(str, size, o) <= max) return str;
    while (str.length > 1 && cv.textWidth(str + '…', size, o) > max) str = str.slice(0, -1);
    return str + '…';
}

function infoCard(cv, G, t, x, y, w, h, spec) {
    const accent = spec.accent || (t.accent2 || '#4da6ff');
    const active = !!spec.active;
    cv.roundRect(x, y, w, h, 14, G.withAlpha('#ffffff', active ? 0.08 : 0.04));
    cv.strokeRoundRect(x, y, w, h, 14, active ? 2 : 1.2, active ? G.withAlpha(accent, 0.92) : G.withAlpha('#ffffff', 0.18));
    cv.fillRect(x + 1, y + 16, 4, h - 32, accent);

    cv.text(fit(cv, spec.title, 21, { literal: true, font: 'bold' }, w - 36), x + 20, y + 34, 21, t.text, { literal: true, font: 'bold' });
    cv.circle(x + 26, y + 66, 6, active ? accent : G.withAlpha('#ffffff', 0.35));
    cv.text(fit(cv, spec.headline, 22, { literal: true, font: 'bold' }, w - 52), x + 40, y + 74, 22, active ? accent : t.text, { literal: true, font: 'bold' });

    cv.text(fit(cv, spec.line1, 16, { literal: true, font: 'label' }, w - 36), x + 20, y + 108, 16, t.dim, { literal: true, font: 'label' });
    cv.text(fit(cv, spec.line2, 16, { literal: true, font: 'label' }, w - 36), x + 20, y + 134, 16, spec.line2Color || t.dim, { literal: true, font: 'label' });

    if (spec.hint) {
        cv.text(spec.hint, x + w - 18, y + h - 14, 14, accent, { literal: true, align: 'right', font: 'bold' });
    }
    if (spec.onTap && cv.target) {
        cv.target(x, y, w, h, spec.onTap, spec.key || spec.title);
    }
}

function drawTripsPane(cv, G, t, lx, top, trips, onBack) {
    const w = 310, h = 365;
    cv.roundRect(lx, top, w, h, 16, G.withAlpha('#ffffff', 0.045));
    cv.strokeRoundRect(lx, top, w, h, 16, 1.3, G.withAlpha('#ffffff', 0.2));
    cv.text('NHẬT KÝ CHUYẾN ĐI', lx + 20, top + 34, 18, t.text, { literal: true, font: 'bold' });
    cv.text('Đóng', lx + w - 20, top + 34, 16, t.accent2 || '#81c4ff', { literal: true, align: 'right', font: 'bold' });
    if (cv.target && onBack) cv.target(lx, top, w, 46, onBack, 'blBackQr');

    if (!trips || !trips.length) {
        cv.text('Chưa có chuyến đi nào', lx + w / 2, top + 180, 17, t.dim, { literal: true, align: 'center', font: 'label' });
        cv.text('Tự lưu khi nổ máy chạy > 100m', lx + w / 2, top + 208, 14, t.dim, { literal: true, align: 'center', font: 'label' });
        return;
    }

    const list = trips.slice(0, 5);
    for (let i = 0; i < list.length; i++) {
        const tr = list[i];
        const ry = top + 54 + i * 60;
        cv.roundRect(lx + 14, ry, w - 28, 52, 10, G.withAlpha('#ffffff', 0.04));
        const d = new Date(tr.endedAt || Date.now());
        const pad = (n) => (n < 10 ? '0' : '') + n;
        const when = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ' ' + pad(d.getDate()) + '/' + (d.getMonth() + 1);
        cv.text(when + ' · ' + tr.distanceKm + ' km', lx + 24, ry + 22, 16, t.text, { literal: true, font: 'bold' });
        cv.text(tr.durationMin + ' phút · Max ' + tr.maxSpeed + ' km/h', lx + 24, ry + 42, 14, t.dim, { literal: true, font: 'label' });
    }
}

function draw(cv, G, t, v, act) {
    act = act || {};
    cv.clear(t.bg);
    G.frame(cv, t, ['MyBMW & 1CR'], 0, []);
    G.panel(cv, t, 24, G.TOP, W - 48, G.BOTTOM - G.TOP, null);

    const lx = 64;
    const top = G.TOP + 34;
    const bottom = G.pageBottom(cv) - (cv.own ? G.MARGIN : 0);

    // LEFT PANE: QR (MyBMW Cloud App or Local Wi-Fi) or Trip Log
    if (v.viewMode === 'trips') {
        drawTripsPane(cv, G, t, lx - 16, top - 6, v.trips, act.toggleTrips);
    } else if (v.state === 'ok' && v.qrMode !== 'local' && v.cloudUrl) {
        let side = 0;
        try { side = QR.draw(cv, v.cloudUrl, lx + 4, top, 5); } catch (e) { side = 0; }
        const qside = side || 245;
        const qx = lx + 4 + qside / 2;
        cv.text('QUÉT GHÉP APP MYBMW', qx, top + qside + 32, 14, t.go || '#2fd27a', { literal: true, align: 'center', font: 'bold', spacing: 1 });
        cv.text('iPhone & Android (4G / Cloud)', qx, top + qside + 58, 16, t.text, { literal: true, align: 'center', font: 'label' });
        cv.text('Chạm đổi sang QR Wi-Fi nội bộ', qx, top + qside + 88, 14, t.accent2 || '#81c4ff', { literal: true, align: 'center', font: 'bold' });
        if (cv.target && act.toggleQrMode) {
            cv.target(lx, top + qside + 68, qside + 12, 34, act.toggleQrMode, 'blToggleQr');
        }
    } else if (v.state === 'ok' && v.url) {
        let side = 0;
        try { side = QR.draw(cv, v.url, lx, top, 7); } catch (e) { side = 0; }
        const qside = side || 259;
        const qx = lx + qside / 2;
        cv.text('MÃ PIN WI-FI NỘI BỘ', qx, top + qside + 28, 13, t.dim, { literal: true, align: 'center', font: 'bold', spacing: 1.5 });
        cv.text(String(v.pin || '').split('').join(' '), qx, top + qside + 72, 46, t.text, { literal: true, align: 'center', font: 'bold', spacing: 3 });
        const ipHint = (v.host || '') + ' · Đổi sang QR App';
        cv.text(ipHint, qx, top + qside + 98, 13, t.accent2 || '#81c4ff', { literal: true, align: 'center', font: 'bold' });
        if (cv.target && act.toggleQrMode) {
            cv.target(lx, top + qside + 80, qside, 30, act.toggleQrMode, 'blToggleQr2');
        }
    } else {
        cv.roundRect(lx, top, 259, 259, 18, G.withAlpha('#ffffff', 0.05));
        cv.strokeRoundRect(lx, top, 259, 259, 18, 1.5, G.withAlpha('#ffffff', 0.2));
        const why = v.state === 'down' ? 'ĐANG KHỞI ĐỘNG TRỢ THỦ' : 'CHƯA CÓ WI-FI / HOTSPOT';
        cv.text(why, lx + 130, top + 134, 17, t.dim, { literal: true, align: 'center', font: 'bold' });
        cv.text('Nối Wi-Fi hoặc điểm phát sóng', lx + 130, top + 162, 14, t.dim, { literal: true, align: 'center', font: 'label' });
    }

    // RIGHT PANE: Header + Connection + 3 Cards + Action Bar
    const rx = 432, rw = W - 56 - rx;
    cv.text('MYBMW & 1CR', rx, G.TOP + 72, 38, t.text, { literal: true, font: 'bold', spacing: 2 });

    const linkReady = v.cloudOk || v.telegramOk || !!v.cloudUrl;
    const tgColor = v.state !== 'ok' ? kindColor(t, 'warn') : (linkReady ? kindColor(t, 'go') : kindColor(t, 'warn'));
    const tgLabel = v.state !== 'ok'
        ? 'Đang chờ dịch vụ bimmer-link…'
        : (v.cloudOk
            ? ('App MyBMW trực tuyến' + (v.telegramOk ? ' · Telegram sẵn sàng' : ''))
            : ('Quét mã QR bên trái bằng iPhone / Android để ghép App MyBMW'));
    const sx = rx + cv.textWidth('MYBMW & 1CR', 38, { literal: true, font: 'bold', spacing: 2 }) + 28;
    cv.circle(sx + 8, G.TOP + 64, 7, tgColor);
    cv.text(fit(cv, tgLabel, 18, { literal: true, font: 'label' }, W - 140 - (sx + 24)), sx + 24, G.TOP + 71, 18, tgColor, { literal: true, font: 'label' });

    if (v.version) {
        cv.text(v.version, W - 56, G.TOP + 34, 14, G.withAlpha('#ffffff', 0.38), { literal: true, align: 'right', font: 'label' });
    }
    const vp = v.vehicleProfile;
    const subLine = (vp && vp.chassis)
        ? (vp.modelTitle + (vp.paintLabel ? (' · ' + vp.paintLabel) : '') + ' — Đề nổ 1CR · Vị trí đỗ hầm · Giám sát Valet')
        : 'Tự chụp vị trí hầm khi tắt máy · Điều khiển đề nổ 1CR & hẹn giờ BDC/IHKA · Giám sát Valet';
    cv.text(fit(cv, subLine, 17, { literal: true, font: 'label' }, rw), rx, G.TOP + 106, 17, t.dim, { literal: true, font: 'label' });

    const tel = v.telemetry || {};
    const c1 = tel.climate1cr || {};
    const valet = v.valet || {};

    const gap = 18;
    const cw = Math.floor((rw - 2 * gap) / 3);
    const cy = G.TOP + 128, ch = 178;

    // Card 1: Option 1CR Remote Start & Departure Timer
    const c1Active = !!c1.active;
    const c1Head = c1.mode === 'engine_1cr'
        ? 'Đang nổ máy 1CR'
        : (c1.mode === 'vent_only'
            ? 'Quạt cabin đang chạy'
            : (c1Active ? 'Đang chạy AutoMode' : (c1.timerText && c1.timerText !== 'Tắt' ? ('Hẹn ' + c1.timerText) : 'Sẵn sàng kích hoạt')));
    const timerStr = c1.timerText && c1.timerText !== 'Tắt' ? ('Hẹn BDC: ' + c1.timerText) : 'Hẹn giờ: Tắt';
    infoCard(cv, G, t, rx, cy, cw, ch, {
        key: 'blCard1cr',
        title: 'Đề nổ từ xa 1CR',
        active: c1Active || !!(c1.timerText && c1.timerText !== 'Tắt'),
        accent: c1Active ? (c1.mode === 'vent_only' ? (t.warn || '#ffb020') : (t.go || '#2fd27a')) : '#a78bfa',
        headline: c1Head,
        line1: timerStr + (c1.discoveredCount ? (' · ' + c1.discoveredCount + ' cổng Climate') : ''),
        line2: c1.lastResult || 'Hỗ trợ kích trực tiếp & hẹn giờ BDC',
        hint: c1Active ? ' Tắt 1CR' : 'Thử nổ',
        onTap: act.toggle1cr,
    });

    // Card 2: Vehicle Location, Fuel, 12V & Lock Check
    const pos = tel.pos;
    const locTitle = pos
        ? ([pos.street, pos.district, pos.city].filter(Boolean).join(', ') || (pos.lat.toFixed(4) + ', ' + pos.lon.toFixed(4)))
        : 'Đang đọc GPS / Nav hầm…';
    const fuelBat = 'Xăng: ' + (tel.fuelPct != null ? tel.fuelPct + '%' : '--') +
        (tel.rangeKm != null ? (' (' + tel.rangeKm + ' km)') : '') +
        ' · Bình: ' + (tel.battery12v != null ? (tel.battery12v + 'V') : 'OK');
    const hasOpen = (tel.doorsOpen && tel.doorsOpen.length) || (tel.windowsOpen && tel.windowsOpen.length) || tel.trunkOpen || tel.hoodOpen || tel.locked === false;
    const dst = v.destination;
    const tireSummary = (tel.tires && tel.tires.fl != null)
        ? ('Lốp: ' + tel.tires.fl + '/' + tel.tires.fr + ' bar')
        : ('Máy ' + (tel.coolantC != null ? tel.coolantC + '°C' : '--') + ' · Ngoài ' + (tel.ambientC != null ? tel.ambientC + '°C' : '--'));
    const card2Line2 = dst
        ? ('Điểm đến App: ' + dst.name)
        : (hasOpen
            ? (tel.hoodOpen
                ? 'Chú ý: Nắp ca-pô đang mở!'
                : (tel.trunkOpen
                    ? 'Chú ý: Cốp sau đang mở!'
                    : ((tel.doorsOpen && tel.doorsOpen.length)
                        ? ('Chú ý: Mở ' + tel.doorsOpen.join(', '))
                        : ((tel.windowsOpen && tel.windowsOpen.length) ? ('Mở: ' + tel.windowsOpen.join(', ')) : 'Chú ý: Cửa xe đang mở khoá'))))
            : ('4 cửa, kính & capo kín · ' + tireSummary));
    infoCard(cv, G, t, rx + cw + gap, cy, cw, ch, {
        key: 'blCardCar',
        title: 'Vị trí & Trạng thái',
        active: !!pos,
        accent: hasOpen ? (t.warn || '#ffb020') : (t.accent2 || '#38bdf8'),
        headline: locTitle,
        line1: fuelBat,
        line2: card2Line2,
        line2Color: dst ? (t.go || '#2fd27a') : (hasOpen ? (t.warn || '#ffb020') : t.dim),
        hint: 'Gửi App',
        onTap: act.snapNow,
    });

    // Card 3: Valet Mode & Trip Log
    const tr = v.lastTrip;
    infoCard(cv, G, t, rx + 2 * (cw + gap), cy, cw, ch, {
        key: 'blCardValet',
        title: 'Valet & Hành trình',
        active: !!valet.enabled,
        accent: valet.enabled ? (t.warn || '#ffb020') : (t.go || '#2fd27a'),
        headline: valet.enabled ? 'Đang giám sát Valet' : 'Valet đang tắt',
        line1: 'Ngưỡng: ' + (valet.maxSpeed || 45) + ' km/h · ' + (valet.maxRpm || 3500) + ' RPM · ' + (valet.radiusM || 500) + 'm',
        line2: tr ? ('Chuyến cuối: ' + tr.distanceKm + ' km (' + tr.durationMin + 'p · Max ' + tr.maxSpeed + ')') : 'Chạm để xem lịch sử chuyến đi',
        hint: v.viewMode === 'trips' ? 'Xem QR' : 'Nhật ký',
        onTap: act.toggleTrips,
    });

    // Status message line above buttons
    const msgY = cy + ch + 30;
    if (v.message) {
        cv.text(fit(cv, v.message, 18, { literal: true, font: 'label' }, rw), rx, msgY, 18, kindColor(t, v.messageKind), { literal: true, font: 'label' });
    }

    // Bottom 4 Action Buttons
    const by = bottom - 52;
    const bgap = 14;
    const bw = Math.floor((rw - 3 * bgap) / 4);
    const go = t.go || '#2fd27a', warn = t.warn || '#ffb020', red = t.crit || '#ef2b2d', acc = t.accent2 || '#4da6ff';

    G.button(cv, t, rx, by, bw, 52,
        c1Active ? 'Tắt 1CR' : (v.armed === '1cr' ? 'Bấm lần nữa!' : 'Đề nổ 1CR'),
        act.toggle1cr || nop,
        { key: 'blBtn1cr', color: c1Active ? red : (v.armed === '1cr' ? warn : go), primary: v.armed === '1cr' || c1Active });

    G.button(cv, t, rx + (bw + bgap), by, bw, 52,
        valet.enabled ? 'Tắt Valet' : 'Bật Valet',
        act.toggleValet || nop,
        { key: 'blBtnValet', color: valet.enabled ? warn : undefined, primary: !!valet.enabled });

    G.button(cv, t, rx + 2 * (bw + bgap), by, bw, 52,
        'Chụp gửi App',
        act.snapNow || nop,
        { key: 'blBtnSnap', color: acc });

    G.button(cv, t, rx + 3 * (bw + bgap), by, bw, 52,
        'Hẹn giờ 1CR',
        act.cycleTimer || nop,
        { key: 'blBtnTimer' });

    return cv;
}

module.exports = { draw, W, H };
