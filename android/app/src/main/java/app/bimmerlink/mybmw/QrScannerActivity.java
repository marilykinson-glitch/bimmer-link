package app.bimmerlink.mybmw;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.hardware.Camera;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

@SuppressWarnings("deprecation")
public class QrScannerActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {
    private static final int REQ_CAMERA = 301;
    private SurfaceView surfaceView;
    private Camera camera;
    private final AtomicBoolean decoding = new AtomicBoolean(false);
    private volatile boolean finished = false;
    private QRCodeReader qrReader;
    private Map<DecodeHintType, Object> hints;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Window w = getWindow();
        w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        w.setStatusBarColor(Color.parseColor("#050811"));
        w.setNavigationBarColor(Color.parseColor("#050811"));

        qrReader = new QRCodeReader();
        hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        surfaceView = new SurfaceView(this);
        surfaceView.getHolder().addCallback(this);
        root.addView(surfaceView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        // Center cyan reticle box
        View reticle = new View(this);
        GradientDrawable border = new GradientDrawable();
        border.setColor(Color.TRANSPARENT);
        border.setStroke(dp(3), Color.parseColor("#38BDF8"));
        border.setCornerRadius(dp(22));
        reticle.setBackground(border);
        FrameLayout.LayoutParams rlp = new FrameLayout.LayoutParams(dp(250), dp(250), Gravity.CENTER);
        root.addView(reticle, rlp);

        // Top instruction label
        TextView hintView = new TextView(this);
        hintView.setText("Hướng camera vào mã QR trên màn hình xe BMW");
        hintView.setTextColor(Color.WHITE);
        hintView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        hintView.setTypeface(Typeface.DEFAULT_BOLD);
        hintView.setGravity(Gravity.CENTER);
        hintView.setPadding(dp(20), dp(12), dp(20), dp(12));
        GradientDrawable pillBg = new GradientDrawable();
        pillBg.setColor(Color.parseColor("#CC0B1222"));
        pillBg.setCornerRadius(dp(16));
        hintView.setBackground(pillBg);
        FrameLayout.LayoutParams hlp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        hlp.topMargin = dp(56);
        root.addView(hintView, hlp);

        // Bottom close button
        Button closeBtn = new Button(this);
        closeBtn.setText("✕  Đóng máy quét");
        closeBtn.setAllCaps(false);
        closeBtn.setTextColor(Color.WHITE);
        closeBtn.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        GradientDrawable btnBg = new GradientDrawable();
        btnBg.setColor(Color.parseColor("#DD1E293B"));
        btnBg.setCornerRadius(dp(14));
        closeBtn.setBackground(btnBg);
        closeBtn.setPadding(dp(26), dp(12), dp(26), dp(12));
        closeBtn.setOnClickListener(v -> {
            setResult(RESULT_CANCELED);
            finish();
        });
        FrameLayout.LayoutParams clp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        clp.bottomMargin = dp(48);
        root.addView(closeBtn, clp);

        setContentView(root);

        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA);
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode == REQ_CAMERA) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                openCamera(surfaceView.getHolder());
            } else {
                setResult(RESULT_CANCELED);
                finish();
            }
        }
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            openCamera(holder);
        }
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        releaseCamera();
    }

    @Override
    protected void onPause() {
        super.onPause();
        releaseCamera();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (camera == null && surfaceView != null && surfaceView.getHolder().getSurface().isValid()
                && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            openCamera(surfaceView.getHolder());
        }
    }

    private void openCamera(SurfaceHolder holder) {
        if (camera != null || finished) return;
        try {
            camera = Camera.open();
            if (camera == null) return;
            camera.setDisplayOrientation(90);
            Camera.Parameters params = camera.getParameters();
            List<String> focusModes = params.getSupportedFocusModes();
            if (focusModes != null) {
                if (focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                    params.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
                } else if (focusModes.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                    params.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
                }
            }
            List<Camera.Size> sizes = params.getSupportedPreviewSizes();
            if (sizes != null && !sizes.isEmpty()) {
                Camera.Size best = sizes.get(0);
                int bestScore = Integer.MAX_VALUE;
                for (Camera.Size s : sizes) {
                    int score = Math.abs(s.width - 1280) + Math.abs(s.height - 720);
                    if (score < bestScore) {
                        bestScore = score;
                        best = s;
                    }
                }
                params.setPreviewSize(best.width, best.height);
            }
            camera.setParameters(params);
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback(this);
            camera.startPreview();
        } catch (Exception ignored) {
            releaseCamera();
        }
    }

    private void releaseCamera() {
        if (camera != null) {
            try {
                camera.setPreviewCallback(null);
                camera.stopPreview();
            } catch (Exception ignored) {
            }
            try {
                camera.release();
            } catch (Exception ignored) {
            }
            camera = null;
        }
    }

    @Override
    public void onPreviewFrame(final byte[] data, final Camera cam) {
        if (finished || data == null || cam == null || !decoding.compareAndSet(false, true)) return;
        final int w, h;
        try {
            Camera.Size sz = cam.getParameters().getPreviewSize();
            w = sz.width;
            h = sz.height;
        } catch (Exception e) {
            decoding.set(false);
            return;
        }
        new Thread(() -> {
            try {
                String text = tryDecodeLuma(data, w, h);
                if (text == null) {
                    // Rotate 90 degrees for portrait orientation if needed
                    byte[] rot = new byte[w * h];
                    for (int y = 0; y < h; y++) {
                        int row = y * w;
                        for (int x = 0; x < w; x++) {
                            rot[x * h + (h - y - 1)] = data[row + x];
                        }
                    }
                    text = tryDecodeLuma(rot, h, w);
                }
                if (text != null && !text.trim().isEmpty() && !finished) {
                    finished = true;
                    final String hit = text.trim();
                    runOnUiThread(() -> {
                        Intent out = new Intent();
                        out.putExtra("qr_text", hit);
                        setResult(RESULT_OK, out);
                        finish();
                    });
                }
            } finally {
                decoding.set(false);
            }
        }).start();
    }

    private String tryDecodeLuma(byte[] yuv, int width, int height) {
        if (yuv.length < width * height) return null;
        try {
            int side = Math.min(width, height) * 4 / 5;
            int left = (width - side) / 2;
            int top = (height - side) / 2;
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(yuv, width, height, left, top, side, side, false);
            BinaryBitmap bmp = new BinaryBitmap(new HybridBinarizer(src));
            qrReader.reset();
            Result r = qrReader.decode(bmp, hints);
            return r != null ? r.getText() : null;
        } catch (Exception ignored) {
            try {
                PlanarYUVLuminanceSource full = new PlanarYUVLuminanceSource(yuv, width, height, 0, 0, width, height, false);
                BinaryBitmap bmp2 = new BinaryBitmap(new HybridBinarizer(full));
                qrReader.reset();
                Result r2 = qrReader.decode(bmp2, hints);
                return r2 != null ? r2.getText() : null;
            } catch (Exception ignored2) {
                return null;
            }
        }
    }
}
