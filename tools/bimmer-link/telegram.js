'use strict';
/**
 * telegram.js - MyBMW & 1CR Telegram Bot controller (pure Node 8, zero dependencies).
 *
 * Features:
 *   - Interactive Inline Keyboard on messages (`🔥 Nổ máy 1CR`, `⏹ Tắt 1CR`, `📸 Chụp ảnh`, `⏰ Hẹn 07:30`, `⏰ Hẹn 17:15`, `🛡️ Bật/Tắt Valet`, `📍 Google Maps`).
 *   - Slash commands: `/start`, `/help`, `/status`, `/photo`, `/1cr`, `/start1cr`, `/stop1cr`, `/timer HH:MM`, `/timer off`, `/valet on|off`, `/trips`.
 *   - One-tap owner Chat ID auto-discovery (`detectOwnerChat`) for effortless pairing on the Phone QR page.
 *   - Automatic Park Snapshot notification (with 4-cam / Dark Telemetry PNG + Trip Summary + Door/Lock check) & Valet Guard violation alerts.
 */
const Up = require('./uplink');

const TG_HOST = 'api.telegram.org';

function mapsUrl(pos) {
    if (!pos || typeof pos.lat !== 'number' || typeof pos.lon !== 'number') return '';
    return 'https://maps.google.com/?q=' + pos.lat.toFixed(6) + ',' + pos.lon.toFixed(6);
}

function mainKeyboard(pos, valetOn) {
    const rows = [
        [
            { text: '🔥 Nổ máy 1CR', callback_data: '1cr_start' },
            { text: '⏹ Tắt 1CR', callback_data: '1cr_stop' },
        ],
        [
            { text: '📸 Chụp & Trạng thái', callback_data: 'snap_now' },
            { text: valetOn ? '🛡️ Tắt Valet' : '🛡️ Bật Valet', callback_data: 'valet_toggle' },
        ],
        [
            { text: '⏰ Hẹn 07:30', callback_data: 'timer_07:30' },
            { text: '⏰ Hẹn 17:15', callback_data: 'timer_17:15' },
            { text: '❌ Huỷ hẹn', callback_data: 'timer_off' },
        ],
    ];
    const mUrl = mapsUrl(pos);
    if (mUrl) rows.unshift([{ text: '📍 Mở vị trí xe trên Google Maps', url: mUrl }]);
    return { inline_keyboard: rows };
}

function formatStatusCaption(header, telemetry, extra) {
    const t = telemetry || {};
    const ex = extra || {};
    const c1 = t.climate1cr || {};
    const lines = [];
    lines.push('🚘 ' + (header || 'TRẠNG THÁI XE BMW MGU'));
    lines.push('• Trạng thái: ' + (t.conditionLabel || (t.engineRunning ? 'Đang nổ máy' : 'Đang đỗ')));
    if (t.pos) {
        const place = [t.pos.street, t.pos.district, t.pos.city].filter(Boolean).join(', ');
        lines.push('• Vị trí: ' + (place ? place + ' ' : '') + '(' + t.pos.lat.toFixed(5) + ', ' + t.pos.lon.toFixed(5) + ' · ' + String(t.pos.source || 'nav').toUpperCase() + ')');
    } else {
        lines.push('• Vị trí: Đang chờ tín hiệu định vị MGU');
    }
    const fuelParts = [];
    if (t.fuelPct != null) fuelParts.push(t.fuelPct + '%');
    if (t.rangeKm != null) fuelParts.push('còn ~' + t.rangeKm + ' km');
    if (fuelParts.length) lines.push('• Nhiên liệu: ' + fuelParts.join(' · '));
    if (t.battery12v != null) {
        lines.push('• Ắc quy 12V: ' + t.battery12v + ' V' + (t.battery12v < 11.85 ? ' ⚠️ (Yếu!)' : ' ✅'));
    }
    const temps = [];
    if (t.ambientC != null) temps.push('Ngoài ' + t.ambientC + '°C');
    if (t.cabinC != null) temps.push('Cabin ' + t.cabinC + '°C');
    if (t.coolantC != null) temps.push('Nước ' + t.coolantC + '°C');
    if (t.oilC != null) temps.push('Dầu ' + t.oilC + '°C');
    if (temps.length) lines.push('• Nhiệt độ: ' + temps.join(' | '));

    const openWarnings = [];
    if (t.doorsOpen && t.doorsOpen.length) openWarnings.push('Cửa mở (' + t.doorsOpen.length + ')');
    if (t.trunkOpen) openWarnings.push('Cốp sau mở');
    if (t.hoodOpen) openWarnings.push('Capo mở');
    if (t.locked === false) openWarnings.push('Xe chưa khoá');
    lines.push('• An ninh: ' + (openWarnings.length ? ('⚠️ ' + openWarnings.join(', ')) : '🔒 Cửa & cốp đóng kín'));

    lines.push('• Đề nổ 1CR: ' + (c1.active ? '🟢 Đang chạy làm mát' : (c1.timerText && c1.timerText !== 'Tắt' ? ('⏰ Đã hẹn BDC ' + c1.timerText) : 'Sẵn sàng')));

    if (ex.trip) {
        lines.push('🏁 Chuyến vừa đi: ' + ex.trip.distanceKm + ' km trong ' + ex.trip.durationMin + ' phút (TB ' + ex.trip.avgSpeed + ' km/h · Max ' + ex.trip.maxSpeed + ' km/h' + (ex.trip.fuelUsedPct != null ? ' · -' + ex.trip.fuelUsedPct + '% xăng' : '') + ')');
    }
    if (ex.valet && ex.valet.enabled) {
        lines.push('🛡️ Chế độ Valet: ĐANG BẬT (Giới hạn ' + ex.valet.maxSpeed + ' km/h · ' + ex.valet.maxRpm + ' RPM · ' + ex.valet.radiusM + 'm)');
    }
    if (ex.note) lines.push('ℹ️ ' + ex.note);
    return lines.join('\n').slice(0, 1000);
}

class TelegramController {
    constructor(opts) {
        this.upOpts = opts.upOpts;
        this.getConfig = opts.getConfig;       // () => { botToken, chatId, valet, ... }
        this.onAction = opts.onAction;         // async (action, arg) => { text, sendPhoto }
        this.log = opts.log || (() => {});
        this.offset = 0;
        this.polling = false;
        this.stopped = false;
        this.lastError = '';
        this.lastOkAt = 0;
    }

    apiPath(token, method) {
        return '/bot' + String(token || '').trim() + '/' + method;
    }

    async callJson(token, method, payload, timeoutMs) {
        if (!token) throw new Error('Chưa cấu hình Bot Token');
        const body = JSON.stringify(payload || {});
        const res = await Up.request(this.upOpts, {
            host: TG_HOST,
            path: this.apiPath(token, method),
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body,
            timeoutMs: timeoutMs || 20000,
        });
        let parsed = null;
        try { parsed = JSON.parse(res.body); } catch (e) {}
        if (!parsed || !parsed.ok) {
            const desc = (parsed && parsed.description) || ('HTTP ' + res.status);
            this.lastError = desc;
            throw new Error(desc);
        }
        this.lastError = '';
        this.lastOkAt = Date.now();
        return parsed.result;
    }

    async sendMessage(text, telemetry, valetOn, overrideToken, overrideChatId) {
        const cfg = this.getConfig();
        const token = overrideToken || cfg.botToken;
        const chatId = overrideChatId || cfg.chatId;
        if (!token || !chatId) throw new Error('Chưa điền Bot Token hoặc Chat ID');
        const payload = {
            chat_id: String(chatId),
            text: String(text),
            disable_web_page_preview: true,
            reply_markup: mainKeyboard(telemetry && telemetry.pos, valetOn),
        };
        return this.callJson(token, 'sendMessage', payload, 15000);
    }

    async sendSnapshotPhoto(pngBuf, caption, telemetry, valetOn, overrideToken, overrideChatId) {
        const cfg = this.getConfig();
        const token = overrideToken || cfg.botToken;
        const chatId = overrideChatId || cfg.chatId;
        if (!token || !chatId) throw new Error('Chưa điền Bot Token hoặc Chat ID');
        const isJpeg = Buffer.isBuffer(pngBuf) && pngBuf.length > 3 && pngBuf[0] === 0xff && pngBuf[1] === 0xd8;
        const mp = Up.buildMultipart({
            chat_id: String(chatId),
            caption: String(caption || '').slice(0, 1000),
            reply_markup: JSON.stringify(mainKeyboard(telemetry && telemetry.pos, valetOn)),
        }, 'photo', isJpeg ? 'bmw-mgu-360.jpg' : 'bmw-mgu-snapshot.png', isJpeg ? 'image/jpeg' : 'image/png', pngBuf);

        const res = await Up.request(this.upOpts, {
            host: TG_HOST,
            path: this.apiPath(token, 'sendPhoto'),
            method: 'POST',
            headers: { 'Content-Type': 'multipart/form-data; boundary=' + mp.boundary },
            bodyBase64: mp.buffer.toString('base64'),
            timeoutMs: 25000,
        });
        let parsed = null;
        try { parsed = JSON.parse(res.body); } catch (e) {}
        if (!parsed || !parsed.ok) {
            const desc = (parsed && parsed.description) || ('HTTP ' + res.status);
            this.lastError = desc;
            throw new Error(desc);
        }
        this.lastError = '';
        this.lastOkAt = Date.now();
        return parsed.result;
    }

    /** Auto-detect owner Chat ID from recent messages sent to the bot (used by Phone QR Setup wizard). */
    async detectOwnerChat(token) {
        const updates = await this.callJson(token, 'getUpdates', { limit: 15, timeout: 0 }, 12000);
        if (!Array.isArray(updates) || !updates.length) return null;
        for (let i = updates.length - 1; i >= 0; i--) {
            const u = updates[i];
            const msg = u.message || u.edited_message || (u.callback_query && u.callback_query.message);
            if (msg && msg.chat && msg.chat.id) {
                const name = [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || String(msg.chat.id);
                return { chatId: String(msg.chat.id), name };
            }
        }
        return null;
    }

    /** Poll incoming commands/buttons when configured. */
    async pollOnce() {
        const cfg = this.getConfig();
        if (!cfg.botToken || !cfg.chatId || this.polling || this.stopped) return;
        this.polling = true;
        try {
            const updates = await this.callJson(cfg.botToken, 'getUpdates', {
                offset: this.offset,
                limit: 10,
                timeout: 8,
                allowed_updates: ['message', 'callback_query'],
            }, 16000);
            if (Array.isArray(updates)) {
                for (let i = 0; i < updates.length; i++) {
                    const u = updates[i];
                    if (u.update_id >= this.offset) this.offset = u.update_id + 1;
                    await this._handleUpdate(u, cfg);
                }
            }
        } catch (e) {
            // Silent when car has no internet uplink yet
        }
        this.polling = false;
    }

    async _handleUpdate(u, cfg) {
        const ownerId = String(cfg.chatId).trim();
        if (u.callback_query) {
            const cq = u.callback_query;
            const chatId = cq.message && cq.message.chat && String(cq.message.chat.id);
            if (chatId !== ownerId) return;
            const data = String(cq.data || '');
            try { await this.callJson(cfg.botToken, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Đang thực hiện trên xe…' }, 8000); } catch (e) {}
            if (data === '1cr_start') await this.onAction('start1cr', {});
            else if (data === '1cr_stop') await this.onAction('stop1cr', {});
            else if (data === 'snap_now') await this.onAction('snap_now', {});
            else if (data === 'valet_toggle') await this.onAction('valet_toggle', {});
            else if (data === 'timer_off') await this.onAction('timer_off', {});
            else if (/^timer_(\d{2}):(\d{2})$/.test(data)) {
                const m = /^timer_(\d{2}):(\d{2})$/.exec(data);
                await this.onAction('timer_set', { hour: Number(m[1]), minute: Number(m[2]) });
            }
            return;
        }

        const msg = u.message;
        if (!msg || !msg.chat || String(msg.chat.id) !== ownerId) return;
        const text = String(msg.text || '').trim();
        if (!text) return;

        const low = text.toLowerCase();
        if (/^\/(start|help)\b/.test(low)) {
            await this.onAction('help', {});
        } else if (/^\/(status|xe)\b/.test(low)) {
            await this.onAction('status', {});
        } else if (/^\/(photo|snap|cam)\b/.test(low)) {
            await this.onAction('snap_now', {});
        } else if (/^\/(1cr|start1cr|nomay)\b/.test(low)) {
            await this.onAction('start1cr', {});
        } else if (/^\/(stop1cr|tatmay)\b/.test(low)) {
            await this.onAction('stop1cr', {});
        } else if (/^\/timer\s+off\b/.test(low)) {
            await this.onAction('timer_off', {});
        } else if (/^\/timer\s+(\d{1,2})[:h](\d{2})\b/.test(low)) {
            const m = /^\/timer\s+(\d{1,2})[:h](\d{2})\b/.exec(low);
            await this.onAction('timer_set', { hour: Number(m[1]), minute: Number(m[2]) });
        } else if (/^\/valet(?:\s+(on|off))?\b/.test(low)) {
            const m = /^\/valet(?:\s+(on|off))?\b/.exec(low);
            await this.onAction('valet_set', { mode: m && m[1] ? m[1] : 'toggle' });
        } else if (/^\/trips?\b/.test(low)) {
            await this.onAction('trips', {});
        }
    }
}

module.exports = {
    TelegramController,
    formatStatusCaption,
    mainKeyboard,
    mapsUrl,
};
