// UI 통합 테스트: 실제 DOM에 앱을 올리고 버튼·슬라이더를 눌러 배선을 검증한다.
// (셰이더 계산이 아니라 "이벤트가 실제로 연결돼 있는가"를 확인하는 테스트)
const fs = require('fs');
const { JSDOM } = require('jsdom');
const { createCanvas } = require('canvas');

const OUT = '/mnt/user-data/outputs';
const html = fs.readFileSync(OUT + '/index.html', 'utf8');
let appjs = fs.readFileSync(OUT + '/app.js', 'utf8');

// MediaPipe import는 네트워크가 필요하므로 스텁으로 대체
appjs = appjs.replace(/^import[\s\S]*?;\s*$/m, '');
// MediaPipe는 전역 스텁으로 대체한다 (코드 구조가 바뀌어도 깨지지 않음)

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://localhost/' });
const { window } = dom;
const doc = window.document;

// --- 브라우저 API 스텁 ---
// 가짜 WebGL: 실제 그리지는 않지만 호출을 모두 받아준다 (배선 검증이 목적)
function fakeGL() {
  const consts = { COMPILE_STATUS: 1, LINK_STATUS: 2, TEXTURE_2D: 3, RGBA: 4,
    UNSIGNED_BYTE: 5, ARRAY_BUFFER: 6, STATIC_DRAW: 7, FLOAT: 8, TRIANGLES: 9,
    VERTEX_SHADER: 10, FRAGMENT_SHADER: 11, CLAMP_TO_EDGE: 12, LINEAR: 13,
    TEXTURE_WRAP_S: 14, TEXTURE_WRAP_T: 15, TEXTURE_MIN_FILTER: 16,
    TEXTURE_MAG_FILTER: 17, TEXTURE0: 33984, UNPACK_FLIP_Y_WEBGL: 18, COLOR_BUFFER_BIT: 19 };
  return new Proxy({}, { get(_, k) {
    if (k in consts) return consts[k];
    if (k === 'getShaderParameter' || k === 'getProgramParameter') return () => true;
    if (k === 'getUniformLocation') return () => ({});
    if (k === 'getAttribLocation') return () => 0;
    if (k === 'createShader' || k === 'createProgram' || k === 'createBuffer' || k === 'createTexture')
      return () => ({});
    if (k === 'getShaderInfoLog' || k === 'getProgramInfoLog') return () => '';
    if (k === 'isContextLost') return () => false;
    return () => {};
  }});
}
window.HTMLCanvasElement.prototype.getContext = function (type) {
  if (type === 'webgl' || type === 'experimental-webgl') return fakeGL();
  if (!this.__c) this.__c = createCanvas(this.width || 300, this.height || 150);
  if (this.__c.width !== this.width || this.__c.height !== this.height) {
    this.__c.width = this.width; this.__c.height = this.height;
  }
  return this.__c.getContext('2d');
};
window.HTMLCanvasElement.prototype.toBlob = function (cb) { cb(new window.Blob([new Uint8Array([1,2,3])], { type: 'image/jpeg' })); };
window.HTMLCanvasElement.prototype.toDataURL = function () { return 'data:image/jpeg;base64,AAA'; };
window.HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
window.cancelAnimationFrame = (id) => clearTimeout(id);
window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {} });
window.confirm = () => true;
window.createImageBitmap = async () => ({ width: 1080, height: 1440, close() {} });
// data URL을 즉시 로드된 것으로 처리 (네이티브 촬영 경로 검증용)
Object.defineProperty(window.Image.prototype, 'src', {
  set(v) { this.__src = v; Object.defineProperty(this, 'naturalWidth', { value: 1080, configurable: true });
           Object.defineProperty(this, 'naturalHeight', { value: 1440, configurable: true });
           setTimeout(() => this.onload && this.onload(), 0); },
  get() { return this.__src; }, configurable: true,
});
const fidb = require('fake-indexeddb');
window.indexedDB = fidb.indexedDB || fidb;
window.IDBKeyRange = require('fake-indexeddb/lib/FDBKeyRange');
window.navigator.mediaDevices = {
  getUserMedia: async () => ({
    getTracks: () => [{ stop() {} }],
    getVideoTracks: () => [{
      stop() {}, getCapabilities: () => ({ torch: true, focusMode: ['continuous'] }),
      applyConstraints: async () => {},
    }],
  }),
};
// 가짜 얼굴 랜드마크 (468점)
window.__detectSizes = [];
globalThis.__fakeLandmarker = {
  detect: (img) => {
    window.__detectSizes.push([img.width, img.height]);
    return { faceLandmarks: [Array.from({ length: 478 }, (_, i) => ({
      x: 0.5 + Math.cos(i) * 0.13, y: 0.5 + Math.sin(i) * 0.17, z: 0 }))] };
  },
};
window.__fakeLandmarker = globalThis.__fakeLandmarker;
window.FilesetResolver = { forVisionTasks: async () => ({}) };
window.FaceLandmarker = { createFromOptions: async () => globalThis.__fakeLandmarker };

// 네이티브 카메라 플러그인 스텁 — NATIVE=1 이면 네이티브 경로를 태운다
const NATIVE = process.env.NATIVE === '1';
const cpLog = [];
if (NATIVE) {
  const png1x1 = fakeFrameB64();
  window.Capacitor = { isNativePlatform: () => true, Plugins: { CameraPreview: {
    start: async (o) => {
      cpLog.push(['start', o.position, o.width, o.height, o.toBack]);
      if (process.env.CRASH === '1') throw new Error('네이티브 크래시 시뮬레이션');
    },
    stop: async () => { cpLog.push(['stop']); },
    flip: async () => { cpLog.push(['flip']); },
    setFlashMode: async (o) => { cpLog.push(['flash', o.flashMode]); },
    capture: async () => { cpLog.push(['capture']); return { value: png1x1 }; },
  }, Filesystem: { writeFile: async () => ({ uri: 'file:///x.jpg' }) } } };
}
function fakeFrameB64() {
  return createCanvas(1080, 1440).toDataURL('image/jpeg').split(',')[1];
}

// jsdom은 레이아웃 계산을 하지 않으므로 미리보기 영역 크기를 실제처럼 만들어준다
window.Element.prototype.getBoundingClientRect = function () {
  if (this.classList && this.classList.contains('stagewrap'))
    return { left: 0, top: 62, width: 1080, height: 1440, right: 1080, bottom: 1502, x: 0, y: 62 };
  return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0 };
};

const results = [];
const check = (name, cond, detail = '') => results.push([name, !!cond, detail]);

// 앱 구동
try {
  window.eval(appjs);
} catch (e) {
  console.log('앱 로드 실패:', e.message);
  process.exit(1);
}

const $ = (id) => doc.getElementById(id);
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const setRange = (el, v) => { el.value = String(v); el.dispatchEvent(new window.Event('input', { bubbles: true })); };

// video를 그릴 수 있는 소스로 대체 (jsdom의 video는 drawImage 대상이 못 됨)
const fakeFrame = createCanvas(1080, 1440);
{
  const fx = fakeFrame.getContext('2d');
  fx.fillStyle = '#c89a86'; fx.fillRect(0, 0, 1080, 1440);
  fx.fillStyle = '#8a5f50'; fx.beginPath(); fx.arc(540, 700, 40, 0, Math.PI * 2); fx.fill();
}
// 앱이 만드는 모든 video 요소에 적용되도록 프로토타입을 패치
Object.defineProperty(window.HTMLVideoElement.prototype, 'videoWidth', { get: () => 1080, configurable: true });
Object.defineProperty(window.HTMLVideoElement.prototype, 'videoHeight', { get: () => 1440, configurable: true });
Object.defineProperty(window.HTMLMediaElement.prototype, 'readyState', { get: () => 4, configurable: true });
window.__fakeFrame = fakeFrame;

// drawImage가 video/ImageBitmap을 받으면 가짜 프레임으로 바꿔치기
const NodeCanvas = createCanvas(1, 1).constructor;
const Ctx2D = createCanvas(1, 1).getContext('2d').constructor;
const origDraw = Ctx2D.prototype.drawImage;
Ctx2D.prototype.drawImage = function (img, ...rest) {
  let src = img;
  if (img && img.__c) src = img.__c;                    // jsdom 캔버스 → 내부 실제 캔버스
  else if (!(img instanceof NodeCanvas)) src = fakeFrame;
  return origDraw.call(this, src, ...rest);
};

setTimeout(() => {
  // 1) 편집 슬라이더가 전부 이벤트에 연결돼 있는가
  const sliders = ['flash','wrinkle','film','sharp','contrast','sat','rGain','gGain','bGain'];
  for (const id of sliders) {
    const el = $(id); const out = $(id + 'Val');
    if (!el || !out) { check('슬라이더 ' + id, false, '요소 없음'); continue; }
    const before = out.textContent;
    setRange(el, id === 'contrast' || id === 'sat' ? 120 : 40);
    check('슬라이더 ' + id, out.textContent !== before || out.textContent === el.value,
      before + ' → ' + out.textContent);
  }

  // 2) 피부결 프리셋 버튼이 상태를 바꾸는가
  const strong = $('skinSeg').querySelector('[data-skin="90"]');
  click(strong);
  check('피부결 버튼', strong.classList.contains('on'), '강하게 선택됨');

  // 3) 토글이 실제로 켜고 꺼지는가 (중복 리스너면 제자리)
  for (const id of ['tgEye','tgContour']) {
    const b = $(id); const t0 = b.textContent;
    click(b); const t1 = b.textContent;
    click(b); const t2 = b.textContent;
    check('토글 ' + id, t1 !== t0 && t2 === t0, t0 + ' → ' + t1 + ' → ' + t2);
  }

  // 4) 상단 아이콘 팝업이 열리고 서로 배타적인가
  click($('settingsBtn'));
  const skinOpen = $('skinBar').classList.contains('open');
  click($('ratioBtn'));
  check('팝업 배타', skinOpen && !$('skinBar').classList.contains('open') && $('ratioBar').classList.contains('open'));

  // 5) 설정이 localStorage에 남는가
  const saved = window.localStorage.getItem('filmcam.settings.v1');
  check('설정 저장', !!saved && JSON.parse(saved).skinAmt === 0.9, saved ? '저장됨' : '없음');

  // 6) 비율 변경이 반영되는가
  click($('ratioBar').querySelector('[data-ratio="1:1"]'));
  check('비율 변경', $('ratioTag').textContent === '1:1', $('ratioTag').textContent);

  // 7) 촬영 전체 흐름: 보정 파라미터가 실제로 전달되는가
  //    drawGL을 가로채 어떤 값으로 호출되는지 기록한다
  const calls = [];
  window.__spyDrawGL = (opt) => calls.push(opt);

  (async () => {
    try {
      click($('startBtn'));
      await new Promise(r => setTimeout(r, 300));
      check('카메라 시작', doc.getElementById('camTop').style.display === 'flex', '상단바 표시');
      try { await window.__testCapture(); }
      catch (e) { check('촬영 예외', false, e.message); }
      const editCall = calls[calls.length - 1] || {};
      check('촬영→보정 호출', calls.length > 0, calls.length + '회 렌더');
      check('피부결 전달', (editCall.smooth ?? 0) > 0, 'smooth=' + editCall.smooth);
      check('잡티 전달', (editCall.blemish ?? 0) > 0, 'blemish=' + editCall.blemish);
      check('눈보정 전달', (editCall.eye ?? 0) > 0, 'eye=' + editCall.eye);
      check('플래시 전달', editCall.flash !== undefined, 'flash=' + editCall.flash);
      check('결과 캔버스 크기', doc.getElementById('editOut').width > 300,
        doc.getElementById('editOut').width + 'px');
      // processShot 단계별 추적
      console.log('  [진단] landmarker =', typeof window.__fakeLandmarker);
      console.log('  [진단] drawGL 호출 인자들 =', JSON.stringify(calls.map(c => Object.keys(c))));
      if (NATIVE) { click($('tgCamMode')); await new Promise(r => setTimeout(r, 400)); }
      if (NATIVE && process.env.CRASH === '1') {
        check('크래시 시 폴백', /웹/.test(doc.getElementById('statusText').textContent), '웹 방식으로 전환됨');
        check('촬영 계속 가능', doc.getElementById('editOut').width > 300,
          doc.getElementById('editOut').width + 'px');
      } else if (NATIVE) {
        check('네이티브 시작', cpLog.some(l => l[0] === 'start'), JSON.stringify(cpLog[0] || []));
        check('네이티브 촬영', cpLog.some(l => l[0] === 'start'), '플러그인 연동 정상');
        check('투명화 미사용', !cpLog.some(l => l[0]==='start' && l[4] === true), 'toBack 사용 안 함');
        check('권한 선확보', cpLog.length > 0, 'getUserMedia 후 start');
        await new Promise(r => setTimeout(r, 3300));   // 안전 판정 대기
        check('크래시 표시 정리', !window.localStorage.getItem('filmcam.nativeTry'),
          '3초 무사고 후 표시 제거');
      }
      // 촬영 결과가 원본 크기 그대로인지 (갤러리에 조각만 저장되던 버그 방지)
      const eo = doc.getElementById('editOut'), cc = doc.getElementById('out');
      check('결과=원본 크기', eo.width === 1080 && eo.height > 1000,
        eo.width + '×' + eo.height);
      check('빌드 버전 표시', /v\d/.test(doc.getElementById('statusText').textContent),
        doc.getElementById('statusText').textContent);
      check('축소 검출 동작', (window.__detectSizes || []).length > 0 &&
        Math.max(...(window.__detectSizes[0] || [9999])) <= 1024,
        '검출 입력 크기 ' + JSON.stringify(window.__detectSizes && window.__detectSizes[0]));
      // 갤러리에서 사진을 열면 편집 화면 진단이 갱신된다
      const all0 = await window.__testGalleryAll();
      if (all0[0]) { await window.__testOpenShot(all0[0]); }
      check('갤러리 재편집 보정 유지', /얼굴 인식 O/.test(doc.getElementById('editDiag').textContent),
        '다시 열어도 보정 적용됨');
      check('편집 진단 표시', /얼굴 인식/.test(doc.getElementById('editDiag').textContent),
        doc.getElementById('editDiag').textContent);
      const shots = await window.__testGalleryAll();
      check('갤러리 자동저장', shots.length === 1, shots.length + '장');
    } catch (e) {
      check('촬영 흐름', false, e.message);
    }
    report();
  })();
  return;

  function report() {
  let fail = 0;
  for (const [n, ok, d] of results) {
    if (!ok) fail++;
    console.log((ok ? 'PASS  ' : 'FAIL  ') + n.padEnd(18) + (d || ''));
  }
  process.exit(fail ? 1 : 0);
  }
}, 400);
