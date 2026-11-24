package app.bimmerlink.mybmw;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import org.json.JSONObject;

public class MyBmwWidgetProvider extends AppWidgetProvider {

    public static void refreshAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, MyBmwWidgetProvider.class));
        if (ids != null && ids.length > 0) {
            updateWidgets(context, mgr, ids);
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateWidgets(context, appWidgetManager, appWidgetIds);
    }

    private static void updateWidgets(Context context, AppWidgetManager mgr, int[] ids) {
        SharedPreferences prefs = context.getSharedPreferences("mybmw_prefs", Context.MODE_PRIVATE);
        String raw = prefs.getString("summary_json", null);

        String carName = "BMW iDrive 7";
        String badge = "Chưa ghép xe";
        String rangeFuel = "-- km · Xăng --%";
        String loc = "Chạm để mở App MyBMW & quét mã QR";
        String meta = "MyBMW MGU";

        if (raw != null) {
            try {
                JSONObject j = new JSONObject(raw);
                carName = j.optString("carName", carName);
                boolean active1cr = j.optBoolean("active1cr", false);
                String timer1cr = j.optString("timer1cr", "");
                badge = active1cr ? "❄️ 1CR ĐANG CHẠY"
                        : (!timer1cr.isEmpty() && !"Tắt".equals(timer1cr) ? ("⏰ Hẹn " + timer1cr) : "🔒 " + j.optString("status", "Đã đỗ"));

                String rStr = j.isNull("rangeKm") ? "--" : String.valueOf(j.optInt("rangeKm"));
                String fStr = j.isNull("fuelPct") ? "--" : String.valueOf(j.optInt("fuelPct"));
                rangeFuel = rStr + " km · Xăng " + fStr + "%";

                String lStr = j.optString("location", "");
                loc = lStr.isEmpty() ? "Đã đồng bộ trạng thái từ đầu MGU" : ("📍 " + lStr);

                long at = j.optLong("updatedAt", 0L);
                String bat = j.isNull("battery12v") ? "" : ("Ắc quy " + j.optDouble("battery12v") + "V · ");
                if (at > 0) {
                    String hhmm = new SimpleDateFormat("HH:mm dd/MM", Locale.getDefault()).format(new Date(at));
                    meta = bat + "Cập nhật " + hhmm;
                }
            } catch (Exception ignored) {
            }
        }

        Intent openIntent = new Intent(context, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
                context, 0, openIntent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        for (int id : ids) {
            RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_mybmw);
            rv.setTextViewText(R.id.wCarName, carName);
            rv.setTextViewText(R.id.wBadge1cr, badge);
            rv.setTextViewText(R.id.wRangeFuel, rangeFuel);
            rv.setTextViewText(R.id.wLocation, loc);
            rv.setTextViewText(R.id.wMeta, meta);
            rv.setOnClickPendingIntent(R.id.widgetRoot, pi);
            mgr.updateAppWidget(id, rv);
        }
    }
}
