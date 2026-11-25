package app.bimmerlink.mybmw;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONObject;

public class MainActivity extends Activity {
    private static final String VIRTUAL_ORIGIN = "https://app.mybmw.local";
    private static final int APK_VERSION_CODE = 16;
    private static final int REQ_QR_SCAN = 201;
    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window w = getWindow();
        w.setStatusBarColor(Color.parseColor("#050811"));
        w.setNavigationBarColor(Color.parseColor("#080C16"));

        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 10);
            }
        }

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#050811"));
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(false);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);

        try {
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    return interceptLocalAsset(request);
                }
            });
        } catch (Exception ignored) {
        }

        webView.addJavascriptInterface(new Bridge(), "AndroidBridge");
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> request.grant(request.getResources()));
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse local = interceptLocalAsset(request);
                return local != null ? local : super.shouldInterceptRequest(view, request);
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri != null && !isVirtualHost(uri.getHost())) {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    return true;
                }
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                deliverIncomingIntent(getIntent());
            }
        });

        setContentView(webView);

        SharedPreferences prefs = getSharedPreferences("mybmw_prefs", MODE_PRIVATE);
        if (prefs.getInt("apk_version", 0) != APK_VERSION_CODE) {
            webView.clearCache(true);
            prefs.edit().putInt("apk_version", APK_VERSION_CODE).apply();
        }
        String savedPair = prefs.getString("pair_code", "");
        String startUrl = VIRTUAL_ORIGIN + "/app/index.html" + (savedPair.isEmpty() ? "" : ("?k=" + savedPair));
        webView.loadUrl(startUrl);

        if (!savedPair.isEmpty()) {
            startMonitor();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        deliverIncomingIntent(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_QR_SCAN && resultCode == RESULT_OK && data != null) {
            String raw = data.getStringExtra("qr_text");
            if (raw != null && !raw.trim().isEmpty()) {
                deliverScannedText(raw.trim());
            }
        }
    }

    private void deliverIncomingIntent(Intent intent) {
        if (intent == null || intent.getData() == null) return;
        deliverScannedText(intent.getDataString());
    }

    private void deliverScannedText(String rawUrl) {
        if (rawUrl == null || webView == null) return;
        CryptoHelper.Identity id = CryptoHelper.derive(rawUrl);
        if (id != null) {
            savePairAndStartMonitor(id.pairCode);
            String js = "window.injectPairCodeFromNative && window.injectPairCodeFromNative(" + JSONObject.quote(id.pairCode) + ");";
            webView.evaluateJavascript(js, null);
        } else {
            String js = "window.injectPairCodeFromNative && window.injectPairCodeFromNative(" + JSONObject.quote(rawUrl) + ");";
            webView.evaluateJavascript(js, null);
        }
    }

    private void savePairAndStartMonitor(String code) {
        SharedPreferences prefs = getSharedPreferences("mybmw_prefs", MODE_PRIVATE);
        prefs.edit().putString("pair_code", code).apply();
        startMonitor();
    }

    private void startMonitor() {
        try {
            Intent svc = new Intent(this, MonitorService.class);
            startForegroundService(svc);
        } catch (Exception ignored) {
        }
    }

    private static boolean isVirtualHost(String host) {
        return "app.mybmw.local".equals(host) || "mybmw.local".equals(host);
    }

    private WebResourceResponse interceptLocalAsset(WebResourceRequest request) {
        if (request == null) return null;
        Uri uri = request.getUrl();
        if (uri == null || !isVirtualHost(uri.getHost())) return null;
        String path = uri.getPath();
        if (path == null || path.equals("/") || path.equals("/app/")) {
            path = "/app/index.html";
        }
        String assetPath = path.startsWith("/") ? path.substring(1) : path;
        try {
            InputStream is = getAssets().open(assetPath);
            String mime = mimeFor(assetPath);
            String enc = mime.startsWith("image/") ? null : "UTF-8";
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store, no-cache, must-revalidate");
            return new WebResourceResponse(mime, enc, 200, "OK", headers, is);
        } catch (Exception ignored) {
            return null;
        }
    }

    private static String mimeFor(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".js")) return "application/javascript";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".webmanifest") || p.endsWith(".json")) return "application/json";
        return "application/octet-stream";
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    public final class Bridge {
        @JavascriptInterface
        public void openQrScanner() {
            runOnUiThread(() -> {
                try {
                    Intent scan = new Intent(MainActivity.this, QrScannerActivity.class);
                    startActivityForResult(scan, REQ_QR_SCAN);
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public void onPairCodeChanged(String code) {
            if (code != null && !code.trim().isEmpty()) {
                runOnUiThread(() -> savePairAndStartMonitor(code.trim()));
            }
        }

        @JavascriptInterface
        public void onVehicleSummary(String summaryJson) {
            if (summaryJson == null) return;
            SharedPreferences prefs = getSharedPreferences("mybmw_prefs", MODE_PRIVATE);
            try {
                JSONObject j = new JSONObject(summaryJson);
                prefs.edit()
                        .putString("summary_json", summaryJson)
                        .putString("car_name", j.optString("carName", "BMW iDrive 7"))
                        .apply();
                runOnUiThread(() -> MyBmwWidgetProvider.refreshAll(MainActivity.this));
            } catch (Exception ignored) {
            }
        }

        @JavascriptInterface
        public void copyToClipboard(String text) {
            if (text == null) return;
            runOnUiThread(() -> {
                try {
                    ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                    if (cm != null) {
                        cm.setPrimaryClip(ClipData.newPlainText("MyBMW Diag", text));
                    }
                } catch (Exception ignored) {
                }
            });
        }
    }
}
