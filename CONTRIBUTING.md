# 기여하기

물리 모델, 카메라 투영, UI, 문서 개선을 환영합니다. 변경의 목적과 사용자가 관찰할 동작을 PR에 설명해 주세요. 물리·렌더링 변경에는 재현 가능한 파라미터나 관련 검증 결과를 함께 남겨 주세요.

이 프로젝트는 [The Unlicense](LICENSE)를 사용합니다. 제출하는 기여에도 같은 조건이 적용됩니다.

## 개발 환경

Node.js 22 이상을 사용합니다. 앱의 런타임은 Node 내장 모듈과 브라우저 API만 사용하며, Playwright는 브라우저 검증용 개발 의존성입니다.

```sh
npm ci
npx playwright install chromium
npm start
```

한 번에 준비하려면 `sh scripts/setup.sh --dev --browser`를 실행할 수 있습니다. CUDA 환경 준비는 [실행 가이드](docs/getting-started.md)를 참고하세요.

## 변경 확인

```sh
npm test
npm run check
npm run test:browser
```

브라우저 테스트는 전용 서버를 자동 실행합니다. 시스템 Chromium을 사용하려면 `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`로 실행합니다. 이미 실행 중인 서버는 `SHUTTER_TEST_URL=http://127.0.0.1:4317 npm run test:browser`로 지정합니다. 검증 아티팩트는 `artifacts/`에 저장됩니다. 이 폴더의 임시 결과, `node_modules/`, 컴파일된 CUDA 바이너리는 커밋하지 않습니다.

CUDA를 수정했다면 GPU가 있는 환경에서 다음 검증도 실행합니다.

```sh
npm run build:cuda
native/shutter-renderer --self-test
# npm start로 실행한 CUDA 서버를 대상으로
npm run test:api
```

물리·카메라 계약을 바꾸면 [모델 문서](docs/physics.md)와 두 렌더러를 함께 확인하세요. WebGL2와 CUDA의 픽셀이 같은 것은 요구하지 않지만, 시간 기준·단위·셔터 방향·카메라 정의는 같아야 합니다.

## 변경 원칙

- 물리 상태는 rad·rad/s·s, 화면 설정은 rpm·ms 단위를 사용합니다. 경계에서 명시적으로 변환합니다.
- 두 셔터는 같은 상태에서 렌더링합니다. 서로 다른 프레임을 비교 화면에 섞지 않습니다.
- 읽기 시간 0, 정지한 물체, 역방향 읽기, 긴 노출을 확인합니다.
- 관성은 독립 설정이며 물체 선택 시 권장 초기값을 적용합니다. 형상·질량에서 관성을 계산하는 변경은 별도의 계약으로 다룹니다.
- GPU가 없는 실행 경로도 유지하고 실제 CUDA와 브라우저 렌더러 표시를 구분합니다.
- 의존성을 추가할 때는 필요한 이유와 런타임/개발 용도를 설명합니다.

버그 보고에는 브라우저와 운영체제, 렌더러 이름, 재현 순서, 저장한 JSON을 첨부하면 도움이 됩니다. GPU 문제라면 CUDA Toolkit·드라이버 버전과 `native/shutter-renderer --info` 출력도 포함해 주세요.
