const BUILD = "v18";

// 어떤 오류든 화면에 보이게 한다. 원인을 모른 채 앱이 멈추는 상황을 막는다.
window.addEventListener("error", (e) => {
  try { showToast("오류: " + String(e.message || e.error).slice(0, 60)); } catch {}
});
window.addEventListener("unhandledrejection", (e) => {
  try { showToast("오류: " + String(e.reason?.message || e.reason).slice(0, 60)); } catch {}
});
import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";

const $ = (id) => document.getElementById(id);
const out = $("out"), ctx = out.getContext("2d");
const editOut = $("editOut"), editCtx = editOut.getContext("2d");
const statusEl = $("status"), statusText = $("statusText");
const screenFlash = $("screenFlash"), focusRing = $("focusRing"), toast = $("toast");

// 어떤 오류든 화면에 보이게 — "왜 안 되지"를 추측하지 않기 위한 진단 시스템
window.addEventListener("error", (e) => showToast("오류: " + (e.message || "").slice(0, 80)));
window.addEventListener("unhandledrejection", (e) => showToast("오류: " + String(e.reason).slice(0, 80)));

let toastTimer = 0;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1800);
}

/* ===== 상태 ===== */
let facing = "user";
let useFlash = true;
let focal = 28, hwZoom = false;
let ssChoice = "auto";
let skinOn = true, blemishOn = true, contourOn = true, filmOn = true, eyeOn = true;
let filmPreset = 0, filmStrength = 0.6;
let skinAmt = 0.6, blemAmt = 0.6;   // 피부결·잡티 세기 (슬라이더 100 = 최대 강도)
let mode = "cam";   // cam | edit
let landmarker = null, lastLandmarks = null, editLandmarks = null;

const video = document.createElement("video");
video.playsInline = true; video.muted = true;

const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d");
const warpCanvas = document.createElement("canvas");   // 윤곽 변위 맵 (실루엣 평탄화 벡터장)
const warpCtx = warpCanvas.getContext("2d");
const capCanvas = document.createElement("canvas");   // 고해상도 촬영 결과 (편집 원본)
const capCtx = capCanvas.getContext("2d");

const FACE_OVAL = [10,338,297,332,284,251,389,356,454,323,361,288,397,365,379,378,400,377,152,148,176,149,150,136,172,58,132,93,234,127,162,21,54,103,67,109];

/* ===== 편집 슬라이더 ===== */
const SLIDERS = ["flash","wrinkle","film","sharp","contrast","sat","rGain","gGain","bGain"];
const S = {};
for (const id of SLIDERS) {
  S[id] = $(id);
  const val = $(id + "Val");
  S[id].addEventListener("input", () => { val.textContent = S[id].value; if (mode === "edit") editRender(); });
}
const WB_MAP = { auto: 0.0, "3300": -1.0, "4400": 0.35, "5600": 1.0 };
let wbValue = 0.0;
document.querySelector("#editScreen .seg").addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  document.querySelectorAll("#editScreen .seg-btn").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  wbValue = WB_MAP[btn.dataset.wb];
  editRender();
});

/* ===== 촬영 화면 컨트롤 ===== */
$("filmPresets").addEventListener("click", (e) => {
  const btn = e.target.closest(".pill");
  if (!btn) return;
  document.querySelectorAll("#filmPresets .pill").forEach(b => b.classList.remove("on"));
  btn.classList.add("on");
  filmPreset = Number(btn.dataset.fp);
  saveSettings();
});
$("blemAmt").addEventListener("input", (e) => {
  blemAmt = e.target.value / 100;
  $("blemAmtVal").textContent = e.target.value;
  saveSettings();
});






// 화이트 밸런스 (촬영 시 굽기)
const WB_CAM = { auto: 0.0, "5600": 0.2, "4500": -0.5, "3300": 1.0 };
let wbCam = 0.0;

/* ===== 상단 아이콘 · 팝업 컨트롤 ===== */
const POPS = { settingsBtn: "skinBar", ssBtn: "ssBar", ratioBtn: "ratioBar",
               focalBtn: "focalBar", filmBtn: "filmBar", wbBtn: "wbBar" };
function closePops(except) {
  for (const [btn, pop] of Object.entries(POPS)) {
    if (pop === except) continue;
    $(pop).classList.remove("open");
    if (btn !== "filmBtn") $(btn).classList.remove("act");
  }
}
for (const [btn, pop] of Object.entries(POPS)) {
  $(btn).addEventListener("click", () => {
    const willOpen = !$(pop).classList.contains("open");
    closePops(willOpen ? pop : null);
    $(pop).classList.toggle("open", willOpen);
  });
}

// 피부결 프리셋 (끄기/기본/자연스럽게/강하게)
$("skinSeg").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("skinSeg").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on");
  skinAmt = Number(b.dataset.skin) / 100;
  skinOn = skinAmt > 0;
  saveSettings();
});
$("tgEye").addEventListener("click", (e) => {
  eyeOn = !eyeOn;
  e.target.classList.toggle("on", eyeOn);
  e.target.textContent = eyeOn ? "켜짐" : "꺼짐";
  saveSettings();
});
$("tgCamMode").addEventListener("click", async () => {
  const b = $("tgCamMode");
  const order = ["web", "fullnative", "system"];
  let next = order[(order.indexOf(camMode) + 1) % order.length];
  if (next === "fullnative" && !FilmCam()) next = "system";
  if (next === "system" && !SysCam()) next = "web";

  if (camMode === "fullnative" && next !== "fullnative") await stopFullNative();

  if (next === "fullnative") {
    if (video.srcObject) { video.srcObject.getTracks().forEach(t => t.stop()); video.srcObject = null; }
    camMode = "fullnative";   // 브릿지 신호가 통과하려면 모드를 먼저 확정해야 한다
    let ok = false;
    try { ok = await startFullNative(); } catch { ok = false; }
    if (!ok) { next = "web"; camMode = "web"; await startStream(); showToast("완전 네이티브를 쓸 수 없어 웹으로 돌아왔어요"); }
    else { glOK = initGLOnce(); showToast("완전 네이티브 · 화면을 탭하면 초점이 맞아요"); }
  } else if (isFullNative()) {
    await startStream();
  }

  camMode = next;
  document.body.classList.toggle("fullnative", camMode === "fullnative");
  b.textContent = camMode === "system" ? "시스템" : camMode === "fullnative" ? "네이티브" : "웹";
  b.classList.toggle("on", camMode !== "web");
  if (camMode === "system") showToast("셔터를 누르면 폰 기본 카메라가 열려요");
  if (camMode === "web") showToast("앱 안에서 바로 촬영해요");
  saveSettings();
});

$("tgContour").addEventListener("click", (e) => {
  contourOn = !contourOn;
  e.target.classList.toggle("on", contourOn);
  e.target.textContent = contourOn ? "켜짐" : "꺼짐";
  if (mode === "edit") { uploadWarp(); editRender(); }
  saveSettings();
});

// 필름 on/off는 아이콘 길게 대신 이중 탭 없이: 세기 0이면 자동 off
$("filmStrength").addEventListener("input", (e) => {
  filmStrength = e.target.value / 100;
  $("filmStrengthVal").textContent = e.target.value;
  filmOn = filmStrength > 0.005;
  $("filmBtn").classList.toggle("on", filmOn);
  pushFilmToNative();
  saveSettings();
});

// 플래시: 끄기 → 화면(전면) → 후면 라이트
const FLASH_MODES = ["off", "screen", "torch"];
const FLASH_TAG = { off: "off", screen: "화면", torch: "LED" };
let flashMode = "off";   // 기본 OFF
$("flashBtn").addEventListener("click", async () => {
  let i = (FLASH_MODES.indexOf(flashMode) + 1) % FLASH_MODES.length;
  // 후면 라이트를 지원하지 않으면 건너뜀
  if (FLASH_MODES[i] === "torch" && !hasTorch()) i = 0;
  flashMode = FLASH_MODES[i];
  $("flashTag").textContent = FLASH_TAG[flashMode];
  $("flashBtn").classList.toggle("on", flashMode !== "off");
  saveSettings();
});
function hasTorch() {
  if (isFullNative()) return true;   // CameraX가 LED를 안전하게 제어
  try { return !!track()?.getCapabilities?.().torch; } catch { return false; }
}
async function setTorch(on) {
  if (isFullNative()) { try { await FilmCam().setTorch({ on }); } catch {} return; }
  if (!hasTorch()) return false;
  try { await track().applyConstraints({ advanced: [{ torch: on }] }); return true; }
  catch { return false; }
}

// 셔터스피드 / 비율 / 화각 / 필름 프리셋 / WB
$("ssBar").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("ssBar").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); ssChoice = b.dataset.ss;
  $("ssTag").textContent = ssChoice === "auto" ? "A" : ssChoice;
  applyShutter();
  saveSettings();
});
$("ratioBar").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("ratioBar").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); ratio = b.dataset.ratio;
  $("ratioTag").textContent = ratio;
  relayoutFullNative();
  relayoutFullNative();
  saveSettings();
});
$("focalBar").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("focalBar").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); focal = Number(b.dataset.focal);
  $("focalTag").textContent = focal;
  applyFocal();
  saveSettings();
});
$("filmPresets").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("filmPresets").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); filmPreset = Number(b.dataset.fp);
  pushFilmToNative();
  $("filmTag").textContent = filmPreset + 1;
});
$("wbBar").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("wbBar").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); wbCam = WB_CAM[b.dataset.wbc];
  pushFilmToNative();
  $("wbBtn").classList.toggle("on", wbCam !== 0);
  saveSettings();
});

// 화면 비율
const RATIOS = { "1:1": 1, "3:4": 3 / 4, "9:16": 9 / 16 };
let ratio = "3:4";
function cropRect(sw0, sh0) {
  // 네이티브는 렌즈 줌으로 이미 당겨져 있으므로 남은 배율만 크롭한다
  const cf = isFullNative() ? Math.min(1, (28 / focal) * nativeZoom)
                                        : (hwZoom ? 1 : 28 / focal);
  let sw = sw0 * cf, sh = sh0 * cf;
  const target = RATIOS[ratio];
  if (sw / sh > target) sw = sh * target; else sh = sw / target;
  return { sx: (sw0 - sw) / 2, sy: (sh0 - sh) / 2, sw, sh };
}

/* ===== 카메라 하드웨어 제어 ===== */
function track() { return video.srcObject?.getVideoTracks()[0]; }

async function applyFocal() {
  if (isFullNative()) { await applyNativeZoom(); return; }
  hwZoom = false;
  const t = track(); const caps = t?.getCapabilities?.();
  if (caps && caps.zoom) {
    const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, caps.zoom.min * (focal / 28)));
    try { await t.applyConstraints({ advanced: [{ zoom: z }] }); hwZoom = true; } catch {}
  }
}

async function applyShutter() {
  if (isFullNative()) return;
  const t = track(); const caps = t?.getCapabilities?.();
  if (ssChoice === "auto") {
    if (caps?.exposureMode?.includes("continuous"))
      t.applyConstraints({ advanced: [{ exposureMode: "continuous" }] }).catch(() => {});
    return;
  }
  if (caps?.exposureTime && caps.exposureMode?.includes("manual")) {
    // exposureTime 단위: 100마이크로초. 1/60초 = 10000/60
    const want = 10000 / Number(ssChoice);
    const v = Math.min(caps.exposureTime.max, Math.max(caps.exposureTime.min, want));
    try {
      await t.applyConstraints({ advanced: [{ exposureMode: "manual", exposureTime: v }] });
    } catch { showToast("이 기기는 수동 셔터를 지원하지 않아요"); }
  } else {
    showToast("이 기기는 수동 셔터를 지원하지 않아요 (오토 유지)");
  }
}

let imageCapture = null;

// 이 기기가 실제로 무엇을 지원하는지 알려준다 (초점·LED는 기기마다 다름)
function reportCaps() {
  let caps = {};
  try { caps = track()?.getCapabilities?.() || {}; } catch {}
  const parts = [BUILD];
  parts.push(camMode === "fullnative" ? "네이티브레이어"
           : camMode === "system" ? "시스템카메라"
           : (video.videoWidth + "×" + video.videoHeight));
  parts.push(caps.focusMode ? "초점 O" : "초점 X");
  parts.push(caps.torch ? "LED O" : "LED X");
  if (imageCapture) parts.push("고화질 촬영 O");
  showToast(parts.join(" · "));
}

function tryFocus(m, nx, ny) {
  // 완전 네이티브 레이어는 CameraX가 초점을 직접 제어한다
  if (isFullNative()) {
    // 완전 네이티브: CameraX의 startFocusAndMetering으로 실제 재초점
    nativeFocus(nx ?? 0.5, ny ?? 0.5);
    return true;
  }
  if (isFullNative()) return true;   // 초점은 네이티브 레이어가 처리
  const t = track();
  if (!t?.getCapabilities) return false;
  let caps = {};
  try { caps = t.getCapabilities(); } catch { return false; }
  const adv = {};
  if (caps.focusMode) {
    adv.focusMode = caps.focusMode.includes(m) ? m
      : caps.focusMode.includes("continuous") ? "continuous"
      : caps.focusMode[0];
  }
  // 탭한 지점을 초점 대상으로 전달 (지원 기기에서 실제 재초점)
  if (nx != null && caps.pointsOfInterest) {
    adv.pointsOfInterest = [{ x: nx, y: ny }];
  }
  if (!Object.keys(adv).length) return false;
  t.applyConstraints({ advanced: [adv] })
    .then(() => { if (nx != null) showToast("초점을 맞췄어요"); })
    .catch(() => { if (nx != null) showToast("이 기기는 지점 초점을 지원하지 않아요"); });
  return true;
}

/* ===== WebGL 파이프라인 ===== */
const glCanvas = document.createElement("canvas");
const gl = glCanvas.getContext("webgl", { premultipliedAlpha: false, preserveDrawingBuffer: true });
let glReady = false, glOK = false, uLoc = {};

const VS = `
attribute vec2 aPos; varying vec2 vUV;
void main() { vUV = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
varying vec2 vUV;

uniform sampler2D uFrame;   // 원본 프레임
uniform sampler2D uMask;    // A=피부, G=눈 흰자
uniform sampler2D uWarp;    // 윤곽 변위 맵 (RG 인코딩)
uniform vec2  uTexel;
uniform float uAspect;
uniform float uRadius;      // 보정 반경 (px)
uniform float uSmooth;      // 피부결
uniform float uBlemish;     // 잡티
uniform float uEye;         // 눈 보정
uniform float uWrinkle;     // 주름 완화
uniform vec4  uFoldL;       // 팔자 후보 캡슐 (좌)
uniform vec4  uFoldR;       // 팔자 후보 캡슐 (우)
uniform float uFoldRad;
uniform float uWarpAmt;
uniform float uLens;
uniform float uSharp;
uniform float uContrast;
uniform float uSat;
uniform vec3  uRGB;
uniform float uWB;
uniform float uFilm;
uniform float uFlash;
uniform vec2  uFlashC;
uniform float uFlashR;
uniform vec4  uLip;   // 입술 (중심 xy, 반경 xy)
uniform float uTime;
uniform vec2  uFmTone;      // 필름 (스케일, 리프트)
uniform float uFmSat;
uniform vec3  uFmHi;
uniform vec3  uFmSh;
uniform float uFmGrain;
uniform float uFmVig;

float lumOf(vec3 v) { return dot(v, vec3(0.299, 0.587, 0.114)); }

// 팔자 후보 캡슐 가중치 (선분 거리 + 입꼬리 방향 테이퍼)
float foldW(vec2 p, vec4 seg, float rad, float aspect) {
  vec2 pa = p - seg.xy, ba = seg.zw - seg.xy;
  pa.y *= aspect; ba.y *= aspect;
  float t = clamp(dot(pa, ba) / max(dot(ba, ba), 0.000001), 0.0, 1.0);
  vec2 d = pa - ba * t;
  float w = 1.0 - smoothstep(rad * 0.25, rad, length(d));
  w *= 1.0 - smoothstep(0.55, 0.95, t);
  return w;
}

void main() {
  vec2 uv = vUV;

  // ===== 윤곽: 실루엣 평탄화 (변위 맵) =====
  if (uWarpAmt > 0.5) {
    vec2 wv = texture2D(uWarp, vUV).rg;
    uv -= (wv - vec2(128.0 / 255.0)) * 0.08;
  }

  // ===== 화각 렌즈 왜곡 =====
  if (abs(uLens) > 0.001) {
    vec2 d2 = uv - 0.5; d2.y *= uAspect;
    float r2 = dot(d2, d2);
    uv = vec2(0.5) + (d2 * (1.0 + uLens * r2)) / vec2(1.0, uAspect);
  }

  vec3 c = texture2D(uFrame, uv).rgb;
  vec3 res = c;
  vec4 mk = texture2D(uMask, uv);
  float skinM = mk.a * (1.0 - mk.g);   // 피부 (눈 영역 제외)

  // ===== 피부: 잡티(조명 결함 보정) + 피부결(주파수 분리) =====
  // 잡티 설계 원칙: 다른 위치의 픽셀을 '복사'하지 않는다.
  // 잡티를 조명 결함으로 보고(레티넥스), 주변과의 저주파 차이만 더한다.
  // 픽셀 이동이 없으므로 구조물이 겹쳐 보이는 현상이 원천적으로 불가능하다.
  if (skinM > 0.01 && (uSmooth > 0.01 || uBlemish > 0.01)) {
    float sigmaR = 0.07 + 0.07 * uSmooth;
    vec3 wsum = c; float wtot = 1.0; vec3 plain = c;
    float minI = 1.0;
    for (int i = 0; i < 8; i++) {
      float ang = 0.7853982 * float(i);
      vec2 dir = vec2(cos(ang), sin(ang));
      vec3 s1 = texture2D(uFrame, uv + dir * uRadius * uTexel).rgb;
      vec3 s2 = texture2D(uFrame, uv + dir * uRadius * 0.55 * uTexel).rgb;
      float w1 = exp(-dot(s1 - c, s1 - c) / (2.0 * sigmaR * sigmaR));
      float w2 = exp(-dot(s2 - c, s2 - c) / (2.0 * sigmaR * sigmaR));
      wsum += s1 * w1 + s2 * w2; wtot += w1 + w2;
      plain += s1 + s2;
      minI = min(minI, min(lumOf(s1), lumOf(s2)));
    }
    vec3 base = wsum / wtot;          // 엣지 보존 스무딩 (Bilateral)
    vec3 avg = plain / 17.0;          // 국소 평균
    vec3 farC = vec3(0.0);            // 잡티 밖 '깨끗한 피부' 기준
    float minF = 1.0, maxF = 0.0, maxRedF = -1.0;
    for (int i = 0; i < 8; i++) {
      float fa = 0.7853982 * float(i);
      vec3 fs2 = texture2D(uFrame, uv + vec2(cos(fa), sin(fa)) * uRadius * 2.0 * uTexel).rgb;
      farC += fs2;
      float lf = lumOf(fs2);
      minF = min(minF, lf); maxF = max(maxF, lf);
      maxRedF = max(maxRedF, fs2.r - (fs2.g + fs2.b) * 0.5);
    }
    farC *= 0.125;

    float lumC = lumOf(c), lumA = lumOf(avg), lumF = lumOf(farC);
    vec3 r = c;

    if (uBlemish > 0.01) {
      // 이상 탐지: 밝기 결함 + 붉은기 결함
      float redC = c.r - (c.g + c.b) * 0.5;
      float redF = farC.r - (farC.g + farC.b) * 0.5;
      // 잡티 = '함몰': 사방 어느 방향으로 가도 밝아진다.
      // 음영 그라데이션은 한쪽이 어두우므로 minF 기준을 절대 통과할 수 없다.
      float pit = minF - lumC;                             // 가장 어두운 방향조차 나보다 밝음
      float redPit = redC - maxRedF;                       // 가장 붉은 방향조차 나보다 덜 붉음

      // 선형 구조 배제 (Frangi 원리):
      // 잡티는 '덩어리'라 어느 축으로 잘라도 골이 깊다.
      // 주름·콧볼 골은 '선'이라 결을 따라 자르면 골이 얕다 → 가장 얕은 축을 기준으로 판정.
      // 골 길이가 샘플 반경보다 짧아도 걸러지도록 두 배율에서 모두 검사한다.
      // 배율마다 '가장 얕은 축'을 재고, 그중 가장 덩어리다운 배율을 채택한다.
      // (작은 배율은 잡티 내부에서 평탄해 보이므로 최솟값을 쓰면 잡티까지 걸러진다)
      float rnd1 = 1.0, rnd2 = 1.0;
      for (int i = 0; i < 4; i++) {
        float ra = 0.7853982 * float(i);
        vec2 rd = vec2(cos(ra), sin(ra));
        vec2 o1 = rd * uRadius * 0.55 * uTexel;
        vec2 o2 = rd * uRadius * 1.15 * uTexel;
        rnd1 = min(rnd1, (lumOf(texture2D(uFrame, uv + o1).rgb)
                        + lumOf(texture2D(uFrame, uv - o1).rgb)) * 0.5 - lumC);
        rnd2 = min(rnd2, (lumOf(texture2D(uFrame, uv + o2).rgb)
                        + lumOf(texture2D(uFrame, uv - o2).rgb)) * 0.5 - lumC);
      }
      float roundness = max(rnd1, rnd2);

      float th = 0.048 - 0.007 * uBlemish;
      float spot = max(smoothstep(th * 0.5, th, pit),
                       smoothstep(th * 0.8, th * 1.6, redPit) * 0.7);
      spot *= smoothstep(th * 0.20, th * 0.55, roundness);  // 선형 구조(주름·골) 배제
      spot *= 1.0 - mk.b;                                   // 해부학적 제외 구역(콧볼 골 등)
      spot *= smoothstep(0.008, 0.030, lumA - lumC);       // 국소성 (보조 게이트)
      spot *= 1.0 - smoothstep(0.26, 0.42, lumF - lumC);   // 진한 점(Mole) 보존
      spot *= smoothstep(0.12, 0.28, c.g);                 // 극암부(머리카락 등) 보호
      spot *= smoothstep(0.10, 0.22, minI);                // 검은 구멍 인접(콧구멍 테두리) 보호
      spot *= 1.0 - smoothstep(0.20, 0.30, pit);           // 너무 깊은 함몰은 구멍이지 잡티가 아님
      // 강도 상단(90~100)에서 과검출이 급증하므로 곡선을 눌러준다
      float strength = uBlemish * (1.0 - 0.28 * smoothstep(0.75, 1.0, uBlemish));
      float glare = smoothstep(th * 0.5, th, lumC - maxF) * 0.55 * strength * (1.0 - mk.b);
      spot = min(spot * 0.9 * strength, 0.85);

      // 조명 결함 복구: 밝기 '배율'만 조정 (Dodge/Burn) — 색·질감 불변, 상한 존재.
      // 덧셈이 아닌 제한된 곱셈이라 주변 구조물이 섞여 들어올 수 없다.
      float liftL = clamp(lumF - lumC, 0.0, 0.085);         // 결함 깊이 (상한)
      float dodge = min(1.0 + (liftL / max(lumC, 0.05)) * spot, 1.16);
      float dropL = clamp(lumC - lumF, 0.0, 0.10);
      float burn = max(1.0 - (dropL / max(lumC, 0.05)) * glare, 0.78);
      r = c * dodge * burn;
      // 붉은기 결함은 별도로 소폭 중화 (여드름 자국·홍조 점)
      float redEx = clamp(redC - redF, 0.0, 0.2);
      r -= vec3(0.66, -0.33, -0.33) * redEx * spot * 0.5;
    }

    if (uSmooth > 0.01) {
      float dev = abs(lumA - lumC);
      float structural = smoothstep(0.035, 0.11, dev);     // 음영·윤곽 보호
      vec3 low = mix(base, avg, uSmooth * 0.75 * (1.0 - structural));
      vec3 hi = r - base;
      r = low + hi * (1.0 - uSmooth * 0.45);
    }
    res = mix(c, r, skinM);
  }

  // ===== 눈: 흰자 정리 (LAB 원리 — 채도만 낮추고 밝기만 올림) =====
  if (mk.g > 0.01 && uEye > 0.01) {
    float l = lumOf(res);
    float white = smoothstep(0.30, 0.50, l);               // 흰자만 (홍채·속눈썹 제외)
    float wgt = mk.g * white * uEye;
    if (wgt > 0.01) {
      // 핏줄: 주변 대비 국소적으로 붉은 가는 구조
      float redL = res.r - (res.g + res.b) * 0.5;
      float redN = 0.0;
      for (int i = 0; i < 4; i++) {
        float ea = 1.5707963 * float(i);
        vec3 s = texture2D(uFrame, uv + vec2(cos(ea), sin(ea)) * uRadius * 0.9 * uTexel).rgb;
        redN += s.r - (s.g + s.b) * 0.5;
      }
      redN *= 0.25;
      float vessel = clamp((redL - redN) * 8.0, 0.0, 1.0);
      res = mix(res, vec3(l), wgt * (0.35 + 0.5 * vessel)); // A·B 채널 → 0 (무채색화)
      res *= 1.0 + wgt * 0.10;                              // L 리프트
    }
  }

  // ===== 주름: 조명 평탄화 (Dodge & Burn) =====
  // 설계 원칙: 색 혼합 없음 — 밝기 '배율'만 조정한다 (겹침 불가).
  // 이웃 샘플이 피부 마스크 밖(입술·눈썹·콧구멍)이면 연산을 차단한다.
  if (uWrinkle > 0.01) {
    float wl = foldW(vUV, uFoldL, uFoldRad, uAspect);
    float wr2 = foldW(vUV, uFoldR, uFoldRad, uAspect);
    float fw = max(wl, wr2);
    if (fw > 0.005) {
      vec4 seg = wl > wr2 ? uFoldL : uFoldR;
      vec2 fd = seg.zw - seg.xy; fd.y *= uAspect;
      fd = normalize(fd);
      vec2 perp = vec2(-fd.y, fd.x); perp.y /= uAspect;
      vec2 along = vec2(fd.x, fd.y / uAspect);
      float pd = uFoldRad * 0.35;
      vec4 m1 = texture2D(uMask, uv + perp * pd);
      vec4 m2 = texture2D(uMask, uv - perp * pd);
      float gate = skinM * (m1.a * (1.0 - m1.g)) * (m2.a * (1.0 - m2.g));
      if (gate > 0.01) {
        float lc = lumOf(res);
        float n1 = lumOf(texture2D(uFrame, uv + perp * pd).rgb);
        float n2 = lumOf(texture2D(uFrame, uv - perp * pd).rgb);
        float la = (n1 + n2) * 0.5;
        float a1 = lumOf(texture2D(uFrame, uv + along * pd).rgb);
        float a2 = lumOf(texture2D(uFrame, uv - along * pd).rgb);
        float lineness = 1.0 - clamp((min(a1, a2) - lc) * 10.0, 0.0, 1.0);
        float amt = uWrinkle * fw * lineness * gate;
        float k = clamp((la - lc) / max(lc, 0.02), -0.30, 0.55);
        res *= 1.0 + k * amt * 0.85;                       // 골 Dodge / 능선 Burn
        res *= 1.0 + fw * uWrinkle * gate * 0.035;         // 볼륨 리라이팅
      }
    }
  }

  // ===== 플래시 필터: 직광 온카메라 플래시 룩 =====
  // 레퍼런스의 핵심은 '원형 스포트라이트'가 아니다.
  // 플래시는 사람에게 고르게 닿고, 뒤에 있는 배경만 거리 때문에 뚝 떨어진다.
  // 그래서 피사체는 균일하게 밝히고, 배경은 (그라데이션 없이) 균일하게 눌러 분리한다.
  if (uFlash > 0.005) {
    vec2 dp = uv - uFlashC; dp.y *= uAspect;
    float d = length(dp) / max(uFlashR, 0.001);

    // 피사체 근사: 얼굴 마스크 + 얼굴 주변의 넓고 완만한 영역(머리·목·어깨)
    float around = 1.0 - smoothstep(0.85, 1.9, d);
    float subject = clamp(max(skinM, around), 0.0, 1.0);
    float bg = 1.0 - subject;

    // 1) 배경만 눌러 피사체를 분리한다 (거리 감쇠는 배경에서 거의 균일하다)
    res *= mix(1.0, mix(1.0, 0.42, bg), uFlash);

    // 2) 피사체는 고르게 밝힌다 — 얼굴 안에서 밝기 차이를 만들지 않는다
    res *= 1.0 + uFlash * subject * 0.30;

    // 3) 직광 특유의 '살짝 날아간' 하이라이트 (부드러운 롤오프)
    vec3 blown = 1.0 - (1.0 - res) * (1.0 - res) * 0.90;
    res = mix(res, blown, uFlash * subject * 0.45);

    // 4) 피부 광택 — 정면광이 만드는 반사
    float ls = lumOf(res);
    res += smoothstep(0.68, 0.95, ls) * uFlash * skinM * 0.13;

    // 5) 정면광은 얼굴 그림자를 얕게 만든다
    res = mix(res, pow(max(res, 0.0), vec3(0.88)), uFlash * skinM * 0.55);

    // 6) 입술: 선명한 색과 광택
    vec2 lp = (uv - uLip.xy) / max(uLip.zw, vec2(0.001));
    float lipW = (1.0 - smoothstep(0.55, 1.0, length(lp))) * step(0.0001, uLip.z);
    res = mix(res, res * vec3(1.12, 0.92, 0.95), uFlash * lipW * 0.75);
    res += smoothstep(0.60, 0.94, lumOf(res)) * uFlash * lipW * 0.18;

    // 7) 혈색이 날아간 창백한 피부톤
    vec3 pale = mix(res, vec3(lumOf(res)), 0.16) * vec3(1.025, 1.01, 1.035);
    res = mix(res, pale, uFlash * skinM * 0.55);

    // 8) Y2K 파파라치 톤 + 필름 그레인
    res = (res - 0.5) * (1.0 + 0.14 * uFlash) + 0.5;
    res *= mix(vec3(1.0), vec3(1.012, 0.997, 1.03), uFlash);
    float fg = fract(sin(dot(gl_FragCoord.xy + vec2(uTime * 331.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    res += fg * uFlash * 0.035;
  }

  // ===== 선명도 =====
  if (uSharp > 0.01) {
    vec3 b = (texture2D(uFrame, uv + vec2(uTexel.x, 0.0)).rgb
            + texture2D(uFrame, uv - vec2(uTexel.x, 0.0)).rgb
            + texture2D(uFrame, uv + vec2(0.0, uTexel.y)).rgb
            + texture2D(uFrame, uv - vec2(0.0, uTexel.y)).rgb) * 0.25;
    res += (res - b) * uSharp * 0.9;
  }

  // ===== 화이트 밸런스 / RGB / 콘트라스트 / 채도 =====
  if (abs(uWB) > 0.001) {
    res *= vec3(1.0 + 0.10 * uWB, 1.0 + 0.015 * uWB, 1.0 - 0.12 * uWB);
  }
  res *= uRGB;
  res = (res - 0.5) * uContrast + 0.5;
  res = mix(vec3(lumOf(res)), res, uSat);

  // ===== 필름 그레이드 (프리셋 파라미터, 레퍼런스 실측값) =====
  if (uFilm > 0.005) {
    vec3 f = res;
    float fl = lumOf(f);
    f = f * mix(1.0, uFmTone.x, uFilm) + vec3(uFmTone.y * uFilm);
    f = mix(f, vec3(lumOf(f)), uFmSat * uFilm);
    float hl = smoothstep(0.55, 0.9, fl);
    f *= mix(vec3(1.0), uFmHi, hl * uFilm);
    float shd = 1.0 - smoothstep(0.1, 0.45, fl);
    f *= mix(vec3(1.0), uFmSh, shd * uFilm);
    vec2 dv = vUV - 0.5;
    f *= 1.0 - dot(dv, dv) * uFmVig * uFilm;
    float g = fract(sin(dot(gl_FragCoord.xy + vec2(uTime * 617.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    f += g * uFmGrain * uFilm;
    res = f;
  }

  gl_FragColor = vec4(clamp(res, 0.0, 1.0), 1.0);
}
`;

function initGLOnce() {
  if (glReady || !gl) return glReady;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      console.error(log);
      showToast("셰이더 오류: " + log.split("\n")[0].slice(0, 70));
      return null;
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  if (!vs || !fs) return false;
  const prog = gl.createProgram();
  gl.attachShader(prog, vs); gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, "aPos");
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const mkTex = (unit) => {
    const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    return t;
  };
  mkTex(0); mkTex(1); mkTex(2);
  ["uFrame","uMask","uWarp","uTexel","uAspect","uRadius","uSmooth","uBlemish","uEye",
   "uWrinkle","uFoldL","uFoldR","uFoldRad","uWarpAmt","uLens","uSharp","uContrast",
   "uSat","uRGB","uWB","uFilm","uFlash","uFlashC","uFlashR","uLip","uTime","uFmTone","uFmSat","uFmHi","uFmSh","uFmGrain","uFmVig"]
    .forEach(n => uLoc[n] = gl.getUniformLocation(prog, n));
  gl.uniform1i(uLoc.uFrame, 0);
  gl.uniform1i(uLoc.uMask, 1);
  gl.uniform1i(uLoc.uWarp, 2);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  glReady = true;
  return true;
}

// 화각별 렌즈 왜곡 계수 (28mm = 배럴, 50mm = 살짝 평탄)
const LENS_MAP = { 28: -0.13, 35: 0.0, 50: 0.06 };

// 필름 프리셋 — 레퍼런스 사진들에서 실측한 4가지 계열
const FILM_PRESETS = [
  { name: "필름1", tone: [0.875, 0.045], sat: 0.14, hi: [1.032, 1.0, 0.968], sh: [0.99, 1.0, 0.86], grain: 0.040, vig: 0.22 },  // 크림
  { name: "필름2", tone: [0.830, 0.075], sat: 0.30, hi: [1.020, 1.0, 0.985], sh: [1.00, 1.0, 0.90], grain: 0.030, vig: 0.15 },  // 소프트
  { name: "필름3", tone: [0.900, 0.030], sat: 0.10, hi: [1.050, 1.0, 0.955], sh: [0.97, 1.0, 0.72], grain: 0.055, vig: 0.30 },  // 도쿄
  { name: "필름4", tone: [0.880, 0.060], sat: 0.00, hi: [1.010, 1.0, 0.900], sh: [1.00, 1.0, 1.02], grain: 0.050, vig: 0.25 },  // 35mm
];

// 공통 유니폼 설정 후 1프레임 그리기
function drawGL(srcTex, opt) {
  if (typeof window !== "undefined" && window.__spyDrawGL) window.__spyDrawGL(opt);
  gl.viewport(0, 0, glCanvas.width, glCanvas.height);
  gl.uniform2f(uLoc.uTexel, 1 / opt.srcW, 1 / opt.srcH);
  gl.uniform1f(uLoc.uAspect, opt.srcH / opt.srcW);
  gl.activeTexture(gl.TEXTURE0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, srcTex);

  gl.uniform1f(uLoc.uRadius, opt.radius ?? 3);
  gl.uniform1f(uLoc.uSmooth, opt.smooth ?? 0);
  gl.uniform1f(uLoc.uBlemish, opt.blemish ?? 0);
  gl.uniform1f(uLoc.uFilm, opt.film ?? 0);
  gl.uniform1f(uLoc.uSharp, opt.sharp ?? 0);
  gl.uniform1f(uLoc.uContrast, opt.contrast ?? 1);
  gl.uniform1f(uLoc.uSat, opt.sat ?? 1);
  gl.uniform3f(uLoc.uRGB, ...(opt.rgb ?? [1, 1, 1]));
  gl.uniform1f(uLoc.uWB, opt.wb ?? 0);
  gl.uniform1f(uLoc.uTime, opt.time ?? 0.5);
  const fm = opt.fm ?? FILM_PRESETS[0];
  gl.uniform2f(uLoc.uFmTone, fm.tone[0], fm.tone[1]);
  gl.uniform1f(uLoc.uFmSat, fm.sat);
  gl.uniform3f(uLoc.uFmHi, fm.hi[0], fm.hi[1], fm.hi[2]);
  gl.uniform3f(uLoc.uFmSh, fm.sh[0], fm.sh[1], fm.sh[2]);
  gl.uniform1f(uLoc.uFmGrain, fm.grain);
  gl.uniform1f(uLoc.uFmVig, fm.vig);
  gl.uniform1f(uLoc.uLens, opt.lens ?? 0);
  gl.uniform1f(uLoc.uWarpAmt, opt.warp ? 1 : 0);
  gl.uniform1f(uLoc.uWrinkle, opt.fold ? (opt.wrinkle ?? 0) : 0);
  gl.uniform1f(uLoc.uEye, opt.eye ?? 0);
  gl.uniform1f(uLoc.uFlash, opt.flash ?? 0);
  gl.uniform2f(uLoc.uFlashC, opt.flashC?.[0] ?? 0.5, 1 - (opt.flashC?.[1] ?? 0.5));
  gl.uniform1f(uLoc.uFlashR, opt.flashR ?? 0.5);
  const lip = opt.lip ?? [0, 0, 0, 0];
  gl.uniform4f(uLoc.uLip, lip[0], lip[1], lip[2], lip[3]);
  if (opt.fold) {
    gl.uniform4f(uLoc.uFoldL, opt.fold.l[0], opt.fold.l[1], opt.fold.l[2], opt.fold.l[3]);
    gl.uniform4f(uLoc.uFoldR, opt.fold.r[0], opt.fold.r[1], opt.fold.r[2], opt.fold.r[3]);
    gl.uniform1f(uLoc.uFoldRad, opt.fold.rad);
  }
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ===== 팔자주름 실측 스캔 (후보정 전용) =====
// 편집 진입 시 촬영된 정지 사진에서 1회 실행. 랜드마크로 탐색 상자를 정하고
// 픽셀 스캔 → 4단계 검증(암부 제외·직선성·방향·최소 깊이)으로 실제 골을 찾는다.

// 윤곽 변위 맵 계산: 실루엣 36점을 가우시안 스무딩한 '매끈한 기준선'을 만들고,
// 실제 선이 기준선에서 튀어나온 만큼의 40%를 당기는 변위 벡터장을 그린다.
// 옆모습에서는 코 방향 실루엣(콧대·입)은 보호한다.
function computeWarpMap(w, hh) {
  const L = editLandmarks || lastLandmarks;
  const n = FACE_OVAL.length;
  const faceW = Math.abs(L[454].x - L[234].x);
  const cx = (L[234].x + L[454].x) / 2;
  const yaw = (L[4].x - cx) / Math.max(faceW, 0.001);
  const noseSign = Math.sign(yaw), yaw01 = Math.min(1, Math.abs(yaw) * 3);
  // 코·입 실루엣이 있는 세로 구간만 보호 (그 위 관자놀이·그 아래 턱은 보정 허용)
  const yTop = L[168].y - 0.01;
  const yBot = L[17].y + (L[152].y - L[17].y) * 0.35;
  // 눈썹 높이 — 이보다 위(이마·관자놀이 라인)는 변형에서 완전 제외 (눈썹이 찌그러지는 것 방지)
  const browY = Math.min(L[105].y, L[334].y);
  const sstep = (a, b, x) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

  const P = FACE_OVAL.map(idx => [L[idx].x, L[idx].y]);
  const GW = [1, 4, 8, 12, 14, 12, 8, 4, 1], gsum = 64;   // 스무딩 가중치 (±4점)
  const D = P.map((_, i) => {
    let sx = 0, sy = 0;
    for (let k = -4; k <= 4; k++) {
      const p = P[(i + k + n) % n]; const g = GW[k + 4];
      sx += p[0] * g; sy += p[1] * g;
    }
    sx /= gsum; sy /= gsum;
    const toNose = Math.max(0, Math.min(1, (P[i][0] - cx) * noseSign / faceW * 2));
    const vert = sstep(yTop - 0.02, yTop + 0.02, P[i][1]) * (1 - sstep(yBot - 0.02, yBot + 0.02, P[i][1]));
    const belowBrow = sstep(browY - 0.01, browY + 0.03, P[i][1]);   // 눈썹 위 포인트는 변형 0
    const s = 0.40 * (1 - toNose * yaw01 * vert) * belowBrow;
    let dx = (sx - P[i][0]) * s, dy = (sy - P[i][1]) * s;
    // 변위량 상한: 극단적으로 튀어나온 지점도 과하게 당기지 않음
    const mag = Math.hypot(dx, dy), cap = faceW * 0.012;
    if (mag > cap) { dx *= cap / mag; dy *= cap / mag; }
    return [dx, dy];
  });

  const img = warpCtx.createImageData(w, hh);
  const data = img.data;
  for (let i = 0; i < data.length; i += 4) { data[i] = 128; data[i + 1] = 128; data[i + 3] = 255; }

  const asp = hh / w;                      // 세로 정규화 보정
  const sigma = faceW * 0.055;             // 영향 반경을 좁게 — 변형이 외곽선 근처에만 머묾
  const acc = new Float32Array(w * hh * 3);
  for (let i = 0; i < n; i++) {
    const px = P[i][0], py = P[i][1], r = sigma * 2.5;
    const x0 = Math.max(0, (px - r) * w | 0), x1 = Math.min(w - 1, Math.ceil((px + r) * w));
    const y0 = Math.max(0, (py - r / asp) * hh | 0), y1 = Math.min(hh - 1, Math.ceil((py + r / asp) * hh));
    for (let y = y0; y <= y1; y++) {
      const ddy = (y / hh - py) * asp;
      for (let x = x0; x <= x1; x++) {
        const ddx = x / w - px;
        const d2 = ddx * ddx + ddy * ddy;
        const wgt = Math.exp(-d2 / (2 * sigma * sigma));
        if (wgt < 0.02) continue;
        const o = (y * w + x) * 3;
        acc[o] += D[i][0] * wgt; acc[o + 1] += D[i][1] * wgt; acc[o + 2] += wgt;
      }
    }
  }
  const K = 0.04;   // 셰이더 디코딩 스케일과 일치 (0.08 = 2K)
  for (let p = 0; p < w * hh; p++) {
    const wsum = acc[p * 3 + 2];
    if (wsum < 0.02) continue;
    const env = Math.min(1, wsum / 0.3);
    const dx = acc[p * 3] / wsum * env;
    const dy = acc[p * 3 + 1] / wsum * env;
    // GL의 uv는 y가 반대이므로 dy 부호 반전해서 저장
    data[p * 4]     = Math.max(0, Math.min(255, 128 + (dx / K) * 127));
    data[p * 4 + 1] = Math.max(0, Math.min(255, 128 + (-dy / K) * 127));
  }
  warpCtx.putImageData(img, 0, 0);
}

/* ===== 촬영 프리뷰 ===== */
const PREVIEW_SCALE = 0.5;   // 미리보기는 절반 해상도 → 발열 절약, 촬영은 원본 해상도

let prevW = 0, prevH = 0;   // 프리뷰 해상도 (startStream에서 설정)

/* ===== 고해상도 촬영 → 편집 화면 ===== */
let systemShot = false, glOKForCapture = true;
async function captureHighRes() {
  systemShot = false;
  // 가능하면 프리뷰 스트림이 아니라 '센서 원본 정지 사진'을 받아 처리한다.
  // 프리뷰는 대역폭 때문에 압축·축소되지만, 정지 사진은 센서 해상도 그대로다.
  let src = video, sw0 = video.videoWidth, sh0 = video.videoHeight;
  if (isFullNative()) {
    try {
      const res = await FilmCam().capture();
      const img = new Image();
      await new Promise((ok, no) => {
        img.onload = ok; img.onerror = () => no(new Error("사진을 읽을 수 없어요"));
        img.src = "data:image/jpeg;base64," + res.value;
      });
      src = img; sw0 = img.naturalWidth; sh0 = img.naturalHeight;
      systemShot = true;   // 네이티브가 이미 처리한 원본 — GL 전처리·미러링 생략
    } catch (e) {
      showToast("촬영 실패: " + String(e?.message || e).slice(0, 40));
      return;
    }
  } else if (camMode === "system") {
    try {
      const img = await shootWithSystemCamera();
      src = img; sw0 = img.naturalWidth; sh0 = img.naturalHeight;
      systemShot = true;
    } catch (e) {
      const msg = String(e?.message || e);
      if (!/cancel/i.test(msg)) showToast("촬영 실패: " + msg.slice(0, 50));
      return;
    }
  }
  if (!isFullNative() && imageCapture) {
    try {
      const blob = await imageCapture.takePhoto();
      const bmp = await createImageBitmap(blob);
      const arPrev = video.videoWidth / video.videoHeight;
      const arShot = bmp.width / bmp.height;
      // 비율이 다르면 얼굴 좌표가 어긋나므로 프리뷰 프레임을 쓴다
      if (Math.abs(arShot - arPrev) < 0.03 && bmp.width >= video.videoWidth) {
        src = bmp; sw0 = bmp.width; sh0 = bmp.height;
      } else { bmp.close?.(); }
    } catch (e) { /* 미지원 기기는 조용히 프리뷰 경로 사용 */ }
  }

  // 원본 해상도로 1프레임 처리 (피부·윤곽·렌즈만 굽고, 색·필름은 편집에서)
  glCanvas.width = sw0;
  glCanvas.height = sh0;
  const faceW = lastLandmarks ? Math.abs(lastLandmarks[454].x - lastLandmarks[234].x) * sw0 : 0;
  // 시스템 카메라 사진은 이미 제조사 파이프라인을 거쳤으므로 그대로 쓴다
  if (systemShot) glOKForCapture = false;
  // 후보정 방식: 촬영 시점에는 원본을 그대로 보존한다 (렌즈 왜곡만 적용)
  // 촬영 원본은 색을 굽지 않고 보존한다. 필름·WB는 편집 단계에서 적용된다.
  if (!systemShot) drawGL(src, {
    srcW: sw0, srcH: sh0,
    lens: LENS_MAP[focal],
    time: 0.5,
  });

  // 미러링 + 화각 크롭을 구워서 편집 원본 확정
  const { sx, sy, sw, sh } = cropRect(sw0, sh0);
  const cw = Math.round(sw), ch = Math.round(sh);
  capCanvas.width = cw; capCanvas.height = ch;
  capCtx.save();
  if (facing === "user" && !isFullNative() && !systemShot) { capCtx.translate(cw, 0); capCtx.scale(-1, 1); }
  capCtx.drawImage((glOK && !systemShot) ? glCanvas : src, sx, sy, sw, sh, 0, 0, cw, ch);
  capCtx.restore();

  shotLandmarks = lastLandmarks;
  shotCropX = sw / sw0;
  shotCropY = sh / sh0;
  shotMirror = facing === "user";
  if (src !== video) src.close?.();

  // 후보정: 찍은 사진에 얼굴 인식 → 마스크 → 보정을 한 번에 적용
  await processShot();

  // 자동으로 앱 내부 갤러리에 보관 (별도 저장 화면 없음)
  try {
    const [proc, orig] = await Promise.all([
      canvasToBlob(editOut, 0.92),
      canvasToBlob(capCanvas, 0.95),
    ]);
    const shot = {
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      ts: Date.now(), processed: proc, original: orig,
      landmarks: editLandmarks ? editLandmarks.map(p => ({ x: p.x, y: p.y })) : null,
      cropX: shotCropX, cropY: shotCropY, mirror: shotMirror,
      settings: { skinAmt, blemAmt, eyeOn, contourOn, filmPreset, filmStrength, wbCam },
    };
    await galleryAdd(shot);
    await refreshGalleryThumb();
    flashThumb();
  } catch (e) {
    showToast("갤러리 저장 실패: " + (e?.message || e));
  }
}

// 찍은 사진에 보정 파이프라인 적용 (실시간이 아니라 후보정 단계)
let lastDetectWhy = "";

// 윤곽 변위 맵을 만들어 GPU에 올린다 (실시간이 아니라 촬영 후 시점)
function uploadWarp() {
  if (!glOK || !editLandmarks) return;
  warpCanvas.width = maskCanvas.width;
  warpCanvas.height = maskCanvas.height;
  if (contourOn) computeWarpMap(warpCanvas.width, warpCanvas.height);
  else {
    warpCtx.fillStyle = "rgb(128,128,0)";   // 중립 (이동 없음)
    warpCtx.fillRect(0, 0, warpCanvas.width, warpCanvas.height);
  }
  gl.activeTexture(gl.TEXTURE2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, warpCanvas);
}
const detectCanvas = document.createElement("canvas");
const detectCtx = detectCanvas.getContext("2d", { willReadFrequently: true });

function scaleForDetect(srcCanvas, maxSide) {
  const w = srcCanvas.width, h = srcCanvas.height;
  const scale = Math.min(1, maxSide / Math.max(w, h));
  if (scale >= 1) return srcCanvas;
  detectCanvas.width = Math.max(2, Math.round(w * scale));
  detectCanvas.height = Math.max(2, Math.round(h * scale));
  detectCtx.drawImage(srcCanvas, 0, 0, detectCanvas.width, detectCanvas.height);
  return detectCanvas;
}

async function processShot() {
  let L = null, why = "";
  if (!landmarker) why = "얼굴 인식 모듈이 준비되지 않았어요";
  else {
    // 원본은 2000px가 넘는 경우가 많다. 큰 이미지를 그대로 넣으면
    // GPU 텍스처 한계에 걸려 얼굴을 못 찾는 기기가 있어 축소본으로 검출한다.
    // 랜드마크는 0~1 비율값이라 원본에 그대로 대응된다.
    const tries = [1024, 640, 1536];
    for (const maxSide of tries) {
      try {
        const src = scaleForDetect(capCanvas, maxSide);
        const r = landmarker.detect(src);
        if (r?.faceLandmarks?.length) { L = r.faceLandmarks[0]; break; }
        why = "사진에서 얼굴을 찾지 못했어요";
      } catch (e) {
        why = "얼굴 인식 오류: " + (e?.message || e).toString().slice(0, 60);
      }
    }
  }
  lastDetectWhy = L ? "" : why;
  if (!L) L = landmarksForCapture();
  editOut.width = capCanvas.width;
  editOut.height = capCanvas.height;
  editLandmarks = L;
  editFold = L ? foldCapsules(L) : null;
  if (!L && why) showToast(why + " — 보정 없이 저장했어요");

  if (L) {
    maskCanvas.width = Math.max(2, Math.round(capCanvas.width / 5));
    maskCanvas.height = Math.max(2, Math.round(capCanvas.height / 5));
    buildFaceMask(maskCanvas.width, maskCanvas.height, L);
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    uploadWarp();
  }
  editRender();
}

// 팔자 후보 영역: 랜드마크로 넓은 캡슐만 만들고, 실제 적용 여부는
// 셰이더의 골 감지(양옆보다 어두움 + 선형성)가 픽셀 단위로 판단한다.
// 위치 추정에 의존하지 않으므로 사람·표정이 달라도 작동한다.
function foldCapsules(L) {
  const faceW = Math.abs(L[454].x - L[234].x);
  // 팔자 주름은 콧볼 옆에서 시작해 입꼬리 '바깥'으로 흐른다.
  // 인중(코 바로 밑)을 침범하지 않도록 시작점을 옆으로 충분히 밀고 반경을 줄인다.
  const mk = (corner) => {
    const dx = corner.x - L[2].x;
    const top = [L[2].x + dx * 0.90, L[2].y + (corner.y - L[2].y) * 0.22];
    const bot = [corner.x + dx * 0.55, corner.y + (corner.y - L[2].y) * 0.20];
    return [top[0], 1 - top[1], bot[0], 1 - bot[1]];
  };
  return { l: mk(L[61]), r: mk(L[291]), rad: faceW * 0.062 };
}

let editFold = null;
let shotLandmarks = null, shotCropX = 1, shotCropY = 1, shotMirror = true;

// 촬영 시점 랜드마크를 '찍힌 사진' 좌표계로 변환 (미러링·화각 크롭 반영)
function landmarksForCapture() {
  if (!shotLandmarks) return null;
  const offX = (1 - shotCropX) / 2, offY = (1 - shotCropY) / 2;
  return shotLandmarks.map(p => {
    let x = (p.x - offX) / shotCropX;
    const y = (p.y - offY) / shotCropY;
    if (shotMirror) x = 1 - x;
    return { x, y };
  });
}

function enterEdit() {
  if (isFullNative()) stopFullNative();
  $("camScreen").classList.remove("on");
  $("galleryScreen").classList.remove("on");
  $("editScreen").classList.add("on");
  const wr = $("wrinkle").closest(".row");
  if (wr) wr.style.opacity = editFold ? "1" : "0.4";
  const diag = $("editDiag");
  if (diag) {
    if (editLandmarks) {
      diag.textContent = "얼굴 인식 O · 피부결 " + Math.round(skinAmt * 100) +
                         " · 잡티 " + Math.round(blemAmt * 100);
      diag.classList.remove("bad");
    } else {
      diag.textContent = "얼굴 인식 X — " + (lastDetectWhy || "원인 불명") + " (보정 미적용)";
      diag.classList.add("bad");
    }
  }
  editRender();
}

function editRender() {
  if (!glOK) { editCtx.drawImage(capCanvas, 0, 0); return; }
  glCanvas.width = capCanvas.width;
  glCanvas.height = capCanvas.height;
  const L = editLandmarks;
  const faceW = L ? Math.abs(L[454].x - L[234].x) * capCanvas.width : 0;
  // 플래시는 얼굴을 광원 중심으로 잡는다 (없으면 화면 중앙)
  let fc = [0.5, 0.45], fr = 0.55, lip = [0, 0, 0, 0];
  if (L) {
    const cx = (L[234].x + L[454].x) / 2, cy = (L[10].y + L[152].y) / 2;
    fc = [cx, cy];
    fr = Math.max(0.25, Math.abs(L[454].x - L[234].x) * 1.9);
    lip = [(L[61].x + L[291].x) / 2, 1 - (L[13].y + L[14].y) / 2,
           Math.abs(L[291].x - L[61].x) * 0.58,
           Math.max(Math.abs(L[14].y - L[13].y) * 1.9, Math.abs(L[454].x - L[234].x) * 0.045)];
  }
  drawGL(capCanvas, {
    srcW: capCanvas.width, srcH: capCanvas.height,
    radius: Math.max(2.5, faceW * 0.030),
    smooth: (skinOn && L) ? skinAmt : 0,
    blemish: (blemishOn && L) ? blemAmt : 0,
    eye: (eyeOn && L) ? 0.55 : 0,
    warp: contourOn && !!L,
    lens: LENS_MAP[focal],
    flash: S.flash ? S.flash.value / 100 : 0,
    flashC: fc, flashR: fr, lip: lip,
    film: S.film.value / 100,
    fm: FILM_PRESETS[filmPreset],
    fold: editFold,
    wrinkle: S.wrinkle.value / 100,
    sharp: S.sharp.value / 100 * 1.1,
    contrast: S.contrast.value / 100,
    sat: S.sat.value / 100,
    rgb: [S.rGain.value / 100, S.gGain.value / 100, S.bGain.value / 100],
    wb: wbValue,
    time: 0.5,
  });
  editCtx.drawImage(glCanvas, 0, 0);
}

$("retakeBtn").addEventListener("click", () => {
  $("editScreen").classList.remove("on");
  openGallery();
});

let galleryURLs = [];
function revokeGallery() { galleryURLs.forEach(u => URL.revokeObjectURL(u)); galleryURLs = []; }

async function refreshGalleryThumb() {
  try {
    const all = await galleryAll();
    const btn = $("galleryBtn");
    if (!all.length) { btn.innerHTML = '<span id="thumbEmpty">▤</span>'; return; }
    const u = URL.createObjectURL(all[0].processed);
    btn.innerHTML = "";
    const im = new Image();
    im.onload = () => URL.revokeObjectURL(u);
    im.src = u;
    btn.appendChild(im);
  } catch {}
}
function flashThumb() {
  const b = $("galleryBtn");
  b.classList.remove("pop"); void b.offsetWidth; b.classList.add("pop");
  showToast("갤러리에 저장했어요");
}

async function openGallery() {
  mode = "gallery";
  if (isFullNative()) await stopFullNative();
  $("camScreen").classList.remove("on");
  $("editScreen").classList.remove("on");
  $("galleryScreen").classList.add("on");
  const grid = $("galGrid");
  revokeGallery();
  grid.innerHTML = "";
  let all = [];
  try { all = await galleryAll(); } catch {}
  $("galEmpty").classList.toggle("hide", all.length > 0);
  $("galCount").textContent = all.length ? all.length + "장" : "";
  for (const shot of all) {
    const url = URL.createObjectURL(shot.processed);
    galleryURLs.push(url);
    const cell = document.createElement("div");
    cell.className = "gal-cell";
    const im = document.createElement("img");
    im.src = url;
    im.addEventListener("click", () => openShot(shot));
    const del = document.createElement("button");
    del.className = "gal-del"; del.textContent = "✕";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await galleryDel(shot.id);
      await refreshGalleryThumb();
      openGallery();
    });
    cell.appendChild(im); cell.appendChild(del);
    grid.appendChild(cell);
  }
}

// 갤러리에서 사진을 열면 원본을 다시 불러 보정 파이프라인을 재적용
async function openShot(shot) {
  try {
    const bmp = await createImageBitmap(shot.original);
    capCanvas.width = bmp.width; capCanvas.height = bmp.height;
    capCtx.drawImage(bmp, 0, 0);
    bmp.close?.();
    editLandmarks = shot.landmarks || null;
    shotLandmarks = shot.landmarks || null;
    shotCropX = 1; shotCropY = 1;
    shotMirror = shot.mirror ?? true;
    editFold = editLandmarks ? foldCapsules(editLandmarks) : null;
    if (editLandmarks) {
      maskCanvas.width = Math.max(2, Math.round(capCanvas.width / 5));
      maskCanvas.height = Math.max(2, Math.round(capCanvas.height / 5));
      buildFaceMask(maskCanvas.width, maskCanvas.height, editLandmarks);
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
      uploadWarp();
    }
    editOut.width = capCanvas.width; editOut.height = capCanvas.height;
    mode = "edit";
    enterEdit();
  } catch (e) {
    showToast("사진을 열 수 없어요");
  }
}

$("galleryBtn").addEventListener("click", openGallery);
$("galBack").addEventListener("click", async () => {
  revokeGallery();
  mode = "cam";
  $("galleryScreen").classList.remove("on");
  $("camScreen").classList.add("on");
  if (isFullNative()) await startFullNative();
});

function photoName() {
  const t = new Date();
  return "film-cam_" + t.getHours() + "시" + t.getMinutes() + "분" + t.getSeconds() + "초.jpg";
}

$("saveBtn").addEventListener("click", async () => {
  editRender();
  try {
    const blob = await canvasToBlob(editOut, 0.92);
    if (!blob) { showToast("이미지 생성 실패"); return; }
    showToast(await saveToDevice(blob, photoName()));
  } catch (e) {
    showToast("저장 실패: " + (e?.message || e));
  }
});

// 공유: 안드로이드 공유 시트로 카톡·인스타 등에 바로 전송
$("shareBtn").addEventListener("click", () => {
  editRender();
  editOut.toBlob(async (blob) => {
    if (!blob) { showToast("이미지 생성 실패"); return; }
    const file = new File([blob], photoName(), { type: "image/jpeg" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); }
      catch (e) { /* 사용자가 공유 시트를 닫음 — 정상 */ }
    } else {
      showToast("이 브라우저는 공유를 지원하지 않아요 — 저장 후 공유해 주세요");
    }
  }, "image/jpeg", 0.92);
});

/* ===== 설정 유지 (앱을 껐다 켜도 마지막 선택을 기억) ===== */
const SET_KEY = "filmcam.settings.v1";
function saveSettings() {
  try {
    localStorage.setItem(SET_KEY, JSON.stringify({
      skinAmt, blemAmt, eyeOn, contourOn, filmPreset, filmStrength,
      focal, ratio, ssChoice, wbCam, flashMode, camMode,
    }));
  } catch {}
}
function loadSettings() {
  let s = null;
  try { s = JSON.parse(localStorage.getItem(SET_KEY) || "null"); } catch {}
  if (!s) return;
  if (typeof s.skinAmt === "number") { skinAmt = s.skinAmt; skinOn = skinAmt > 0; }
  if (typeof s.blemAmt === "number") { blemAmt = s.blemAmt; blemishOn = blemAmt > 0; }
  if (typeof s.eyeOn === "boolean") eyeOn = s.eyeOn;
  if (typeof s.contourOn === "boolean") contourOn = s.contourOn;
  if (typeof s.filmPreset === "number") filmPreset = s.filmPreset;
  if (typeof s.filmStrength === "number") { filmStrength = s.filmStrength; filmOn = filmStrength > 0.005; }
  if (typeof s.focal === "number") focal = s.focal;
  if (typeof s.ratio === "string" && RATIOS[s.ratio]) ratio = s.ratio;
  if (typeof s.ssChoice === "string") ssChoice = s.ssChoice;
  if (typeof s.wbCam === "number") wbCam = s.wbCam;
  if (typeof s.flashMode === "string") flashMode = s.flashMode;
  if (["web", "system"].includes(s.camMode)) camMode = s.camMode;
  syncUIFromState();
}
function syncUIFromState() {
  const pick = (bar, attr, val) => {
    const el = $(bar); if (!el) return;
    el.querySelectorAll(".pill").forEach(b => b.classList.toggle("on", b.dataset[attr] == val));
  };
  pick("skinSeg", "skin", Math.round(skinAmt * 100));
  pick("ssBar", "ss", ssChoice);
  pick("ratioBar", "ratio", ratio);
  pick("focalBar", "focal", focal);
  pick("filmPresets", "fp", filmPreset);
  const wbKey = Object.keys(WB_CAM).find(k => WB_CAM[k] === wbCam) || "auto";
  pick("wbBar", "wbc", wbKey);
  $("blemAmt").value = Math.round(blemAmt * 100);
  $("blemAmtVal").textContent = Math.round(blemAmt * 100);
  $("filmStrength").value = Math.round(filmStrength * 100);
  $("filmStrengthVal").textContent = Math.round(filmStrength * 100);
  $("tgEye").classList.toggle("on", eyeOn); $("tgEye").textContent = eyeOn ? "켜짐" : "꺼짐";
  $("tgContour").classList.toggle("on", contourOn); $("tgContour").textContent = contourOn ? "켜짐" : "꺼짐";
  $("ssTag").textContent = ssChoice === "auto" ? "A" : ssChoice;
  $("ratioTag").textContent = ratio;
  $("focalTag").textContent = focal;
  $("filmTag").textContent = filmPreset + 1;
  $("flashTag").textContent = FLASH_TAG[flashMode] || "off";
  $("flashBtn").classList.toggle("on", flashMode !== "off");
  $("wbBtn").classList.toggle("on", wbCam !== 0);
  $("filmBtn").classList.toggle("on", filmOn);
}

// 화면 크기가 바뀌면 네이티브 프리뷰를 다시 맞춘다
let relayoutTimer = null;
window.addEventListener("resize", () => {
  if (isFullNative()) {
    clearTimeout(relayoutTimer);
    relayoutTimer = setTimeout(() => { relayoutFullNative().catch(() => {}); }, 300);
    return;
  }
  if (!isFullNative()) return;
  clearTimeout(relayoutTimer);
  relayoutTimer = setTimeout(() => { relayoutNative().catch(() => {}); }, 300);
});

// 앱이 백그라운드로 갔다 오면 프리뷰를 재개한다
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) { if (isFullNative()) await stopFullNative(); return; }
  if (mode === "cam" && isFullNative()) {
    try { await startFullNative(); } catch { await startStream(); }
  }
});

/* ===== 앱 내부 갤러리 (기기 저장소에 남는 임시 보관함) ===== */
const DB_NAME = "filmcam", STORE = "shots";
let dbP = null;
function db() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    const rq = indexedDB.open(DB_NAME, 1);
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains(STORE))
        rq.result.createObjectStore(STORE, { keyPath: "id" });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbP;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => res(r?.result);
    t.onerror = () => rej(t.error);
  });
}
async function galleryAdd(shot) { return tx("readwrite", s => s.put(shot)); }
async function galleryAll() {
  const d = await db();
  return new Promise((res, rej) => {
    const out = [];
    const t = d.transaction(STORE, "readonly");
    t.objectStore(STORE).openCursor(null, "prev").onsuccess = (e) => {
      const c = e.target.result;
      if (c) { out.push(c.value); c.continue(); } else res(out);
    };
    t.onerror = () => rej(t.error);
  });
}
async function galleryDel(id) { return tx("readwrite", s => s.delete(id)); }

function canvasToBlob(cv, q) {
  return new Promise(r => cv.toBlob(b => r(b), "image/jpeg", q));
}

/* ===== 기기에 저장 (Capacitor 네이티브 경로) ===== */
async function saveToDevice(blob, name) {
  const FS = window.Capacitor?.Plugins?.Filesystem;
  if (FS) {
    const b64 = await new Promise(r => {
      const fr = new FileReader();
      fr.onload = () => r(String(fr.result).split(",")[1]);
      fr.readAsDataURL(blob);
    });
    await FS.writeFile({ path: name, data: b64, directory: "DOCUMENTS", recursive: true });
    return "기기에 저장했어요 (문서 폴더)";
  }
  // 웹 폴백
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return "저장했어요";
}

/* ===== 네이티브 카메라 (Camera2 기반 플러그인) =====
   WebView의 getUserMedia는 압축·축소된 스트림만 주고 초점 제어도 막혀 있다.
   네이티브 프리뷰는 WebView '뒤'에 그려지므로, 미리보기 영역만 투명하게 뚫어준다.
   실시간 보정을 후보정으로 옮겼기 때문에 프레임을 JS로 가져올 필요가 없어졌다. */
let started = false;
// 완전 네이티브 모드: CameraX 레이어가 미리보기를 그리고 있는 상태
function isFullNative() { return camMode === "fullnative"; }
let camMode = "web";   // "web" | "system"
// 미리보기가 놓일 화면상의 사각형 (선택한 비율에 맞춰 레터박스)
// 네이티브 레이어는 이 좌표로 정확히 배치된다
function stageRect() {
  const el = document.querySelector('.stagewrap');
  const r = el.getBoundingClientRect();
  const target = RATIOS[ratio];
  let w = r.width, h = r.height;
  if (w / h > target) w = h * target; else h = w / target;
  return {
    x: Math.round(r.left + (r.width - w) / 2),
    y: Math.round(r.top + (r.height - h) / 2),
    width: Math.round(w), height: Math.round(h),
  };
}

function FilmCam() { return window.Capacitor?.Plugins?.FilmCamera || null; }

// 필름 프리셋을 네이티브 GPU로 전달 (신호만 보내고 연산은 네이티브가 수행)
async function pushFilmToNative() {
  const fc = FilmCam();
  if (!fc || camMode !== "fullnative") return;
  const p = FILM_PRESETS[filmPreset] || FILM_PRESETS[0];
  try {
    await fc.setFilm({
      strength: filmOn ? filmStrength : 0,
      toneScale: p.tone[0], toneLift: p.tone[1], sat: p.sat,
      hiR: p.hi[0], hiG: p.hi[1], hiB: p.hi[2],
      shR: p.sh[0], shG: p.sh[1], shB: p.sh[2],
      grain: p.grain, vig: p.vig, wb: wbCam,
    });
  } catch (e) { /* 신호 전달 실패는 화면만 영향 */ }
}

// 미리보기 영역이 바뀌면 네이티브 레이어도 같은 자리로 옮긴다
async function relayoutFullNative() {
  const fc = FilmCam();
  if (!fc || camMode !== "fullnative") return;
  const r = stageRect();
  if (!(r.width > 20 && r.height > 20)) return;
  try { await fc.setLayout({ x: r.x, y: r.y, width: r.width, height: r.height }); }
  catch { try { await startFullNative(); } catch {} }
}

async function startFullNative() {
  const fc = FilmCam();
  if (!fc) return false;
  let r = stageRect();
  for (let i = 0; i < 12 && !(r.width > 20 && r.height > 20); i++) {
    await new Promise(res => requestAnimationFrame(() => setTimeout(res, 30)));
    r = stageRect();
  }
  if (!(r.width > 20 && r.height > 20)) return false;
  if (!(await ensureCameraPermission())) { showToast("카메라 권한이 필요해요"); return false; }
  try {
    await fc.start({ x: r.x, y: r.y, width: r.width, height: r.height,
                     position: facing === "user" ? "front" : "rear" });
    document.body.classList.add("fullnative");
    await pushFilmToNative();
    return true;
  } catch (e) {
    showToast("네이티브 레이어 시작 실패: " + String(e?.message || e).slice(0, 40));
    document.body.classList.remove("fullnative");
    return false;
  }
}

async function stopFullNative() {
  const fc = FilmCam();
  document.body.classList.remove("fullnative");
  if (!fc) return;
  try { await fc.stop(); } catch {}
}

// 탭 초점 — 이 레이어를 만든 가장 큰 이유
async function nativeFocus(nx, ny) {
  const fc = FilmCam();
  if (!fc || camMode !== "fullnative") return false;
  try { await fc.focus({ x: nx, y: ny }); return true; } catch { return false; }
}

function SysCam() { return window.Capacitor?.Plugins?.Camera || null; }

// 시스템 카메라로 한 장 찍어 이미지로 받아온다
async function shootWithSystemCamera() {
  const cam = SysCam();
  if (!cam) throw new Error("시스템 카메라를 쓸 수 없어요");
  const photo = await cam.getPhoto({
    quality: 95,
    resultType: "base64",
    source: "CAMERA",
    direction: facing === "user" ? "FRONT" : "REAR",
    correctOrientation: true,
    saveToGallery: false,
    allowEditing: false,
  });
  if (!photo?.base64String) throw new Error("사진을 받지 못했어요");
  const img = new Image();
  await new Promise((ok, no) => {
    img.onload = ok;
    img.onerror = () => no(new Error("사진을 읽을 수 없어요"));
    img.src = "data:image/jpeg;base64," + photo.base64String;
  });
  return img;
}

function FilmCam() { return window.Capacitor?.Plugins?.FilmCamera || null; }


// 네이티브 카메라가 기기에서 앱을 죽이는 경우를 대비한 자가복구 장치.
// 시도 직전에 표시를 남기고, 성공하면 지운다.
// 앱이 죽으면 표시가 남아 있으므로 다음 실행에서 자동으로 웹 방식으로 되돌린다.
const NATIVE_FLAG = "filmcam.nativeTry";
let nativeBlocked = false;
try { nativeBlocked = !!localStorage.getItem(NATIVE_FLAG); } catch {}

function isNativeApp() {
  try { return !!(window.Capacitor?.isNativePlatform?.() ?? window.Capacitor?.isNative); }
  catch { return false; }
}

// 네이티브 카메라를 열기 전에 권한을 먼저 확보한다.
// 권한 없이 네이티브 카메라를 열면 기기에 따라 앱이 즉시 종료된다.
async function ensureCameraPermission() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    s.getTracks().forEach(t => t.stop());
    await new Promise(r => setTimeout(r, 250));   // 기기가 카메라를 완전히 놓을 시간
    return true;
  } catch (e) {
    return false;
  }
}



let nativeZoom = 1;
// 화각: 렌즈 줌으로 당길 수 있는 만큼 당기고, 모자란 만큼만 촬영 후 크롭한다
async function applyNativeZoom() {
  const fc = FilmCam();
  if (!fc || camMode !== "fullnative") { nativeZoom = 1; return; }
  try {
    const res = await fc.setZoom({ ratio: focal / 28 });
    nativeZoom = res?.zoom || 1;
  } catch { nativeZoom = 1; }
}



// 네이티브 프리뷰를 현재 비율/위치에 다시 맞춘다


// 네이티브 촬영: 센서 원본 JPEG을 받아 캔버스로 옮긴다

/* ===== 카메라 시작 / 전환 ===== */
async function startStream() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    await new Promise(r => setTimeout(r, 120));   // 기기가 카메라를 놓을 시간
  }
  // 제약 조건을 단계적으로 완화하며 시도 — 기기가 특정 조합을 거부해도 전환 성공
  // 센서가 주는 만큼 최대한 크게 요청 → 실패하면 단계적으로 낮춘다
  const tries = [
    { video: { facingMode: { exact: facing }, width: { ideal: 2160 }, height: { ideal: 2880 } }, audio: false },
    { video: { facingMode: { exact: facing }, width: { ideal: 1440 }, height: { ideal: 1920 } }, audio: false },
    { video: { facingMode: { exact: facing }, width: { ideal: 1080 }, height: { ideal: 1440 } }, audio: false },
    { video: { facingMode: facing, width: { ideal: 1440 }, height: { ideal: 1920 } }, audio: false },
    { video: { facingMode: facing }, audio: false },
    { video: true, audio: false },
  ];
  let stream = null, lastErr = null;
  for (const c of tries) {
    try { stream = await navigator.mediaDevices.getUserMedia(c); break; }
    catch (e) { lastErr = e; }
  }
  if (!stream) throw lastErr || new Error("카메라를 열 수 없어요");
  video.srcObject = stream;
  await video.play();
  // 정지 사진 전용 고해상도 경로: 프리뷰 스트림이 아니라 센서 원본을 받아온다
  imageCapture = null;
  try {
    const t0 = track();
    if (window.ImageCapture && t0) imageCapture = new ImageCapture(t0);
  } catch { imageCapture = null; }
  reportCaps();

  prevW = Math.round(video.videoWidth * PREVIEW_SCALE);
  prevH = Math.round(video.videoHeight * PREVIEW_SCALE);
  glCanvas.width = prevW; glCanvas.height = prevH;
  maskCanvas.width = warpCanvas.width = Math.round(video.videoWidth / 5);
  maskCanvas.height = warpCanvas.height = Math.round(video.videoHeight / 5);
  glOK = initGLOnce();
  if (glOK) {
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    warpCtx.fillStyle = "rgb(128,128,0)";   // 중립 변위 (이동 없음)
    warpCtx.fillRect(0, 0, warpCanvas.width, warpCanvas.height);
    gl.activeTexture(gl.TEXTURE2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, warpCanvas);
  }
  lastLandmarks = null; maskDirty = false;
  tryFocus("continuous");
  await applyFocal();
  await applyShutter();
}

$("startBtn").addEventListener("click", async () => {
  loadSettings();
  const btn = $("startBtn");
  btn.disabled = true; btn.textContent = "준비 중…";
  try {
    // 얼굴 인식 모델은 인터넷에서 받아온다. 실패해도 카메라는 켜져야 하므로 분리한다.
    try {
      const fileset = await FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
      );
      const mkOpts = (delegate) => ({
        baseOptions: {
          modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          delegate,
        },
        runningMode: "IMAGE", numFaces: 1,
      });
      try {
        landmarker = await FaceLandmarker.createFromOptions(fileset, mkOpts("GPU"));
      } catch (e) {
        // GPU 델리게이트를 지원하지 않는 기기가 있다
        landmarker = await FaceLandmarker.createFromOptions(fileset, mkOpts("CPU"));
      }
    } catch (e) {
      landmarker = null;
      showToast("얼굴 인식 모듈을 불러오지 못했어요 (인터넷 확인) — 촬영은 가능해요");
    }
    // 카메라는 항상 검증된 웹 방식으로 켠다.
    // 네이티브는 설정에서 사용자가 직접 켤 때만 시도한다 (자동 시도는 앱이 못 켜질 위험).
    await startStream();
    if (!glOK) showToast("이 기기는 GPU 처리를 지원하지 않아요");
    $("placeholder").style.display = "none";
    $("camScreen").classList.add("live");
    $("status").style.display = "flex";
    out.style.display = "block";
    started = true;
    $("camTop").style.display = "flex";
    $("camBottom").style.display = "flex";
    $("shotBtn").disabled = false;
    requestAnimationFrame(loop);
  } catch (err) {
    btn.disabled = false; btn.textContent = "카메라 켜기";
    alert("카메라를 켤 수 없어요.\n브라우저의 카메라 권한을 확인해 주세요.\n\n" + err.message);
  }
  finally {
    const b = $("startBtn");
    if (b) { b.disabled = false; b.textContent = "카메라 켜기"; }
  }
});

$("flipBtn").addEventListener("click", async () => {
  facing = (facing === "user") ? "environment" : "user";
  if (isFullNative()) {
    try {
      await FilmCam().flip();
      await pushFilmToNative();
      await applyNativeZoom();      // 전환 후 색감·줌을 다시 적용해야 한다
    } catch { await startFullNative(); }
    saveSettings();
    return;
  }
  try { await startStream(); }
  catch (err) {
    facing = (facing === "user") ? "environment" : "user";
    await startStream().catch(() => {});
    showToast("카메라 전환 실패");
  }
});

/* ===== 탭 초점 ===== */
$("camScreen").addEventListener("click", async (e) => {
  if (mode !== "cam") return;
  // 네이티브 모드에서는 미리보기가 WebView 뒤에 있어 out을 기준으로 삼을 수 없다.
  // 화면 좌표를 그대로 넘기고 회전·좌표 변환은 CameraX에 맡긴다.
  if (isFullNative()) {
    const r = stageRect();
    const x = e.clientX - r.x, y = e.clientY - r.y;
    if (x < 0 || y < 0 || x > r.width || y > r.height) return;
    focusRing.style.left = e.clientX + "px";
    focusRing.style.top = e.clientY + "px";
    focusRing.classList.remove("go");
    void focusRing.offsetWidth;
    focusRing.classList.add("go");
    try { await FilmCam().focus({ x, y, viewWidth: r.width, viewHeight: r.height }); }
    catch { showToast("초점을 맞추지 못했어요"); }
    return;
  }
  if (e.target !== out) return;
  focusRing.style.left = e.clientX + "px";
  focusRing.style.top = e.clientY + "px";
  focusRing.classList.remove("go");
  void focusRing.offsetWidth;
  focusRing.classList.add("go");
  // 탭 위치를 카메라 프레임 기준 0~1 좌표로 변환 (미러링 반영)
  const r = out.getBoundingClientRect();
  let nx = (e.clientX - r.left) / r.width;
  const ny = (e.clientY - r.top) / r.height;
  if (facing === "user") nx = 1 - nx;
  const ok = tryFocus("single-shot", Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny)));
  if (!ok) showToast("이 기기는 수동 초점을 지원하지 않아요");
  setTimeout(() => tryFocus("continuous"), 1200);
});

// 상태 배지를 탭하면 내부 상태를 보여줌 (원격 디버깅용)
statusEl.addEventListener("click", () => {
  showToast(`GPU:${glOK ? "OK" : "실패"} 얼굴:${lastLandmarks ? "O" : "X"} ` +
    `피부결:${Math.round(skinAmt * 100)} 잡티:${Math.round(blemAmt * 100)} ` +
    `윤곽:${contourOn ? "on" : "off"} 필름:${filmOn ? Math.round(filmStrength * 100) : "off"}`);
});

/* ===== 백그라운드 복귀 · GPU 손실 복구 ===== */
// 앱이 뒤로 갔다 오면 카메라 트랙이 끊기거나 영상이 멈춘다 → 상태를 점검하고 되살림
async function ensureAlive() {
  if (mode !== "cam" || !video.srcObject) return;
  const t = track();
  if (!t || t.readyState === "ended") {
    try { await startStream(); showToast("카메라를 다시 연결했어요"); } catch { showToast("카메라 재연결 실패 — 앱을 다시 열어주세요"); }
    return;
  }
  if (video.paused) video.play().catch(() => {});
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") setTimeout(ensureAlive, 250);
});
window.addEventListener("focus", () => setTimeout(ensureAlive, 250));
window.addEventListener("pageshow", () => setTimeout(ensureAlive, 250));

// GPU 컨텍스트가 날아가면(백그라운드 전환 시 흔함) 재초기화
glCanvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault(); glReady = false; glOK = false;
});
glCanvas.addEventListener("webglcontextrestored", () => {
  glOK = initGLOnce();
  if (glOK && video.videoWidth) { maskDirty = true; showToast("그래픽을 복구했어요"); }
});

/* ===== 메인 루프 ===== */
let frameCount = 0, lastSeen = 0, maskDirty = false, lastRenderTs = 0;

function loop(ts) {
  requestAnimationFrame(loop);
  if (mode !== "cam") return;
  if (!isFullNative() && video.readyState < 2) return;
  if (ts - lastRenderTs < 31) return;   // 30fps 상한
  lastRenderTs = ts;

  // 보정은 촬영 후에 하므로 프리뷰에서는 얼굴 인식을 돌리지 않는다.
  // 그만큼 프레임 처리가 가벼워져 미리보기 화질과 반응이 좋아진다.
  statusEl.classList.add("tracking");
  statusText.textContent = "촬영 준비됨 · " + BUILD + (camMode === "system" ? " · 시스템카메라" : camMode === "fullnative" ? " · 완전네이티브" : camMode === "native" ? " · 프리뷰" : " · 웹");

  if (isFullNative()) return;   // 네이티브 프리뷰는 화면 뒤에서 직접 그려진다

  // 프리뷰 렌더 (화각 + 화면 비율 크롭)
  // 보정(피부·잡티)은 촬영 후에 하지만, 색감과 그레인은 실시간으로 보여준다.
  // 필름 룩이 이 앱의 정체성이라 찍기 전에 결과를 가늠할 수 있어야 한다.
  // 얼굴 관련 연산을 모두 끄고 색 변환만 통과시켜 프리뷰 부담을 최소화한다.
  let src = video;
  const srcW = video.videoWidth, srcH = video.videoHeight;
  if (glOK && (filmOn || wbCam !== 0)) {
    const gw = Math.max(2, Math.round(srcW * PREVIEW_SCALE));
    const gh = Math.max(2, Math.round(srcH * PREVIEW_SCALE));
    if (glCanvas.width !== gw || glCanvas.height !== gh) {
      glCanvas.width = gw; glCanvas.height = gh;
    }
    drawGL(video, {
      srcW: gw, srcH: gh,
      film: filmOn ? filmStrength : 0,
      fm: FILM_PRESETS[filmPreset],
      wb: wbCam,
      lens: LENS_MAP[focal],
      time: (ts % 10000) / 10000,     // 그레인이 프레임마다 살아 움직이도록
    });
    src = glCanvas;
  }
  const { sx, sy, sw, sh } = cropRect(srcW, srcH);
  const k = (src === glCanvas) ? glCanvas.width / srcW : 1;   // 프리뷰 축척 보정
  const ow = Math.round(sw), oh = Math.round(sh);
  if (out.width !== ow || out.height !== oh) { out.width = ow; out.height = oh; }
  ctx.save();
  if (facing === "user") { ctx.translate(ow, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src, sx * k, sy * k, sw * k, sh * k, 0, 0, ow, oh);
  ctx.restore();
}

/* ===== 얼굴 마스크 ===== */
function buildFaceMaskIfNeeded() {
  if (!maskDirty || !lastLandmarks) return;
  buildFaceMask(maskCanvas.width, maskCanvas.height, lastLandmarks);
  gl.activeTexture(gl.TEXTURE1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
  if (contourOn) {
    computeWarpMap(warpCanvas.width, warpCanvas.height);
    gl.activeTexture(gl.TEXTURE2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, warpCanvas);
  }
  maskDirty = false;
}

// 눈 흰자 폴리곤 (MediaPipe 눈 컨투어)
const EYE_L = [263,249,390,373,374,380,381,382,362,398,384,385,386,387,388,466];
const EYE_R = [33,7,163,144,145,153,154,155,133,173,157,158,159,160,161,246];

// 마스크 채널 설계: A(+R)=피부 영역, G=눈 흰자 영역
function buildFaceMask(w, h, L) {
  maskCtx.clearRect(0, 0, w, h);
  maskCtx.save();
  maskCtx.filter = "blur(" + w * 0.015 + "px)";
  maskCtx.fillStyle = "rgb(255,0,0)";
  maskCtx.beginPath();
  FACE_OVAL.forEach((idx, i) => {
    const p = L[idx];
    i === 0 ? maskCtx.moveTo(p.x * w, p.y * h) : maskCtx.lineTo(p.x * w, p.y * h);
  });
  maskCtx.closePath();
  maskCtx.fill();
  maskCtx.restore();

  const faceW = Math.abs(L[454].x - L[234].x) * w;
  const nTop = L[168], nBot = L[2];
  const ncx = (nTop.x + nBot.x) / 2 * w, ncy = (nTop.y + nBot.y) / 2 * h;
  const ndx = (nBot.x - nTop.x) * w, ndy = (nBot.y - nTop.y) * h;
  const nLen = Math.hypot(ndx, ndy);
  const nAng = Math.atan2(ndy, ndx) - Math.PI / 2;
  maskCtx.save();
  maskCtx.filter = "blur(" + w * 0.01 + "px)";
  maskCtx.fillStyle = "rgb(255,0,0)";
  maskCtx.beginPath();
  maskCtx.ellipse(ncx, ncy, faceW * 0.14, nLen * 0.8, nAng, 0, Math.PI * 2);
  maskCtx.fill();
  maskCtx.restore();

  // 눈·눈썹·입 제외
  maskCtx.save();
  maskCtx.globalCompositeOperation = "destination-out";
  maskCtx.filter = "blur(" + faceW * 0.02 + "px)";
  maskCtx.fillStyle = "#fff";
  carveEllipse(L[159], L[145], faceW * 0.15, faceW * 0.07, w, h);
  carveEllipse(L[386], L[374], faceW * 0.15, faceW * 0.07, w, h);
  carveEllipse(L[105], L[105], faceW * 0.16, faceW * 0.045, w, h);
  carveEllipse(L[334], L[334], faceW * 0.16, faceW * 0.045, w, h);
  carveEllipse(L[13],  L[14],  faceW * 0.22, faceW * 0.11, w, h);
  // 콧구멍: '사방보다 어두운 함몰'의 대표 사례라 잡티 탐지가 오인하기 쉬움 → 원천 제외
  for (const corner of [L[61], L[291]]) {
    const nx = L[2].x + (corner.x - L[2].x) * 0.30;
    const ny = L[2].y + (L[1].y - L[2].y) * 0.30;
    const p = { x: nx, y: ny };
    carveEllipse(p, p, faceW * 0.065, faceW * 0.050, w, h);
  }
  maskCtx.restore();

  // 콧볼 골(alar crease)·팔자 시작부 → B 채널 = 잡티 탐지 제외.
  // 이 골들은 '지워야 할 잡티'가 아니라 '남겨야 할 정상 굴곡'이다.
  // (주름 완화는 A 채널을 쓰므로 여기서 계속 동작한다)
  maskCtx.save();
  maskCtx.filter = "blur(" + faceW * 0.03 + "px)";
  maskCtx.fillStyle = "rgb(0,0,255)";
  maskCtx.strokeStyle = "rgb(0,0,255)";
  maskCtx.lineCap = "round";
  maskCtx.lineWidth = faceW * 0.09;
  // 랜드마크 번호에 의존하지 않고 코 기준점(L[2])과 얼굴 폭으로 위치를 잡는다
  const nbx = L[2].x * w, nby = L[2].y * h;
  for (const side of [-1, 1]) {
    const ax = nbx + side * faceW * 0.105 * w / 1;
    const ay = nby - faceW * 0.02 * h / 1;
    maskCtx.beginPath();
    maskCtx.ellipse(ax, ay, faceW * w * 0.085, faceW * w * 0.075, 0, 0, Math.PI * 2);
    maskCtx.fill();
    // 콧볼에서 입꼬리 쪽으로 이어지는 골도 함께 제외
    const corner = side < 0 ? L[61] : L[291];
    if (corner) {
      maskCtx.beginPath();
      maskCtx.moveTo(ax, ay);
      maskCtx.lineTo(ax + (corner.x * w - ax) * 0.40, ay + (corner.y * h - ay) * 0.40);
      maskCtx.stroke();
    }
  }
  maskCtx.restore();

  // 눈 흰자 → G 채널 (눈 보정 전용 영역)
  maskCtx.save();
  maskCtx.filter = "blur(" + w * 0.006 + "px)";
  maskCtx.fillStyle = "rgb(0,255,0)";
  for (const ring of [EYE_L, EYE_R]) {
    maskCtx.beginPath();
    ring.forEach((idx, i) => {
      const p = L[idx];
      i === 0 ? maskCtx.moveTo(p.x * w, p.y * h) : maskCtx.lineTo(p.x * w, p.y * h);
    });
    maskCtx.closePath();
    maskCtx.fill();
  }
  maskCtx.restore();
}

function carveEllipse(top, bottom, rx, ry, w, h) {
  const cx = (top.x + bottom.x) / 2 * w;
  const cy = (top.y + bottom.y) / 2 * h;
  maskCtx.beginPath();
  maskCtx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
  maskCtx.fill();
}

/* ===== 촬영 ===== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

$("shotBtn").addEventListener("click", async () => {
  closePops(null);
  if (flashMode === "screen") {
    screenFlash.classList.add("on");      // 전면: 화면 전체를 흰색으로
    await sleep(420);
    await captureHighRes();
    await sleep(140);
    screenFlash.classList.remove("on");
  } else if (flashMode === "torch") {
    const ok = await setTorch(true);      // 후면: LED 라이트
    await sleep(ok ? 450 : 0);
    await captureHighRes();
    if (ok) { await sleep(120); setTorch(false); }
  } else {
    await captureHighRes();
  }
});


// 네이티브 카메라를 쓸 수 없는 빌드면 버튼을 비활성으로 보여준다
(function initCamModeBtn() {
  const b = $("tgCamMode");
  if (!b) return;
  if (!SysCam()) { b.textContent = "웹"; b.style.opacity = "0.45"; return; }
  b.textContent = camMode === "system" ? "시스템" : "웹";
  b.classList.toggle("on", camMode !== "web");
})();

// 앱을 다시 열어도 갤러리 썸네일과 설정이 남아있게 한다
loadSettings();
refreshGalleryThumb();


// 테스트 훅
if (typeof window !== "undefined") {
  window.__testStart = () => startStream();
  window.__testCapture = () => captureHighRes();
  window.__testOpenShot = (s) => openShot(s);
  window.__testFocus = (x,y) => tryFocus("single-shot", x, y);
  window.__testLoop = (ts) => { mode = "cam"; loop(ts); };
  window.__testGalleryAll = () => galleryAll();
}
