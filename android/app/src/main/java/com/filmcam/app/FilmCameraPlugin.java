package com.filmcam.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Matrix;
import android.util.Base64;
import android.util.DisplayMetrics;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraControl;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.DisplayOrientedMeteringPointFactory;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.core.ZoomState;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.core.content.ContextCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;

/**
 * 완전 네이티브 카메라 레이어.
 *
 * 구조:
 *   - CameraX가 카메라를 열고, 프레임을 GL 외부 텍스처로 흘려보낸다 (복사 없음).
 *   - FilmGLView가 필름 셰이더를 입혀 화면에 그린다.
 *   - 이 뷰는 WebView '뒤'에 깔리고, WebView는 투명해져 UI만 위에 떠 있다.
 *     → UI가 카메라에 가려지는 문제가 구조적으로 불가능하다.
 *   - 웹 UI는 브릿지로 숫자만 보내고, 이미지 연산은 전부 네이티브 GPU가 한다.
 */
@CapacitorPlugin(name = "FilmCamera")
public class FilmCameraPlugin extends Plugin {

    private FilmGLView glView;
    private FrameLayout container;
    private ProcessCameraProvider cameraProvider;
    private CameraControl cameraControl;
    private Camera camera;
    private ImageCapture imageCapture;
    private boolean frontFacing = true;
    private int viewPxW = 1, viewPxH = 1;

    private float density() {
        DisplayMetrics dm = getContext().getResources().getDisplayMetrics();
        return dm.density;
    }

    private void layoutGlView(int cssX, int cssY, int cssW, int cssH) {
        float d = density();
        viewPxW = Math.max(1, (int) (cssW * d));
        viewPxH = Math.max(1, (int) (cssH * d));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(viewPxW, viewPxH);
        lp.leftMargin = (int) (cssX * d);
        lp.topMargin = (int) (cssY * d);
        glView.setLayoutParams(lp);
    }

    @PluginMethod
    public void start(final PluginCall call) {
        final int x = call.getInt("x", 0);
        final int y = call.getInt("y", 0);
        final int w = call.getInt("width", 0);
        final int h = call.getInt("height", 0);
        frontFacing = !"rear".equals(call.getString("position", "front"));

        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (container == null) {
                        // 컨테이너는 화면 전체를 덮고(어떤 루트 레이아웃에도 안전하게 들어가도록
                        // 기본 파라미터로 붙인 뒤 크기만 키운다), GL 뷰를 그 안에 배치한다.
                        container = new FrameLayout(getContext());
                        container.setBackgroundColor(Color.BLACK);
                        glView = new FilmGLView(getContext());
                        container.addView(glView, new FrameLayout.LayoutParams(1, 1));

                        ViewGroup root = (ViewGroup) getBridge().getWebView().getParent();
                        root.addView(container, 0);   // 인덱스 0 = WebView 뒤
                        ViewGroup.LayoutParams rlp = container.getLayoutParams();
                        rlp.width = ViewGroup.LayoutParams.MATCH_PARENT;
                        rlp.height = ViewGroup.LayoutParams.MATCH_PARENT;
                        container.setLayoutParams(rlp);
                    }
                    container.setVisibility(android.view.View.VISIBLE);
                    layoutGlView(x, y, w, h);

                    // WebView를 투명하게 → 카메라가 비치고 UI는 위에 남는다
                    getBridge().getWebView().setBackgroundColor(Color.TRANSPARENT);

                    bindCamera(call);
                } catch (Exception e) {
                    call.reject("카메라 시작 실패: " + e.getMessage());
                }
            }
        });
    }

    /** 미리보기 영역 변경(비율 전환 등) — 카메라를 다시 열지 않고 위치만 바꾼다. */
    @PluginMethod
    public void setLayout(final PluginCall call) {
        final int x = call.getInt("x", 0);
        final int y = call.getInt("y", 0);
        final int w = call.getInt("width", 0);
        final int h = call.getInt("height", 0);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (glView == null) { call.reject("카메라가 열려 있지 않아요"); return; }
                try { layoutGlView(x, y, w, h); call.resolve(); }
                catch (Exception e) { call.reject("배치 실패: " + e.getMessage()); }
            }
        });
    }

    private void bindCamera(final PluginCall call) {
        final com.google.common.util.concurrent.ListenableFuture<ProcessCameraProvider> future =
                ProcessCameraProvider.getInstance(getContext());
        future.addListener(new Runnable() {
            @Override
            public void run() {
                try {
                    cameraProvider = future.get();
                    cameraProvider.unbindAll();

                    Preview preview = new Preview.Builder()
                            .setTargetAspectRatio(androidx.camera.core.AspectRatio.RATIO_4_3)
                            .build();
                    preview.setSurfaceProvider(glView.getSurfaceProvider());

                    imageCapture = new ImageCapture.Builder()
                            .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                            .setTargetAspectRatio(androidx.camera.core.AspectRatio.RATIO_4_3)
                            .build();

                    CameraSelector selector = frontFacing
                            ? CameraSelector.DEFAULT_FRONT_CAMERA
                            : CameraSelector.DEFAULT_BACK_CAMERA;

                    camera = cameraProvider.bindToLifecycle(
                            (androidx.lifecycle.LifecycleOwner) getActivity(),
                            selector, preview, imageCapture);
                    cameraControl = camera.getCameraControl();
                    call.resolve();
                } catch (Exception e) {
                    call.reject("카메라 바인딩 실패: " + e.getMessage());
                }
            }
        }, ContextCompat.getMainExecutor(getContext()));
    }

    @PluginMethod
    public void stop(final PluginCall call) {
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (cameraProvider != null) cameraProvider.unbindAll();
                    if (container != null) container.setVisibility(android.view.View.GONE);
                    getBridge().getWebView().setBackgroundColor(Color.BLACK);
                } catch (Exception ignored) { }
                call.resolve();
            }
        });
    }

    /** 탭 초점 — 이 레이어를 만든 가장 큰 이유. 좌표는 미리보기 기준 CSS px. */
    @PluginMethod
    public void focus(final PluginCall call) {
        final float cssX = call.getFloat("x", 0f);
        final float cssY = call.getFloat("y", 0f);
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (cameraControl == null || camera == null || glView == null) {
                    call.resolve(); return;
                }
                try {
                    float d = density();
                    // 화면 방향까지 계산해주는 팩토리 — 회전 좌표 변환을 CameraX가 처리한다
                    DisplayOrientedMeteringPointFactory factory =
                            new DisplayOrientedMeteringPointFactory(
                                    getActivity().getWindowManager().getDefaultDisplay(),
                                    camera.getCameraInfo(),
                                    (float) viewPxW, (float) viewPxH);
                    MeteringPoint point = factory.createPoint(cssX * d, cssY * d);
                    FocusMeteringAction action = new FocusMeteringAction.Builder(
                            point, FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                            .build();
                    cameraControl.startFocusAndMetering(action);
                } catch (Exception ignored) {
                    // 초점 실패가 앱을 막아서는 안 된다
                }
                call.resolve();
            }
        });
    }

    /** LED 토치. CameraX가 미지원 기기를 스스로 무시하므로 안전하다. */
    @PluginMethod
    public void setTorch(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        if (cameraControl == null) { call.resolve(); return; }
        try { cameraControl.enableTorch(on); } catch (Exception ignored) { }
        call.resolve();
    }

    /** 화각(28/35/50mm)을 광학·디지털 줌으로. 실제 적용된 배율을 돌려준다. */
    @PluginMethod
    public void setZoom(PluginCall call) {
        float ratio = call.getFloat("ratio", 1f);
        JSObject ret = new JSObject();
        if (cameraControl == null || camera == null) {
            ret.put("zoom", 1f); call.resolve(ret); return;
        }
        try {
            ZoomState zs = camera.getCameraInfo().getZoomState().getValue();
            float max = zs != null ? zs.getMaxZoomRatio() : 1f;
            float min = zs != null ? zs.getMinZoomRatio() : 1f;
            float applied = Math.max(min, Math.min(max, ratio));
            cameraControl.setZoomRatio(applied);
            ret.put("zoom", applied);
        } catch (Exception e) {
            ret.put("zoom", 1f);
        }
        call.resolve(ret);
    }

    /** 필름 룩 파라미터 → GPU. 프리셋 변경은 숫자 전달일 뿐, 연산은 네이티브가 한다. */
    @PluginMethod
    public void setFilm(PluginCall call) {
        if (glView == null) { call.resolve(); return; }
        glView.setFilmParams(
                call.getFloat("strength", 0f),
                call.getFloat("toneScale", 1f),
                call.getFloat("toneLift", 0f),
                call.getFloat("sat", 0f),
                call.getFloat("hiR", 1f), call.getFloat("hiG", 1f), call.getFloat("hiB", 1f),
                call.getFloat("shR", 1f), call.getFloat("shG", 1f), call.getFloat("shB", 1f),
                call.getFloat("grain", 0f), call.getFloat("vig", 0f),
                call.getFloat("wb", 0f));
        call.resolve();
    }

    @PluginMethod
    public void flip(final PluginCall call) {
        frontFacing = !frontFacing;
        getActivity().runOnUiThread(new Runnable() {
            @Override
            public void run() { bindCamera(call); }
        });
    }

    /** 센서 원본 촬영. 보정(피부·잡티)은 웹 레이어가 후처리로 담당한다. */
    @PluginMethod
    public void capture(final PluginCall call) {
        if (imageCapture == null) { call.reject("카메라가 준비되지 않았어요"); return; }
        imageCapture.takePicture(ContextCompat.getMainExecutor(getContext()),
                new ImageCapture.OnImageCapturedCallback() {
                    @Override
                    public void onCaptureSuccess(@NonNull ImageProxy image) {
                        try {
                            ByteBuffer buf = image.getPlanes()[0].getBuffer();
                            byte[] bytes = new byte[buf.remaining()];
                            buf.get(bytes);
                            int rot = image.getImageInfo().getRotationDegrees();
                            image.close();

                            if (rot != 0 || frontFacing) {
                                Bitmap bm = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                                Matrix m = new Matrix();
                                m.postRotate(rot);
                                if (frontFacing) m.postScale(-1, 1);   // 미리보기와 같은 방향으로
                                Bitmap out = Bitmap.createBitmap(bm, 0, 0,
                                        bm.getWidth(), bm.getHeight(), m, true);
                                ByteArrayOutputStream bos = new ByteArrayOutputStream();
                                out.compress(Bitmap.CompressFormat.JPEG, 95, bos);
                                bytes = bos.toByteArray();
                                bm.recycle();
                                out.recycle();
                            }

                            JSObject ret = new JSObject();
                            ret.put("value", Base64.encodeToString(bytes, Base64.NO_WRAP));
                            call.resolve(ret);
                        } catch (OutOfMemoryError oom) {
                            call.reject("메모리가 부족해요 — 다시 시도해 주세요");
                        } catch (Exception e) {
                            call.reject("사진 처리 실패: " + e.getMessage());
                        }
                    }

                    @Override
                    public void onError(@NonNull ImageCaptureException e) {
                        call.reject("촬영 실패: " + e.getMessage());
                    }
                });
    }
}
