// 실사 사진 겹침 검증: 사용자가 올린 셀카에 최대 강도 보정 후
// (1) 겹침 = 원본에 없던 고주파 에지가 Δ맵에 생기는지
// (2) 효과 = 실제로 픽셀이 변하긴 하는지
const fs = require('fs');
const Jimp = require('jimp');
const createGL = require('gl');

(async () => {
  const app = fs.readFileSync('/mnt/user-data/outputs/app.js', 'utf8');
  const VS = app.match(/const VS = `([\s\S]*?)`;/)[1];
  const FS = app.match(/const FS = `([\s\S]*?)`;/)[1];

  const img = await Jimp.read('/mnt/user-data/uploads/KakaoTalk_20260827_155409206.jpg');
  // 스크린샷에서 사진 영역만 크롭 (상단 UI·하단 버튼 제외)
  img.crop(0, Math.round(img.bitmap.height * 0.30), img.bitmap.width, Math.round(img.bitmap.height * 0.32));
  img.resize(256, Jimp.AUTO);
  const W = img.bitmap.width, H = img.bitmap.height;
  console.log(`사진 로드: ${W}x${H}`);

  const gl = createGL(W, H);
  const compile = (ty, src) => { const s = gl.createShader(ty); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,3,-1,-1,3]), gl.STATIC_DRAW);
  const aPos = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const uLoc = {};
  ['uFrame','uMask','uWarp','uTexel','uAspect','uRadius','uSmooth','uBlemish','uEye','uWrinkle',
   'uFoldL','uFoldR','uFoldRad','uWarpAmt','uLens','uSharp','uContrast','uSat','uRGB','uWB',
   'uFilm','uTime','uFmTone','uFmSat','uFmHi','uFmSh','uFmGrain','uFmVig']
    .forEach(n => uLoc[n] = gl.getUniformLocation(prog, n));

  const mkTex = (unit, data) => { const t = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, data); };

  const frame = new Uint8Array(img.bitmap.data);
  // 피부 마스크: 살구톤 휴리스틱 (r>g>b, 충분히 밝음)
  const mask = new Uint8Array(W * H * 4);
  let minX = W, maxX = 0, minY = H, maxY = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const r = frame[i], g = frame[i + 1], b = frame[i + 2];
    if (r > 95 && r > g && g > b - 8 && r - b > 12 && r - b < 110 && r < 250) {
      mask[i] = 255; mask[i + 3] = 255;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
  }
  console.log(`피부 영역: x ${minX}-${maxX}, y ${minY}-${maxY}`);
  // 앱의 피부 파싱과 동일: 검은 구멍(콧구멍 등)은 4px 팽창시켜 마스크에서 제외
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (frame[(y * W + x) * 4 + 1] >= 55) continue;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy < 0 || yy >= H || xx < 0 || xx >= W) continue;
      mask[(yy * W + xx) * 4 + 3] = 0; mask[(yy * W + xx) * 4] = 0;
    }
  }
  // 실제 앱 마스크처럼 경계를 부드럽게 (5px 박스 블러 2회)
  for (let pass = 0; pass < 2; pass++) {
    const src = new Uint8Array(mask);
    for (let y = 2; y < H - 2; y++) for (let x = 2; x < W - 2; x++) {
      let s = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
        s += src[((y + dy) * W + (x + dx)) * 4 + 3];
      mask[(y * W + x) * 4 + 3] = s / 25;
      mask[(y * W + x) * 4] = s / 25;
    }
  }
  const warp = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) { warp[i*4] = 128; warp[i*4+1] = 128; warp[i*4+3] = 255; }
  mkTex(0, frame); mkTex(1, mask); mkTex(2, warp);
  gl.uniform1i(uLoc.uFrame, 0); gl.uniform1i(uLoc.uMask, 1); gl.uniform1i(uLoc.uWarp, 2);

  const faceW = maxX - minX;
  const cx = (minX + maxX) / 2 / W, cy = (minY + maxY * 2) / 3 / H;   // 하관 근처
  const rad = faceW / W * 0.085;
  const render = (o) => {
    gl.viewport(0, 0, W, H);
    gl.uniform2f(uLoc.uTexel, 1 / W, 1 / H);
    gl.uniform1f(uLoc.uAspect, H / W);
    gl.uniform1f(uLoc.uRadius, Math.max(2.5, faceW * 0.03));
    gl.uniform1f(uLoc.uSmooth, o.smooth ?? 0);
    gl.uniform1f(uLoc.uBlemish, o.blemish ?? 0);
    gl.uniform1f(uLoc.uEye, 0);
    gl.uniform1f(uLoc.uWrinkle, o.wrinkle ?? 0);
    gl.uniform4f(uLoc.uFoldL, cx - 0.08, 1 - (cy - 0.05), cx - 0.11, 1 - (cy + 0.06));
    gl.uniform4f(uLoc.uFoldR, cx + 0.08, 1 - (cy - 0.05), cx + 0.11, 1 - (cy + 0.06));
    gl.uniform1f(uLoc.uFoldRad, rad);
    gl.uniform1f(uLoc.uWarpAmt, 0); gl.uniform1f(uLoc.uLens, 0);
    gl.uniform1f(uLoc.uSharp, 0); gl.uniform1f(uLoc.uContrast, 1); gl.uniform1f(uLoc.uSat, 1);
    gl.uniform3f(uLoc.uRGB, 1, 1, 1); gl.uniform1f(uLoc.uWB, 0);
    gl.uniform1f(uLoc.uFilm, 0); gl.uniform1f(uLoc.uTime, 0.5);
    gl.uniform2f(uLoc.uFmTone, 1, 0); gl.uniform1f(uLoc.uFmSat, 0);
    gl.uniform3f(uLoc.uFmHi, 1, 1, 1); gl.uniform3f(uLoc.uFmSh, 1, 1, 1);
    gl.uniform1f(uLoc.uFmGrain, 0); gl.uniform1f(uLoc.uFmVig, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };

  const base = render({});
  const full = render({ smooth: 0.9, blemish: 1.0, wrinkle: 1.0 });   // 전부 최대 강도
  // 범인 분리
  const only = {
    피부결: render({ smooth: 0.9 }),
    잡티: render({ blemish: 1.0 }),
    주름: render({ wrinkle: 1.0 }),
  };
  const atP = (p, x, y) => p[((H - 1 - y) * W + x) * 4 + 1];
  console.log('=== (87,108) 주변 원본 G값 ===');
  for (let y = 104; y <= 112; y++) {
    let row = '';
    for (let x = 82; x <= 93; x++) row += String(frame[((y*W)+x)*4+1]).padStart(4);
    console.log('y='+y, row);
  }
  for (const [name, px] of Object.entries(only)) {
    for (let y = 106; y <= 110; y++) {
      let row = '';
      for (let x = 82; x <= 93; x++) row += String(atP(px,x,y) - atP(base,x,y)).padStart(4);
      console.log(name + ' Δ(y='+y+'):', row);
    }
  }

  // (1) 효과 확인: 피부 픽셀 평균 변화
  // (2) 겹침 검사: Δ맵의 급격한 에지 (겹침 = 구조 복제 = 원본에 없던 에지)
  const at = (p, x, y) => p[((H - 1 - y) * W + x) * 4 + 1];   // readPixels는 상하 반전
  // Δ맵 좌표 (x,y) → 원본 배열 좌표 (x, H-1-y) 로 통일해 읽는 헬퍼
  const fG = (x, y) => frame[((H - 1 - y) * W + x) * 4 + 1];
  const mA = (x, y) => mask[((H - 1 - y) * W + x) * 4 + 3];
  let sumD = 0, n = 0, maxGrad = 0, gradPos = null;
  for (let y = minY + 2; y < maxY - 2; y++) for (let x = minX + 2; x < maxX - 2; x++) {
    // 완전한 피부 내부만 검사 (마스크 경계 전이 구간 제외)
    let mmin = 255;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++)
      mmin = Math.min(mmin, mA(x + dx, y + dy));
    if (mmin < 250) continue;
    // 원래부터 강한 에지였던 자리(콧구멍·눈·머리카락 인접)는 제외 —
    // 검증 목표는 '매끈한 피부 위에 새 구조가 생기는가'이므로
    let omin = 255, omax = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const v = fG(x + dx, y + dy);
      if (v < omin) omin = v; if (v > omax) omax = v;
    }
    if (omax - omin > 25) continue;
    const d = at(full, x, y) - at(base, x, y);
    const dR = at(full, x + 1, y) - at(base, x + 1, y);
    const dD = at(full, x, y + 1) - at(base, x, y + 1);
    sumD += Math.abs(d); n++;
    const g2 = Math.max(Math.abs(dR - d), Math.abs(dD - d));
    // 원본이 '함몰'(주변보다 어두운 실제 잡티)인 지점의 복구 에지는 정상 동작.
    // 매끈한 피부 위에서 생긴 큰 에지만 '겹침'이다.
    let nb = 0, nc = 0;
    for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
      if (Math.abs(dx) < 4 && Math.abs(dy) < 4) continue;
      nb += fG(x + dx, y + dy); nc++;
    }
    const isPit = nb / nc - fG(x, y) > 4;
    if (g2 > maxGrad && !isPit && mA(x+1, y) && mA(x, y+1)) { maxGrad = g2; gradPos = [x, y]; }
  }
  // 콧구멍/검은 구멍 주변 하이라이트 검사
  let haloViol = 0, haloChecked = 0, worstHalo = 0, haloPos = null;
  for (let y = minY + 6; y < maxY - 6; y++) for (let x = minX + 6; x < maxX - 6; x++) {
    let nearHole = false;
    for (let dy = -6; dy <= 6 && !nearHole; dy++) for (let dx = -6; dx <= 6; dx++) {
      if (fG(x + dx, y + dy) < 55) { nearHole = true; break; }
    }
    if (!nearHole) continue;
    haloChecked++;
    const d = at(full, x, y) - at(base, x, y);
    if (d > worstHalo) { worstHalo = d; haloPos = [x, y]; }
    if (d > 8) haloViol++;
  }
  console.log(`구멍 인접 픽셀 ${haloChecked}개 중 밝힘 위반 ${haloViol}개 (최대 +${worstHalo} @ ${haloPos})`);
  console.log(haloViol === 0 ? 'PASS  구멍 주변 하이라이트 없음' : 'FAIL  구멍 주변 하이라이트');
  console.log(`피부 픽셀 ${n}개 검사`);
  console.log(`평균 변화량: ${(sumD/n).toFixed(2)} (0이면 효과 없음)`);
  console.log(`Δ 최대 기울기: ${maxGrad} @ ${gradPos} (겹침이면 20+ 급증, 정상은 한 자릿수)`);
  const effect = sumD / n > 0.8;
  const noGhost = maxGrad <= 12;
  console.log(effect ? 'PASS  효과 존재' : 'FAIL  효과 없음');
  console.log(noGhost ? 'PASS  겹침 없음 (실사 검증)' : 'FAIL  겹침 의심');
  // 결과 저장 (사용자 확인용)
  const outImg = new Jimp(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const si = ((H - 1 - y) * W + x) * 4, di = (y * W + x) * 4;
    outImg.bitmap.data[di] = full[si]; outImg.bitmap.data[di+1] = full[si+1];
    outImg.bitmap.data[di+2] = full[si+2]; outImg.bitmap.data[di+3] = 255;
  }
  await outImg.writeAsync('/mnt/user-data/outputs/실사검증-최대강도보정.jpg');
  process.exit(effect && noGhost && haloViol === 0 ? 0 : 1);
})();
