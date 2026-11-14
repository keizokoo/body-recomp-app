# 바디 리컴포지션 (body-recomp-app)

## 무엇
- 인바디·운동·식단·걸음수·마운자로(GLP-1)를 추적하는 개인용 PWA.
- 파일: index.html(단일 파일, 약 0.6MB) · sw.js · manifest.json · 아이콘.
- 데이터: Google 시트(InBody·식단·운동 등 탭) ↔ Apps Script 웹앱으로 동기화(`cloudSync`, pull 계열 함수).
- 서버 코드 Code.gs: **저장소에 없음** → `gas/Code.gs`로 추가 예정.

## 이 앱만의 주의점
- 분석·월간 점검 로직은 `body-recomp-analysis`, `body-recomp-monthly-review` 스킬 기준을 따른다.
- 목표(확정 계획): 골격근 33kg 복구 + 체지방률 16~17%. 점검은 월 1회 (일·주 단위 점검 기능은 만들지 않는다).
- 시트 열 구조(예: InBody의 bodyType, meals의 creatine)를 바꾸면 Code.gs와 기존 데이터 호환을 확인.
- `deploy-test.txt`: 예전 Drive→Apps Script→GitHub 자동 업로드 파이프라인 테스트 흔적.

## 배포
- 확인 필요: GitHub Pages인지 다른 호스팅인지.

## 작업 규칙 (모든 앱 공통)
- 코드 수정: `solo-app-code-edit` 스킬 절차를 따른다. 새 기능·탭 추가: `solo-app-new-build` 스킬.
- Apps Script·시트·배포 콘솔처럼 사용자가 직접 화면을 조작해야 하면 `gas-nondev-walkthrough` 스타일로 단계별 안내.
- index.html은 단일 파일이고 크다 → 전체를 다시 쓰지 말고 필요한 부분만 수정. 수정 전에 grep으로 관련 코드를 모두 찾을 것.
- 배포할 때마다 sw.js의 `CACHE_NAME` 버전을 올린다 (안 올리면 PWA가 옛 화면을 계속 보여줌).
- localStorage 키 이름(`*_v1` 등)을 바꾸면 기존 사용자 데이터가 사라진 것처럼 보인다 → 바꿀 때는 이전(마이그레이션) 코드 필수.
- 시트 동기화(push/pull) 형식을 바꾸면 Apps Script `Code.gs`도 같이 바꿔야 한다 → 사용자에게 Apps Script 수정·재배포 단계를 따로 안내.
- 작업은 브랜치 → PR → 사용자가 병합. main에 직접 push하지 않는다.
- 변경 후 Playwright로 index.html을 열어 콘솔 오류가 없는지 확인한다.

## 사용자
- 비개발자 1인 운영. 설명은 한국어 존댓말, 결론 먼저, 사용자가 할 일은 번호 매긴 단계로.

## 결정 기록 (채팅에서 확정한 사항을 한 줄씩 추가)
- (비어 있음)
