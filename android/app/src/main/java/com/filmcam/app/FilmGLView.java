package com.filmcam.app;

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.opengl.GLES11Ext;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.view.Surface;

import androidx.camera.core.Preview;
import androidx.camera.core.SurfaceRequest;
import androidx.core.content.ContextCompat;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

import javax.microedition.khronos.egl.EGLConfig;
import javax.microedition.khronos.opengles.GL10;

/**
 * 카메라 프레임을 GPU에서 직접 받아 필름 셰이더를 입히는 뷰.
 *
 * CameraX가 SurfaceTexture로 프레임을 보내고(외부 텍스처, 복사 없음),
 * 매 프레임 셰이더가 색을 변환해 화면에 그린다. CPU를 거치지 않는다.
 *
 * 센서는 가로로 누워 있으므로 회전을 직접 처리해야 하고(안 하면 90도 돌아감),
 * 버퍼와 뷰의 비율이 다르면 중앙 크롭으로 채운다(안 하면 얼굴이 늘어남).
 */
public class FilmGLView extends GLSurfaceView {

    private final Renderer renderer;

    public FilmGLView(Context context) {
        super(context);
        setEGLContextClientVersion(2);
        renderer = new Renderer();
        setRenderer(renderer);
        setRenderMode(GLSurfaceView.RENDERMODE_WHEN_DIRTY);
    }

    public Preview.SurfaceProvider getSurfaceProvider() {
        return new Preview.SurfaceProvider() {
            @Override
            public void onSurfaceRequested(final SurfaceRequest request) {
                // 화면 회전량은 CameraX가 알려준다 — 셰이더에서 그만큼 되돌린다
                request.setTransformationInfoListener(
                        ContextCompat.getMainExecutor(getContext()),
                        new androidx.core.util.Consumer<SurfaceRequest.TransformationInfo>() {
                            @Override
                            public void accept(SurfaceRequest.TransformationInfo info) {
                                renderer.rotationDeg = info.getRotationDegrees();
                            }
                        });
                renderer.onSurfaceRequested(request, FilmGLView.this);
            }
        };
    }

    public void setFilmParams(float strength, float toneScale, float toneLift, float sat,
                              float hiR, float hiG, float hiB,
                              float shR, float shG, float shB,
                              float grain, float vig, float wb) {
        renderer.strength = strength;
        renderer.toneScale = toneScale;
        renderer.toneLift = toneLift;
        renderer.sat = sat;
        renderer.hi[0] = hiR; renderer.hi[1] = hiG; renderer.hi[2] = hiB;
        renderer.sh[0] = shR; renderer.sh[1] = shG; renderer.sh[2] = shB;
        renderer.grain = grain;
        renderer.vig = vig;
        renderer.wb = wb;
        requestRender();
    }

    /** 필름 그레이드 셰이더 — 웹 버전과 동일한 수식을 GPU에서 실행한다. */
    private static class Renderer implements GLSurfaceView.Renderer,
            SurfaceTexture.OnFrameAvailableListener {

        private static final String VS =
                "attribute vec2 aPos;\n" +
                "varying vec2 vUV;\n" +
                "uniform mat4 uTexM;\n" +
                "uniform float uRot;\n" +      // 화면 회전 보정 (라디안)
                "uniform vec2 uCover;\n" +     // 중앙 크롭 배율
                "void main() {\n" +
                "  vec2 c = (aPos * 0.5 + 0.5) - 0.5;\n" +
                "  c *= uCover;\n" +
                "  float s = sin(uRot), co = cos(uRot);\n" +
                "  c = vec2(c.x * co - c.y * s, c.x * s + c.y * co);\n" +
                "  vUV = (uTexM * vec4(c + 0.5, 0.0, 1.0)).xy;\n" +
                "  gl_Position = vec4(aPos, 0.0, 1.0);\n" +
                "}\n";

        private static final String FS =
                "#extension GL_OES_EGL_image_external : require\n" +
                "precision mediump float;\n" +
                "varying vec2 vUV;\n" +
                "uniform samplerExternalOES uTex;\n" +
                "uniform float uStrength, uToneScale, uToneLift, uSat, uGrain, uVig, uWB, uTime;\n" +
                "uniform vec3 uHi, uSh;\n" +
                "float lumOf(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }\n" +
                "void main() {\n" +
                "  vec3 c = texture2D(uTex, vUV).rgb;\n" +
                "  if (abs(uWB) > 0.001) {\n" +
                "    c *= vec3(1.0 + 0.10 * uWB, 1.0 + 0.015 * uWB, 1.0 - 0.12 * uWB);\n" +
                "  }\n" +
                "  if (uStrength > 0.005) {\n" +
                "    float l = lumOf(c);\n" +
                "    vec3 f = c * mix(1.0, uToneScale, uStrength) + vec3(uToneLift * uStrength);\n" +
                "    f = mix(f, vec3(lumOf(f)), uSat * uStrength);\n" +
                "    float hl = smoothstep(0.55, 0.9, l);\n" +
                "    f *= mix(vec3(1.0), uHi, hl * uStrength);\n" +
                "    float shd = 1.0 - smoothstep(0.1, 0.45, l);\n" +
                "    f *= mix(vec3(1.0), uSh, shd * uStrength);\n" +
                "    vec2 dv = vUV - 0.5;\n" +
                "    f *= 1.0 - dot(dv, dv) * uVig * uStrength;\n" +
                "    float g = fract(sin(dot(gl_FragCoord.xy + vec2(uTime * 617.0),\n" +
                "                  vec2(12.9898, 78.233))) * 43758.5453) - 0.5;\n" +
                "    f += g * uGrain * uStrength;\n" +
                "    c = f;\n" +
                "  }\n" +
                "  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);\n" +
                "}\n";

        float strength = 0f, toneScale = 1f, toneLift = 0f, sat = 0f;
        float grain = 0f, vig = 0f, wb = 0f;
        float[] hi = {1f, 1f, 1f};
        float[] sh = {1f, 1f, 1f};
        volatile int rotationDeg = 0;

        private int program, texId;
        private SurfaceTexture surfaceTexture;
        private Surface providedSurface;
        private FloatBuffer verts;
        private final float[] texM = new float[16];
        private GLSurfaceView view;
        private SurfaceRequest pending;
        private long startNs = System.nanoTime();
        private volatile int bufW = 0, bufH = 0;
        private int viewW = 1, viewH = 1;

        void onSurfaceRequested(SurfaceRequest request, GLSurfaceView v) {
            this.view = v;
            this.pending = request;
            if (surfaceTexture != null) attach(request);
        }

        private void attach(SurfaceRequest request) {
            android.util.Size size = request.getResolution();
            bufW = size.getWidth();
            bufH = size.getHeight();
            surfaceTexture.setDefaultBufferSize(bufW, bufH);
            if (providedSurface != null) {
                try { providedSurface.release(); } catch (Exception ignored) { }
            }
            providedSurface = new Surface(surfaceTexture);
            request.provideSurface(providedSurface,
                    ContextCompat.getMainExecutor(view.getContext()),
                    new androidx.core.util.Consumer<SurfaceRequest.Result>() {
                        @Override
                        public void accept(SurfaceRequest.Result result) { }
                    });
            pending = null;
        }

        @Override
        public void onSurfaceCreated(GL10 gl, EGLConfig config) {
            int[] t = new int[1];
            GLES20.glGenTextures(1, t, 0);
            texId = t[0];
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                    GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                    GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                    GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
            GLES20.glTexParameteri(GLES11Ext.GL_TEXTURE_EXTERNAL_OES,
                    GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);

            surfaceTexture = new SurfaceTexture(texId);
            surfaceTexture.setOnFrameAvailableListener(this);
            if (pending != null) attach(pending);

            program = buildProgram(VS, FS);

            float[] quad = {-1, -1, 3, -1, -1, 3};
            verts = ByteBuffer.allocateDirect(quad.length * 4)
                    .order(ByteOrder.nativeOrder()).asFloatBuffer();
            verts.put(quad).position(0);
        }

        @Override
        public void onSurfaceChanged(GL10 gl, int w, int h) {
            viewW = Math.max(1, w);
            viewH = Math.max(1, h);
            GLES20.glViewport(0, 0, w, h);
        }

        @Override
        public void onDrawFrame(GL10 gl) {
            if (surfaceTexture == null) return;
            try {
                surfaceTexture.updateTexImage();
                surfaceTexture.getTransformMatrix(texM);
            } catch (Exception ignored) { return; }

            GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
            GLES20.glUseProgram(program);

            int aPos = GLES20.glGetAttribLocation(program, "aPos");
            GLES20.glEnableVertexAttribArray(aPos);
            GLES20.glVertexAttribPointer(aPos, 2, GLES20.GL_FLOAT, false, 0, verts);

            GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
            GLES20.glBindTexture(GLES11Ext.GL_TEXTURE_EXTERNAL_OES, texId);
            GLES20.glUniform1i(GLES20.glGetUniformLocation(program, "uTex"), 0);
            GLES20.glUniformMatrix4fv(
                    GLES20.glGetUniformLocation(program, "uTexM"), 1, false, texM, 0);

            // 회전 보정 + 중앙 크롭: 회전 후의 버퍼 비율과 뷰 비율을 맞춘다
            int rot = rotationDeg;
            float rad = (float) Math.toRadians(rot);
            float bw = (rot == 90 || rot == 270) ? bufH : bufW;
            float bh = (rot == 90 || rot == 270) ? bufW : bufH;
            float coverX = 1f, coverY = 1f;
            if (bw > 0 && bh > 0) {
                float viewAR = (float) viewW / viewH;
                float bufAR = bw / bh;
                if (bufAR > viewAR) coverX = viewAR / bufAR;   // 버퍼가 더 넓다 → 좌우를 자른다
                else coverY = bufAR / viewAR;                   // 버퍼가 더 길다 → 위아래를 자른다
            }
            // 회전 축에 맞춰 크롭 배율을 적용
            float cx = (rot == 90 || rot == 270) ? coverY : coverX;
            float cy = (rot == 90 || rot == 270) ? coverX : coverY;
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uRot"), rad);
            GLES20.glUniform2f(GLES20.glGetUniformLocation(program, "uCover"), cx, cy);

            float t = (System.nanoTime() - startNs) / 1e9f;
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uStrength"), strength);
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uToneScale"), toneScale);
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uToneLift"), toneLift);
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uSat"), sat);
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uGrain"), grain);
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uVig"), vig);
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uWB"), wb);
            GLES20.glUniform1f(GLES20.glGetUniformLocation(program, "uTime"), t % 10f);
            GLES20.glUniform3f(GLES20.glGetUniformLocation(program, "uHi"), hi[0], hi[1], hi[2]);
            GLES20.glUniform3f(GLES20.glGetUniformLocation(program, "uSh"), sh[0], sh[1], sh[2]);

            GLES20.glDrawArrays(GLES20.GL_TRIANGLES, 0, 3);
        }

        @Override
        public void onFrameAvailable(SurfaceTexture st) {
            if (view != null) view.requestRender();
        }

        private static int buildProgram(String vs, String fs) {
            int v = compile(GLES20.GL_VERTEX_SHADER, vs);
            int f = compile(GLES20.GL_FRAGMENT_SHADER, fs);
            int p = GLES20.glCreateProgram();
            GLES20.glAttachShader(p, v);
            GLES20.glAttachShader(p, f);
            GLES20.glLinkProgram(p);
            return p;
        }

        private static int compile(int type, String src) {
            int s = GLES20.glCreateShader(type);
            GLES20.glShaderSource(s, src);
            GLES20.glCompileShader(s);
            int[] ok = new int[1];
            GLES20.glGetShaderiv(s, GLES20.GL_COMPILE_STATUS, ok, 0);
            if (ok[0] == 0) {
                android.util.Log.e("FilmGLView", GLES20.glGetShaderInfoLog(s));
            }
            return s;
        }
    }
}
