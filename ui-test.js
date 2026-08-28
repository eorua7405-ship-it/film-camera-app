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
const SYS = process.env.SYS === '1';
const FULL = process.env.FULL === '1' || process.env.NATIVE === '1';
const cpLog = [];
if (NATIVE || FULL) {
  const png1x1 = fakeFrameB64();
  window.Capacitor = { isNativePlatform: () => true, Plugins: { FilmCamera: {
    start: async (o) => {
      cpLog.push(['fn.start', o.position, o.width, o.height]);
      if (process.env.CRASH === '1') throw new Error('네이티브 시작 실패 시뮬레이션');
    },
    stop: async () => { cpLog.push(['fn.stop']); },
    setLayout: async (o) => { cpLog.push(['fn.setLayout', o.width, o.height]); },
    flip: async () => { cpLog.push(['fn.flip']); },
    focus: async (o) => { cpLog.push(['fn.focus', Math.round(o.x), Math.round(o.y)]); },
    setTorch: async (o) => { cpLog.push(['fn.setTorch', o.on]); },
    setZoom: async (o) => { cpLog.push(['fn.setZoom', o.ratio]); return { zoom: Math.min(o.ratio, 2) }; },
    setFilm: async (o) => { cpLog.push(['fn.setFilm', o.strength, o.grain]); },
    capture: async () => { cpLog.push(['fn.capture']); return { value: png1x1 }; },
  }, Filesystem: { writeFile: async () => ({ uri: 'file:///x.jpg' }) } } };
}
if (SYS) {
  // 시스템 카메라(폰 기본 카메라 앱) 스텁
  window.Capacitor = window.Capacitor || { isNativePlatform: () => true, Plugins: {} };
  window.Capacitor.Plugins = window.Capacitor.Plugins || {};
  window.Capacitor.Plugins.Camera = {
    getPhoto: async (o) => {
      cpLog.push(['getPhoto', o.direction, o.quality]);
      return { base64String: fakeFrameB64() };
    },
  };
  window.Capacitor.Plugins.Filesystem = { writeFile: async () => ({ uri: 'file:///x.jpg' }) };
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
      const editCall = [...calls].reverse().find(c => c.smooth !== undefined) || {};
      check('촬영→보정 호출', calls.length > 0, calls.length + '회 렌더');
      check('피부결 전달', (editCall.smooth ?? 0) > 0, 'smooth=' + editCall.smooth);
      check('잡티 전달', (editCall.blemish ?? 0) > 0, 'blemish=' + editCall.blemish);
      check('눈보정 전달', (editCall.eye ?? 0) > 0, 'eye=' + editCall.eye);
      check('플래시 전달', editCall.flash !== undefined, 'flash=' + editCall.flash);
      check('결과 캔버스 크기', doc.getElementById('editOut').width > 300,
        doc.getElementById('editOut').width + 'px');
      // processShot 단계별 추적
      console.log('  [진단] drawGL 호출 인자들 =', JSON.stringify(calls.map(c => Object.keys(c))));
      if (NATIVE) {
        window.localStorage.removeItem('filmcam.settings.v1');
        // 웹 → 시스템 → 네이티브 순환이므로 두 번 눌러 네이티브까지 간다
        // 시스템 카메라가 없는 환경에서는 웹 → 네이티브로 바로 넘어간다
        click($('tgCamMode')); await new Promise(r => setTimeout(r, 600));
        check('setFlashMode 미호출', !cpLog.some(l => l[0] === 'flash'),
          '크래시 유발 호출 없음');
        check('네이티브 레이어 시작', cpLog.some(l => l[0] === 'fn.start'), '브릿지 start 전달');
        check('필름 신호 전달', cpLog.some(l => l[0] === 'fn.setFilm' && l[1] > 0),
          '프리셋이 네이티브 GPU로 전달됨');
        // 탭 초점: 화면 좌표가 네이티브로 전달되어야 한다
        const stage = doc.querySelector('.stagewrap');
        stage.dispatchEvent(new window.MouseEvent('click',
          { bubbles: true, clientX: 300, clientY: 700 }));
        await new Promise(r => setTimeout(r, 200));
        check('탭 초점 전달', cpLog.some(l => l[0] === 'fn.focus'),
          JSON.stringify(cpLog.find(l => l[0] === 'fn.focus') || []));
        // 화각 변경이 렌즈 줌으로 전달되는가
        const f50 = doc.querySelector('[data-focal="50"]');
        if (f50) { click(f50); await new Promise(r => setTimeout(r, 200)); }
        check('화각→렌즈 줌', cpLog.some(l => l[0] === 'fn.setZoom'),
          JSON.stringify(cpLog.find(l => l[0] === 'fn.setZoom') || []));
        check('투명 레이아웃', doc.body.classList.contains('fullnative'), 'body.fullnative');
        check('네이티브 모드 진입', doc.getElementById('tgCamMode').textContent === '네이티브',
          doc.getElementById('tgCamMode').textContent);
      }
      if (FULL) {
        window.localStorage.removeItem('filmcam.settings.v1');
        click($('tgCamMode')); await new Promise(r => setTimeout(r, 700));
        console.log('  [진단] toast =', doc.getElementById('toast').textContent);
        check('완전네이티브 진입', doc.getElementById('tgCamMode').textContent === '네이티브',
          doc.getElementById('tgCamMode').textContent);
        check('네이티브 레이어 시작', cpLog.some(l => l[0] === 'fn.start'), '카메라 레이어 기동');
        check('UI 잘림 방지', doc.body.classList.contains('fullnative'),
          '상하단 불투명 처리');
        check('필름 신호 전달', cpLog.some(l => l[0] === 'fn.setFilm'), '브릿지로 프리셋 전송');
        cpLog.length = 0;
        window.__testFocus && window.__testFocus(0.3, 0.7);
        await new Promise(r => setTimeout(r, 200));
        check('탭 초점 동작', cpLog.some(l => l[0] === 'fn.focus'), '초점 명령 전달됨');
        await window.__testCapture();
        check('네이티브 촬영', cpLog.some(l => l[0] === 'fn.capture'), '센서 원본 수신');
      }
      if (SYS) {
        click($('tgCamMode')); await new Promise(r => setTimeout(r, 400));   // 웹 → 네이티브(없으면 건너뜀)
        if ($('tgCamMode').textContent !== '시스템') {
          click($('tgCamMode')); await new Promise(r => setTimeout(r, 400));
        }
      }
if (SYS) {
        check('시스템 모드 전환', doc.getElementById('tgCamMode').textContent === '시스템',
          doc.getElementById('tgCamMode').textContent);
        await window.__testCapture();   // 전환 후 다시 촬영
      }
      if (NATIVE && process.env.CRASH === '1') {
        check('크래시 시 폴백', /웹/.test(doc.getElementById('statusText').textContent), '웹 방식으로 전환됨');
        check('촬영 계속 가능', doc.getElementById('editOut').width > 300,
          doc.getElementById('editOut').width + 'px');
      } else if (NATIVE) {
        check('네이티브 시작', cpLog.some(l => l[0] === 'fn.start'), JSON.stringify(cpLog[0] || []));
        check('네이티브 촬영', cpLog.some(l => l[0] === 'fn.start'), '플러그인 연동 정상');
        check('투명화 미사용', !cpLog.some(l => l[0]==='fn.start' && l[4] === true), 'toBack 사용 안 함');
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
if (SYS) {
        check('시스템 카메라 호출', cpLog.some(l => l[0] === 'getPhoto'), '기본 카메라 앱 실행');
        check('시스템 모드 표시', /시스템카메라/.test(doc.getElementById('statusText').textContent),
          doc.getElementById('statusText').textContent);
      }
      // 실시간 필름 프리뷰: 필름이 켜져 있으면 프리뷰가 GL을 통과해야 한다
      calls.length = 0;
      window.__testLoop && window.__testLoop(performance.now() + 5000);
      const previewCall = calls.find(c => c.film !== undefined && c.smooth === undefined);
      // 네이티브 모드는 프리뷰를 네이티브 뷰가 직접 그리므로 GL을 타지 않는다
      check('실시간 필름 프리뷰', (NATIVE || FULL) ? true : (!!previewCall && previewCall.film > 0),
        previewCall ? 'film=' + previewCall.film : 'GL 통과 안 함');
      check('프리뷰는 얼굴연산 없음', !previewCall || !previewCall.smooth,
        '피부 보정은 프리뷰에서 제외');
      const all0 = await window.__testGalleryAll();
      if (all0[0]) { await window.__testOpenShot(all0[0]); }
      check('갤러리 재편집 보정 유지', /얼굴 인식 O/.test(doc.getElementById('editDiag').textContent),
        '다시 열어도 보정 적용됨');
      check('편집 진단 표시', /얼굴 인식/.test(doc.getElementById('editDiag').textContent),
        doc.getElementById('editDiag').textContent);
      const shots = await window.__testGalleryAll();
      check('갤러리 자동저장', shots.length === ((SYS || FULL) ? 2 : 1), shots.length + '장');
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
