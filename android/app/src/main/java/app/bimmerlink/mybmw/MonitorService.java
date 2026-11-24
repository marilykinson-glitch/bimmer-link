package app.bimmerlink.mybmw;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

public class MonitorService extends Service {
    private static final String CH_BG = "mybmw_bg";
    private static final String CH_ALERT = "mybmw_alerts";
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean running = false;
    private long lastPollSec = 0;
    private long cooldownUntilMs = 0;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            pool.execute(() -> pollOnce());
            handler.postDelayed(this, 90000);
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels();
        Notification bg = new Notification.Builder(this, CH_BG)
                .setContentTitle("MyBMW đang đồng bộ xe")
                .setContentText("Theo dõi trạng thái đỗ xe, 1CR & cảnh báo Valet")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .build();
        startForeground(101, bg);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!running) {
            running = true;
            handler.post(tick);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacksAndMessages(null);
        pool.shutdownNow();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void ensureChannels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel bg = new NotificationChannel(CH_BG, "Đồng bộ nền MyBMW", NotificationManager.IMPORTANCE_LOW);
        NotificationChannel alert = new NotificationChannel(CH_ALERT, "Cảnh báo Valet & Đỗ xe", NotificationManager.IMPORTANCE_HIGH);
        nm.createNotificationChannel(bg);
        nm.createNotificationChannel(alert);
    }

    private void pollOnce() {
        SharedPreferences prefs = getSharedPreferences("mybmw_prefs", MODE_PRIVATE);
        String pairCode = prefs.getString("pair_code", null);
        CryptoHelper.Identity id = CryptoHelper.derive(pairCode);
        if (id == null) return;

        if (System.currentTimeMillis() < cooldownUntilMs) return;
        String since = lastPollSec > 0 ? String.valueOf(lastPollSec) : "all";
        HttpURLConnection conn = null;
        try {
            URL u = new URL("https://ntfy.sh/" + id.stateTopic + "/json?poll=1&since=" + since);
            conn = (HttpURLConnection) u.openConnection();
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(12000);
            int code = conn.getResponseCode();
            if (code == 429) {
                cooldownUntilMs = System.currentTimeMillis() + 180000L;
                return;
            }
            if (code != 200) return;

            BufferedReader br = new BufferedReader(new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            String line;
            long prevAlertAt = prefs.getLong("last_alert_at", 0L);
            long prevParkedAt = prefs.getLong("last_parked_at", 0L);

            while ((line = br.readLine()) != null) {
                if (line.trim().isEmpty()) continue;
                JSONObject ev = new JSONObject(line);
                if (!"message".equals(ev.optString("event"))) continue;
                long tSec = ev.optLong("time", 0L);
                if (tSec >= lastPollSec) lastPollSec = tSec + 1;

                String plain = CryptoHelper.decryptPacket(id.aesKey, ev.optString("message", ""));
                if (plain == null) continue;
                JSONObject pkt = new JSONObject(plain);
                if (!"state".equals(pkt.optString("t"))) continue;

                updateSummaryAndWidget(prefs, pkt);

                JSONObject alertObj = pkt.optJSONObject("alert");
                if (alertObj != null) {
                    long alertAt = alertObj.optLong("at", 0L);
                    if (alertAt > prevAlertAt) {
                        prefs.edit().putLong("last_alert_at", alertAt).apply();
                        fireNotification(201, "🚨 CẢNH BÁO VALET BMW", alertObj.optString("reason", "Phát hiện vi phạm ngưỡng Valet!"));
                    }
                } else if ("parked".equals(pkt.optString("event"))) {
                    long pktAt = pkt.optLong("at", 0L);
                    if (pktAt > prevParkedAt && prevParkedAt > 0) {
                        fireNotification(202, "🅿️ Xe BMW vừa đỗ an toàn", "Mở MyBMW để xem vị trí đỗ & ảnh trạng thái.");
                    }
                    if (pktAt > prevParkedAt) {
                        prefs.edit().putLong("last_parked_at", pktAt).apply();
                    }
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void updateSummaryAndWidget(SharedPreferences prefs, JSONObject pkt) {
        try {
            JSONObject tel = pkt.optJSONObject("telemetry");
            if (tel == null) return;
            JSONObject c1 = tel.optJSONObject("climate1cr");
            JSONObject pos = tel.optJSONObject("pos");

            StringBuilder loc = new StringBuilder();
            if (pos != null) {
                String[] parts = {pos.optString("street", ""), pos.optString("district", ""), pos.optString("city", "")};
                for (String p : parts) {
                    if (p != null && !p.isEmpty()) {
                        if (loc.length() > 0) loc.append(", ");
                        loc.append(p);
                    }
                }
            }

            JSONObject sum = new JSONObject();
            sum.put("carName", prefs.getString("car_name", "BMW iDrive 7"));
            sum.put("status", tel.optString("conditionLabel", "Đã đỗ"));
            if (!tel.isNull("fuelPct")) sum.put("fuelPct", tel.optInt("fuelPct"));
            if (!tel.isNull("rangeKm")) sum.put("rangeKm", tel.optInt("rangeKm"));
            if (!tel.isNull("battery12v")) sum.put("battery12v", tel.optDouble("battery12v"));
            sum.put("active1cr", c1 != null && c1.optBoolean("active", false));
            sum.put("timer1cr", c1 != null ? c1.optString("timerText", "") : "");
            sum.put("location", loc.toString());
            sum.put("updatedAt", pkt.optLong("at", System.currentTimeMillis()));

            prefs.edit().putString("summary_json", sum.toString()).apply();
            handler.post(() -> MyBmwWidgetProvider.refreshAll(this));
        } catch (Exception ignored) {
        }
    }

    private void fireNotification(int id, String title, String body) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        PendingIntent pi = PendingIntent.getActivity(
                this, id, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(this, CH_ALERT)
                .setContentTitle(title)
                .setContentText(body)
                .setSmallIcon(android.R.drawable.stat_sys_warning)
                .setAutoCancel(true)
                .setContentIntent(pi)
                .build();
        nm.notify(id, n);
    }
}
