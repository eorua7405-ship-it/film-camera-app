// 보정 엔진 기능 테스트 — 실제 셰이더를 헤드리스 GL에서 실행해 각 기능이 픽셀을 바꾸는지 검증
const fs = require('fs');
const createGL = require('gl');

const app = fs.readFileSync('/mnt/user-data/outputs/app.js', 'utf8');
const VS = app.match(/const VS = `([\s\S]*?)`;/)[1];
const FS = app.match(/const FS = `([\s\S]*?)`;/)[1];

const W = 128, H = 128;
const gl = createGL(W, H);

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const uLoc = {};
['uFrame','uMask','uWarp','uTexel','uAspect','uRadius','uSmooth','uBlemish','uFilm','uSharp',
 'uContrast','uSat','uRGB','uWB','uTime','uLens','uWarpAmt','uWrinkle','uFoldL','uFoldR','uFoldRad',
 'uEye','uFlash','uFlashC','uFlashR','uLip','uFilm','uFmTone','uFmSat','uFmHi','uFmSh','uFmGrain','uFmVig'].forEach(n => uLoc[n] = gl.getUniformLocation(prog, n));

function mkTex(unit, data) {
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return t;
}

// 가짜 '얼굴' 프레임: 회색 피부(160) + 중앙에 어두운 잡티(110) + 미세 노이즈
const frame = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  let v = 160 + (Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 5) - 2;  // 비주기 결 노이즈
  const dx = x - 40, dy = y - 64;
  if (dx * dx + dy * dy < 25) v = 110;                      // 둥근 잡티 (반경 5px)
  // 팔자 라인 자리에 '선형 골' — (0.45,0.62)→(0.55,0.38) 경로를 따라 어두운 선
  for (let t2 = 0; t2 <= 1; t2 += 0.02) {
    const lx = (0.45 + 0.10 * t2) * 128, ly = (0.62 - 0.24 * t2) * 128;
    if (Math.abs(x - lx) < 1.6 && Math.abs(y - ly) < 1.6) v = 112;
  }
  frame[i] = v + 20; frame[i + 1] = v; frame[i + 2] = v - 10; frame[i + 3] = 255;
}
// 눈 흰자 영역: 밝은 회백색 + 가로 핏줄(붉은 선)
for (let y = 8; y < 20; y++) for (let x = 80; x < 100; x++) {
  const i = (y * W + x) * 4;
  frame[i] = 205; frame[i+1] = 200; frame[i+2] = 198; frame[i+3] = 255;
  if (y === 14) { frame[i] = 195; frame[i+1] = 130; frame[i+2] = 130; }
}
// 마스크: A(+R)=피부, G=눈 흰자
const mask = new Uint8Array(W * H * 4);
for (let y = 24; y < 104; y++) for (let x = 24; x < 104; x++) {
  const i = (y * W + x) * 4; mask[i + 3] = 255; mask[i] = 255;
}
// 눈 흰자 패치 (오른쪽 위 구석): G=255
for (let y = 8; y < 20; y++) for (let x = 80; x < 100; x++) {
  const i = (y * W + x) * 4; mask[i] = 0; mask[i + 1] = 255; mask[i + 3] = 255;
}
// 워프 맵: 중립(128) + 오른쪽 구역에 변위
const warp = new Uint8Array(W * H * 4);
for (let i = 0; i < W * H; i++) { warp[i*4] = 128; warp[i*4+1] = 128; warp[i*4+3] = 255; }
for (let y = 40; y < 90; y++) for (let x = 90; x < 110; x++) { warp[(y*W+x)*4] = 180; }

mkTex(0, frame); mkTex(1, mask); mkTex(2, warp);
gl.uniform1i(uLoc.uFrame, 0); gl.uniform1i(uLoc.uMask, 1); gl.uniform1i(uLoc.uWarp, 2);

function render(opt) {
  gl.viewport(0, 0, W, H);
  gl.uniform2f(uLoc.uTexel, 1 / W, 1 / H);
  gl.uniform1f(uLoc.uAspect, 1);
  gl.uniform1f(uLoc.uRadius, opt.radius ?? 8);
  gl.uniform1f(uLoc.uSmooth, opt.smooth ?? 0);
  gl.uniform1f(uLoc.uBlemish, opt.blemish ?? 0);
  gl.uniform1f(uLoc.uFilm, opt.film ?? 0);
  gl.uniform1f(uLoc.uSharp, opt.sharp ?? 0);
  gl.uniform1f(uLoc.uContrast, opt.contrast ?? 1);
  gl.uniform1f(uLoc.uSat, opt.sat ?? 1);
  gl.uniform3f(uLoc.uRGB, 1, 1, 1);
  gl.uniform1f(uLoc.uWB, opt.wb ?? 0);
  gl.uniform1f(uLoc.uTime, 0.5);
  gl.uniform1f(uLoc.uLens, opt.lens ?? 0);
  gl.uniform1f(uLoc.uWarpAmt, opt.warp ? 1 : 0);
  gl.uniform1f(uLoc.uWrinkle, opt.wrinkle ?? 0);
  gl.uniform1f(uLoc.uEye, opt.eye ?? 0);
  gl.uniform1f(uLoc.uFlash, opt.flash ?? 0);
  gl.uniform2f(uLoc.uFlashC, 0.5, 0.5);
  gl.uniform1f(uLoc.uFlashR, 0.35);
  gl.uniform4f(uLoc.uFoldL, 0.45, 0.62, 0.55, 0.38);   // 중앙 잡티를 지나는 라인
  gl.uniform4f(uLoc.uFoldR, 0.6, 0.6, 0.55, 0.4);
  gl.uniform1f(uLoc.uFoldRad, 0.08);
  gl.uniform2f(uLoc.uFmTone, 0.875, 0.045);
  gl.uniform1f(uLoc.uFmSat, 0.14);
  gl.uniform3f(uLoc.uFmHi, 1.032, 1.0, 0.968);
  gl.uniform3f(uLoc.uFmSh, 0.99, 1.0, 0.86);
  gl.uniform1f(uLoc.uFmGrain, 0.04);
  gl.uniform1f(uLoc.uFmVig, 0.22);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return px;
}

const at = (px, x, y) => px[((y * W) + x) * 4 + 1];   // G 채널
const diff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i += 4) s += Math.abs(a[i+1] - b[i+1]); return s / (a.length / 4); };

const base = render({});
const tests = [];

// 1. 잡티: 어두운 점(110)이 주변(160) 쪽으로 밝아져야 함
const bl = render({ blemish: 0.75 });
tests.push(['잡티 제거', at(bl, 40, 64) - at(base, 40, 64) > 8,
  `잡티 밝기 ${at(base,40,64)} → ${at(bl,40,64)}`]);

// 2. 피부결: 마스크 안 노이즈 분산이 줄어야 함
const variance = (px) => { let m=0,c=0; for(let y=30;y<60;y++)for(let x=74;x<104;x++){m+=at(px,x,y);c++;} m/=c;
  let v=0; for(let y=30;y<60;y++)for(let x=74;x<104;x++) v+=(at(px,x,y)-m)**2; return v/c; };
const sm = render({ smooth: 0.65 });
tests.push(['피부결', variance(sm) < variance(base) * 0.9,
  `노이즈 분산 ${variance(base).toFixed(2)} → ${variance(sm).toFixed(2)}`]);

// 3a. 주름: 선형 골은 밝아져야 함 (라인 위 t=0.25 지점 = (61,71))
const wr = render({ wrinkle: 0.5 });
tests.push(['주름(선형 골)', at(wr, 61, 71) - at(base, 61, 71) > 5,
  `골 밝기 ${at(base,61,71)} → ${at(wr,61,71)}`]);
// 3b. 주름: 둥근 잡티는 건드리면 안 됨 (점/선 구분)
tests.push(['주름(잡티 보호)', Math.abs(at(wr, 40, 64) - at(base, 40, 64)) <= 2,
  `잡티 밝기 ${at(base,40,64)} → ${at(wr,40,64)} (변화 없어야 정상)`]);

// 4. 필름: 전체 픽셀이 유의미하게 변해야 함
const fm = render({ film: 0.8 });
tests.push(['필름', diff(fm, base) > 3, `평균 변화량 ${diff(fm, base).toFixed(2)}`]);

// 5. 윤곽 워프: 변위 구역의 픽셀이 이동해야 함
const wp = render({ warp: true });
tests.push(['윤곽 워프', diff(wp, base) > 0.05, `평균 변화량 ${diff(wp, base).toFixed(3)}`]);

// 6. 마스크 밖 보호: 피부 보정이 마스크 밖(10,10)을 건드리면 안 됨
tests.push(['마스크 보호', Math.abs(at(sm, 10, 10) - at(base, 10, 10)) <= 1,
  `마스크 밖 ${at(base,10,10)} → ${at(sm,10,10)}`]);

// 8. 유령(겹침) 방지: 눈썹 같은 뚜렷한 구조가 잡티 제거로 복제되면 안 됨
//    강한 가로 엣지를 만들고, 잡티 최대 강도에서 그 구조가 옆으로 번지는지 검사
const frame2 = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  let v = 160 + (Math.abs(Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 5) - 2;
  if (y >= 44 && y <= 50) v = 70;          // 눈썹 같은 진한 가로선
  frame2[i] = v + 20; frame2[i+1] = v; frame2[i+2] = v - 10; frame2[i+3] = 255;
}
gl.activeTexture(gl.TEXTURE0);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame2);
const g0 = render({});
const g1 = render({ blemish: 1.0 });
// 선에서 충분히 떨어진 깨끗한 피부(y=75~95)가 어두워지면 = 구조가 복제된 것
let ghost = 0, n = 0;
for (let y = 75; y < 95; y++) for (let x = 35; x < 95; x++) { ghost += Math.abs(at(g1,x,y) - at(g0,x,y)); n++; }
ghost /= n;
tests.push(['유령 방지', ghost < 4, `깨끗한 영역 변화량 ${ghost.toFixed(2)} (작아야 정상)`]);
gl.activeTexture(gl.TEXTURE0);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);

// 9. 눈 보정: 핏줄 붉은기 감소 + 흰자 밝기 상승
const ey = render({ eye: 0.6 });
const redAt = (px,x,y) => px[((y*W)+x)*4] - (px[((y*W)+x)*4+1] + px[((y*W)+x)*4+2]) / 2;
tests.push(['눈(핏줄)', redAt(ey, 90, 14) < redAt(base, 90, 14) - 8,
  `핏줄 붉은기 ${redAt(base,90,14).toFixed(0)} → ${redAt(ey,90,14).toFixed(0)}`]);
tests.push(['눈(밝기)', at(ey, 90, 11) > at(base, 90, 11) + 3,
  `흰자 밝기 ${at(base,90,11)} → ${at(ey,90,11)}`]);

// 10. 주름 마스크 게이트: 이웃이 마스크 밖(입술 등)이면 연산 차단 → 겹침 방지
//     마스크 밖 어두운 가로 바 옆의 피부가 주름 최대 강도에서도 변하면 안 됨
const frame3 = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4;
  let v = 160;
  if (y >= 60 && y <= 66 && x >= 40 && x <= 90) v = 60;   // 입술 같은 어두운 바
  frame3[i] = v + 20; frame3[i+1] = v; frame3[i+2] = v - 10; frame3[i+3] = 255;
}
const mask3 = new Uint8Array(mask);
for (let y = 57; y <= 69; y++) for (let x = 37; x <= 93; x++) {
  const i = (y * W + x) * 4; mask3[i+3] = 0;               // 입술 영역은 마스크에서 제외
}
gl.activeTexture(gl.TEXTURE0);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame3);
gl.activeTexture(gl.TEXTURE1);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask3);
const w0 = render({});
const w1 = render({ wrinkle: 1.0 });
// '구조적 겹침' 판별: 겹침 = 원본에 없던 급격한 에지가 Δ맵에 생기는 것.
// 볼륨 리라이팅의 부드러운 falloff는 Δ기울기가 완만하므로 통과한다.
let maxGrad = 0, lmean = 0, ln = 0;
for (let y = 71; y < 80; y++) for (let x = 45; x < 84; x++) {
  const d1 = at(w1,x,y) - at(w0,x,y);
  const d2 = at(w1,x+1,y) - at(w0,x+1,y);
  maxGrad = Math.max(maxGrad, Math.abs(d2 - d1));
  lmean += d1; ln++;
}
lmean /= ln;
tests.push(['주름 게이트', maxGrad <= 3 && Math.abs(lmean) < 7,
  `입술 인접: Δ기울기 최대 ${maxGrad} (겹침이면 급증) / 평균 ${lmean.toFixed(2)}`]);
gl.activeTexture(gl.TEXTURE0);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, frame);
gl.activeTexture(gl.TEXTURE1);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask);

// 12. 해부학적 제외 구역(B채널): 콧볼 골 같은 정상 굴곡은 잡티 보정이 닿지 않아야 함
const maskB = new Uint8Array(mask);
for (let y = 40; y < 56; y++) for (let x = 40; x < 56; x++) {
  const i = (y * W + x) * 4; maskB[i + 2] = 255;          // B=255 → 잡티 제외
}
gl.activeTexture(gl.TEXTURE1);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, maskB);
const bx0 = render({});
const bx1 = render({ blemish: 1.0 });
const bDelta = Math.abs(at(bx1, 48, 48) - at(bx0, 48, 48));
tests.push(['B채널 제외', bDelta <= 1, `제외 구역 잡티 변화량 ${bDelta} (0이어야 정상)`]);
gl.activeTexture(gl.TEXTURE1);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, mask);

// 13. 플래시 필터: 직광 플래시 = 가까운 곳은 밝고 먼 곳은 급격히 어두워짐
const fl = render({ flash: 0.9 });
const near = at(fl, 64, 64) - at(base, 64, 64);   // 얼굴(마스크 안)
const far2 = at(fl, 8, 8) - at(base, 8, 8);       // 배경(마스크 밖)
tests.push(['플래시(피사체 분리)', near > 6 && far2 < -25,
  `얼굴 ${near > 0 ? '+' : ''}${near} / 배경 ${far2} (배경이 확실히 죽어야 정상)`]);
// 입술 영역이 주변 피부보다 붉고 밝은가
const redOf = (p,x,y)=>p[((y*W)+x)*4] - (p[((y*W)+x)*4+1]+p[((y*W)+x)*4+2])/2;
// 얼굴 안에 원형 스포트라이트가 생기면 안 된다 (레퍼런스는 고르게 밝다)
const faceDeltas = [];
for (let y = 40; y < 90; y += 6) for (let x = 40; x < 90; x += 6) faceDeltas.push(at(fl,x,y) - at(base,x,y));
const fMean = faceDeltas.reduce((a,b)=>a+b,0)/faceDeltas.length;
const fSpread = Math.max(...faceDeltas) - Math.min(...faceDeltas);
tests.push(['플래시(스포트라이트 없음)', fSpread < 45,
  `얼굴 내 밝기 편차 ${fSpread} (작아야 고르게 빛남, 평균 ${fMean.toFixed(0)})`]);
let lipBest = -999, lipY = 0;
for (let y = 30; y < 100; y++) { const v = redOf(fl,64,y) - redOf(base,64,y); if (v > lipBest) { lipBest = v; lipY = y; } }
const lipRef = redOf(fl,64,20) - redOf(base,64,20);
tests.push(['플래시(입술 광택)', lipBest > lipRef + 2,
  '입술부 붉은기 ' + lipBest.toFixed(1) + ' @y=' + lipY + ' / 주변 ' + lipRef.toFixed(1)]);
tests.push(['플래시(끄면 무변화)', Math.abs(at(render({ flash: 0 }), 64, 64) - at(base, 64, 64)) <= 1,
  '플래시 0에서 원본 유지']);

let fail = 0;
for (const [name, ok, detail] of tests) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(8)} ${detail}`);
  if (!ok) fail++;
}
process.exit(fail ? 1 : 0);
