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
let skinOn = true, blemishOn = true, contourOn = true, filmOn = true;
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
$("tgContour").addEventListener("click", (e) => { contourOn = !contourOn; e.target.classList.toggle("on", contourOn); });
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
uniform sampler2D uFrame;
uniform sampler2D uMask;
uniform vec2  uTexel;      // 소스 1픽셀 크기
uniform float uAspect;     // 세로/가로 비율
uniform float uRadius;
uniform float uSmooth;
uniform float uBlemish;
uniform float uFilm;
uniform float uSharp;
uniform float uContrast;
uniform float uSat;
uniform vec3  uRGB;
uniform float uWB;
uniform float uTime;
uniform vec2  uFmTone;     // 필름 톤커브 (스케일, 리프트)
uniform float uFmSat;      // 필름 채도 감쇄
uniform vec3  uFmHi;       // 하이라이트 틴트
uniform vec3  uFmSh;       // 섀도 틴트
uniform float uFmGrain;    // 그레인 세기
uniform float uFmVig;      // 비네트 세기
uniform float uLens;       // 화각별 렌즈 왜곡 (28mm 배럴 ~ 50mm 평탄)
uniform sampler2D uWarp;   // 윤곽 변위 맵 (실루엣 평탄화 벡터, RG 인코딩)
uniform float uWarpAmt;    // 윤곽 보정 on/off
uniform float uWrinkle;    // 팔자주름 완화 강도 (0.5 = 주름을 원래의 50%로)
uniform vec4  uFoldL;      // 왼쪽 팔자 라인 (시작점.xy, 끝점.zw)
uniform vec4  uFoldR;      // 오른쪽 팔자 라인
uniform float uFoldRad;    // 팔자 캡슐 반경

// 선분(팔자 라인) 주변 캡슐 가중치: 라인에 가까울수록 1
float foldW(vec2 p, vec4 seg, float rad, float aspect) {
  vec2 pa = p - seg.xy, ba = seg.zw - seg.xy;
  pa.y *= aspect; ba.y *= aspect;
  float t = clamp(dot(pa, ba) / max(dot(ba, ba), 0.000001), 0.0, 1.0);
  vec2 d = pa - ba * t;
  float w = 1.0 - smoothstep(rad * 0.25, rad, length(d));
  w *= 1.0 - smoothstep(0.55, 0.95, t);  // 입꼬리 방향으로 갈수록 일찍 소멸 ('조커' 방지)
  return w;
}

void main() {
  vec2 uv = vUV;

  // ===== 윤곽 보정: 실루엣의 튀어나온 부분(광대 모서리·각진 턱)을 평탄화 =====
  // JS에서 계산한 변위 맵을 샘플. 튀어나온 지점만 매끈한 기준선 쪽으로 당겨진다.
  if (uWarpAmt > 0.5) {
    vec2 wv = texture2D(uWarp, vUV).rg;
    uv -= (wv - vec2(128.0 / 255.0)) * 0.08;
  }

  // ===== 화각 렌즈 느낌: 28mm 배럴 왜곡(가장자리 볼록) ~ 50mm 평탄 =====
  if (abs(uLens) > 0.001) {
    vec2 cc = uv - 0.5; cc.y *= uAspect;
    float r2 = dot(cc, cc);
    vec2 cd = cc * (1.0 + uLens * r2);
    cd.y /= uAspect;
    uv = 0.5 + cd;
  }

  vec3 c = texture2D(uFrame, uv).rgb;
  vec3 res = c;
  float m = texture2D(uMask, uv).a;

  // ===== 피부 보정 (얼굴 마스크 안에서만) =====
  if (m > 0.01 && (uSmooth > 0.01 || uBlemish > 0.01)) {
    float sigmaR = 0.07 + 0.07 * uSmooth;
    vec3 sum = c; float wsum = 1.0; vec3 plain = c;
    for (int i = 0; i < 16; i++) {
      float ang = 0.3926991 * float(i);
      float ring = (mod(float(i), 2.0) < 1.0) ? 1.0 : 0.55;
      vec2 off = vec2(cos(ang), sin(ang)) * uRadius * ring * uTexel;
      vec3 s = texture2D(uFrame, uv + off).rgb;
      float d = length(s - c);
      float wr = exp(-(d * d) / (2.0 * sigmaR * sigmaR));
      sum += s * wr; wsum += wr; plain += s;
    }
    vec3 base = sum / wsum;
    vec3 avg = plain / 17.0;
    vec3 hi = c - base;

    // 넓은 반경의 '깨끗한 피부' 기준값 — 잡티가 커도 오염되지 않도록 바깥에서 샘플
    vec3 far = vec3(0.0);
    for (int i = 0; i < 8; i++) {
      float fa = 0.7853982 * float(i);
      far += texture2D(uFrame, uv + vec2(cos(fa), sin(fa)) * uRadius * 2.7 * uTexel).rgb;
    }
    far /= 8.0;

    // ── 1단계: 이상 탐지 (Anomaly Detection) ──
    // 밝기 이상(그림자·흉터)과 색 이상(붉은기·색소침착)을 함께 본다
    vec3 lw = vec3(0.299, 0.587, 0.114);
    float lumC = dot(c, lw), lumA = dot(far, lw);
    float darker = lumA - lumC;                          // 주변보다 어두운 정도
    float redC = c.r - (c.g + c.b) * 0.5;
    float redA = far.r - (far.g + far.b) * 0.5;
    float dRed = redC - redA;                            // 주변보다 붉은 정도
    float score = max(darker, dRed * 0.9);

    float th = 0.042 - 0.020 * uBlemish;
    float spot = smoothstep(th * 0.45, th, score);

    // ── 남겨야 할 특징 보호 (점·눈썹·입술 경계·머리카락) ──
    spot *= 1.0 - smoothstep(0.26, 0.42, darker);        // 아주 진한 점(Mole)만 보존
    spot *= smoothstep(0.12, 0.28, c.g);                 // 원래 매우 어두운 영역 보호
    spot *= 1.0 - 0.4 * smoothstep(0.68, 0.88, lumA);    // 하이라이트는 약하게
    spot *= 1.0 * uBlemish;

    // 밝은 반점(모공 반짝임)도 대칭으로 정리
    float glare = smoothstep(th * 0.45, th, -darker) * 0.55 * uBlemish;

    // ── 2단계: 질감 이식 인페인팅 ──
    // 잡티 자리를 평평하게 덮지 않고, 근처 '깨끗한 피부'의 결을 가져와 새로 그린다
    vec2 donorOff = vec2(uRadius * 2.3, uRadius * 1.1) * uTexel;
    vec3 dC = texture2D(uFrame, uv + donorOff).rgb;
    vec3 dA = (texture2D(uFrame, uv + donorOff + vec2(uRadius, 0.0) * uTexel).rgb
             + texture2D(uFrame, uv + donorOff - vec2(uRadius, 0.0) * uTexel).rgb
             + texture2D(uFrame, uv + donorOff + vec2(0.0, uRadius) * uTexel).rgb
             + texture2D(uFrame, uv + donorOff - vec2(0.0, uRadius) * uTexel).rgb) * 0.25;
    vec3 donorTex = dC - dA;                             // 이식할 피부 결 (고주파)

    // ── 3단계: 마이크로 톤 조정 + 블렌딩 ──
    // 주변의 정상 혈색/톤(저주파) + 이식한 질감(고주파) → 경계 없는 융합
    float fix = max(spot, glare);
    vec3 inpaint = far + donorTex * 0.85;
    vec3 r = mix(c, inpaint, fix);

    // 주파수 분리 스무딩: 톤 층만 정리, 결은 강도에 비례해 보존
    float dev = abs(darker);
    float structural = smoothstep(0.035, 0.11, dev);
    vec3 lowNew = mix(base, avg, uSmooth * 0.75 * (1.0 - structural));
    vec3 hiKeep = r - base;
    r = lowNew + hiKeep * (1.0 - uSmooth * 0.45);

    res = mix(c, r, m);
  }


  // ===== 팔자주름 완화: 후보 영역 안에서 '실제 골'을 감지해 적용 =====
  // 랜드마크는 탐색 영역만 정하고, 픽셀 분석으로 진짜 주름을 찾는다.
  // 주름 = 예상 방향의 수직 양옆보다 어두운 홈. 골이 아닌 곳은 건드리지 않으므로
  // 사람마다 주름 위치가 달라도 자동 적응하고, 입꼬리가 밝아지는 오류도 원천 차단.
  if (uWrinkle > 0.01) {
    float wl = foldW(vUV, uFoldL, uFoldRad, uAspect);
    float wr2 = foldW(vUV, uFoldR, uFoldRad, uAspect);
    float fw = max(wl, wr2) * uWrinkle;
    if (fw > 0.01) {
      vec4 seg = wl > wr2 ? uFoldL : uFoldR;
      vec2 fdir = seg.zw - seg.xy; fdir.y *= uAspect;
      fdir = normalize(fdir);
      vec2 perp = vec2(-fdir.y, fdir.x); perp.y /= uAspect;   // 주름 방향의 수직
      float pd = uFoldRad * 0.55;
      vec3 lwF = vec3(0.299, 0.587, 0.114);
      float lc = dot(res, lwF);
      float n1 = dot(texture2D(uFrame, uv + perp * pd).rgb, lwF);
      float n2 = dot(texture2D(uFrame, uv - perp * pd).rgb, lwF);
      float target = (n1 + n2) * 0.5;                             // 양옆 피부의 평균 밝기
      // 골 게이트: 양옆보다 실제로 어두운 곳만 (얕은 골도 감지되도록 문턱 낮춤)
      float gate = smoothstep(0.012, 0.05, target - lc);
      // 선형성: 주름은 '선'이라 진행 방향으로도 어둡고, 잡티는 '점'이라 끊긴다
      vec2 fuv = vec2(fdir.x, fdir.y / uAspect);
      float a1 = dot(texture2D(uFrame, uv + fuv * pd).rgb, lwF);
      float a2 = dot(texture2D(uFrame, uv - fuv * pd).rgb, lwF);
      float lineness = 1.0 - clamp((min(a1, a2) - lc) * 12.0, 0.0, 1.0);
      // '골 깊이의 절반을 메움': 얕든 깊든 항상 깊이에 비례해 uWrinkle(50%)만큼 채워짐
      float ratio = min(target / max(lc, 0.02), 1.6);
      float fillAmt = min(1.0, max(wl, wr2) * 1.3) * gate * lineness * uWrinkle;
      res *= 1.0 + (ratio - 1.0) * fillAmt;
    }
  }

  // ===== 선명도 =====
  if (uSharp > 0.001) {
    vec3 nb = texture2D(uFrame, uv + vec2(uTexel.x, 0.0)).rgb
            + texture2D(uFrame, uv - vec2(uTexel.x, 0.0)).rgb
            + texture2D(uFrame, uv + vec2(0.0, uTexel.y)).rgb
            + texture2D(uFrame, uv - vec2(0.0, uTexel.y)).rgb;
    res += (c - nb * 0.25) * uSharp;
  }

  // ===== 화이트 밸런스 / RGB / 콘트라스트 / 채도 =====
  res *= vec3(1.0 + 0.09 * uWB, 1.0 + 0.015 * uWB, 1.0 - 0.09 * uWB);
  res *= uRGB;
  res = (res - 0.5) * uContrast + 0.5;
  res = clamp(res, 0.0, 1.0);
  float sl = dot(res, vec3(0.299, 0.587, 0.114));
  res = mix(vec3(sl), res, uSat);

  // ===== 필름 그레이드: 프리셋 파라미터 기반 (레퍼런스 실측값) =====
  if (uFilm > 0.005) {
    vec3 f = res;
    float fl = dot(f, vec3(0.299, 0.587, 0.114));
    f = f * mix(1.0, uFmTone.x, uFilm) + vec3(uFmTone.y * uFilm);      // 페이드 톤커브
    f = mix(f, vec3(dot(f, vec3(0.299, 0.587, 0.114))), uFmSat * uFilm); // 채도
    float hl = smoothstep(0.55, 0.9, fl);
    f *= mix(vec3(1.0), uFmHi, hl * uFilm);                             // 하이라이트 틴트
    float shd = 1.0 - smoothstep(0.1, 0.45, fl);
    f *= mix(vec3(1.0), uFmSh, shd * uFilm);                            // 섀도 틴트
    vec2 dv = vUV - 0.5;
    f *= 1.0 - dot(dv, dv) * uFmVig * uFilm;                            // 비네트
    float g = fract(sin(dot(gl_FragCoord.xy + vec2(uTime * 617.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
    f += g * uFmGrain * uFilm;                                          // 그레인
    res = f;
  }

  gl_FragColor = vec4(clamp(res, 0.0, 1.0), 1.0);
}`;

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
  ["uFrame","uMask","uTexel","uAspect","uRadius","uSmooth","uBlemish","uFilm","uSharp",
   "uContrast","uSat","uRGB","uWB","uTime","uLens",
   "uWarp","uWarpAmt","uWrinkle","uFoldL","uFoldR","uFoldRad",
   "uFmTone","uFmSat","uFmHi","uFmSh","uFmGrain","uFmVig"]
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
function captureHighRes() {
  // 원본 해상도로 1프레임 처리 (피부·윤곽·렌즈만 굽고, 색·필름은 편집에서)
  glCanvas.width = video.videoWidth;
  glCanvas.height = video.videoHeight;
  const faceW = lastLandmarks ? Math.abs(lastLandmarks[454].x - lastLandmarks[234].x) * video.videoWidth : 0;
  drawGL(video, {
    srcW: video.videoWidth, srcH: video.videoHeight,
    radius: Math.max(2.5, faceW * 0.030),
    smooth: (skinOn && lastLandmarks) ? skinAmt : 0,
    blemish: (blemishOn && lastLandmarks) ? blemAmt : 0,
    lens: LENS_MAP[focal],
    warp: contourOn && !!lastLandmarks,
    film: filmOn ? filmStrength : 0,               // 필름 프리셋을 사진에 직접 굽기
    fm: FILM_PRESETS[filmPreset],
    wb: wbCam,
    time: (performance.now() % 10000) / 10000,     // 그레인은 사진에 고정
  });

  // 미러링 + 화각 크롭을 구워서 편집 원본 확정
  const { sx, sy, sw, sh } = cropRect(video.videoWidth, video.videoHeight);
  const cw = Math.round(sw), ch = Math.round(sh);
  capCanvas.width = cw; capCanvas.height = ch;
  capCtx.save();
  if (facing === "user") { capCtx.translate(cw, 0); capCtx.scale(-1, 1); }
  capCtx.drawImage(glOK ? glCanvas : video, sx, sy, sw, sh, 0, 0, cw, ch);
  capCtx.restore();

  shotLandmarks = lastLandmarks;
  shotCropX = sw / video.videoWidth;
  shotCropY = sh / video.videoHeight;
  shotMirror = facing === "user";
  enterEdit();
}

// 팔자 후보 영역: 랜드마크로 넓은 캡슐만 만들고, 실제 적용 여부는
// 셰이더의 골 감지(양옆보다 어두움 + 선형성)가 픽셀 단위로 판단한다.
// 위치 추정에 의존하지 않으므로 사람·표정이 달라도 작동한다.
function foldCapsules(L) {
  const faceW = Math.abs(L[454].x - L[234].x);
  const mk = (corner) => {
    const top = [L[2].x + (corner.x - L[2].x) * 0.55, L[2].y + (corner.y - L[2].y) * 0.05];
    const bot = [corner.x + (corner.x - L[13].x) * 0.55, corner.y + (corner.y - L[2].y) * 0.10];
    return [top[0], 1 - top[1], bot[0], 1 - bot[1]];
  };
  return { l: mk(L[61]), r: mk(L[291]), rad: faceW * 0.11 };
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
  if (EL) { try { editFold = foldCapsules(EL); } catch (e) { editFold = null; } }
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
  const tries = [
    { video: { facingMode: { exact: facing }, width: { ideal: 1080 }, height: { ideal: 1440 } }, audio: false },
    { video: { facingMode: facing, width: { ideal: 1080 }, height: { ideal: 1440 } }, audio: false },
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
  buildFaceMask(maskCanvas.width, maskCanvas.height);
  gl.activeTexture(gl.TEXTURE1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
  if (contourOn) {
    computeWarpMap(warpCanvas.width, warpCanvas.height);
    gl.activeTexture(gl.TEXTURE2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, warpCanvas);
  }
  maskDirty = false;
}

function buildFaceMask(w, h) {
  maskCtx.clearRect(0, 0, w, h);
  const L = lastLandmarks;
  maskCtx.save();
  maskCtx.filter = "blur(" + w * 0.015 + "px)";
  maskCtx.fillStyle = "#fff";
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
  maskCtx.fillStyle = "#fff";
  maskCtx.beginPath();
  maskCtx.ellipse(ncx, ncy, faceW * 0.14, nLen * 0.8, nAng, 0, Math.PI * 2);
  maskCtx.fill();
  maskCtx.restore();

  maskCtx.save();
  maskCtx.globalCompositeOperation = "destination-out";
  maskCtx.filter = "blur(" + faceW * 0.02 + "px)";
  maskCtx.fillStyle = "#fff";
  carveEllipse(L[159], L[145], faceW * 0.15, faceW * 0.07, w, h);
  carveEllipse(L[386], L[374], faceW * 0.15, faceW * 0.07, w, h);
  carveEllipse(L[105], L[105], faceW * 0.16, faceW * 0.045, w, h);
  carveEllipse(L[334], L[334], faceW * 0.16, faceW * 0.045, w, h);
  carveEllipse(L[13],  L[14],  faceW * 0.22, faceW * 0.11, w, h);
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
    captureHighRes();
    await sleep(140);
    screenFlash.classList.remove("on");
  } else if (flashMode === "torch") {
    const ok = await setTorch(true);      // 후면: LED 라이트
    await sleep(ok ? 450 : 0);
    captureHighRes();
    if (ok) { await sleep(120); setTorch(false); }
  } else {
    captureHighRes();
  }
});
