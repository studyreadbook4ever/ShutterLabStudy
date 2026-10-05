# 실행 가이드

## 가장 빠른 시작

GitHub에서 저장소를 clone하거나 **Code → Download ZIP**으로 내려받은 뒤 압축을 해제합니다. Node.js 22 이상이 설치된 터미널에서 프로젝트 폴더로 이동합니다.

```sh
git clone https://github.com/studyreadbook4ever/ShutterLabStudy.git
cd ShutterLabStudy
node --version
npm start
```

<http://127.0.0.1:4317>을 Chromium 또는 Chrome에서 엽니다. WebGL2를 사용할 수 있으면 CUDA가 없어도 실험 화면이 동작합니다. 앱은 로컬에서 실행되며 외부 서비스 계정이 필요하지 않습니다.

`sh scripts/setup.sh`는 Node 버전을 확인하고 실행 방법을 안내합니다. 기본 실행은 패키지를 설치하지 않습니다.

| 명령 | 목적 |
| --- | --- |
| `npm start` | 로컬 앱 실행 |
| `SHUTTER_PORT=4318 npm start` | 다른 포트로 실행 |
| `sh scripts/setup.sh --dev` | 검증용 개발 의존성 설치 |
| `sh scripts/setup.sh --dev --browser` | 개발 의존성과 Playwright Chromium 설치 |
| `sh scripts/setup.sh --cuda` | CUDA 렌더러 빌드 |
| `sh scripts/setup.sh --help` | 준비 스크립트 옵션 보기 |

## CUDA 실행 경로

GPU가 없어도 브라우저 모드가 동작하지만, `.cu` 코드를 실습하려면 NVIDIA GPU·호환 드라이버·CUDA Toolkit 12 이상과 `make`가 필요합니다. 기본 Makefile은 `nvcc`와 `-arch=native`를 사용합니다. 컴파일러 경로와 GPU 아키텍처를 환경에 맞게 지정할 수 있습니다.

```sh
npm run build:cuda
native/shutter-renderer --info
native/shutter-renderer --self-test
npm start
```

컴파일된 렌더러와 실제 CUDA 장치를 사용할 수 있으면 앱이 CUDA 경로를 선택합니다. 빌드 전에 켠 서버는 종료하고 다시 실행하세요. 화면의 백엔드 이름과 장치 이름이 현재 실행 경로를 보여 줍니다. GUI에서 WebGL2를 선택할 수도 있습니다.

```sh
NVCC=/path/to/nvcc CUDA_ARCH=sm_XX npm run build:cuda
```

컴파일된 바이너리는 플랫폼과 GPU 환경에 종속되므로 배포본에 포함하지 않습니다. 받은 저장소에서 직접 빌드합니다. 자세한 설정은 [네이티브 렌더러 문서](../native/README.md)에 있습니다.

## 브라우저 검증

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

Linux에서 브라우저 시스템 라이브러리가 없다면 `npx playwright install --with-deps chromium`을 사용할 수 있습니다. 이 옵션은 운영체제 패키지 설치 권한이 필요할 수 있습니다. 이미 설치된 Chromium은 `CHROMIUM_PATH=/usr/bin/chromium npm run test:browser`로 지정합니다.

테스트는 별도의 로컬 서버를 자동 실행하고 종료합니다. 외부에서 실행한 서버에 연결하려면 `SHUTTER_TEST_URL=http://127.0.0.1:4317 npm run test:browser`로 지정합니다.

## 문제 해결

| 증상 | 확인할 내용 |
| --- | --- |
| `npm` 또는 `node`를 찾을 수 없음 | Node.js 22 이상을 설치한 뒤 새 터미널 실행 |
| 주소를 열 수 없음 | `npm start` 터미널이 살아 있는지, 출력된 포트가 맞는지 확인 |
| `EADDRINUSE` | 다른 포트로 실행하거나 해당 포트의 기존 서버 종료 |
| CUDA 컴파일러를 찾을 수 없음 | Toolkit 설치와 `NVCC` 경로 확인; 우선 WebGL2 모드로 실행 가능 |
| CUDA 빌드 후에도 WebGL2 표시 | 서버 재시작, `--info` 실행, GPU·드라이버 호환 확인 |
| WebGL2를 사용할 수 없음 | Chromium의 하드웨어 가속 설정과 `chrome://gpu` 확인 |
| 이미지 갱신이 느림 | 시간 샘플 수·해상도를 줄이고 실제 렌더러 표시 확인 |
| 긴 노출에서 잔상이 층으로 보임 | 시간 샘플 수 증가; 매우 빠른 회전에서는 유한 샘플링의 한계가 있음 |

[실험 가이드](experiments.md)와 [모델 설명](physics.md)으로 이어서 실습할 수 있습니다.
