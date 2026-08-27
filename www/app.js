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
let landmarker = null, lastLandmarks = null;

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
const SLIDERS = ["wrinkle","film","sharp","contrast","sat","rGain","gGain","bGain"];
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
});
$("blemAmt").addEventListener("input", (e) => {
  blemAmt = e.target.value / 100;
  $("blemAmtVal").textContent = e.target.value;
});
$("filmStrength").addEventListener("input", (e) => {
  filmStrength = e.target.value / 100;
  $("filmStrengthVal").textContent = e.target.value;
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
});
$("tgEye").addEventListener("click", (e) => {
  eyeOn = !eyeOn;
  e.target.classList.toggle("on", eyeOn);
  e.target.textContent = eyeOn ? "켜짐" : "꺼짐";
});
$("tgContour").addEventListener("click", (e) => {
  contourOn = !contourOn;
  e.target.classList.toggle("on", contourOn);
  e.target.textContent = contourOn ? "켜짐" : "꺼짐";
});

// 필름 on/off는 아이콘 길게 대신 이중 탭 없이: 세기 0이면 자동 off
$("filmStrength").addEventListener("input", (e) => {
  filmStrength = e.target.value / 100;
  $("filmStrengthVal").textContent = e.target.value;
  filmOn = filmStrength > 0.005;
  $("filmBtn").classList.toggle("on", filmOn);
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
});
function hasTorch() {
  try { return !!track()?.getCapabilities?.().torch; } catch { return false; }
}
async function setTorch(on) {
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
});
$("ratioBar").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("ratioBar").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); ratio = b.dataset.ratio;
  $("ratioTag").textContent = ratio;
});
$("focalBar").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("focalBar").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); focal = Number(b.dataset.focal);
  $("focalTag").textContent = focal;
  applyFocal();
});
$("filmPresets").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("filmPresets").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); filmPreset = Number(b.dataset.fp);
  $("filmTag").textContent = filmPreset + 1;
});
$("wbBar").addEventListener("click", (e) => {
  const b = e.target.closest(".pill"); if (!b) return;
  $("wbBar").querySelectorAll(".pill").forEach(x => x.classList.remove("on"));
  b.classList.add("on"); wbCam = WB_CAM[b.dataset.wbc];
  $("wbBtn").classList.toggle("on", wbCam !== 0);
});

// 화면 비율
const RATIOS = { "1:1": 1, "3:4": 3 / 4, "9:16": 9 / 16 };
let ratio = "3:4";
function cropRect(sw0, sh0) {
  const cf = hwZoom ? 1 : 28 / focal;
  let sw = sw0 * cf, sh = sh0 * cf;
  const target = RATIOS[ratio];
  if (sw / sh > target) sw = sh * target; else sh = sw / target;
  return { sx: (sw0 - sw) / 2, sy: (sh0 - sh) / 2, sw, sh };
}

/* ===== 카메라 하드웨어 제어 ===== */
function track() { return video.srcObject?.getVideoTracks()[0]; }

async function applyFocal() {
  hwZoom = false;
  const t = track(); const caps = t?.getCapabilities?.();
  if (caps && caps.zoom) {
    const z = Math.min(caps.zoom.max, Math.max(caps.zoom.min, caps.zoom.min * (focal / 28)));
    try { await t.applyConstraints({ advanced: [{ zoom: z }] }); hwZoom = true; } catch {}
  }
}

async function applyShutter() {
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
  const parts = [video.videoWidth + "×" + video.videoHeight];
  parts.push(caps.focusMode ? "초점 O" : "초점 X");
  parts.push(caps.torch ? "LED O" : "LED X");
  if (imageCapture) parts.push("고화질 촬영 O");
  showToast(parts.join(" · "));
}

function tryFocus(m, nx, ny) {
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
  t.applyConstraints({ advanced: [adv] }).catch(() => {});
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
      float th = 0.045 - 0.014 * uBlemish;
      float spot = max(smoothstep(th * 0.5, th, pit),
                       smoothstep(th * 0.8, th * 1.6, redPit) * 0.7);
      spot *= smoothstep(th * 0.20, th * 0.55, roundness);  // 선형 구조(주름·골) 배제
      spot *= 1.0 - mk.b;                                   // 해부학적 제외 구역(콧볼 골 등)
      spot *= smoothstep(0.008, 0.030, lumA - lumC);       // 국소성 (보조 게이트)
      spot *= 1.0 - smoothstep(0.26, 0.42, lumF - lumC);   // 진한 점(Mole) 보존
      spot *= smoothstep(0.12, 0.28, c.g);                 // 극암부(머리카락 등) 보호
      spot *= smoothstep(0.10, 0.22, minI);                // 검은 구멍 인접(콧구멍 테두리) 보호
      spot *= 1.0 - smoothstep(0.20, 0.30, pit);           // 너무 깊은 함몰은 구멍이지 잡티가 아님
      float glare = smoothstep(th * 0.5, th, lumC - maxF) * 0.55 * uBlemish * (1.0 - mk.b);   // 사방보다 밝은 반점만
      spot = min(spot * 0.9 * uBlemish, 0.9);

      // 조명 결함 복구: 밝기 '배율'만 조정 (Dodge/Burn) — 색·질감 불변, 상한 존재.
      // 덧셈이 아닌 제한된 곱셈이라 주변 구조물이 섞여 들어올 수 없다.
      float liftL = clamp(lumF - lumC, 0.0, 0.12);         // 결함 깊이 (상한)
      float dodge = min(1.0 + (liftL / max(lumC, 0.05)) * spot, 1.22);
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
   "uSat","uRGB","uWB","uFilm","uTime","uFmTone","uFmSat","uFmHi","uFmSh","uFmGrain","uFmVig"]
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
  const L = lastLandmarks;
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
function camPreviewFrame() {
  if (!glOK) return video;
  if (glCanvas.width !== prevW || glCanvas.height !== prevH) {
    glCanvas.width = prevW; glCanvas.height = prevH;   // 촬영 후 프리뷰 크기 복귀
  }
  buildFaceMaskIfNeeded();
  const faceW = lastLandmarks ? Math.abs(lastLandmarks[454].x - lastLandmarks[234].x) * video.videoWidth : 0;
  drawGL(video, {
    srcW: video.videoWidth, srcH: video.videoHeight,
    radius: Math.max(2.5, faceW * 0.030),
    smooth: (skinOn && lastLandmarks) ? skinAmt : 0,
    blemish: (blemishOn && lastLandmarks) ? blemAmt : 0,
    eye: (eyeOn && lastLandmarks) ? 0.55 : 0,
    film: filmOn ? filmStrength : 0,
    fm: FILM_PRESETS[filmPreset],
    wb: wbCam,
    lens: LENS_MAP[focal],
    warp: contourOn && !!lastLandmarks,
    time: (performance.now() % 10000) / 10000,
  });
  return glCanvas;
}

/* ===== 고해상도 촬영 → 편집 화면 ===== */
async function captureHighRes() {
  // 가능하면 프리뷰 스트림이 아니라 '센서 원본 정지 사진'을 받아 처리한다.
  // 프리뷰는 대역폭 때문에 압축·축소되지만, 정지 사진은 센서 해상도 그대로다.
  let src = video, sw0 = video.videoWidth, sh0 = video.videoHeight;
  if (imageCapture) {
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
  drawGL(src, {
    srcW: sw0, srcH: sh0,
    radius: Math.max(2.5, faceW * 0.030),
    smooth: (skinOn && lastLandmarks) ? skinAmt : 0,
    blemish: (blemishOn && lastLandmarks) ? blemAmt : 0,
    eye: (eyeOn && lastLandmarks) ? 0.55 : 0,
    lens: LENS_MAP[focal],
    warp: contourOn && !!lastLandmarks,
    film: filmOn ? filmStrength : 0,               // 필름 프리셋을 사진에 직접 굽기
    fm: FILM_PRESETS[filmPreset],
    wb: wbCam,
    time: (performance.now() % 10000) / 10000,     // 그레인은 사진에 고정
  });

  // 미러링 + 화각 크롭을 구워서 편집 원본 확정
  const { sx, sy, sw, sh } = cropRect(sw0, sh0);
  const cw = Math.round(sw), ch = Math.round(sh);
  capCanvas.width = cw; capCanvas.height = ch;
  capCtx.save();
  if (facing === "user") { capCtx.translate(cw, 0); capCtx.scale(-1, 1); }
  capCtx.drawImage(glOK ? glCanvas : video, sx, sy, sw, sh, 0, 0, cw, ch);
  capCtx.restore();

  shotLandmarks = lastLandmarks;
  shotCropX = sw / sw0;
  shotCropY = sh / sh0;
  shotMirror = facing === "user";
  enterEdit();
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
  mode = "edit";
  $("camScreen").classList.remove("on");
  $("editScreen").classList.add("on");
  editOut.width = capCanvas.width;
  editOut.height = capCanvas.height;

  // 팔자 골 스캔: 정지 사진 재인식을 먼저 시도하고, 실패하면 촬영 순간 랜드마크로 대체
  editFold = null;
  let EL = null;
  try {
    const r = landmarker.detectForVideo(capCanvas, performance.now() + 1);
    EL = r.faceLandmarks?.[0] ?? null;
  } catch (e) { EL = null; }
  if (!EL) EL = landmarksForCapture();
  if (EL) {
    try {
      editFold = foldCapsules(EL);
      // 찍힌 사진 기준의 마스크로 교체 (주름의 입술·눈썹 차단 게이트가 이 마스크를 씀)
      maskCanvas.width = Math.max(2, Math.round(capCanvas.width / 5));
      maskCanvas.height = Math.max(2, Math.round(capCanvas.height / 5));
      buildFaceMask(maskCanvas.width, maskCanvas.height, EL);
      gl.activeTexture(gl.TEXTURE1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    } catch (e) { editFold = null; }
  }
  const wr = $("wrinkle").closest(".row");
  if (wr) wr.style.opacity = editFold ? "1" : "0.4";
  if (!editFold) showToast("얼굴을 찾지 못해 주름 완화를 쓸 수 없어요");
  editRender();
}

function editRender() {
  if (!glOK) { editCtx.drawImage(capCanvas, 0, 0); return; }
  glCanvas.width = capCanvas.width;
  glCanvas.height = capCanvas.height;
  drawGL(capCanvas, {
    srcW: capCanvas.width, srcH: capCanvas.height,
    film: S.film.value / 100,
    fm: FILM_PRESETS[filmPreset],
    fold: editFold,
    wrinkle: S.wrinkle.value / 100,
    sharp: S.sharp.value / 100 * 1.1,
    contrast: S.contrast.value / 100,
    sat: S.sat.value / 100,
    rgb: [S.rGain.value / 100, S.gGain.value / 100, S.bGain.value / 100],
    wb: wbValue,
  });
  editCtx.drawImage(glCanvas, 0, 0);
}

$("retakeBtn").addEventListener("click", () => {
  if (video.videoWidth) {
    maskCanvas.width = warpCanvas.width;
    maskCanvas.height = warpCanvas.height;
    maskDirty = true;
  }
  mode = "cam";
  $("editScreen").classList.remove("on");
  $("camScreen").classList.add("on");
});

function photoName() {
  const t = new Date();
  return "film-cam_" + t.getHours() + "시" + t.getMinutes() + "분" + t.getSeconds() + "초.jpg";
}

$("saveBtn").addEventListener("click", () => {
  editRender();
  const a = document.createElement("a");
  a.href = editOut.toDataURL("image/jpeg", 0.92);   // 고품질 JPEG (PNG 대비 용량 1/5)
  a.download = photoName();
  a.click();
  showToast("저장했어요");
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
  const btn = $("startBtn");
  btn.disabled = true; btn.textContent = "준비 중…";
  try {
    const fileset = await FilesetResolver.forVisionTasks(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm"
    );
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        delegate: "GPU",
      },
      runningMode: "VIDEO", numFaces: 1,
    });
    await startStream();
    if (!glOK) showToast("이 기기는 GPU 처리를 지원하지 않아요");
    $("placeholder").style.display = "none";
    $("camScreen").classList.add("live");
    $("status").style.display = "flex";
    out.style.display = "block";
    $("camTop").style.display = "flex";
    $("camBottom").style.display = "flex";
    $("shotBtn").disabled = false;
    requestAnimationFrame(loop);
  } catch (err) {
    btn.disabled = false; btn.textContent = "카메라 켜기";
    alert("카메라를 켤 수 없어요.\n브라우저의 카메라 권한을 확인해 주세요.\n\n" + err.message);
  }
});

$("flipBtn").addEventListener("click", async () => {
  facing = (facing === "user") ? "environment" : "user";
  try { await startStream(); }
  catch (err) {
    facing = (facing === "user") ? "environment" : "user";
    await startStream().catch(() => {});
    showToast("카메라 전환 실패");
  }
});

/* ===== 탭 초점 ===== */
$("camScreen").addEventListener("click", (e) => {
  if (mode !== "cam" || e.target !== out) return;
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
  if (mode !== "cam" || video.readyState < 2) return;
  if (ts - lastRenderTs < 31) return;   // 30fps 상한
  lastRenderTs = ts;

  if (frameCount % 3 === 0) {
    const result = landmarker.detectForVideo(video, performance.now());
    const fresh = result.faceLandmarks?.[0] ?? null;
    if (fresh) { lastLandmarks = fresh; lastSeen = performance.now(); maskDirty = true; }
    else if (performance.now() - lastSeen > 5000) lastLandmarks = null;
  }
  frameCount++;

  statusEl.classList.toggle("tracking", !!lastLandmarks);
  statusText.textContent = lastLandmarks ? "얼굴 인식 중" : "얼굴 찾는 중…";

  // 프리뷰 렌더 (화각 + 화면 비율 크롭)
  const src = camPreviewFrame();
  const srcW = src === video ? video.videoWidth : glCanvas.width;
  const srcH = src === video ? video.videoHeight : glCanvas.height;
  const { sx, sy, sw, sh } = cropRect(srcW, srcH);
  const ow = Math.round(sw), oh = Math.round(sh);
  if (out.width !== ow || out.height !== oh) { out.width = ow; out.height = oh; }
  ctx.save();
  if (facing === "user") { ctx.translate(ow, 0); ctx.scale(-1, 1); }
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, ow, oh);
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
  maskCtx.filter = "blur(" + faceW * 0.025 + "px)";
  maskCtx.strokeStyle = "rgb(0,0,255)";
  maskCtx.lineCap = "round";
  maskCtx.lineWidth = faceW * 0.10;
  for (const pair of [[L[129], L[61]], [L[358], L[291]]]) {
    const a = pair[0], b = pair[1];
    if (!a || !b) continue;
    maskCtx.beginPath();
    maskCtx.moveTo(a.x * w, a.y * h);
    maskCtx.lineTo((a.x + (b.x - a.x) * 0.40) * w, (a.y + (b.y - a.y) * 0.40) * h);
    maskCtx.stroke();
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
