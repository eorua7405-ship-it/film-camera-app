#!/bin/bash
# 전체 테스트 한 번에 실행
echo "═══ 1. 보정 엔진 (셰이더 계산 검증) ═══"
xvfb-run -a node /tmp/engine-test.js || exit 1
echo ""
echo "═══ 2. 실사 사진 (겹침·아티팩트 검증) ═══"
xvfb-run -a node /tmp/realphoto-test.js 2>&1 | grep -E "PASS|FAIL|변화량|기울기" || exit 1
echo ""
echo "═══ 3. UI 통합 (버튼·슬라이더·촬영 흐름 배선 검증) ═══"
node /tmp/ui-test.js || exit 1

echo ""
echo "═══ 4. 시스템 카메라 경로 ═══"
SYS=1 node /tmp/ui-test.js || exit 1
