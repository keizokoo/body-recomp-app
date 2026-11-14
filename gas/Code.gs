/**
 * 바디 리컴포지션 앱 - 클라우드 동기화 백엔드
 *
 * [2026-11-11b 수정] 추가 속도 개선(2026-11-11 배포 후 실측: 시트 하나 읽는 데 0.3~1.3초 — 데이터 양보다 시트 API 호출 횟수가 시간을 좌우함. 앱 2026-11-11-a와 짝, 점수 공식·시트 구조·응답 필드는 그대로).
 *    ①시트 헤더 확인(getLastColumn+헤더 읽기 2회)을 배포 버전당 한 번만 하고 캐시(CacheService)로 건너뜀 — getOrCreateSheet_ (시트당 호출 약 7→3회)
 *    ②앱이 보낸 본문(POST)은 컬렉션별로 직전에 처리한 본문과 지문이 같으면 그 시트를 읽지도 쓰지도 않음(채팅 업로드·?push 경로는 그대로 항상 처리) — applyIncoming_
 *    ③스크립트 속성은 한 번에 읽고 모아서 한 번에 저장(propGet_/propSet_/propsFlush_), 인박스가 비었으면 processed 폴더 조회 생략 — processInbox_
 *    ④점수 재계산을 건너뛴 저장이면 응답에서 점수 시트 2개 읽기를 생략(앱은 점수가 없으면 기존 값 유지)
 *
 * [2026-11-11 수정] 동기화 속도 개선(앱 2026-11-10-c와 호환, 앱 수정 없음. 점수 공식·시트 구조·응답 필드는 그대로, 응답에 codeVersion·단계별 시간만 추가).
 *    ①한 번의 요청 안에서 같은 시트를 여러 번 읽던 것을 읽기 캐시로 한 번만 읽음(쓰기 직후엔 해당 시트 캐시를 비움) — readSheet_/upsertSheet_
 *    ②날짜·주별 점수를 날짜마다 시트를 읽고 쓰던 것을 한 번에 묶어 저장하고, updatedAt만 다른 행은 다시 쓰지 않음 — refreshDailyScoresForDates_/refreshWeeklyScoresForDates_
 *    ③바뀐 기록이 없고 오늘 이미 점수를 계산했다면(스크립트 속성 scoresRefreshedDay) 점수 재계산을 건너뜀 — applyIncoming_
 *    ④PR 검사는 이미 검사한 운동(날짜|이름|세트 내용 서명 같음, 속성 prSeen)을 건너뜀 — checkAndNotifyExercisePRs_
 *    ⑤전체 조회의 리포트 이력은 시트 전체가 아니라 끝쪽 60행만 읽어 최근 30건을 만듦(앱이 받는 내용 동일), ?days=N 조회는 날짜 열로 대상 행을 먼저 찾아 그 구간만 읽음
 *    ⑥전체 조회 응답의 stageMs에 시트별 누적 소요시간(r-시트이름)을 추가(앱 동기화 배지에 그대로 표시됨. 값은 요청 시작 후 누적 초). 끄려면 STAGE_DETAIL_ = false
 *
 * [2026-11-10 수정] 전체 조회(앱 열기·지금 동기화)가 22초 넘게 걸려 시간 초과되던 문제 개선(앱 2026-11-10-b와 짝, 점수 계산·시트 구조는 그대로).
 *    ①전체 조회에서 인박스를 처리하다 시간이 오래 걸리면(요청 시작 후 9초 경과) 남은 파일은 1분 트리거에 맡기고 먼저 응답 ②드라이브 일시 오류 재시도(2초·4초 대기)는
 *    전체 조회 중에는 하지 않음(트리거가 이미 재시도) ③트리거 점검(ScriptApp.getProjectTriggers)은 6시간에 한 번만 ④가벼운 조회(light)는 앱이 쓰지 않는 ReportHistory를
 *    읽지 않음 ⑤응답에 단계별 소요시간 stageMs를 담고 스크립트 속성 lastGetStages에도 남김(원인 추적용). 파라미터 없는 옛 동작·응답 필드는 그대로.
 *
 * [2026-11-09c 수정] 동기화 속도 개선(앱 index.html 2026-11-09-l과 짝, 점수 계산·시트 구조는 그대로). ①upsertSheet_: 시트를 레코드마다 다시 읽던 것을 한 번만 읽고, 값이 그대로인 행은 쓰지 않고, 새 행은 한 번에 붙임
 *    ②applyIncoming_: 앱이 매번 보내는 최근 14일 전체가 아니라 실제로 바뀐 기록의 날짜 + 오늘만 점수 재계산 ③Meta 읽기 캐시(키마다 시트 전체를 다시 읽던 것)·값이 같으면 쓰지 않음
 *    ④doGet ?light=1(인박스 확인·트리거 점검 생략)·?days=N(최근 N일만) 지원, 응답에 serverMs(서버 소요 ms) 추가. 파라미터가 없으면 예전과 똑같이 동작.
 *
 * [2026-11-09b 수정] 주간 점수 근력 — 턱걸이 인정 규칙 개정(정희님 확정 2026-11-09): 옛 "주 100회" 규칙 폐지. 월~일에 턱걸이(풀업·친업, 밴드 보조 포함)를 '유효 세트'(정상 가동범위 반복 5회 이상 + 세트 종료 RIR 0~4 입력,
 *    시도 횟수가 있으면 정상 반복 이하가 아니어야 함)로 한 날이 2일 이상이고 유효 세트 합계가 6세트 이상이면 근력 +1(최대 1). 실제 근력일이 이미 2회면 더하지 않음(점수 상한 2회). 매달리기·RIR 없는 옛 기록은 불인정.
 *    앱 내부 주간 활동 점수일 뿐 전신 근력운동 1회와 생리학적으로 같다는 뜻이 아님. 바꾼 곳: wsPullValidSet_·wsPullWeek_ 신설(wsPullReps_ 삭제)·computeWeeklyScore_·formatWeeklyScoreBlock_·WEEKLY_SCORE_VERSION_(옛 주 점수 자동 재계산). 앱 index.html 2026-11-09-e와 짝.
 *
 * [2026-11-07d 수정] 앱에서 운동을 삭제하면 서버가 Workouts 시트의 같은 날짜·이름 행도 지운다(applyWorkoutTombstones_). 기존엔 삭제 표시(deletedIds)만 Meta에 저장하고
 *    시트 행은 남겨서, 앱 화면은 맞는데 저녁 요약·주간 점수·운동 칼로리 합계는 삭제한 운동까지 세던 문제(2026-11-07 등 PT 중복 행)를 고침.
 *    안전장치: ①이번 동기화에서 새로 추가된 운동 삭제 표시('k:날짜|이름')만 대상 ②날짜·이름이 정확히 같은 행만 ③한 번에 5행 초과면 지우지 않고 로그만 ④지운 행은 DeletedRows 시트에 백업
 *    ⑤식단·인바디·걸음수·허리둘레는 건드리지 않음 ⑥실패해도 동기화 자체는 정상. 지운 날짜는 하루·주간 점수를 즉시 다시 계산한다. 앱 index.html은 변경 없음.
 *
 * [2026-11-07c 수정] 운동 가산 A안(정희님 확정, 계수 0.6): 칼로리 주 목표 = 2,050 + max(0, 그 주 운동 합계 − 2,300)×0.6÷7, 밴드 ±150. 주간 점수 칼로리 항목·텔레그램·경고가 같은 목표를 쓴다. WeeklyScore 시트에 exerciseKcal·kcalTarget 열 추가(버전 2026-11-07c, 다음 저장 때 자동 재계산).
 *
 * [2026-11-07b 수정] 기준 전면 개정(정희님 지시, 앱 index.html 2026-11-07-b와 짝):
 *    ①칼로리 목표 = 주 평균 고정 2,050kcal(밴드 1,900~2,200) — 기초대사×1.5−550·운동 보정 폐지(computeCalorieTarget_가 인자를 무시하고 고정값 반환)
 *      근거: 6/29~11/2 주간 인바디 변화(체지방×7,700+제지방×1,800kcal/kg)와 식단 평균으로 구한 유지 칼로리 4주 창 9개가 2,117~2,254(평균 약 2,190), 지방 −0.14kg/주 ≈ 하루 −150kcal.
 *    ②탄수 등급(A/B/C) 목표·알림 삭제 ③단백질 기본 140~170→130~160g(설정 저장값은 rule='2026-11-07'인 것만 반영)
 *    ④유산소 인정 = part '유산소' AND (30분 이상 OR 3km 이상), 평균심박 조건 폐지(dsIsQualifyingCardio_·wsIsCardio_ 같은 기준) ⑤주간 점수 칼로리 밴드 1,900~2,200, 버전 2026-11-07b(시트 행 자동 재계산).
 *    DailyScore(옛 하루 점수) 계산식은 그대로 두되 유산소 기준만 위와 같게 맞춤.
 *
 * [2026-11-07 수정] 하루 점수 → 주간 점수(100점, 월~일). WeeklyScore 시트 신설, 저녁 텔레그램은 하루 점수 대신 주간 점수 블록, doGet/doPost 응답에 weeklyScores 추가.
 *    근력: PT·기록 없는 세션도 30분 이상이면 1회(볼륨·종목 불필요) 주 2회 만점 30점 / 유산소: 20분 이상 지속 주 3회 만점 20점(심박 조건 없음) / 단백질: 120g 이상 주 5일 만점 20점 /
 *    기록: 주 6일 만점 10점 / 칼로리: 주 평균(오늘 진행 중인 날 제외) 1,950~2,200 만점 20점(밖으로 300kcal에서 0). 탄수·기초대사·운동 보정은 쓰지 않음.
 *    DailyScore 계산·시트는 그대로 둠(허브 요약 등 기존 읽기용). 바꾼 곳: SHEETS.weeklyScore, 주간 점수 함수 묶음(wsXxx_), refreshDailyScoresForDates_ 끝, 저녁 요약 블록, doGet/doPost 응답.
 *
 * 설치 방법
 * 1) 새 Google Sheet를 만든다 (예: "바디리컴포지션 동기화")
 * 2) 상단 메뉴 확장 프로그램 > Apps Script 클릭
 * 3) 기본 코드를 지우고 이 파일 전체를 붙여넣기
 * 4) 저장(Ctrl+S) 후 우측 상단 "배포 > 새 배포"
 * 5) 유형: 웹 앱 선택
 *    - 실행 계정: 나
 *    - 액세스 권한: 전체(모든 사용자, Google 계정 없어도 됨) ← 중요
 * 6) 배포 후 나오는 "웹 앱 URL"을 (a) 앱 설정 탭 > 클라우드 동기화에 붙여넣고, (b) 이 채팅에도 한 번 공유해주세요.
 *    URL을 채팅에 공유해주시면, 이후 인바디/식단/운동 사진을 분석할 때 제가 그 자리에서 시트에 바로 반영할 수 있습니다.
 * 7) 처음 배포 시 권한 승인 화면이 뜨면 "고급 > 안전하지 않음으로 이동 > 허용" 진행
 *
 * 이미 이전 버전으로 배포했다면: 코드만 이 내용으로 덮어쓴 뒤
 * "배포 > 배포 관리 > 연필 아이콘 > 버전: 새 버전 > 배포" 로 갱신하면 URL은 그대로 유지됩니다.
 *
 * [2026-11-03 수정] 텔레그램 "aiAnalysis-인바디 불일치" 경고 반복 방지 + 동기화 부담 감소(앱 index.html 빌드 2026-11-03-a와 짝). 2026-10-31 기능(bodyType·보조운동)은 그대로.
 *    1) 앱/업로드가 이미 시트에 있는 것과 '똑같은 분석 글'을 보내면 아무것도 하지 않음(보관·덮어쓰기·경고 생략) — applyIncoming_.
 *    2) 같은 날짜 경고는 하루 1번만(Meta 'aiGapAlertedDate') — checkAiAnalysisInbodyGap_.
 *    3) 업로드 JSON에 "inbodySkipped": true 를 넣으면 인바디 미측정일로 보고 경고 생략.
 *    ※ 9/13 사고 방지(분석만 올라오고 인바디 구조화 데이터 없을 때 경고)는 그대로 유지.
 *
 * [2026-10-31 수정] 인바디 유형(I/C) 기록용 열 추가(앱 index.html 빌드 2026-10-31-a와 짝). InBody 시트에 bodyType('I'/'C'/'D', 정희님이 인바디 화면에서 확인한 값) 열을 더한다.
 *    같은 날짜 행을 다시 올릴 때(앱 push·채팅 인박스) 이 키가 없으면 시트에 있던 값을 지우지 않고 유지한다(식단 items와 같은 upsertSheet_ keepCols 방식). 값을 지우려면 null을 명시한다.
 *    바꾼 곳: SHEETS.inbody.cols(열 추가, 기존 시트는 getOrCreateSheet_가 헤더 끝에 자동 보강), applyIncoming_의 인바디 upsert 호출(keepCols 지정).
 *    [2026-10-31 수정 2] 하루 점수 근력일 집계: 보조운동(part='보조운동')은 그날 근력·최근 7일 근력일로 세지 않고(탄수 등급도 근력 없는 날 A등급), 최근 7일 중 5일 이상 하면 근력일 +1(최대 1). 바꾼 곳: dsIsAux_ 신설·dsIsStrength_ 첫 줄·computeDailyScoreCore_의 sDays·DAILY_SCORE_VERSION_. 점수 배점·공식은 동일.
 * [2026-10-26 수정] 칼로리 목표 개정 B안(기초대사 7일 평균, 앱 index.html 빌드 2026-10-26-a와 짝). 2026-10-27분부터 칼로리 목표·하루 점수·텔레그램 목표·허브 알림의 기초대사를
 *    '그날 측정값'이 아니라 '최근 유효 측정 7번 평균 제지방(체중−체지방량, 제외 확정일 건너뜀)'으로 구한 값(370+21.6×평균 제지방)으로 쓴다.
 *    2026-10-26 이전 날짜는 예전 방식(그날 또는 직전 측정 BMR)을 그대로 쓰므로 저장된 점수가 '점수 다시 계산'으로도 바뀌지 않는다. 점수 공식 자체(computeDailyScoreCore_)와 보정식(0.3·0.6)은 바꾸지 않음.
 *    바꾼 곳: bmrForTargetOn_ 신설, buildDailyScoreInput 어댑터·식단 등록 텔레그램·저녁 요약·허브 칼로리 알림의 BMR 입력 4곳. DAILY_SCORE_VERSION_ 2026-10-26(입력 변경 표시용).
 * [2026-10-20 수정] 마이라이프 "오늘" 화면의 인바디 변화(어제 대비·7회 평균 대비) 표시용으로 읽기 전용 요약(?summary=1)에 값 추가. 이 함수(handleHubSummary_) 외에는 바꾸지 않음.
 * 1) inbody에 muscle(골격근량 kg)·fat(체지방량 kg) 추가(기존 date·weight·fatPct는 그대로).
 * 2) inbodyPrev: 직전 유효 측정(제외 확정분 건너뜀) 1건 — {date,weight,muscle,fat,fatPct}. 어제 기록이면 앱이 "어제 대비"로 표시.
 * 3) ma7: 체중·골격근·체지방·체지방률 각각의 최근 유효 7건 평균(최신 측정 포함, 필드별로 값이 있는 것만) + ma7Count(필드별 건수).
 *    기존 fatPctMA7·fatPctMA7Count는 그대로 두었고 ma7.fatPct와 같은 값이다. 쓰기·인박스 처리·트리거 설치 없음.
 *
 * [2026-10-18 수정] 앱 개선 묶음 2차(앱 index.html 빌드 2026-10-18-b와 짝). 앞선 2026-10-16 코드에서 아래만 바꿈.
 * 1) 분석 누락 경고 개선(B1): recordInboxArrival_가 "분석 없이 들어온 데이터 건수"(inboxPendingCount)를 세고, 경고 문구에 마지막 분석 시각·마지막 데이터 시각·건수를
 *    함께 적는다. doGet 응답에 inboxStatus{dataAt, analysisAt, pendingCount}를 실어 앱 분석 카드가 "분석 이후 새 데이터 N건"을 표시한다(경고 조건·1회 발송 규칙은 그대로).
 * 2) 운동 이름 바꾸기(C1, 안전한 형태): 채팅 업로드의 workouts 레코드에 renameFrom("이전 이름")을 넣으면 같은 날짜의 그 이름 행을 새 이름으로 바꿔
 *    중복 행이 생기지 않게 한다(applyWorkoutRenames_). 새 이름 행이 이미 있으면 건드리지 않는다. ※ id 컬럼 방식은 앱이 날짜|이름 키로 병합(10/2 사고)해서 채택하지 않음.
 * 3) 식단 구성 항목(C4): Meals 시트에 items 열(JSON: [{name,kcal,protein,carbs,src,errorPct}]) 추가. 합계(calories/protein/carbs)가 점수 원본인 점은 그대로이고,
 *    items는 정정할 때 항목별로 다시 합산하기 위한 내역이다. 업로드에 items 키가 없으면 시트의 기존 items를 유지(upsertSheet_ keepCols).
 * 4) GitHub 자동배포 채널 제거(D2): deployFiles/deployChunk 처리, getGithubConfig_·deployFileToGithub_·processDeploy_·processDeployChunk_·chunkPropKey_·testGithubAuth,
 *    doGet 응답의 lastDeployStatus/lastDeployAt 삭제(앱은 이 값을 쓰지 않음). 코드 배포는 앞으로도 index.html 다운로드 → GitHub 직접 업로드만 사용.
 *    ※ 스크립트 속성의 GITHUB_TOKEN은 코드와 별개로 남아 있으므로 편집기 > 프로젝트 설정 > 스크립트 속성에서 삭제하고, GitHub에서 토큰도 폐기할 것.
 * 5) 크레아틴 메모 인식(creatineGramsFromNote_): "크레아틴 미확인/모름/확인안됨/?"을 복용으로 읽지 않는다(2026-10-08·09 점수 5점 오반영의 원인, 앱과 같은 규칙).
 *
 * [2026-10-16 수정] 앱 개선 묶음(앱 index.html 빌드 2026-10-16-b와 짝)
 * 1) findBmrForDate_: 제외 확정일의 BMR은 건너뛰고 직전 정상 측정 BMR 사용(칼로리 목표·하루 점수·알림 공통).
 * 2) 하루 점수: 식단 specialDayType='illness'(질병·회복)인 날은 점수 산출 안 함(computeDailyScoreCore_ inp.special). 공식 자체는 2026-10-05 허용오차+선형감점 그대로. DAILY_SCORE_VERSION_ 2026-10-16.
 * 3) Meals 시트에 estimated·errorPct 열 추가(기존 시트는 헤더 끝에 자동 보강). 점수의 "추정 포함" 표시는 estimated를 우선 쓰고, 없는 옛 기록은 메모의 '추정'으로 폴백.
 *    업로드에 estimated/errorPct 키가 없으면 시트에 있던 값을 유지(크레아틴과 같은 이유 — normalizeIncomingMeals_).
 * 4) 허브용 읽기 전용 요약: <웹앱 URL>?summary=1 (handleHubSummary_). 인박스 처리·쓰기 없음.
 *
 * [2026-10-13 수정] 인바디 "제외 확정" + Claude 분석 누락 경고(정희님 확정 설계, 앱 index.html 빌드 2026-10-13-a와 짝).
 * 1) SHEETS.inbody에 exclude(true=제외/false=유지/'보류'/빈 값=미결정)·excludeReason(사유)·excludeAt(결정 시각, ISO) 열 추가 —
 *    getOrCreateSheet_가 기존 InBody 시트 헤더 끝에 자동 보강(시트를 손으로 고칠 필요 없음). 제외는 삭제가 아니라 표시라 행은 그대로 남는다.
 * 2) 제외분(exclude===true)은 서버 계산에서도 건너뜀: computeInbodyMA7Compare_(최근 7건 vs 직전 7건, "유효 측정만 7건씩"),
 *    getStartInbody_(골격근 손실비율의 시작점), 체지방률 추세 정체 알림(checkDailyReminders). 전일 대비·측정 공백 알림은 "측정은 했음"이라 그대로 둔다.
 * 3) normalizeIncomingInbody_: 채팅(Drive 인박스)·앱이 같은 날짜를 다시 올릴 때 exclude 키가 빠져 있어도 시트의 제외 표시를 지우지 않는다.
 *    결정 시각(excludeAt)이 더 늦은 쪽이 이긴다(앱의 mergeInbodyByDate_와 같은 규칙). exclude를 보내면서 excludeAt이 없으면 서버가 지금 시각을 기록.
 * 4) 분석 누락 경고: 인박스(채팅 업로드)로 새 인바디/식단이 들어온 뒤 ANALYSIS_LAG_MIN_(20분) 안에 aiAnalysis가 올라오지 않으면
 *    텔레그램으로 1회 경고(recordInboxArrival_ / checkAnalysisLag_, checkInboxTrigger 1분 트리거에서 검사). 앱의 14일 동기화(doPost)는 세지 않는다.
 *    ※ 날짜 문자열(aiAnalysisDate)이 아니라 "수신 시각"으로 비교 — 시트가 날짜 문자열을 UTC Date로 바꿔 저장하는 문제를 피하려는 것.
 * 5) 하루 점수(BMR)·칼로리 목표는 이번에 건드리지 않음(제외일 BMR 처리는 정희님 판단 대기).
 *
 * [2026-10-05 수정] 서버 PR 경신 알림 복구(checkAndNotifyExercisePRs_).
 * 증상: 9/18에 넣은 PR 알림이 한 번도 울리지 않음. 원인: 종목의 ex.weight/ex.reps를 읽었는데 실제 업로드 형식은
 * {name, part, maxWeight, oneRM, sets:[{weight,reps}]}라 값이 항상 비어 있었음(시트 Workouts 실데이터로 확인).
 * 수정: 새 헬퍼 bestOneRMFromExercise_가 sets 배열에서 세트별 weight×(1+reps/30)의 최댓값을 구해 비교에 사용.
 * - 어시스티드(보조중량) 제외: 이름에 '어시스티드'가 있거나 세트에 assist 필드가 있으면 계산 안 함.
 * - 맨몸 세트({reps}만)·weight 0은 estimate1RM_이 null이라 자동 제외.
 * - 평평한 옛 형식({sets:3 또는 "20/20/20", reps:총횟수, weight}, 7/20~8/11 업로드분)은 의도적으로 계산하지 않음 —
 *   reps가 세트당이 아니라 총 횟수라 그대로 넣으면 1RM이 약 3배 부풀어 이후 진짜 PR을 가릴 수 있음.
 * 호출 순서(시트 반영 전 비교)·종목명 정규화·메시지 형식·점수 공식은 그대로. 다른 함수는 건드리지 않음.
 *
 * [2026-10-05-b 수정] ①크레아틴: 식단 메모에 "크레아틴"이 적혀 있으면(예: "쉐이크2스쿱+크레아틴", "크레아틴 5g") 크레아틴 칸이 비어 있어도 복용으로 인식.
 *    g 숫자가 없으면 3g. "크레아틴 안 먹음/미복용/없음/스킵" 같은 부정 표현은 복용 아님. 새 식단이 들어올 때(applyIncoming_)·점수 계산 때 적용하고,
 *    새 식단에 크레아틴 항목 자체가 없으면(채팅 업로드가 칸을 빼먹은 경우) 시트에 이미 있던 크레아틴 값을 지우지 않고 유지(앱 저장은 항상 값/null을 명시하므로 영향 없음).
 *    ②편집기 실행 없이 앱 설정탭 버튼 한 번으로 "크레아틴 보정 + 하루 점수 다시 계산" 실행: doGet ?recomputeScores=1 (handleRecomputeScores_).
 *
 * [2026-10-05 수정] 하루 점수 채점 기준 완화(정희님 요청: 목표에 거의 도달한 날을 과하게 깎지 않기) + 저장 직후 앱에 점수 즉시 반영.
 * 1) 칼로리·단백질·탄수를 "허용오차 + 선형 감점"으로 변경(dsBandTol_). 목표 범위에서 허용오차 이내면 만점, 그 밖은
 *    허용 가장자리 기준 이탈량에 비례해 0점까지 선형 감소. 칼로리 하한 -50kcal(상한은 기존 +100 그대로), 단백질 하한 -5g(상한은 기존대로 감점 없음),
 *    탄수 ±5g. 감소 폭: 칼로리 450kcal / 단백질·탄수 40g 이탈 시 0점(옛 단계식의 "150kcal→2/3, 300kcal→1/3", "20g→1/2"를 직선으로 이은 값).
 *    운동·활동·기록·보조 항목은 그대로. DAILY_SCORE_VERSION_ 2026-10-05. calc.py daily_score·테스트 벡터도 같은 날짜로 함께 갱신해야 한다.
 * 2) doPost 응답에 dailyScores(최근 30건)를 함께 돌려줌 — 앱이 저장 직후 동기화 응답만으로 새 점수를 바로 표시(별도 재조회 없음).
 * 3) recomputeDailyScoresAll 추가 — 편집기에서 한 번 실행하면 시작일~오늘 점수를 새 기준으로 전부 다시 계산(트리거 불필요, 기준 변경 직후 1회용).
 * 4) 시간 트리거 3종(checkInboxTrigger 1분, sendEveningDigest 21시, checkDailyReminders 9시)은 그대로 유지 — 점수 계산용이 아니라
 *    Drive 인박스 수신·텔레그램 저녁 요약·리마인더/어제 점수 확정용이라 지우면 채팅→시트 반영이 멈춘다. 점수는 이미 데이터가 들어올 때마다(applyIncoming_) 즉시 계산된다.
 *
 * [2026-10-04 추가] 하루 점수(100점 만점) — 텔레그램 저녁 요약·DailyScore 시트·앱 카드의 공통 원본.
 * 정희님 컨펌(2026-10-04): 100점 만점, 배점 칼로리30/단백질20/탄수15/운동·활동25/기록·보조10,
 * 운동·활동은 "오늘 기록 12.5 + 최근 7일 균형 12.5", 단계식 채점, 2026-10-03분부터 적용.
 * 이 점수는 체성분 판정이 아니라 "그날 행동 평가"이며 점수 단독으로 몸 상태를 판단하지 않는다.
 * 1) computeDailyScoreCore_: 순수 계산 함수. 채팅용 calc.py daily_score와 같은 공식이라
 *    scripts/daily_score_vectors.json의 36건 입력/기대값을 둘 다 통과해야 한다(수정 시 반드시 같이 갱신).
 *    JS Math.round 방식 반올림, 식단 미기록/BMR 미확인이면 0점이 아니라 score=null("산출 안 함").
 * 2) computeDailyScoreForDate_: 시트에서 그날 식단·최근 7일 운동·BMR·PR을 읽어 Core에 넣는 어댑터.
 *    인정 유산소는 구조화 필드(avgHR/durationMin)만 사용하고 note 텍스트는 파싱하지 않는다.
 *    "추정 포함" 표기만은 식단 note에 '추정'이 있는지로 판단(표시용 힌트일 뿐 점수에는 영향 없음).
 * 3) SHEETS.dailyScore('DailyScore' 시트)에 날짜당 1행을 덮어써 저장. 오늘 날짜는 '잠정', 지난 날짜는 '확정'.
 *    데이터가 들어올 때마다(applyIncoming_ 끝) 영향받는 날짜(그날~+6일)를 다시 계산해 저장하고,
 *    매일 오전 checkDailyReminders가 어제 점수를 한 번 더 계산해 '확정'으로 마감한다.
 *    저장 실패가 데이터 동기화(본 기능)를 막지 않도록 모두 try/catch로 감쌌다.
 * 4) sendEveningDigest(매일 21시대) 맨 아래에 점수 블록 추가 — 기존 요약 본문은 그대로.
 * 5) doGet 응답에 dailyScores(최근 30건) 추가 — 앱이 표시만 한다(앱은 점수를 직접 계산하지 않음).
 *
 * [2026-10-02 수정] 저항운동 부위 판정(inferPartsForEntry_) 오인식 수정 + 운동 등록 텔레그램 알림에 요약 한 줄 추가.
 * 1) inferPartsForEntry_: 앱(index.html 빌드 2026-10-02-a)의 inferPartsForEntry와 같은 규칙으로 맞춤.
 *    - part가 정확히 '유산소'인 순수 유산소 세션은 note를 훑지 않음. note에 적힌 "어깨 석회성건염 치료 중",
 *      "등/이두 근력 직후 연속 진행" 같은 설명 문구가 부위로 잡혀 걷기·러닝머신이 저항운동으로 오인식되던 문제
 *      (checkDailyReminders의 "저항운동이 N일째 없어요" 알림 판정에 영향).
 *    - 종목의 part가 '가슴/삼두'처럼 복합 표기면 BODY_PARTS_ 단위로 분해.
 * 2) buildWorkoutSummaryLine_ 신규 + notifyImmediate_의 운동 알림에 한 줄 추가: "볼륨 · 종목/세트/횟수 · 시간".
 *    구조화 필드(volume/exercises/durationMin)만 사용하고 note 텍스트는 파싱하지 않음. 값이 없으면 기존 알림과 동일.
 *
 * [2026-09-24 수정] MA7(직전 7건) 계산 버그 3곳 수정 — computeInbodyMA7Compare_,
 * buildInbodyAnalysisComment_, notifyImmediate_(인바디 메시지 작성부).
 * 실사고(2026-09-24): 여행 중 체중계만 사용해 골격근/체지방/체지방률이 빈칸인 레코드
 * (9/12·9/13·9/14)가 최근 7건 윈도우에 섞여 들어가면서, 기존 avg() 헬퍼가
 * Number(null||0)으로 빈칸을 0으로 계산 → 텔레그램 알림에 "MA7 골격근 18.6kg,
 * -4.5kg", "골격근손실비율 4.299(임계값 초과)" 같은 완전히 잘못된 값이 발송됨(실제
 * 올바른 값은 골격근 +0.37kg로 양호). 날짜 정렬 자체는 원래도 정상이었음(정렬 로직은
 * 변경하지 않음) — 문제는 오직 "빈칸을 0으로 세는" 평균 계산 방식이었음. 수정 후에는
 * 필드별로 실제 값이 있는 레코드만 걸러 평균을 내고, 유효값이 부족하면 그 필드는 null
 * 반환 → 알림 메시지에는 "판단보류(최근7건 유효값부족)"로 명시적으로 표시됨. 다른
 * 함수/로직은 전혀 손대지 않음.
 *
 * [2026-09-18 추가] 자동화 4종 — "수동으로 하던 일" 자동화 관점 보완.
 * 1) 6-A: aiAnalysis/comprehensiveReport를 덮어쓰기 직전 값을 ReportHistory 시트에 자동 보관
 *    (archiveReportBeforeOverwrite_) — 기존엔 매번 완전히 덮어써져서 지난 분석이 영구 소실됐음.
 * 2) 1-B: 운동 데이터 수신 시 종목별 추정1RM(Epley)을 계산해 역대 최고기록과 비교, 새 PR이면
 *    텔레그램 자동 발송(checkAndNotifyExercisePRs_) — 기존엔 Claude가 채팅에서 매번 수동/부정확
 *    하게 비교하던 것(2026-09-13 aiAnalysis 참고)을 서버가 원시데이터(exercises 배열)로 대체.
 * 3) 7-A·8: 인바디 2일공백/체성분실측 3일공백/저항운동 5일공백을 서버 트리거로 검사해 텔레그램
 *    발송(checkDailyReminders) — 기존 index.html의 checkReminders()는 "앱을 열었을 때만" 검사
 *    하는 구조라 앱을 안 열면 리마인더가 전혀 전달되지 않았음(코드 주석에 명시된 한계였음).
 * 4) [같은 날 추가 수정] 위 checkDailyReminders와 기존 sendEveningDigest 모두 원래는 "Apps
 *    Script 편집기 > 트리거 추가"를 사람이 손으로 한 번씩 눌러야 등록됐는데(정희님 요청: "트리거
 *    등록 방법은 머니트레일 프로젝트 참고해서 동일하게 앱에서 실행되게 수정해줘"), 이제
 *    ensureTriggersInstalled_()가 doGet() 호출 시(=앱을 열거나 동기화할 때) 자동으로 3개 트리거
 *    (checkInboxTrigger/sendEveningDigest/checkDailyReminders)를 전부 자동 등록함 — 편집기 조작
 *    불필요. 이미 등록돼 있으면 건드리지 않음(멱등). 자세한 내용은 ensureTriggersInstalled_ 주석,
 *    설정 절차는 위 "텔레그램 연동 설정" 6번 참고.
 * 이 5가지 모두 기존 함수/로직은 건드리지 않고 새 함수만 추가하는 방식으로 구현함.
 *
 * [2026-09-18 버그수정] handleTriggerStatus_에 try/catch 누락 — 정희님이 설정탭 "🩺 상태 확인"
 * 버튼을 눌렀을 때 "확인 실패: Failed to fetch"가 뜨는 문제 실사용 중 발견. 원인: 같은 파일의
 * handleInstallTrigger_는 try/catch로 감싸져 있었지만 handleTriggerStatus_는 감싸지 않아,
 * ScriptApp.getProjectTriggers() 호출이 예외를 던지면(트리거 관리 권한이 아직 미승인인 경우 등)
 * doGet 밖으로 예외가 그대로 전파 → Apps Script가 CORS 헤더 없는 자체 오류 페이지를 반환 →
 * 브라우저가 이를 네트워크 오류("Failed to fetch")로 표시. handleInstallTrigger_와 동일한
 * try/catch를 추가해 항상 CORS 안전한 JSON({ok:false, error:...})을 반환하도록 수정.
 *
 * [2026-09-14 추가] aiAnalysis-인바디 불일치 감지 경보.
 * 실사고(2026-09-13): Claude 세션이 체중 수치를 aiAnalysis 코멘트 문장 안에만 적고
 * 같은 날짜의 구조화 inbody 레코드는 올리지 않아서, 그 날짜가 시트 기반 계산(이동평균 등)
 * 에서 통째로 빠짐 — 사용자가 다음날 "어제 대비 비교"를 요청하고서야 수동으로 발견됨.
 * applyIncoming_에서 aiAnalysis 처리 직후 checkAiAnalysisInbodyGap_를 호출해서, 그 날짜에
 * 구조화 인바디 데이터가(같은 배치 payload든 기존 시트든) 전혀 없으면 텔레그램으로 즉시
 * 경고를 보내도록 함. 숫자를 정규식으로 역추출해 자동 보정하지는 않음(이 프로젝트에서
 * 과거 반복된 실패 패턴이라 의도적으로 배제) — 사람이 확인 후 수동으로 구조화 데이터를
 * 올리는 것을 전제로 한 "조기 경보"용임.
 *
 * [2026-09-13 추가] 운동 구조화 필드 4종(avgHR/durationMin/distanceKm/specialCondition) Workouts 시트 지원.
 * index.html이 유산소 세션의 note 자유텍스트 정규식 파싱(parseHR/parseDurationMin/parseKm) 대신
 * 구조화 필드로 값을 남기도록 바뀌었고(treadmillSteps 필드를 도입했던 것과 동일한 이유 —
 * 표현이 바뀔 때마다 값을 놓치는 문제 방지), 여행중/컨디션난조 등으로 강도를 낮춘 세션임을
 * 표시하는 specialCondition 필드도 추가됐음(2026-09-13). 클라이언트는 이미 cloudSync 시 이
 * 필드들을 포함해서 전송하지만, 서버(Apps Script)의 SHEETS.workouts.cols에 컬럼이 없으면
 * upsertSheet_/readSheet_가 header 기준으로 필드를 골라 쓰는 구조상 값이 조용히 버려진다
 * (2026-08-25 specialDayType 때와 동일한 원인). SHEETS.workouts.cols에 4개만 추가하면 됨 —
 * upsertSheet_/readSheet_ 둘 다 header를 기준으로 완전히 제네릭하게 동작하므로(header.map(h
 * => rec[h])), 다른 로직은 손댈 필요가 전혀 없음. 기존 Workouts 시트에도 getOrCreateSheet_가
 * 다음 doGet 호출 시 헤더 끝에 컬럼을 자동으로 보강해주므로 시트를 손으로 고칠 필요 없음.
 *
 * [2026-08-25 추가] specialDayType(과식/음주/컨디션난조/외식 등) 구조화 필드 Meals 시트 지원.
 * 기존엔 index.html 로컬 데이터 모델에만 specialDayType 필드가 있고 클라이언트는 이미
 * cloudSync 시 이 필드를 포함해서 전송하고 있었는데(meals: recentWindow_(state.meals)),
 * 서버(Apps Script)의 SHEETS.meals.cols에 이 컬럼이 없어서 upsertSheet_가 header 기준으로
 * 필드를 골라 쓰는 구조상 값이 조용히 버려지고 있었음(2026-08-25 발견) — 이 때문에 Claude가
 * Drive 인박스로 specialDayType을 올려도 절대 반영될 수 없었고, 앱 자체 동기화로도 저장이
 * 안 됐음. SHEETS.meals.cols에 'specialDayType'만 추가하면 됨 — upsertSheet_/readSheet_ 둘 다
 * header를 기준으로 완전히 제네릭하게 동작하므로(header.map(h => rec[h])), 다른 로직은 손댈
 * 필요가 전혀 없음. 기존 Meals 시트에도 getOrCreateSheet_가 다음 doGet 호출 시 헤더 끝에
 * 컬럼을 자동으로 보강해주므로 시트를 손으로 고칠 필요 없음.
 *
 * [2026-08-16 추가] 트레드밀 걸음수(treadmillSteps) 구조화 필드 지원.
 * 기존엔 인클라인 트레드밀 세션의 걸음수가 note 자유텍스트 안에 묻혀 있어서, 클라이언트
 * (index.html)가 정규식으로 재파싱하다가 표현이 바뀔 때마다 걸음수를 놓치는 문제가 반복됐음.
 * 이제 워크아웃 레코드에 treadmillSteps라는 별도 숫자 필드를 두고, 그 값을 note 텍스트와
 * 무관하게 그대로 신뢰해서 쓰도록 클라이언트를 바꿨음(2026-08-16). 이 필드가 시트 왕복
 * (pull/push) 과정에서 유실되지 않으려면 서버(Apps Script)도 이 컬럼을 알아야 하므로,
 * 아래 SHEETS.workouts.cols에 'treadmillSteps'를 추가함 — getOrCreateSheet_가 기존 시트에
 * 없는 컬럼은 헤더 끝에 자동으로 보강해주므로 시트를 손으로 고칠 필요는 없음.
 *
 * [2026-08-10 추가] 마운자로 투여 차수(MOUNJARO_DOSES) 자동화.
 * 기존엔 index.html에 하드코딩된 배열을 매주 직접 고쳐 GitHub에 재배포해야 했고,
 * 실제로 8차(7/23) 이후 9·10차가 누락된 채 방치되는 사고가 있었음(2026-08-10 발견).
 * applyIncoming_에 data.mounjaroDoses 처리 추가(Meta 'mounjaroDoses' 키에 JSON 문자열로 저장),
 * doGet() out 객체에 mounjaroDoses/mounjaroDosesDate 필드 추가. 이제 Claude가 목요일 투여 후
 * Drive 인박스에 {"mounjaroDoses":[{cycle,date,dose},...]}만 올리면 index.html 재배포 없이
 * 앱(cloudSync)에 자동 반영됨(클라이언트 측 state.mounjaroDoses 소비 로직은 index.html
 * 2026-08-10 버전부터 포함 — 반드시 그 버전 이상으로 함께 배포되어 있어야 함).
 *
 * [2026-08-06 추가] 알림봇 개선 6종.
 * 1. 부동소수점 반올림: round1_ 헬퍼를 formatDelta_ 및 누적합계(totalCal/totalProt/totalCarb)
 *    계산부에 공통 적용해서 "151.79999999999998" 같은 표시 오류 제거.
 * 2. 인바디 즉시알림에 전일 대비(±) 표시: findPrevInbody_로 직전 측정치를 찾아 각 지표
 *    옆에 전일 대비 변화량을 병기.
 * 3. 운동 알림에 Zone2(105-125bpm) 준수 여부 표시: extractAvgHeartRate_로 note에서
 *    "평균심박XXXbpm" 패턴을 추출해 목표존 준수 여부 표시. 단, part가 정확히 '유산소'인
 *    순수 유산소 세션에만 적용 — 근력+유산소 혼합 세션은 note에 등장하는 평균심박이
 *    근력 구간 값일 수 있어(정규식이 첫 매치만 잡음) 오귀속 위험이 있으므로 제외함.
 * 5. 저녁요약에 "오늘 N목표 중 M개 달성" 한 줄 요약 추가(칼로리/단백질/탄수화물 3개 기준).
 * 6. processInbox_에서 파일 처리 실패 시 텔레그램으로 실패 알림 발송(기존엔 조용히 스킵).
 * 7. 인바디 즉시알림에 MA7(직전7건) 대비 변화 + 규칙기반(A안, 템플릿) 분석 코멘트 추가:
 *    - 전일대비 방향성(골격근/체지방 동시개선·혼조 등) 자동 판정
 *    - MA7 골격근 손실폭을 합의된 롤백기준(-0.3kg)과 비교
 *    - 골격근손실비율(SURMOUNT-1 방식, 프로그램 시작일 대비 MA7 기준)을 0.51 임계값과 비교
 *    ※ 이 코멘트는 진짜 AI 분석이 아니라 정해진 규칙을 조합한 템플릿 문장입니다.
 *    맥락(질병, 특이일정 등)을 반영하지 못하므로 정밀 분석은 채팅에서 별도로 받아야 합니다.
 *
 * [2026-08-04 추가] 텔레그램 알림 (상세형: 즉시알림 + 저녁요약).
 * 필요 스크립트 속성 2개: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (설정 방법은 코드 하단
 * "텔레그램 연동 설정" 함수 주석 참고). 두 속성이 없으면 알림 관련 함수들은 조용히
 * 아무것도 하지 않고 넘어가므로(예외를 던지지 않음), 기존 동기화 동작에는 영향이 없습니다.
 * - 즉시알림: Drive 인박스 파일이 처리될 때(=processInbox_ 안에서) 그 파일에 담긴
 *   inbody/workouts/meals 내용을 바로 요약해서 보냄.
 * - 저녁요약: sendEveningDigest() 함수를 "시간 기반 트리거"로 매일 저녁(예: 21시)에
 *   실행되도록 Apps Script 편집기에서 등록해야 함(코드만으로는 자동 등록되지 않음 —
 *   Apps Script 트리거는 배포와 별개로 편집기에서 수동으로 한 번 등록하는 게 정석).
 *
 * [2026-08-05 추가] 식단 누적 알림에 목표/델타 표시.
 * index.html의 computeCalorieTarget/computeCarbTarget과 동일한 공식을 Apps Script에도
 * 이식해서(computeCalorieTarget_/computeCarbTarget_), notifyImmediate_의 식단 메시지에
 * "칼로리/단백질/탄수화물 목표 대비 부족·초과분"을 함께 표시하도록 확장함. 그날 인바디
 * BMR과 운동볼륨(그날 총 볼륨 + 역대 PR)을 시트에서 다시 읽어와 계산하므로, 값을
 * 별도로 넘겨줄 필요 없이 시트 상태만 정확하면 항상 맞게 계산됨.
 *
 * [2026-08-04 추가] "종합 리포트"(comprehensiveReport) Meta 필드 처리.
 * 앱의 새 "리포트" 탭이 aiAnalysis와 동일한 방식으로 Claude가 작성한 정기 리포트 텍스트를
 * 받아 보여주도록, Meta 시트에 comprehensiveReport/comprehensiveReportDate 키를 저장하고
 * doGet 응답에도 포함시킴.
 *
 * [2026-07-29 추가 → 2026-10-18 제거] GitHub 자동배포 채널(deployFiles/deployChunk)과 "GitHub 연동 설정"은 코드와 함께 삭제됐다.
 * 앱 코드 배포는 index.html 다운로드 → GitHub "Upload files"로만 한다. 스크립트 속성에 남은 GITHUB_TOKEN/OWNER/REPO/BRANCH는 지워도 된다.
 *
 * ## 텔레그램 연동 설정 (최초 1회만)
 * 1) 텔레그램 앱에서 @BotFather 검색 > /newbot > 안내에 따라 봇 이름 설정
 *    > 완료되면 Bot Token이 발급됨(예: 123456:ABC-...)
 * 2) 방금 만든 봇을 검색해서 아무 메시지나 한 번 보내기(예: "안녕")
 * 3) 브라우저에서 https://api.telegram.org/bot<위토큰>/getUpdates 접속
 *    > 응답 JSON 안의 "chat":{"id": ...} 의 숫자가 Chat ID
 * 4) Apps Script 편집기 좌측 톱니바퀴(프로젝트 설정) > 스크립트 속성 > "스크립트 속성 추가"
 *    - TELEGRAM_BOT_TOKEN = (1에서 받은 토큰)
 *    - TELEGRAM_CHAT_ID = (3에서 확인한 숫자)
 * 5) 코드 저장 후 "배포 > 배포 관리 > 연필 아이콘 > 새 버전 > 배포"로 갱신
 * 6) [2026-09-18 수정] 예전엔 여기서 "Apps Script 편집기 > 시계 아이콘(트리거) > 트리거 추가"를
 *    사람이 직접 눌러 sendEveningDigest/checkDailyReminders를 등록해야 했지만, 이제는 그럴 필요
 *    없습니다 — 배포 후 앱을 한 번 열거나(=doGet 호출) "지금 동기화"를 한 번만 눌러도
 *    ensureTriggersInstalled_()가 자동으로 3개 트리거(checkInboxTrigger 1분마다,
 *    sendEveningDigest 매일 저녁9시대, checkDailyReminders 매일 오전9시대)를 전부 등록합니다.
 *    이미 등록돼 있으면 중복 생성하지 않고 건너뜁니다(getProjectTriggers()로 핸들러명 기준 확인).
 *    ⚠️ 단, 이 기능은 스크립트가 트리거를 직접 만들 수 있는 권한(script.scriptapp)을 새로
 *    요구하므로, 이번 코드로 새 버전을 배포한 뒤 앱을 처음 열 때 Google 권한 승인 화면이 다시
 *    뜰 수 있습니다 — "고급 > 안전하지 않음으로 이동 > 허용"으로 한 번만 승인해주면 됩니다
 *    (파일 상단 "설치 방법" 7번과 동일한 절차).
 *
 * [2026-07-19 수정] 허리둘레(Waist) 시트 연동 추가.
 * 앱(index.html)의 목표 탭에 "허리둘레 추적" 섹션이 새로 생기면서, 클라이언트가
 * cloudSync 시 waist 배열을 함께 전송/수신하도록 바뀜 — 이에 맞춰 서버(Apps Script)도
 * SHEETS.waist 정의 추가, applyIncoming_에 upsertSheet_ 호출 추가, doGet 응답에
 * waist 필드 추가. 날짜당 1건이 정상인 데이터라 인바디/걸음수와 동일하게 matchField 없이
 * "날짜만" 매칭 사용.
 *
 * [2026-07-17 수정] upsertSheet_의 matchName(boolean)을 matchField(string)로 일반화.
 * 기존엔 운동(name)만 "날짜+이름"으로 매칭하고 식단(meals)은 항상 "날짜만"으로 매칭해서,
 * 같은 날 두 번째 끼니를 올리면 첫 번째 끼니가 통째로 덮어써지는 버그가 있었음
 * (2026-07-17 실제 재현 확인: 점심 업로드 후 저녁 업로드 시 점심 유실).
 * 이제 식단도 "날짜+note"로 매칭해서, note가 다르면 별도 행으로 추가되고
 * note가 같으면(=같은 끼니 재업로드/정정) 그 행만 갱신됨 — 클라이언트 mergeMealsByDate_와 동일한 방식.
 *
 * 동작 방식: Claude가 "body-recomp-inbox"라는 Drive 폴더에 JSON 파일을 올려두면,
 * 앱이 열려서 이 스크립트(doGet)가 호출될 때마다 그 폴더를 확인해 자동으로 시트에 반영하고,
 * 처리된 파일은 같은 폴더 안의 "processed" 하위 폴더로 옮깁니다.
 *
 * 시트가 비어있어도 자동으로 InBody / Workouts / Meals / Steps / Waist / Meta 탭을 만들어줍니다.
 */








// [2026-09-19 추가, 머니트레일 벤치마킹] inbody/workouts/meals/waist에 updatedAt(클라이언트가
// 저장 시각을 ISO 문자열로 기록)을 추가 — 필드(레코드) 단위 타임스탬프 우선 병합용. 기존 시트도
// getOrCreateSheet_가 헤더 끝에 자동으로 컬럼을 보강해주므로 별도 마이그레이션 작업 불필요.
// 기존 행은 이 값이 빈 문자열(=null)이라, 클라이언트 병합 로직은 양쪽 다 값이 있을 때만
// 타임스탬프를 비교하고 없으면 기존처럼 "서버 값 신뢰"로 안전하게 폴백한다.
const CODE_VERSION_ = '2026-11-11b'; // [2026-11-11] 응답의 codeVersion으로 내려감(배포된 서버 버전 확인용)
const STAGE_DETAIL_ = true;          // [2026-11-11] true면 전체 조회 stageMs에 시트별 누적 소요시간을 추가(측정 후 false로 바꿔도 됨)
const SHEETS = {
  // [2026-10-13] exclude/excludeReason/excludeAt: 인바디 "제외 확정" — 위 헤더 설명 참고. 기존 시트는 getOrCreateSheet_가 헤더 끝에 자동 보강.
  inbody: {name:'InBody', cols:['date','weight','muscle','fat','fatPct','bmr','updatedAt','exclude','excludeReason','excludeAt','bodyType']}, // 2026-10-31: bodyType(인바디 유형 I/C) 추가
  // [2026-09-19 수정, 20선 16번] ptSession(PT 세션 여부, boolean) 컬럼 추가 — getOrCreateSheet_가
  // 헤더 끝에 자동 보강하므로 기존 데이터에는 영향 없음.
  workouts: {name:'Workouts', cols:['date','name','part','volume','calories','note','treadmillSteps','avgHR','durationMin','distanceKm','specialCondition','ptSession','exercises','updatedAt']},
  // [2026-09-25 추가] creatine(g) 컬럼 — 크레아틴 복용 모니터링. getOrCreateSheet_가 기존 Meals 시트 헤더 끝에 자동 보강.
  // [2026-10-16 추가] estimated(TRUE=추정치 포함)·errorPct(추정 오차 ±%) — 식단 메모의 '추정' 단어에 의존하던 표시를 구조화. 기존 시트는 헤더 끝에 자동 보강.
  // [2026-10-18 추가] items(JSON): 식단 구성 항목 [{name,kcal,protein,carbs,src,errorPct}] — 합계 정정용 내역. 합계 열이 점수의 원본이다. 기존 시트는 헤더 끝에 자동 보강.
  meals: {name:'Meals', cols:['date','calories','protein','carbs','note','specialDayType','updatedAt','creatine','estimated','errorPct','items']},
  steps: {name:'Steps', cols:['date','steps','km','kcal','floors']},
  // [2026-09-19 수정, 20선 14번] fasting(아침 공복 측정 여부) 컬럼 추가 — getOrCreateSheet_가
  // 기존 시트 헤더 끝에 자동으로 보강하므로 기존 데이터에는 영향 없음(다른 신규 컬럼과 동일 패턴).
  waist: {name:'Waist', cols:['date','waist','fasting','updatedAt']},
  // [2026-09-18 추가, 6-A] aiAnalysis/comprehensiveReport가 덮어써지기 직전의 값을 보관하는
  // 히스토리 로그. 날짜당 여러 건이 쌓일 수 있어(같은 날 여러 번 갱신) matchField 없이
  // 항상 새 행으로 append만 함 — archiveReportBeforeOverwrite_ 참고.
  reportHistory: {name:'ReportHistory', cols:['date','type','content']},
  // [2026-09-19 추가, 개선안 20선 3번] 부작용 기록이 그동안 로컬(기기)에만 있어서 기기를
  // 분실/초기화하면 영구 유실될 위험이 있었음. id는 시트에 컬럼이 없으므로(다른 기록들과 동일한
  // 이유 — workouts 참고) 클라이언트가 pull 후 ensureWorkoutIds류 방식으로 재부여한다.
  // matchField='symptom'으로 날짜+증상 기준 매칭(workouts가 날짜+종목명으로 매칭하는 것과 동일 패턴).
  sideEffects: {name:'SideEffects', cols:['date','symptom','severity','note','updatedAt']},
  // [2026-10-04 추가] 하루 점수(100점) 저장소 — 날짜당 1행(날짜만 매칭이라 같은 날짜는 덮어씀).
  // 오늘은 status '잠정', 지난 날짜는 '확정'. detail은 항목별 근거 문구 JSON. 앱은 이 시트를 표시만 한다.
  dailyScore: {name:'DailyScore', cols:['date','score','calories','protein','carbs','activity','record','status','estimated','updatedAt','version','detail']},
  // [2026-11-07 추가] 주간 점수(100점) 저장소 — 주(월요일 날짜=date)당 1행. 앱은 표시만 한다.
  weeklyScore: {name:'WeeklyScore', cols:['date','weekEnd','score','strength30','cardio20','protein20','record10','calories20','strengthDays','cardioDays','protein120Days','recordDays','avgKcal','oldDailyAvg','status','updatedAt','version','exerciseKcal','kcalTarget']},
};








// [2026-11-11b] 스크립트 속성: 키마다 getProperty를 부르면 호출당 수십~백 ms가 들므로 한 번에 읽어 두고(propsAll_) 쓸 때는 모아서 한 번에 저장(propsFlush_)한다.
// 이 캐시로 읽고 쓰는 키는 prSeen·scoresRefreshedDay·inFp:* 뿐이다(다른 속성은 예전처럼 직접 읽고 씀).
let PROPS_ = null, PROPS_DIRTY_ = {};
function propsAll_(){
  if(!PROPS_){ try{ PROPS_ = PropertiesService.getScriptProperties().getProperties() || {}; }catch(e){ PROPS_ = {}; } }
  return PROPS_;
}
function propGet_(k){ const p = propsAll_(); return Object.prototype.hasOwnProperty.call(p, k) ? p[k] : null; }
function propSet_(k, v){ const s = String(v); propsAll_()[k] = s; PROPS_DIRTY_[k] = s; }
function propsFlush_(){
  const keys = Object.keys(PROPS_DIRTY_);
  if(!keys.length) return;
  try{ PropertiesService.getScriptProperties().setProperties(PROPS_DIRTY_); }catch(e){ Logger.log('속성 저장 실패(동기화는 정상): ' + e); }
  PROPS_DIRTY_ = {};
}
/** 문자열 지문(서로 다른 해시 2종 + 길이). 같은 본문이면 같은 값, 내용이 달라지면 사실상 항상 달라진다. */
function fingerprint_(s){
  let h1 = 5381, h2 = 0;
  for(let i = 0; i < s.length; i++){ const c = s.charCodeAt(i); h1 = ((h1 * 33) ^ c) >>> 0; h2 = (Math.imul(h2, 31) + c) >>> 0; }
  return h1.toString(36) + '.' + h2.toString(36) + '.' + s.length;
}
// [2026-11-11b] 시트 헤더 확인 캐시: 헤더에 빠진 열을 보강하는 확인(getLastColumn + 헤더 읽기)은 배포 버전(CODE_VERSION_)당 시트별로 한 번만 하면 된다.
let HDR_OK_ = null;
function hdrKey_(){ return 'hdrOK_' + CODE_VERSION_; }
function hdrOkLoad_(){
  if(HDR_OK_) return HDR_OK_;
  HDR_OK_ = {};
  try{ const raw = CacheService.getScriptCache().get(hdrKey_()); if(raw) HDR_OK_ = JSON.parse(raw) || {}; }catch(e){}
  return HDR_OK_;
}
let HDR_DIRTY_ = false;
function hdrOkMark_(name){
  const m = hdrOkLoad_();
  if(m[name]) return;
  m[name] = 1; HDR_DIRTY_ = true; // 저장은 요청 끝에서 한 번에(hdrOkFlush_)
}
function hdrOkFlush_(){
  if(!HDR_DIRTY_) return;
  HDR_DIRTY_ = false;
  try{ CacheService.getScriptCache().put(hdrKey_(), JSON.stringify(hdrOkLoad_()), 21600); }catch(e){}
}
function getOrCreateSheet_(ss, name, headerCols){
  let sh = ss.getSheetByName(name);
  if(!sh){
    sh = ss.insertSheet(name);
    sh.appendRow(headerCols);
    hdrOkMark_(name);
    return sh;
  }
  if(hdrOkLoad_()[name]) return sh; // 이 버전에서 이미 헤더를 확인한 시트
  // 기존 시트에 새로 추가된 컬럼(예: exercises)이 없으면 헤더 끝에 보강
  const lastCol = sh.getLastColumn();
  const existingHeader = lastCol>0 ? sh.getRange(1,1,1,lastCol).getValues()[0] : [];
  const missing = headerCols.filter(c => !existingHeader.includes(c));
  if(missing.length){
    sh.getRange(1, existingHeader.length+1, 1, missing.length).setValues([missing]);
    invalidateSheetCache_(name);
  }
  hdrOkMark_(name);
  return sh;
}
// [2026-11-11] 읽기 캐시: 한 번의 실행(요청) 안에서 같은 시트를 여러 번 통째로 읽던 것을 한 번만 읽는다. 전역 변수는 실행마다 새로 시작하므로 다른 요청에는 영향이 없다.
// 시트를 쓰거나 지우는 곳(upsertSheet_·applyWorkoutRenames_·applyWorkoutTombstones_·backfillMealCreatine_·archiveReportBeforeOverwrite_·헤더 보강)은 invalidateSheetCache_(시트이름)으로 그 시트 캐시를 비운다.
let SHEET_RAW_CACHE_ = {};
let SHEET_OBJ_CACHE_ = {};
function invalidateSheetCache_(name){
  if(name){ delete SHEET_RAW_CACHE_[name]; delete SHEET_OBJ_CACHE_[name]; }
  else { SHEET_RAW_CACHE_ = {}; SHEET_OBJ_CACHE_ = {}; }
}
function readSheetRaw_(sh, name){
  if(SHEET_RAW_CACHE_[name]) return SHEET_RAW_CACHE_[name];
  const v = sh.getDataRange().getValues();
  SHEET_RAW_CACHE_[name] = v;
  return v;
}
function readSheet_(ss, def){
  // 캐시된 배열은 복사해서 돌려준다(호출부가 .sort() 등으로 순서를 바꿔도 캐시가 흔들리지 않게). 행 객체 자체는 공유하지만 호출부는 읽기만 한다(수정은 복사본에서).
  if(SHEET_OBJ_CACHE_[def.name]) return SHEET_OBJ_CACHE_[def.name].slice();
  const sh = getOrCreateSheet_(ss, def.name, def.cols);
  const values = readSheetRaw_(sh, def.name);
  if(values.length < 2) return [];
  const rows = rowsToObjects_(values[0], values.slice(1));
  SHEET_OBJ_CACHE_[def.name] = rows;
  return rows.slice();
}
/** 헤더 + 데이터 행 → 객체 배열(readSheet_와 같은 규칙: 첫 칸이 비면 건너뜀, JSON 문자열 복원, Date는 yyyy-MM-dd) */
function rowsToObjects_(header, dataRows){
  return dataRows
    .filter(row => row[0] !== '' && row[0] !== null)
    .map(row => {
      const obj = {};
      header.forEach((h,i) => {
        let v = row[i];
        if(v === '') v = null;
        // JSON으로 저장해둔 필드(예: exercises)는 다시 객체/배열로 복원
        if(v !== null && typeof v === 'string' && (v[0]==='[' || v[0]==='{')){
          try{ v = JSON.parse(v); }catch(e){ /* 파싱 실패 시 원문 유지 */ }
        }
        obj[h] = v;
      });
      // 날짜 컬럼이 Date 객체로 들어온 경우 YYYY-MM-DD 문자열로 정규화
      if(obj.date instanceof Date){
        obj.date = Utilities.formatDate(obj.date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      }
      return obj;
    });
}
/** [2026-11-11] 시트 끝쪽 n행만 읽는다(리포트 이력처럼 위에서부터 쌓이는 시트용). 캐시는 쓰지 않는다. */
function readSheetTail_(ss, def, n){
  const sh = getOrCreateSheet_(ss, def.name, def.cols);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if(lastRow < 2 || lastCol < 1) return [];
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const start = Math.max(2, lastRow - n + 1);
  return rowsToObjects_(header, sh.getRange(start, 1, lastRow - start + 1, lastCol).getValues());
}
/**
 * [2026-11-11] ?days=N 조회용: 날짜 열만 먼저 읽어 cutoff(yyyy-MM-dd) 이후 행이 시작되는 위치를 찾고, 그 위치부터 끝까지만 읽는다.
 * 시트가 날짜순이 아니어도 안전하다(찾은 위치 앞쪽의 더 오래된 행은 읽지 않고, 위치 뒤쪽의 오래된 행은 호출부의 recent_ 필터가 다시 거른다).
 * 날짜 열이 없거나 이미 캐시된 시트면 기존 방식(readSheet_)으로 읽는다.
 */
function readSheetSince_(ss, def, cutoff){
  if(SHEET_OBJ_CACHE_[def.name]) return SHEET_OBJ_CACHE_[def.name].slice();
  const sh = getOrCreateSheet_(ss, def.name, def.cols);
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if(lastRow < 2 || lastCol < 1) return [];
  const header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const di = header.indexOf('date');
  if(di < 0) return readSheet_(ss, def);
  const tz = Session.getScriptTimeZone();
  const dates = sh.getRange(2, di + 1, lastRow - 1, 1).getValues();
  let first = -1;
  for(let i = 0; i < dates.length; i++){
    let d = dates[i][0];
    if(d instanceof Date) d = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    d = (d === null || d === undefined) ? '' : String(d);
    if(d !== '' && d >= cutoff){ first = i; break; }
  }
  if(first < 0) return [];
  const start = first + 2;
  return rowsToObjects_(header, sh.getRange(start, 1, lastRow - start + 1, lastCol).getValues());
}








/**
 * matchField: null/undefined면 "날짜만" 매칭(인바디/걸음수/허리둘레처럼 하루 1건이 정상인 데이터).
 * matchField가 문자열(예: 'name', 'note')이면 "날짜 + 해당 필드값"으로 매칭해서
 * 같은 날짜라도 그 필드값이 다르면 별도 행으로 추가됨(운동/식단처럼 하루 여러 건이 정상인 데이터).
 */
function upsertSheet_(ss, def, incoming, matchField, keepCols, ignoreCols){
  // [2026-11-09c] 속도 개선: ①시트를 레코드마다 다시 읽지 않고 한 번만 읽어 메모리에서 매칭 ②값이 그대로인 행은 쓰지 않음(앱은 최근 14일을 매번 다시 보냄)
  // ③새 행은 한 번에 붙임. 매칭 규칙·keepCols 규칙은 이전과 같다. 반환: 실제로 바뀌었거나 새로 들어간 레코드 배열(점수 재계산 범위를 줄이는 데 씀).
  const changed = [];
  if(!incoming || !incoming.length) return changed;
  const sh = getOrCreateSheet_(ss, def.name, def.cols);
  const tz = Session.getScriptTimeZone();
  // [2026-11-11] 읽기 캐시 사용(배열만 복사: 아래에서 cur[행] = 새값으로 바꾸거나 push해도 캐시 원본은 그대로). ignoreCols: 이 열만 다르면 '같은 행'으로 보고 쓰지 않음(예: 점수 시트의 updatedAt).
  const cur = readSheetRaw_(sh, def.name).slice();
  const header = cur[0];
  const origLen = cur.length;
  const dateIdx = header.indexOf('date');
  const matchIdx = matchField ? header.indexOf(matchField) : -1;
  const sameCell = (a, b) => {
    if(a instanceof Date){
      if(b instanceof Date) return a.getTime() === b.getTime();
      const bs = String(b);
      if(/^\d{4}-\d{2}-\d{2}$/.test(bs)) return Utilities.formatDate(a, tz, 'yyyy-MM-dd') === bs;
      const t = Date.parse(bs);
      return !isNaN(t) && a.getTime() === t;
    }
    if(a === b) return true;
    // 시트에 숫자로 들어 있고 보내온 값이 같은 숫자의 문자열이면 같은 값(시트는 문자열 숫자를 숫자로 저장함). 반대(시트가 문자열, 보낸 값이 숫자)는 예전처럼 다시 써서 숫자로 바로잡는다.
    return typeof a === 'number' && typeof b === 'string' && /^-?\d+(\.\d+)?$/.test(b) && Number(b) === a;
  };
  incoming.forEach(rec => {
    if(!rec || !rec.date) return;
    const rowVals = header.map(h => {
      const v = rec[h];
      if(v === undefined || v === null) return '';
      // 객체/배열(예: exercises)은 셀에 JSON 문자열로 저장
      if(typeof v === 'object') return JSON.stringify(v);
      return v;
    });
    let matchIdxRow = -1;
    for(let i=1;i<cur.length;i++){
      let d = cur[i][dateIdx];
      if(d instanceof Date) d = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
      if(d !== rec.date) continue;
      if(matchField){
        if(cur[i][matchIdx] === (rec[matchField] || '')){ matchIdxRow = i; break; }
      } else {
        matchIdxRow = i; break;
      }
    }
    if(matchIdxRow >= 0){
      // 2026-10-18: keepCols에 적힌 열은 업로드에 그 키가 아예 없으면(undefined) 시트에 있던 값을 유지(예: 식단 items). null을 명시하면 지움.
      if(keepCols && keepCols.length){
        const prevRow_ = cur[matchIdxRow];
        keepCols.forEach(c => { const ci = header.indexOf(c); if(ci >= 0 && rec[c] === undefined) rowVals[ci] = prevRow_[ci]; });
      }
      const prev = cur[matchIdxRow];
      let same = true;
      for(let c=0;c<header.length;c++){ if(ignoreCols && ignoreCols.indexOf(header[c]) >= 0) continue; if(!sameCell(prev[c], rowVals[c])){ same = false; break; } }
      if(same) return; // 시트와 똑같음 — 쓰지 않음
      if(matchIdxRow < origLen) sh.getRange(matchIdxRow+1, 1, 1, header.length).setValues([rowVals]);
      cur[matchIdxRow] = rowVals; // 이번 묶음 안의 새 행(아직 시트에 안 붙은 것)이면 메모리에서만 갱신, 마지막에 한 번에 붙임
      changed.push(rec);
    } else {
      cur.push(rowVals);
      changed.push(rec);
    }
  });
  if(cur.length > origLen){
    const add = cur.slice(origLen), start = origLen + 1, last = start + add.length - 1;
    if(last > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), last - sh.getMaxRows());
    sh.getRange(start, 1, add.length, header.length).setValues(add);
  }
  if(changed.length) invalidateSheetCache_(def.name); // [2026-11-11] 쓴 시트는 다음 읽기 때 다시 읽는다
  return changed;
}








/**
 * [2026-10-18 추가] 운동 이름 바꾸기. 운동은 "날짜+이름 완전일치"로 매칭돼서 이름만 바꿔 다시 올리면 새 행이 생겨 중복이 됐다.
 * 업로드 레코드에 renameFrom("이전 이름")이 있으면, 같은 날짜에 그 이름 행이 있고 새 이름 행은 없을 때 이름 칸만 새 이름으로 바꾼다 —
 * 이어지는 upsertSheet_가 바뀐 행을 날짜+새 이름으로 찾아 나머지 값을 덮어쓴다. 행을 지우지는 않는다(새 이름 행이 이미 있으면 아무것도 안 함).
 */
function applyWorkoutRenames_(ss, workouts){
  if(!Array.isArray(workouts)) return;
  const renames = workouts.filter(w => w && w.date && w.name && typeof w.renameFrom === 'string' && w.renameFrom.trim() && String(w.renameFrom).trim() !== String(w.name).trim());
  if(!renames.length) return;
  const sh = getOrCreateSheet_(ss, SHEETS.workouts.name, SHEETS.workouts.cols);
  const header = sh.getDataRange().getValues()[0];
  const di = header.indexOf('date'), ni = header.indexOf('name');
  if(di < 0 || ni < 0) return;
  renames.forEach(w => {
    const values = sh.getDataRange().getValues();
    let oldRow = null, newExists = false;
    for(let i = 1; i < values.length; i++){
      let d = values[i][di];
      if(d instanceof Date) d = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      if(d !== w.date) continue;
      if(values[i][ni] === w.name) newExists = true;
      if(oldRow === null && values[i][ni] === String(w.renameFrom).trim()) oldRow = i + 1;
    }
    if(oldRow !== null && !newExists){ sh.getRange(oldRow, ni + 1).setValue(w.name); invalidateSheetCache_(SHEETS.workouts.name); }
  });
}








/**
 * [2026-11-07d 추가] 앱이 보낸 deletedIds 중 "새로 추가된 운동 삭제 표시(k:날짜|이름)"에 해당하는 Workouts 행을 지운다.
 * 반환값: 지운 행의 날짜 배열(점수 재계산용). 지우기 전 행 내용은 DeletedRows 시트에 백업한다.
 * 다시 저장(철회)된 운동은 앱이 삭제 표시를 해제하므로 이 함수가 건드리지 않는다.
 */
function applyWorkoutTombstones_(ss, newDeleted){
  const out = [];
  let nd = newDeleted;
  if(typeof nd === 'string'){ try{ nd = JSON.parse(nd); }catch(e){ return out; } }
  if(!nd || !nd.workouts) return out;
  let old = {};
  try{ const rawOld = getMeta_(ss, 'deletedIds'); old = rawOld ? (typeof rawOld === 'string' ? JSON.parse(rawOld) : rawOld) : {}; }catch(e){ old = {}; }
  const oldW = (old && old.workouts) || {};
  const wanted = {};
  let n = 0;
  Object.keys(nd.workouts).forEach(k => {
    if(k.indexOf('k:') !== 0 || oldW[k]) return;
    const body = k.slice(2), p = body.indexOf('|');
    if(p > 0){ wanted[body.slice(0, p) + '|' + body.slice(p + 1).trim()] = true; n++; }
  });
  if(!n) return out;
  const sh = getOrCreateSheet_(ss, SHEETS.workouts.name, SHEETS.workouts.cols);
  const values = sh.getDataRange().getValues();
  if(values.length < 2) return out;
  const header = values[0], di = header.indexOf('date'), ni = header.indexOf('name');
  if(di < 0 || ni < 0) return out;
  const tz = Session.getScriptTimeZone();
  const hits = [];
  for(let i = 1; i < values.length; i++){
    let d = values[i][di];
    d = (d instanceof Date) ? Utilities.formatDate(d, tz, 'yyyy-MM-dd') : String(d).slice(0, 10);
    const nm = String(values[i][ni] == null ? '' : values[i][ni]).trim();
    if(wanted[d + '|' + nm]) hits.push({row: i + 1, date: d, name: nm, vals: values[i]});
  }
  if(!hits.length) return out;
  if(hits.length > 5){ Logger.log('운동 삭제 반영 중단: 지울 행이 ' + hits.length + '개(5개 초과) — 시트를 직접 확인하세요'); return out; }
  const bk = getOrCreateSheet_(ss, 'DeletedRows', ['deletedAt', 'sheet', 'date', 'name', 'rowJson']);
  const nowIso = new Date().toISOString();
  hits.forEach(h => bk.appendRow([nowIso, SHEETS.workouts.name, h.date, h.name, JSON.stringify(h.vals.map(v => (v instanceof Date) ? v.toISOString() : v))]));
  hits.sort((a, b) => b.row - a.row).forEach(h => sh.deleteRow(h.row));
  invalidateSheetCache_(SHEETS.workouts.name);
  hits.forEach(h => { if(out.indexOf(h.date) < 0) out.push(h.date); });
  return out;
}
// [2026-11-09c] Meta는 키마다 시트 전체를 다시 읽던 것(doGet 한 번에 12번 넘게)을 한 번 읽어 두고 재사용. setMeta_가 쓸 때 캐시도 같이 갱신한다.
let META_CACHE_ = null;
// [2026-11-09c] 한 번의 요청이 30초를 넘기지 않도록 시간 예산을 둔다. 점수 재계산처럼 '다음 변경 때 다시 만들어지는' 후순위 작업은 이미 SYNC_BUDGET_MS_ 넘게 썼으면 건너뛴다(데이터 저장은 항상 먼저 끝남).
let REQ_T0_ = Date.now();
const SYNC_BUDGET_MS_ = 14000;
function overBudget_(){ return (Date.now() - REQ_T0_) > SYNC_BUDGET_MS_; }
function metaCacheLoad_(ss){
  if(META_CACHE_) return META_CACHE_;
  const sh = getOrCreateSheet_(ss, 'Meta', ['key','value']);
  const values = sh.getDataRange().getValues();
  const m = {};
  for(let i=1;i<values.length;i++){
    if(!Object.prototype.hasOwnProperty.call(m, values[i][0])) m[values[i][0]] = values[i][1];
  }
  META_CACHE_ = m;
  return m;
}
function getMeta_(ss, key){
  const m = metaCacheLoad_(ss);
  return Object.prototype.hasOwnProperty.call(m, key) ? m[key] : null;
}
function setMeta_(ss, key, value){
  if(META_CACHE_ && Object.prototype.hasOwnProperty.call(META_CACHE_, key) && String(META_CACHE_[key]) === String(value)) return; // 이미 같은 값 — 시트를 읽지도 쓰지도 않음
  const sh = getOrCreateSheet_(ss, 'Meta', ['key','value']);
  const values = sh.getDataRange().getValues();
  // [2026-11-09c] 값이 이미 같으면 쓰지 않는다(앱이 매 동기화마다 deletedIds·goals·favorites를 그대로 다시 보내므로)
  for(let i=1;i<values.length;i++){
    if(values[i][0] === key){
      if(String(values[i][1]) !== String(value)) sh.getRange(i+1,2).setValue(value);
      if(META_CACHE_) META_CACHE_[key] = value;
      return;
    }
  }
  sh.appendRow([key, value]);
  if(META_CACHE_) META_CACHE_[key] = value;
}








/**
 * [2026-08-04 추가] 텔레그램 연동 설정값을 스크립트 속성에서 읽어옴.
 * 둘 중 하나라도 없으면 sendTelegramMessage_가 조용히 아무것도 안 하고 리턴.
 */
function getTelegramConfig_(){
  const props = PropertiesService.getScriptProperties();
  return {
    token: props.getProperty('TELEGRAM_BOT_TOKEN'),
    chatId: props.getProperty('TELEGRAM_CHAT_ID'),
  };
}








/**
 * [2026-08-04 추가] 텔레그램으로 메시지 한 건 발송.
 * 알림 실패가 데이터 처리(시트 반영) 자체를 막으면 안 되므로, 실패해도 예외를 던지지
 * 않고 로그만 남김 — 알림은 어디까지나 "부가 기능"이고 데이터 동기화가 본 기능이기 때문.
 */
function sendTelegramMessage_(text){
  const cfg = getTelegramConfig_();
  if(!cfg.token || !cfg.chatId) return; // 미설정 상태 — 조용히 건너뜀
  try{
    const url = `https://api.telegram.org/bot${cfg.token}/sendMessage`;
    UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({chat_id: cfg.chatId, text, parse_mode: 'HTML'}),
      muteHttpExceptions: true,
    });
  } catch(e){
    Logger.log('텔레그램 발송 실패: ' + e);
  }
}








/**
 * [2026-08-06 추가] 부동소수점 오차 제거용 반올림 헬퍼(소수점 1자리).
 * "151.8 - 150" 같은 JS 부동소수점 연산 결과가 그대로 표시되던 문제(1번)를
 * 델타 계산과 누적합계 계산 양쪽에서 공통으로 방지하기 위해 사용.
 */
function round1_(n){
  return Math.round(n * 10) / 10;
}








/**
 * [2026-08-05 추가] index.html의 computeCalorieTarget/computeCarbTarget/parseVolume과
 * 동일한 공식을 Apps Script에도 이식한 헬퍼 모음. 텔레그램 식단 누적 알림에
 * "목표 대비 부족·초과분"을 표시하기 위해 사용.
 */
// [2026-09-19 수정, 개선안 20선 2번] 기존엔 이 세 값이 const라 클라이언트 설정탭(state.goals)과
// 완전히 무관한 하드코딩값이었음 — 정희님이 앱에서 단백질/탄수/심박존 목표를 바꿔도 텔레그램은
// 영원히 이 기본값 기준으로 델타를 계산해 알려주는 불일치가 있었음(20선 리포트 2번 항목).
// 이제 let으로 바꾸고, applyGoalsOverride_(ss)가 Meta의 goals를 읽어 이 값들을 갱신한다 —
// 클라이언트의 applyGoalOverrides_() 패턴과 동일한 구조.
const PROTEIN_TARGET_RANGE_DEFAULT_ = [130, 160]; // 2026-11-07: 140~170→130~160g(총 단백질 1.62g/kg 이상 추가 이득 없음, 제지방 57kg×2.3g≈131g)
const KCAL_TARGET_MID_ = 2050, KCAL_BAND_LOW_ = 1900, KCAL_BAND_HIGH_ = 2200; // 2026-11-07: 칼로리 주 평균 기본 목표(밴드)
// [2026-11-07c] A안: 운동 가산은 주 단위 — 그 주(월~일) 운동 칼로리 합계가 2,300kcal를 넘으면 초과분의 60%를 하루 평균으로 환산해 더한다(앱 kcalWeekTarget_와 같은 규칙, 매월 점검에서 재보정).
const KCAL_EXTRA_BASE_WEEK_ = 2300, KCAL_EXTRA_FACTOR_ = 0.6, KCAL_BAND_HALF_ = 150;
const CARB_TARGET_RANGES_DEFAULT_ = { A:[130,150], B:[150,180], C:[180,210] };
// [2026-09-19 추가, 20선 13번] index.html FAT_GOALS와 동일하게 goals.fatGoals로 덮어쓸 수 있는
// 체지방률 목표 — computeGoalDriftAlertServer_가 "다음 목표"를 찾을 때 사용.
const FAT_GOALS_DEFAULT_ = [{label:"1차 목표", pct:20}, {label:"2차 목표", pct:18}];
let PROTEIN_TARGET_RANGE_ = PROTEIN_TARGET_RANGE_DEFAULT_;
let CARB_TARGET_RANGES_ = CARB_TARGET_RANGES_DEFAULT_;
let FAT_GOALS_ = FAT_GOALS_DEFAULT_;
const CARB_VOLUME_PR_RATIO_ = 0.4;
/** Meta의 goals(클라이언트 설정탭에서 저장한 JSON)를 읽어 PROTEIN_TARGET_RANGE_/
 *  CARB_TARGET_RANGES_/ZONE2_LOW_/ZONE2_HIGH_를 그 값으로 갱신. goals가 없거나 파싱 실패하면
 *  기본값을 유지(폴백). 단백질 자동계산 모드(perKgMin/perKgMax)면 InBody 최신 체중을 조회해
 *  클라이언트의 applyGoalOverrides_()와 동일한 방식으로 범위를 계산한다.
 *  텔레그램 메시지를 만드는 함수(notifyImmediate_/sendEveningDigest) 맨 앞에서 호출할 것. */
function applyGoalsOverride_(ss){
  PROTEIN_TARGET_RANGE_ = PROTEIN_TARGET_RANGE_DEFAULT_;
  CARB_TARGET_RANGES_ = CARB_TARGET_RANGES_DEFAULT_;
  ZONE2_LOW_ = ZONE2_LOW_DEFAULT_;
  ZONE2_HIGH_ = ZONE2_HIGH_DEFAULT_;
  FAT_GOALS_ = FAT_GOALS_DEFAULT_;
  let g;
  try{
    const raw = getMeta_(ss, 'goals');
    g = raw ? JSON.parse(raw) : null;
  }catch(e){ g = null; }
  if(!g || typeof g!=='object') return;
  // [2026-09-19 추가, 20선 13번] index.html의 FAT_GOALS 덮어쓰기(g.fatGoals)와 동일한 패턴.
  if(Array.isArray(g.fatGoals) && g.fatGoals.length){
    FAT_GOALS_ = g.fatGoals;
  }
  if(g.carbRanges){
    CARB_TARGET_RANGES_ = {
      A: g.carbRanges.A || CARB_TARGET_RANGES_DEFAULT_.A,
      B: g.carbRanges.B || CARB_TARGET_RANGES_DEFAULT_.B,
      C: g.carbRanges.C || CARB_TARGET_RANGES_DEFAULT_.C,
    };
  }
  if(g.cardioHR && g.cardioHR.min!=null && g.cardioHR.max!=null){
    ZONE2_LOW_ = g.cardioHR.min; ZONE2_HIGH_ = g.cardioHR.max;
  }
  const proteinRuleOk_ = !!(g.protein && g.protein.rule === '2026-11-07'); // 새 기준 이전에 저장된 값(140~170 등)은 무시
  if(proteinRuleOk_ && g.protein.mode==='auto' && g.protein.perKgMin && g.protein.perKgMax){
    const allInbody = readSheet_(ss, SHEETS.inbody).filter(r=>r.weight!=null).sort((a,b)=>String(a.date).localeCompare(String(b.date)));
    const last = allInbody[allInbody.length-1];
    if(last && last.weight){
      PROTEIN_TARGET_RANGE_ = [Math.round(last.weight*g.protein.perKgMin), Math.round(last.weight*g.protein.perKgMax)];
      return;
    }
  }
  if(proteinRuleOk_ && g.protein.min!=null && g.protein.max!=null){
    PROTEIN_TARGET_RANGE_ = [g.protein.min, g.protein.max];
  }
}








function parseVolume_(v){
  if(v===null||v===undefined) return 0;
  if(typeof v==='number') return v;
  const n = Number(String(v).replace(/[^0-9.]/g,''));
  return isNaN(n) ? 0 : n;
}








// 칼로리 목표: base(BMR×1.5-550) + (EAT가 BMR×0.3 초과 시) 초과분×0.6 보정
// [2026-11-07] 기초대사·운동 보정 폐지: 주 평균 고정 목표 밴드(인자는 호환용으로 받고 무시)
function computeCalorieTarget_(bmr, eatKcal){
  return { targetLow: KCAL_BAND_LOW_, targetHigh: KCAL_BAND_HIGH_ }; // 기본 밴드(운동 가산 없음) — 실제 목표는 kcalWeekTargetOn_ 사용. 호환용으로만 남김
}
// 탄수화물 목표: 오늘 근력볼륨 vs 역대 PR의 40% 기준 A/B/C 3단계
// hasStrengthToday=false면 무조건 A등급(근력 없는 날)
function computeCarbTarget_(todayVolumeKg, prVolumeKg, hasStrengthToday){
  if(!hasStrengthToday){
    return { tier:'A', range: CARB_TARGET_RANGES_.A, reason:'근력 없는 날' };
  }
  if(!prVolumeKg || prVolumeKg<=0){
    return { tier:'B', range: CARB_TARGET_RANGES_.B, reason:'PR 데이터 없음(기본 B등급)' };
  }
  const threshold = prVolumeKg * CARB_VOLUME_PR_RATIO_;
  if(todayVolumeKg >= threshold){
    return { tier:'C', range: CARB_TARGET_RANGES_.C, reason:`볼륨 ${Math.round(todayVolumeKg)}kg ≥ PR40%(${Math.round(threshold)}kg)` };
  }
  return { tier:'B', range: CARB_TARGET_RANGES_.B, reason:`볼륨 ${Math.round(todayVolumeKg)}kg < PR40%(${Math.round(threshold)}kg)` };
}








// 델타 문자열: 하한 미달=섭취-하한(부족), 상한 초과=섭취-상한(초과), 범위 내="범위내"
// [2026-08-06 수정(1번)] round1_ 적용해서 부동소수점 오차 표시 제거.
function formatDelta_(value, low, high){
  const v = round1_(value);
  if(v < low) return `${round1_(v - low)} (부족)`;
  if(v > high) return `+${round1_(v - high)} (초과)`;
  return '범위내';
}








// 해당 날짜(또는 그 이전 가장 최근) InBody 기록에서 BMR을 찾음 — 오늘 인바디가
// 아직 없는 시점(예: 저녁 식단 알림인데 다음날 아침 인바디 전)이면 최근값을 대신 사용.
// [2026-10-16] 정희님이 제외 확정한 날(장염 탈수 등)의 BMR은 수분 왜곡값이라 건너뛰고, 직전 정상 측정의 BMR을 쓴다.
function findBmrForDate_(inbodyRows, date){
  const rows = (inbodyRows || []).filter(r => !isInbodyExcluded_(r));
  const sameDate = rows.find(r => r.date === date);
  if(sameDate && sameDate.bmr) return Number(sameDate.bmr);
  const past = rows
    .filter(r => r.date <= date && r.bmr)
    .sort((a,b) => b.date.localeCompare(a.date));
  return past.length ? Number(past[0].bmr) : null;
}


// [2026-10-26 신설] 칼로리 목표용 기초대사(B안). 하루 인바디의 BMR은 수분 때문에 흔들려(중앙값 9kcal, 최대 57kcal) 목표가 ×1.5로 증폭되므로
// 최근 유효 측정 7번 평균 제지방으로 계산한다. 인바디 BMR = 370 + 21.6 × 제지방(체중−체지방량) — 시트 110건 전부 검증된 식.
// 제외 확정일과 체중만 잰 날(체지방 없음)은 건너뛴다. 2026-10-27 이전 날짜는 예전 방식(findBmrForDate_)을 그대로 쓴다.
const BMR_SMOOTH_START_DATE_ = '2026-10-27';
const BMR_SMOOTH_N_ = 7;
function smoothedBmrForDate_(inbodyRows, date){
  const rows = (inbodyRows || [])
    .filter(r => r && !isInbodyExcluded_(r) && String(r.date) <= String(date) && dsNum_(r.weight) !== null && dsNum_(r.fat) !== null)
    .sort((a,b) => String(a.date).localeCompare(String(b.date)));
  if(!rows.length) return null;
  const lastN = rows.slice(-BMR_SMOOTH_N_);
  const ffm = lastN.reduce((s,r) => s + (dsNum_(r.weight) - dsNum_(r.fat)), 0) / lastN.length;
  return Math.round(370 + 21.6 * ffm);
}
function bmrForTargetOn_(inbodyRows, date){
  if(String(date) < BMR_SMOOTH_START_DATE_) return findBmrForDate_(inbodyRows, date);
  return smoothedBmrForDate_(inbodyRows, date) || findBmrForDate_(inbodyRows, date);
}








/**
 * [2026-08-06 추가(2번)] 해당 날짜 이전 가장 최근 InBody 기록을 찾음(전일 대비 계산용).
 * 반드시 "정확히 하루 전"이 아니라 그 이전의 가장 최근 측정치를 사용 — 인바디를
 * 매일 재지 않는 날(예: 8/2 결측)이 있어도 항상 비교 가능하도록.
 */
function findPrevInbody_(allInbody, date){
  const past = allInbody
    .filter(r => r.date < date && r.weight != null)
    .sort((a,b) => b.date.localeCompare(a.date));
  return past.length ? past[0] : null;
}








/**
 * [2026-08-06 추가(7번)] 프로그램 시작일(가장 오래된 InBody 기록)을 찾음.
 * 골격근손실비율(SURMOUNT-1 방식) 계산 시 분모/분자의 기준점으로 사용.
 */
function getStartInbody_(allInbody){
  const sorted = allInbody.filter(r => r.weight != null && !isInbodyExcluded_(r)).sort((a,b) => a.date.localeCompare(b.date)); // 2026-10-13: 제외분은 시작점 후보에서 제외
  return sorted.length ? sorted[0] : null;
}








/**
 * [2026-10-13 추가] 인바디 "제외 확정" 공통 함수. 앱 index.html의 isExcluded_/validInbody와 같은 규칙:
 * exclude가 true(또는 문자열 TRUE)일 때만 제외, false·'보류'·빈 값은 평균에 포함.
 */
function isInbodyExcluded_(r){
  return !!r && (r.exclude === true || r.exclude === 'TRUE' || r.exclude === 'true');
}
function validInbody_(rows){
  return (rows || []).filter(r => !isInbodyExcluded_(r));
}
function toIsoStr_(v){
  if(v && typeof v.toISOString === 'function') return v.toISOString(); // Date(시트가 날짜로 바꾼 값 포함)
  return v === null || v === undefined ? '' : String(v);
}
/**
 * 들어오는 인바디 배열을 시트에 쓰기 전에 정리(원본 배열은 건드리지 않고 복사본 반환).
 * ① exclude를 정하면서 excludeAt이 없으면(채팅이 보낸 제외) 지금 시각을 기록
 * ② 시트에 같은 날짜의 결정(excludeAt)이 이미 있으면, 들어온 결정 시각이 더 늦을 때만 덮어쓰고 아니면 시트 값을 유지
 *    (exclude 키가 아예 없는 업로드·결정 시각이 옛날인 앱 push가 제외 표시를 지우지 못하게 함 — 크레아틴 유지 처리와 같은 이유)
 */
function normalizeIncomingInbody_(ss, rows){
  if(!rows || !rows.length) return rows;
  let existing = null;
  const nowIso = new Date().toISOString();
  return rows.map(r => {
    if(!r) return r;
    const out = Object.assign({}, r);
    const decided = out.exclude !== undefined && out.exclude !== null && out.exclude !== '';
    if(decided && !out.excludeAt) out.excludeAt = nowIso;
    if(existing === null) existing = readSheet_(ss, SHEETS.inbody);
    const prev = existing.filter(x => x.date === out.date)[0];
    if(prev && prev.excludeAt){
      const incomingAt = toIsoStr_(out.excludeAt).slice(0, 19);
      const prevAt = toIsoStr_(prev.excludeAt).slice(0, 19);
      if(!(incomingAt > prevAt)){
        out.exclude = prev.exclude;
        out.excludeReason = prev.excludeReason;
        out.excludeAt = prev.excludeAt;
      }
    }
    return out;
  });
}
/**
 * [2026-10-13 추가] Claude 분석 누락 경고. 실사고(2026-10-13): 새 인바디를 올리면서 분석(aiAnalysis)을 같이 올리지 않아 앱의
 * "Claude 분석" 카드가 10/10에 멈춘 채 며칠 지나도 아무 알림이 없었음. 인박스(채팅 업로드)로 들어온 파일만 센다 — 앱의 14일 동기화는
 * 매번 최근 인바디를 다시 보내므로 세면 오탐이 난다. 날짜 문자열 대신 "수신 시각"을 비교(aiAnalysisDate는 시트가 UTC Date로 바꿀 수 있음).
 */
const ANALYSIS_LAG_MIN_ = 20; // 분
function recordInboxArrival_(data){
  const props = PropertiesService.getScriptProperties();
  const now = new Date().toISOString();
  const hasData = (Array.isArray(data.inbody) && data.inbody.length) || (Array.isArray(data.meals) && data.meals.length);
  if(hasData){
    const dates = [].concat(data.inbody || [], data.meals || []).map(r => r && r.date).filter(Boolean).map(d => String(d).slice(0, 10)).sort();
    props.setProperty('inboxDataAt', now);
    props.setProperty('inboxDataDate', dates.length ? dates[dates.length - 1] : '');
    // 2026-10-18: 분석 없이 들어온 데이터 건수(분석이 같은 파일에 있거나 이후 올라오면 0으로 되돌림) — 경고 문구와 앱 분석 카드 표시용
    const prevN = Number(props.getProperty('inboxPendingCount') || 0);
    props.setProperty('inboxPendingCount', String(data.aiAnalysis ? 0 : prevN + 1));
  }
  if(data.aiAnalysis){
    props.setProperty('inboxAnalysisAt', now);
    props.setProperty('inboxPendingCount', '0');
  }
}
/** 2026-10-18: 앱 분석 카드용 상태. pendingCount>0이면 "분석 이후 새 데이터가 들어옴". 실패하면 null(앱은 표시만 생략). */
function getInboxStatus_(){
  try{
    const props = PropertiesService.getScriptProperties();
    const dataAt = props.getProperty('inboxDataAt') || null;
    const analysisAt = props.getProperty('inboxAnalysisAt') || null;
    const n = Number(props.getProperty('inboxPendingCount') || 0);
    const lagging = !!dataAt && (!analysisAt || analysisAt < dataAt);
    return {dataAt: dataAt, analysisAt: analysisAt, pendingCount: lagging ? n : 0};
  } catch(e){ return null; }
}
function kstLabel_(iso){
  if(!iso) return '기록 없음';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '기록 없음' : Utilities.formatDate(d, 'Asia/Seoul', 'M/d HH:mm');
}
function checkAnalysisLag_(){
  const props = PropertiesService.getScriptProperties();
  const dataAt = props.getProperty('inboxDataAt');
  if(!dataAt) return;
  const analysisAt = props.getProperty('inboxAnalysisAt') || '';
  if(analysisAt >= dataAt) return; // 데이터 이후(또는 같은 파일)에 분석이 올라옴
  if(props.getProperty('inboxLagAlertedFor') === dataAt) return; // 같은 도착 건은 1회만
  const lagMin = Math.round((Date.now() - new Date(dataAt).getTime()) / 60000);
  if(lagMin < ANALYSIS_LAG_MIN_) return;
  const dataDate = props.getProperty('inboxDataDate') || '';
  sendTelegramMessage_(
    `⚠️ <b>Claude 분석 갱신 누락 의심</b>\n` +
    `새 인바디/식단${dataDate ? '(' + dataDate + ' 기준)' : ''}이 ${lagMin}분 전에 들어왔는데, 그 뒤로 "Claude 분석"이 올라오지 않았어요. ` +
    `앱의 분석 카드는 마지막 분석 내용 그대로 남아 있어요. 채팅에서 분석도 올려달라고 요청해 주세요.\n` +
    `· 마지막 분석: ${kstLabel_(analysisAt)} · 마지막 데이터: ${kstLabel_(dataAt)} · 분석 이후 새 데이터 ${Number(props.getProperty('inboxPendingCount') || 0)}건`
  );
  props.setProperty('inboxLagAlertedFor', dataAt);
}




/**
 * [2026-08-06 추가(7번)] MA7(직전 7건) vs 그 이전 7건 비교.
 * date 이하의 기록만 사용(미래 데이터 누수 방지), 날짜 오름차순 정렬 후 뒤에서 7개씩 슬라이스.
 * 총 기록이 8건 미만이면(비교 자체가 무의미) null 반환.
 *
 * [2026-09-24 수정] 체중만 있고 골격근/체지방/체지방률이 빈칸인 레코드(여행 중 체중계만
 * 기록한 날 등)가 최근 7건 윈도우에 섞이면, 기존 avg() 헬퍼가 Number(null||0)으로 빈칸을
 * 0으로 계산해 MA7이 터무니없이 낮게 나오는 버그가 있었음(실사고 2026-09-24 — 텔레그램
 * 알림에 "MA7 골격근 18.6kg, -4.5kg" 같은 오탐이 발송됨). 날짜 정렬 로직 자체는 원래도
 * 정상이었으므로 그대로 두고, 필드별로 실제 값이 있는 레코드만 걸러 평균을 내도록 변경.
 * 유효값이 하나도 없으면 그 필드는 null 반환(호출부에서 "판단 보류"로 처리).
 */
function computeInbodyMA7Compare_(allInbody, date){
  const sorted = allInbody
    .filter(r => r.date <= date && r.weight != null && !isInbodyExcluded_(r)) // 2026-10-13: 제외 확정분은 건너뜀(유효 측정만 7건씩)
    .sort((a,b) => a.date.localeCompare(b.date));
  if(sorted.length < 8) return null;








  const current = sorted.slice(-7);
  const previous = sorted.slice(-14, -7);
  if(previous.length < 1) return null;








  const avgValid_ = (arr, key) => {
    const valid = arr.filter(r => r[key] != null && r[key] !== '' && !isNaN(Number(r[key])));
    if(!valid.length) return null;
    return { avg: valid.reduce((s,r) => s + Number(r[key]), 0) / valid.length, validCount: valid.length };
  };
  const fields = ['weight','muscle','fat','fatPct'];
  const result = { currentCount: current.length, previousCount: previous.length };
  fields.forEach(f => {
    const cur = avgValid_(current, f);
    const prev = avgValid_(previous, f);
    if(!cur || !prev){
      result[f] = null;
    } else {
      result[f] = { current: cur.avg, previous: prev.avg, delta: cur.avg - prev.avg, validCount: cur.validCount };
    }
  });
  return result;
}








/**
 * [2026-08-06 추가(7번)] 골격근손실비율(SURMOUNT-1 방식): 골격근 %감소율 ÷ 체중 %감소율.
 * 시작일 실측값 대비, 현재는 MA7 평균값을 사용(단일측정치 노이즈 완화).
 * 체중 감소율이 0 이하(감량 정체/증가)면 비율 자체가 의미 없으므로 null 반환.
 */
function computeMuscleLossRatio_(startRec, ma7CurrentWeight, ma7CurrentMuscle){
  if(!startRec || !startRec.weight || !startRec.muscle) return null;
  const weightLossPct = (startRec.weight - ma7CurrentWeight) / startRec.weight * 100;
  const muscleLossPct = (startRec.muscle - ma7CurrentMuscle) / startRec.muscle * 100;
  if(weightLossPct <= 0) return null;
  return { weightLossPct, muscleLossPct, ratio: muscleLossPct / weightLossPct };
}








const MUSCLE_LOSS_RATIO_THRESHOLD_ = 0.51;
const MUSCLE_MA7_ROLLBACK_DELTA_ = -0.3;








/**
 * [2026-08-06 추가(7번)] 인바디 즉시알림용 규칙기반(A안, 템플릿) 분석 코멘트 생성.
 * ⚠️ 진짜 AI 분석이 아니라 정해진 조건문 조합입니다 — 질병/컨디션 등 텍스트 맥락은
 * 반영하지 못하므로, 특이 상황 해석은 채팅에서 별도로 받아야 합니다.
 *
 * [2026-09-24 수정] computeInbodyMA7Compare_가 이제 필드별로 null을 반환할 수 있으므로
 * (골격근/체지방/체지방률 유효값 부족 시), ma7.muscle 등이 null인 경우를 명시적으로
 * 처리해서 "판단보류"로 표시하도록 수정. 이전엔 이 케이스를 구분하지 못하고 0으로 계산된
 * 값을 그대로 정상 수치처럼 취급해 잘못된 경고를 냈음.
 */
function buildInbodyAnalysisComment_(r, prevRec, ma7, startRec){
  const lines = [];








  // 전일 대비 방향성 판정
  if(prevRec){
    const muscleDelta = round1_(r.muscle - prevRec.muscle);
    const fatDelta = round1_(r.fat - prevRec.fat);
    if(muscleDelta >= 0 && fatDelta <= 0){
      lines.push('전일 대비 골격근+체지방 동시 개선(단일측정치, 반등 확정 아님).');
    } else if(muscleDelta < 0 && fatDelta > 0){
      lines.push('전일 대비 골격근 감소+체지방 증가 — 단일측정치이나 확인 필요.');
    } else {
      lines.push('전일 대비 지표 혼조 — 단일측정치라 추세 판단 보류.');
    }
  }








  // MA7 방향성 + 롤백기준 비교
  if(ma7){
    if(!ma7.weight || !ma7.muscle || !ma7.fat || !ma7.fatPct){
      lines.push('MA7 비교: 최근 7건 중 골격근/체지방 실측값이 부족해(체중만 기록된 날 포함) 이번엔 계산을 보류합니다.');
    } else {
      const muscleMA7Delta = round1_(ma7.muscle.delta);
      const fatMA7Delta = round1_(ma7.fat.delta);
      const weightMA7Delta = round1_(ma7.weight.delta);
      let ma7Line = `MA7(골격근·체지방 유효값 ${ma7.muscle.validCount}건) 체중 ${weightMA7Delta >= 0 ? '+' : ''}${weightMA7Delta}kg`;
      ma7Line += fatMA7Delta > 0 ? ', 체지방 반등 주의' : ', 체지방 감소 추세 유지';
      lines.push(ma7Line + '.');








      if(muscleMA7Delta <= MUSCLE_MA7_ROLLBACK_DELTA_){
        lines.push(`⚠️ MA7 골격근 손실폭(${muscleMA7Delta}kg)이 롤백기준(${MUSCLE_MA7_ROLLBACK_DELTA_}kg) 도달/초과 — 운동전략 재검토 필요.`);
      } else {
        lines.push(`MA7 골격근 손실폭(${muscleMA7Delta}kg)은 롤백기준(${MUSCLE_MA7_ROLLBACK_DELTA_}kg) 이내로 양호.`);
      }
      const ratioInfo = computeMuscleLossRatio_(startRec, ma7.weight.current, ma7.muscle.current);
      if(ratioInfo){
        const ratio = Math.round(ratioInfo.ratio * 1000) / 1000;
        lines.push(`골격근손실비율(MA7기준) ${ratio}, 임계값(${MUSCLE_LOSS_RATIO_THRESHOLD_}) ${ratio >= MUSCLE_LOSS_RATIO_THRESHOLD_ ? '초과' : '이내'}.`);
      }
    }
  } else {
    lines.push('MA7 비교: 누적 기록 8건 미만이라 계산 불가.');
  }








  return lines.join('\n');
}
/** 부호 포함 숫자 문자열(+/-) 포맷 — 0은 "0.0"으로 표시 */
function formatSignedDelta_(n){
  if(n > 0) return `+${n}`;
  if(n === 0) return '0.0';
  return `${n}`;
}








/**
 * [2026-08-06 추가(3번)] note 문자열에서 "평균심박XXXbpm" 패턴을 추출.
 * 여러 세션이 한 note에 섞여 있으면 첫 매치만 잡히므로, 순수 유산소(part==='유산소')
 * 세션에만 사용하도록 호출부에서 제한함(혼합 세션은 오귀속 위험이 있어 제외).
 */
function extractAvgHeartRate_(note){
  if(!note) return null;
  const m = String(note).match(/평균심박\s*(\d+)\s*bpm/);
  return m ? Number(m[1]) : null;
}








// [2026-09-19 수정, 개선안 20선 2번] const→let, applyGoalsOverride_ 참고(위 PROTEIN_TARGET_RANGE_ 주석).
const ZONE2_LOW_DEFAULT_ = 105;
const ZONE2_HIGH_DEFAULT_ = 125;
let ZONE2_LOW_ = ZONE2_LOW_DEFAULT_;
let ZONE2_HIGH_ = ZONE2_HIGH_DEFAULT_;








function formatZoneStatus_(hr){
  if(hr == null) return '';
  if(hr < ZONE2_LOW_) return `\n평균심박 ${hr}bpm ⚠️ 존 미달 (목표 ${ZONE2_LOW_}-${ZONE2_HIGH_}bpm, ${hr - ZONE2_LOW_}bpm)`;
  if(hr > ZONE2_HIGH_) return `\n평균심박 ${hr}bpm ⚠️ 존 초과 (목표 ${ZONE2_LOW_}-${ZONE2_HIGH_}bpm, +${hr - ZONE2_HIGH_}bpm)`;
  return `\n평균심박 ${hr}bpm ✅ 존 준수 (목표 ${ZONE2_LOW_}-${ZONE2_HIGH_}bpm)`;
}








/** 델타 문자열로부터 목표 달성 여부 배지(✅/⚠️부족/⚠️초과)를 만듦(5번, 저녁요약 총평용) */
function goalStatusLabel_(delta){
  if(delta === '범위내') return '✅';
  if(delta.indexOf('부족') !== -1) return '⚠️부족';
  if(delta.indexOf('초과') !== -1) return '⚠️초과';
  return '⚠️';
}








// ============================================================================
// [2026-10-04 추가] 하루 점수(100점 만점) — 헤더 주석의 설명 참고.
// 이 구간의 계산 함수(dsXxx_, computeDailyScoreCore_)는 채팅용 calc.py daily_score와 같은 공식이다.
// 한쪽을 고치면 반드시 다른 쪽과 daily_score_vectors.json(36건)으로 다시 맞춰볼 것.
// ============================================================================
const DAILY_SCORE_VERSION_ = '2026-11-09'; // 11-09: 보조운동 7일 중 5일 +1 보너스 폐지(옛 하루 점수 참고용). 이전 10-31: 보조운동은 근력일로 세지 않고 7일 중 5일 이상이면 근력일 +1(입력 규칙 변경, 점수 공식·배점은 동일). 10-26: 10-26: 목표용 BMR 입력만 변경(2026-10-27분부터 최근 7번 평균 기준, 공식은 동일). 10-16: 질병·회복일(specialDayType='illness')은 점수 산출 안 함(공식은 10-05와 동일)
const DAILY_SCORE_START_DATE_ = '2026-10-03'; // 이 날짜 이전은 점수를 매기지 않음(정희님 컨펌)








/**
 * [2026-10-05-b 추가] 식단 메모에서 크레아틴 복용을 읽는다. 반환: 복용 g(숫자) 또는 null(복용 표시 없음/부정 표현).
 * 규칙: "크레아틴"(또는 creatine) 바로 뒤에 "N g"가 있으면 그 값, 없으면 기본 3g. 바로 뒤에 부정 표현이 있으면 복용 아님.
 * 숫자를 멋대로 추측하지 않는 최소 규칙만 사용 — 키워드 + 바로 뒤 "숫자g"만 본다.
 */
const CREATINE_DEFAULT_G_ = 3;
function creatineGramsFromNote_(note){
  const s = String(note === null || note === undefined ? '' : note);
  const re = /크레아틴|creatine/gi;
  let m;
  while((m = re.exec(s)) !== null){
    const after = s.slice(m.index + m[0].length, m.index + m[0].length + 14);
    // 2026-10-18: "크레아틴 미확인"처럼 복용 여부를 모르는 표현도 복용으로 읽혀 하루 점수 기록·보조 5점이 잘못 붙던 문제(2026-10-08·09) — 앱 index.html과 같은 규칙.
    if(/^\s*[:=]?\s*(미복용|미섭취|미기록|미확인|모름|불명|불확실|확인\s*(?:안|전|필요|불가)|안\s*먹|못\s*먹|안\s*함|없음|스킵|패스|\?|X\b|x\b)/.test(after)) continue;
    const g = /^\s*[:=]?\s*(\d+(?:\.\d+)?)\s*g/i.exec(after);
    return g ? Number(g[1]) : CREATINE_DEFAULT_G_;
  }
  return null;
}
/** 식단 한 건의 크레아틴 g: 크레아틴 칸이 0보다 크면 그 값, 아니면 메모에서 읽은 값, 없으면 0 */
function mealCreatineGrams_(m){
  const n = Number(m && m.creatine);
  if(n > 0) return n;
  const g = creatineGramsFromNote_(m && m.note);
  return g > 0 ? g : 0;
}
/**
 * 들어온 식단 배열을 시트에 쓰기 전에 정리(원본 배열은 건드리지 않고 복사본 반환).
 * ①creatine 칸이 비어 있고 메모에 크레아틴이 있으면 칸을 채움 ②creatine 키 자체가 없는 업로드(채팅)는 시트에 이미 있는 같은 날짜의 크레아틴 값을 유지.
 */
function normalizeIncomingMeals_(ss, meals){
  if(!meals || !meals.length) return meals;
  let existing = null;
  return meals.map(m => {
    if(!m) return m;
    const out = Object.assign({}, m);
    if(out.estimated === undefined || out.errorPct === undefined){
      if(existing === null) existing = readSheet_(ss, SHEETS.meals);
      const prevE = existing.filter(r => r.date === out.date && (r.estimated !== null || r.errorPct !== null))[0];
      if(prevE){
        if(out.estimated === undefined && prevE.estimated !== null) out.estimated = prevE.estimated;
        if(out.errorPct === undefined && prevE.errorPct !== null) out.errorPct = prevE.errorPct;
      }
    }
    if(!(Number(out.creatine) > 0)){
      const g = creatineGramsFromNote_(out.note);
      if(g > 0) out.creatine = g;
      else if(out.creatine === undefined){
        if(existing === null) existing = readSheet_(ss, SHEETS.meals);
        const prev = existing.filter(r => r.date === out.date && Number(r.creatine) > 0)[0];
        if(prev) out.creatine = Number(prev.creatine);
      }
    }
    return out;
  });
}
/** 시트 Meals에 이미 있는 행 중 creatine 칸이 비었고 메모에 크레아틴이 있는 행을 채운다. 반환: 채운 날짜 목록 */
function backfillMealCreatine_(ss){
  const sh = getOrCreateSheet_(ss, SHEETS.meals.name, SHEETS.meals.cols);
  const values = sh.getDataRange().getValues();
  if(values.length < 2) return [];
  const header = values[0];
  const di = header.indexOf('date'), ni = header.indexOf('note'), ci = header.indexOf('creatine');
  if(di < 0 || ni < 0 || ci < 0) return [];
  const filled = [];
  for(let i = 1; i < values.length; i++){
    if(Number(values[i][ci]) > 0) continue;
    const g = creatineGramsFromNote_(values[i][ni]);
    if(g > 0){
      sh.getRange(i + 1, ci + 1).setValue(g);
      invalidateSheetCache_(SHEETS.meals.name);
      let d = values[i][di];
      if(d instanceof Date) d = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      filled.push(String(d));
    }
  }
  return filled;
}








function dsNum_(v){
  if(v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, '').replace(/kg/g, ''));
  return isNaN(n) ? null : n;
}
/** 근력 세션 = 볼륨>0 이거나, 순수 유산소가 아니면서 종목(exercises) 기록이 있는 세션 */
// [2026-10-31] 보조운동(part가 정확히 '보조운동': 밴드 턱걸이·매달리기 등)은 그날 근력으로도, 최근 7일 근력일로도 세지 않는다.
// [2026-11-09b] 옛 "보조운동 7일 중 5일 → 근력일 +1" 보너스는 폐지(주간 점수의 턱걸이 유효 세트 규칙으로 대체).
function dsIsAux_(w){ return String((w && w.part) || '').trim() === '보조운동'; }
function dsIsStrength_(w){
  if(dsIsAux_(w)) return false;
  const vol = dsNum_(w.volume);
  if(vol && vol > 0) return true;
  if(String(w.part || '').trim() === '유산소') return false;
  return Array.isArray(w.exercises) && w.exercises.length > 0;
}
/** 인정 유산소 = part가 정확히 '유산소' AND 평균심박 105 이상 AND 20분 이상(구조화 필드만, 없으면 불인정) */
function dsIsQualifyingCardio_(w){
  // [2026-11-07] 30분 이상 또는 3km 이상(평균심박 조건 폐지) — 주간 점수 wsIsCardio_와 같은 기준
  if(String(w.part || '').trim() !== '유산소') return false;
  const dur = dsNum_(w.durationMin), km = dsNum_(w.distanceKm);
  return (dur !== null && dur >= 30) || (km !== null && km >= 3);
}
/** 범위 내=full, 범위 밖 gap이 nearGap 이내=near, midGap 이내=mid(없으면 null), 그 외 0 */
function dsBand_(value, low, high, full, near, mid, nearGap, midGap){
  if(value >= low && value <= high) return {points: full, inRange: true, over: false, gap: 0};
  const below = value < low;
  const gap = below ? low - value : value - high;
  let points = 0;
  if(gap <= nearGap) points = near;
  else if(mid !== null && gap <= midGap) points = mid;
  return {points: points, inRange: false, over: !below, gap: gap};
}
/**
 * [2026-10-05 추가] 허용오차 + 선형 감점 채점. 목표 범위(low~high) 밖이라도 허용오차(tol) 이내면 만점,
 * 그 너머는 허용 가장자리 기준 이탈량(outGap)에 비례해 full에서 0점까지 직선으로 줄어든다(decayWidth만큼 벗어나면 0점).
 * 반환: {points(소수 2자리), inRange(원래 목표 범위 안), inTol(허용오차까지 포함해 만점), over(상한 쪽 이탈), gap(원래 범위 기준 이탈량), outGap}
 * calc.py _band_tol과 같은 공식이다(점수 벡터로 패리티 확인).
 */
const DS_CAL_TOL_LOW_ = 50, DS_CAL_DECAY_ = 450;   // 칼로리: 하한 -50kcal 허용(상한은 기존 목표범위 +100 그대로), 450kcal 이탈 시 0점
const DS_PROT_TOL_LOW_ = 5, DS_PROT_DECAY_ = 40;   // 단백질: 하한 -5g 허용(상한 초과는 원래 감점 없음), 40g 이탈 시 0점
const DS_CARB_TOL_ = 5, DS_CARB_DECAY_ = 40;       // 탄수: ±5g 허용, 40g 이탈 시 0점
function dsBandTol_(value, low, high, full, tolLow, tolHigh, decayWidth){
  const inRange = value >= low && value <= high;
  const below = value < low;
  const gap = inRange ? 0 : (below ? low - value : value - high);
  const outGap = Math.max(0, gap - (below ? tolLow : tolHigh));
  const points = outGap > 0 ? Math.max(0, full * (1 - outGap / decayWidth)) : full;
  return {points: Math.round(points * 100) / 100, inRange: inRange, inTol: outGap === 0, over: !inRange && !below, gap: gap, outGap: outGap};
}
function dsDateMinus_(date, days){
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
function dsFmt_(n){ return String(Math.round(n * 10) / 10); } // 표시용: 소수 1자리, 불필요한 .0 제거








/**
 * 순수 계산. 입력: {date, bmr, meal:{calories,protein,carbs,creatine}|null, workouts:[최근 7일 전체],
 * pr_kg, protein_range, carb_ranges, estimated}. 시트 접근 없음(테스트·패리티 검증용).
 * 식단 미기록 또는 BMR 미확인이면 score=null(0점이 아니라 "산출 안 함").
 */
function computeDailyScoreCore_(inp){
  const date = inp.date;
  const meal = inp.meal;
  if(!meal || dsNum_(meal.calories) === null){
    return {date: date, score: null, reason: '식단 미기록 — 점수 산출 안 함', version: DAILY_SCORE_VERSION_};
  }
  if(inp.special === 'illness'){
    return {date: date, score: null, reason: '질병·회복일 — 점수 산출 안 함', version: DAILY_SCORE_VERSION_};
  }
  const bmr = dsNum_(inp.bmr);
  if(!bmr){
    return {date: date, score: null, reason: 'BMR 미확인 — 칼로리 목표 계산 불가', version: DAILY_SCORE_VERSION_};
  }
  const winStart = dsDateMinus_(date, 6);
  const wsAll = (inp.workouts || []).filter(w => { const d = String(w.date).slice(0, 10); return d >= winStart && d <= date; });
  const wsToday = wsAll.filter(w => String(w.date).slice(0, 10) === date);








  // 목표: computeCalorieTarget_/computeCarbTarget_와 같은 규칙(기본목표 반올림 후 보정)
  const eat = wsToday.reduce((s, w) => s + (dsNum_(w.calories) || 0), 0);
  const base = Math.round(bmr * 1.5 - 550);
  const thr = bmr * 0.3;
  const tgt = eat > thr ? Math.round(base + (eat - thr) * 0.6) : base;
  const calLo = tgt, calHi = tgt + 100;








  const todayVol = wsToday.reduce((s, w) => s + (dsNum_(w.volume) || 0), 0);
  const hasStrengthToday = wsToday.some(dsIsStrength_);
  const pr = dsNum_(inp.pr_kg) || 0;
  const cr = inp.carb_ranges || {A:[130,150], B:[150,180], C:[180,210]};
  let tier;
  if(!hasStrengthToday) tier = 'A';
  else if(pr <= 0) tier = 'B';
  else tier = todayVol >= pr * 0.4 ? 'C' : 'B';
  const carbLo = cr[tier][0], carbHi = cr[tier][1];
  const pr_ = inp.protein_range || [140, 170];
  const protLo = pr_[0], protHi = pr_[1];








  const cal = dsNum_(meal.calories);
  const prot = dsNum_(meal.protein) || 0;
  const carb = dsNum_(meal.carbs) || 0;








  const bCal = dsBandTol_(cal, calLo, calHi, 30, DS_CAL_TOL_LOW_, 0, DS_CAL_DECAY_);
  let pProt, protText;
  if(prot > protHi){ pProt = 20; protText = '상한 초과(감점 없음) (' + round1_(prot) + 'g)'; }
  else {
    const b = dsBandTol_(prot, protLo, protHi, 20, DS_PROT_TOL_LOW_, 0, DS_PROT_DECAY_);
    pProt = b.points;
    protText = b.inRange ? '범위 내 (' + round1_(prot) + 'g)'
      : (b.inTol ? '하한 근접 -' + round1_(b.gap) + 'g (허용 -' + DS_PROT_TOL_LOW_ + 'g 이내, 감점 없음)' : '하한 미달 -' + round1_(b.gap) + 'g');
  }
  const bCarb = dsBandTol_(carb, carbLo, carbHi, 15, DS_CARB_TOL_, DS_CARB_TOL_, DS_CARB_DECAY_);








  const dayStrength = hasStrengthToday ? 7.5 : 0;
  const dayCardio = wsToday.some(dsIsQualifyingCardio_) ? 5.0 : 0;
  const sDates = {}, cDates = {};
  wsAll.forEach(w => {
    const d = String(w.date).slice(0, 10);
    if(dsIsStrength_(w)) sDates[d] = true;
    if(dsIsQualifyingCardio_(w)) cDates[d] = true;
  });
  const sDays = Object.keys(sDates).length, cDays = Object.keys(cDates).length;
  const wkStrength = Math.min(sDays, 3) / 3 * 7.5;
  const wkCardio = Math.min(cDays, 3) / 3 * 5.0;
  const pAct = Math.round((dayStrength + dayCardio + wkStrength + wkCardio) * 100) / 100;








  const creatineTaken = (dsNum_(meal.creatine) || 0) > 0;
  const pRec = 5 + (creatineTaken ? 5 : 0);








  const calText = bCal.inRange ? '목표 범위 내 (' + round1_(cal) + 'kcal)'
    : (bCal.inTol ? '하한 근접 -' + round1_(bCal.gap) + 'kcal (허용 -' + DS_CAL_TOL_LOW_ + 'kcal 이내, 감점 없음)'
      : (bCal.over ? '상한 초과 +' : '하한 미달 -') + round1_(bCal.gap) + 'kcal');
  const carbText = tier + '등급 ' + (bCarb.inRange ? '범위 내 (' + round1_(carb) + 'g)'
    : (bCarb.inTol ? (bCarb.over ? '상한 근접 +' : '하한 근접 -') + round1_(bCarb.gap) + 'g (허용 ±' + DS_CARB_TOL_ + 'g 이내, 감점 없음)'
      : (bCarb.over ? '상한 초과 +' : '하한 미달 -') + round1_(bCarb.gap) + 'g'));
  const actText = '오늘 ' + dsFmt_(dayStrength + dayCardio) + '/12.5 + 최근7일 ' + dsFmt_(wkStrength + wkCardio) +
    '/12.5 (근력 ' + sDays + '일·유산소 ' + cDays + '일)';
  const recText = '식단 기록' + (creatineTaken ? ' + 크레아틴' : ', 크레아틴 미기록');








  const parts = {
    calories: {points: bCal.points, max: 30, basis: calText},
    protein: {points: pProt, max: 20, basis: protText},
    carbs: {points: bCarb.points, max: 15, basis: carbText},
    activity: {points: pAct, max: 25, basis: actText},
    record: {points: pRec, max: 10, basis: recText},
  };
  const sum = parts.calories.points + parts.protein.points + parts.carbs.points + parts.activity.points + parts.record.points;
  return {
    date: date,
    score: Math.round((sum + 1e-9) * 10) / 10,
    max: 100,
    parts: parts,
    tier: tier,
    calTarget: [calLo, calHi],
    estimated: !!inp.estimated,
    version: DAILY_SCORE_VERSION_,
  };
}








/** 시트에서 그날 식단·최근 7일 운동·BMR·PR을 읽어 Core에 넣는 어댑터. 데이터는 호출자가 한 번만 읽어 넘긴다. */
function computeDailyScoreForDate_(date, allInbody, allWorkouts, allMeals){
  const mealRows = allMeals.filter(m => m.date === date);
  let meal = null, estimated = false, special = null;
  if(mealRows.length){
    meal = {
      calories: mealRows.reduce((s, m) => s + (dsNum_(m.calories) || 0), 0),
      protein: mealRows.reduce((s, m) => s + (dsNum_(m.protein) || 0), 0),
      carbs: mealRows.reduce((s, m) => s + (dsNum_(m.carbs) || 0), 0),
      creatine: mealRows.reduce((s, m) => s + mealCreatineGrams_(m), 0), // 2026-10-05-b: 칸이 비어도 메모의 "크레아틴" 인식
    };
    // 표시용 힌트일 뿐 점수에는 영향 없음: 식단 note에 '추정'이 있으면 "추정 포함"으로 표기
    // [2026-10-16] 구조화 필드 estimated(TRUE)를 우선 쓰고, 없는 옛 기록은 note의 '추정' 단어로 폴백
    estimated = mealRows.some(m => m.estimated === true || m.estimated === 'TRUE' || m.estimated === 'true' || /추정/.test(String(m.note || '')));
    if(mealRows.some(m => m.specialDayType === 'illness')) special = 'illness';
  }
  const prKg = allWorkouts.reduce((max, w) => Math.max(max, parseVolume_(w.volume)), 0);
  return computeDailyScoreCore_({
    date: date,
    bmr: bmrForTargetOn_(allInbody, date),
    meal: meal,
    workouts: allWorkouts,
    pr_kg: prKg,
    protein_range: PROTEIN_TARGET_RANGE_,
    carb_ranges: CARB_TARGET_RANGES_,
    estimated: estimated,
    special: special,
  });
}








/** DailyScore 시트에 날짜당 1행 저장(같은 날짜는 덮어씀). status: '잠정'|'확정' */
function dailyScoreRecord_(r, status){
  if(!r || r.score === null || r.score === undefined) return null;
  const p = r.parts;
  return {
    date: r.date,
    score: r.score,
    calories: p.calories.points,
    protein: p.protein.points,
    carbs: p.carbs.points,
    activity: p.activity.points,
    record: p.record.points,
    status: status,
    estimated: r.estimated,
    updatedAt: new Date().toISOString(),
    version: r.version,
    detail: {
      calories: p.calories.basis, protein: p.protein.basis, carbs: p.carbs.basis,
      activity: p.activity.basis, record: p.record.basis,
      tier: r.tier, calTarget: r.calTarget,
    },
  };
}
// [2026-11-11] 하루 점수 저장: 날짜마다 시트를 읽고 쓰던 것을 모아서 한 번에(updatedAt만 다른 행은 쓰지 않음)
function saveDailyScores_(ss, records){
  const recs = (records || []).filter(Boolean);
  if(recs.length) upsertSheet_(ss, SHEETS.dailyScore, recs, null, null, ['updatedAt']);
}
function saveDailyScore_(ss, r, status){
  const rec = dailyScoreRecord_(r, status);
  if(rec) saveDailyScores_(ss, [rec]);
}








/** 텔레그램 저녁 요약 맨 아래에 붙일 점수 블록. label 예: "21시 기준 잠정" */
function formatDailyScoreBlock_(r, label){
  if(!r || r.score === null || r.score === undefined){
    return '🎯 하루 점수: 산출 안 함' + (r && r.reason ? ' (' + r.reason.replace(/ — 점수 산출 안 함$/, '') + ')' : '');
  }
  const p = r.parts;
  let s = '🎯 <b>하루 점수 ' + dsFmt_(r.score) + ' / 100</b>' + (label ? '  (' + label + ')' : '') + '\n' +
    '· 칼로리 ' + dsFmt_(p.calories.points) + ' / 30 — ' + p.calories.basis + '\n' +
    '· 단백질 ' + dsFmt_(p.protein.points) + ' / 20 — ' + p.protein.basis + '\n' +
    '· 탄수 ' + dsFmt_(p.carbs.points) + ' / 15 — ' + p.carbs.basis + '\n' +
    '· 운동·활동 ' + dsFmt_(p.activity.points) + ' / 25 — ' + p.activity.basis + '\n' +
    '· 기록·보조 ' + dsFmt_(p.record.points) + ' / 10 — ' + p.record.basis + '\n' +
    '※ 체성분 판정이 아니라 그날 행동 평가예요.';
  if(r.estimated) s += '\n※ 식단에 추정치가 포함돼 있어(±20~30%) 칼로리·탄수 점수가 달라질 수 있어요.';
  return s;
}








// =====================================================================================
// [2026-11-07 추가] 주간 점수(100점, 월~일) — 하루 점수를 대신해 앱·텔레그램에 보여주는 점수.
//  근력 30(주 2회 만점, 1회 15) · 유산소 20(주 3회 만점, 비례) · 단백질 20(120g 이상 5일 만점, 비례) · 기록 10(6일 만점, 비례)
//  · 칼로리 20(주 평균 1,950~2,200 만점, 밖으로 300kcal 벗어나면 0, 선형). 하루·주 단위 경고·색 구분은 하지 않는다(숫자만).
//  근력일: 보조운동·유산소·회복이 아닌 세션 중 볼륨>0 또는 종목 기록 있음 또는 30분 이상(PT처럼 볼륨 기록이 없어도 근력 1회).
//  유산소일: part가 정확히 '유산소' AND (30분 이상 OR 3km 이상)(심박은 참고만). 칼로리 밴드 1,900~2,200(2026-11-07b). 칼로리 평균은 오늘(진행 중)을 제외한다(그 주 다른 날이 없으면 오늘 포함).
//  공식 사본: 채팅 점검 때 같은 값으로 재현 가능(2026-11-07 시트 기준 6주 백테스트 일치).
// =====================================================================================
const WEEKLY_SCORE_VERSION_ = '2026-11-09b';
const WEEKLY_SCORE_START_ = '2026-09-28';                      // 이 주(월요일)부터 계산
const WEEKLY_SCORE_SKIP_ = {'2026-10-12': '장염 회복주 — 점수 산출 안 함(참고값만)'}; // 정희님이 확정한 질병·회복주
const WS_KCAL_LOW_ = 1900, WS_KCAL_HIGH_ = 2200, WS_KCAL_ZERO_GAP_ = 300, WS_PROTEIN_MIN_ = 120;
function wsDate_(v){ return String(v || '').slice(0, 10); }
/** 그 날짜가 속한 주(월~일)의 칼로리 목표: 기본 2,050 + 운동 가산(합계 2,300 초과분×0.6÷7). 운동 칼로리는 Workouts 시트 calories(채택값) 합계 */
function kcalWeekTargetFrom_(allWorkouts, date){
  const start = wsWeekStart_(date), end = dsDateMinus_(start, -6);
  const eat = allWorkouts.reduce((s, w) => { const d = wsDate_(w.date); return (d >= start && d <= end) ? s + (dsNum_(w.calories) || 0) : s; }, 0);
  const add = Math.round(Math.max(0, eat - KCAL_EXTRA_BASE_WEEK_) * KCAL_EXTRA_FACTOR_ / 7);
  const mid = KCAL_TARGET_MID_ + add;
  return {eat: Math.round(eat), add: add, mid: mid, low: mid - KCAL_BAND_HALF_, high: mid + KCAL_BAND_HALF_, weekStart: start};
}
function kcalWeekTargetOn_(ss, date){ return kcalWeekTargetFrom_(readSheet_(ss, SHEETS.workouts), date); }
function wsR1_(n){ return Math.round(n * 10) / 10; }
function wsWeekStart_(date){
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
function wsIsStrength_(w){
  if(dsIsAux_(w)) return false;
  const part = String(w.part || '').trim();
  if(part === '' || part === '유산소' || part === '회복') return false;
  const vol = dsNum_(w.volume), dur = dsNum_(w.durationMin);
  if(vol && vol > 0) return true;
  if(Array.isArray(w.exercises) && w.exercises.length > 0) return true;
  return dur !== null && dur >= 30;
}
// [2026-11-09b] 턱걸이 유효 세트 규칙: 보조운동 기록의 풀업·친업·턱걸이 종목 세트 중 정상 반복(reps) 5회 이상 + rir 0~4 입력(시도 tried가 있으면 reps 이상)인 세트만 유효.
// 5회·RIR 0~4는 앱 운영용 실용 기준(공식 가이드라인 값 아님). 매달리기(초)는 제외. RIR이 없는 옛 기록·문구만 있는 기록은 유효 세트로 세지 않는다.
const WS_PULL_SET_MIN_REPS_ = 5, WS_PULL_RIR_MAX_ = 4, WS_PULL_WEEK_MIN_SETS_ = 6, WS_PULL_WEEK_MIN_DAYS_ = 2;
function wsPullValidSet_(st){
  if(!st) return false;
  const r = Number(st.reps); if(!(r >= WS_PULL_SET_MIN_REPS_)) return false;
  if(st.rir === null || st.rir === undefined || st.rir === '') return false;
  const rir = Number(st.rir); if(isNaN(rir) || rir < 0 || rir > WS_PULL_RIR_MAX_) return false;
  if(st.tried !== null && st.tried !== undefined && st.tried !== '' && Number(st.tried) < r) return false;
  return true;
}
/** 한 운동 기록의 유효 턱걸이 세트 수(보조운동 기록만) */
function wsPullValidSets_(w){
  if(!dsIsAux_(w) || !Array.isArray(w.exercises)) return 0;
  let n = 0;
  w.exercises.forEach(ex => {
    if(!/턱걸이|친업|풀업|pull|chin/i.test(String((ex && ex.name) || ''))) return;
    n += (Array.isArray(ex.sets) ? ex.sets : []).filter(wsPullValidSet_).length;
  });
  return n;
}
/** 주간 판정: byDate = {날짜: 유효 세트 수} → 수행일·유효 세트 합계·인정 여부 */
function wsPullWeek_(byDate){
  const dates = Object.keys(byDate).filter(d => byDate[d] > 0);
  const sets = dates.reduce((s, d) => s + byDate[d], 0);
  return {days: dates.length, sets: sets, bonus: (dates.length >= WS_PULL_WEEK_MIN_DAYS_ && sets >= WS_PULL_WEEK_MIN_SETS_) ? 1 : 0};
}
function wsIsCardio_(w){
  return dsIsQualifyingCardio_(w); // 30분 이상 또는 3km 이상
}
function computeWeeklyScore_(weekStart, allWorkouts, allMeals, today){
  const weekEnd = dsDateMinus_(weekStart, -6);
  const inWeek = d => d >= weekStart && d <= weekEnd;
  const sDays = {}, cDays = {};
  const pullByDate = {};
  allWorkouts.forEach(w => {
    const d = wsDate_(w.date); if(!inWeek(d)) return;
    const pv = wsPullValidSets_(w); if(pv) pullByDate[d] = (pullByDate[d] || 0) + pv;
    if(wsIsStrength_(w)) sDays[d] = 1;
    if(wsIsCardio_(w)) cDays[d] = 1;
  });
  const byDay = {};
  allMeals.forEach(m => {
    const d = wsDate_(m.date); if(!inWeek(d)) return;
    const c = dsNum_(m.calories) || 0; if(c <= 0) return;
    if(!byDay[d]) byDay[d] = {cal: 0, prot: 0};
    byDay[d].cal += c; byDay[d].prot += dsNum_(m.protein) || 0;
  });
  const days = Object.keys(byDay).sort();
  if(!days.length) return null;                                   // 그 주 식단 기록이 없으면 저장하지 않음
  const calDays = days.filter(d => d < today);
  const useDays = calDays.length ? calDays : days;
  const avgKcal = Math.round(useDays.reduce((s, d) => s + byDay[d].cal, 0) / useDays.length);
  const pw = wsPullWeek_(pullByDate);                                // 2026-11-09b: 유효 세트 6세트·2일 이상 → 근력 +1(최대 1)
  const gymN = Object.keys(sDays).length;
  const sN = gymN >= 2 ? gymN : gymN + pw.bonus, cN = Object.keys(cDays).length;
  const pN = days.filter(d => byDay[d].prot >= WS_PROTEIN_MIN_).length, rN = days.length;
  const kt = kcalWeekTargetFrom_(allWorkouts, weekStart);
  const gap = avgKcal < kt.low ? kt.low - avgKcal : (avgKcal > kt.high ? avgKcal - kt.high : 0);
  const parts = {
    strength: wsR1_(Math.min(sN, 2) / 2 * 30),
    cardio: wsR1_(Math.min(cN, 3) / 3 * 20),
    protein: wsR1_(Math.min(pN, 5) / 5 * 20),
    record: wsR1_(Math.min(rN, 6) / 6 * 10),
    calories: wsR1_(Math.max(0, 20 * (1 - gap / WS_KCAL_ZERO_GAP_))),
  };
  const skip = WEEKLY_SCORE_SKIP_[weekStart] || null;
  const total = skip ? null : wsR1_(parts.strength + parts.cardio + parts.protein + parts.record + parts.calories);
  return {
    weekStart: weekStart, weekEnd: weekEnd, score: total, parts: parts,
    counts: {strengthDays: sN, pullDays: pw.days, pullSets: pw.sets, pullBonus: pw.bonus, cardioDays: cN, proteinDays: pN, recordDays: rN, avgKcal: avgKcal, exerciseKcal: kt.eat, kcalTarget: kt.mid, kcalLow: kt.low, kcalHigh: kt.high},
    status: skip || (weekEnd < today ? '확정' : '잠정'),
  };
}
function weeklyScoreRecord_(r){
  if(!r) return null;
  return {
    date: r.weekStart, weekEnd: r.weekEnd, score: r.score,
    strength30: r.parts.strength, cardio20: r.parts.cardio, protein20: r.parts.protein, record10: r.parts.record, calories20: r.parts.calories,
    strengthDays: r.counts.strengthDays, cardioDays: r.counts.cardioDays, protein120Days: r.counts.proteinDays, recordDays: r.counts.recordDays, avgKcal: r.counts.avgKcal,
    status: r.status, updatedAt: new Date().toISOString(), version: WEEKLY_SCORE_VERSION_,
    exerciseKcal: r.counts.exerciseKcal, kcalTarget: r.counts.kcalTarget,
  };
}
// [2026-11-11] 주간 점수 저장도 한 번에 묶고, updatedAt만 다른 행은 쓰지 않는다(oldDailyAvg 열 보존은 그대로)
function saveWeeklyScores_(ss, records){
  const recs = (records || []).filter(Boolean);
  if(recs.length) upsertSheet_(ss, SHEETS.weeklyScore, recs, null, ['oldDailyAvg'], ['updatedAt']);
}
function saveWeeklyScore_(ss, r){
  const rec = weeklyScoreRecord_(r);
  if(rec) saveWeeklyScores_(ss, [rec]);
}
/** 영향받는 날짜들이 속한 주의 점수를 다시 계산해 저장(시트 값은 호출부가 이미 읽은 것을 재사용) */
function refreshWeeklyScoresForDates_(ss, dates, allWorkouts, allMeals, today){
  const weeks = [];
  dates.forEach(d => { const ws = wsWeekStart_(d); if(ws >= WEEKLY_SCORE_START_ && weeks.indexOf(ws) === -1) weeks.push(ws); });
  saveWeeklyScores_(ss, weeks.sort().map(ws => weeklyScoreRecord_(computeWeeklyScore_(ws, allWorkouts, allMeals, today))));
}
/** 시작 주~이번 주 전부 다시 계산(편집기 실행·앱 "점수 다시 계산"·자동 보정이 같이 쓴다) */
function recomputeWeeklyScores_(ss){
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const allWorkouts = readSheet_(ss, SHEETS.workouts), allMeals = readSheet_(ss, SHEETS.meals);
  const dates = []; let d = WEEKLY_SCORE_START_;
  while(d <= today){ dates.push(d); d = dsDateMinus_(d, -7); }
  refreshWeeklyScoresForDates_(ss, dates, allWorkouts, allMeals, today);
  return dates.length;
}
function recomputeWeeklyScoresAll(){ Logger.log('주간 점수 재계산 ' + recomputeWeeklyScores_(SpreadsheetApp.getActiveSpreadsheet()) + '주'); }
/** 새 기록이 저장될 때마다 호출: 주간 점수 시트에 빠진 주가 있거나 옛 버전 행이 있으면 전부 한 번 다시 만든다(편집기 실행 불필요, 이후엔 건너뜀) */
function ensureWeeklyScoresCurrent_(ss){
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const expected = Math.floor((new Date(today + 'T00:00:00Z') - new Date(WEEKLY_SCORE_START_ + 'T00:00:00Z')) / (7 * 86400000)) + 1;
  const rows = readSheet_(ss, SHEETS.weeklyScore);
  if(rows.length >= expected && rows.every(r => String(r.version || '') === WEEKLY_SCORE_VERSION_)) return;
  recomputeWeeklyScores_(ss);
}
function formatWeeklyScoreBlock_(r, label){
  if(!r) return '🎯 주간 점수: 이번 주 식단 기록이 아직 없어요.';
  if(r.score === null || r.score === undefined) return '🎯 주간 점수: 산출 안 함 (' + r.status + ')';
  const p = r.parts, c = r.counts;
  return '🎯 <b>이번 주 점수 ' + dsFmt_(r.score) + ' / 100</b>' + (label ? '  (' + label + ')' : '') + '\n' +
    '· 근력 ' + dsFmt_(p.strength) + ' / 30 — ' + c.strengthDays + '회 (2회 만점)' + (c.pullBonus ? ' · 턱걸이 유효 ' + c.pullSets + '세트·' + c.pullDays + '일 → 근력 +1 포함(합계 상한 2회)' : (c.pullSets ? ' · 턱걸이 유효 ' + c.pullSets + '/' + WS_PULL_WEEK_MIN_SETS_ + '세트·' + c.pullDays + '/' + WS_PULL_WEEK_MIN_DAYS_ + '일' : '')) + '\n' +
    '· 유산소 ' + dsFmt_(p.cardio) + ' / 20 — ' + c.cardioDays + '회 (30분↑ 또는 3km↑, 3회 만점)\n' +
    '· 단백질 ' + dsFmt_(p.protein) + ' / 20 — 120g 이상 ' + c.proteinDays + '일 (5일 만점)\n' +
    '· 기록 ' + dsFmt_(p.record) + ' / 10 — ' + c.recordDays + '일 (6일 만점)\n' +
    '· 칼로리 ' + dsFmt_(p.calories) + ' / 20 — 평균 ' + c.avgKcal + 'kcal (이번 주 목표 ' + c.kcalTarget + ', ' + c.kcalLow + '~' + c.kcalHigh + ' 만점 · 운동 ' + c.exerciseKcal + 'kcal 반영)\n' +
    '※ 월~일 한 주 기준이고 하루 점수가 아니에요. 부족한 칸은 남은 날에 채우면 돼요.';
}




/**
 * 영향받는 날짜들의 점수를 다시 계산해 저장. 시트는 한 번만 읽는다.
 * 오늘(또는 미래) 날짜는 '잠정', 지난 날짜는 '확정'. 시작일 이전·식단 미기록 날짜는 건너뜀.
 * 실패해도 데이터 동기화(본 기능)를 막지 않도록 호출부에서 try/catch로 감싼다.
 */
function refreshDailyScoresForDates_(ss, dates){
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const targets = [];
  dates.forEach(d => { if(d && d >= DAILY_SCORE_START_DATE_ && d <= today && targets.indexOf(d) === -1) targets.push(d); });
  if(!targets.length) return;
  applyGoalsOverride_(ss);
  const allInbody = readSheet_(ss, SHEETS.inbody);
  const allWorkouts = readSheet_(ss, SHEETS.workouts);
  const allMeals = readSheet_(ss, SHEETS.meals);
  saveDailyScores_(ss, targets.sort().map(d => {
    const r = computeDailyScoreForDate_(d, allInbody, allWorkouts, allMeals);
    return dailyScoreRecord_(r, d < today ? '확정' : '잠정');
  }));
  // [2026-11-07] 같은 날짜들이 속한 주의 주간 점수도 함께 갱신(실패해도 하루 점수·동기화는 그대로)
  try{ refreshWeeklyScoresForDates_(ss, targets, allWorkouts, allMeals, today); }
  catch(wErr){ Logger.log('주간 점수 갱신 실패(동기화는 정상): ' + wErr); }
}
/** 이번에 들어온 payload의 날짜 + 각 운동 날짜의 이후 6일(7일 창에 영향받는 날짜)을 모아 다시 계산 */
function refreshDailyScoresForPayload_(ss, data){
  const dates = [];
  const add = d => { if(d){ const s = String(d).slice(0, 10); if(dates.indexOf(s) === -1) dates.push(s); } };
  (data.meals || []).forEach(m => m && add(m.date));
  (data.inbody || []).forEach(r => r && add(r.date));
  (data.workouts || []).forEach(w => {
    if(!w || !w.date) return;
    const s = String(w.date).slice(0, 10);
    for(let i = 0; i <= 6; i++){ const t = new Date(s + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + i); add(t.toISOString().slice(0, 10)); }
  });
  if(dates.length) refreshDailyScoresForDates_(ss, dates);
  // [2026-11-07] 주간 점수 시트가 비었거나 옛 버전이면 이번 저장 때 한 번에 보정
  try{ ensureWeeklyScoresCurrent_(ss); } catch(wErr){ Logger.log('주간 점수 자동 보정 실패(저장은 정상): ' + wErr); }
}
/**
 * [2026-10-05 추가] 편집기에서 한 번 실행하는 1회용 함수(트리거 아님): 채점 기준을 바꾼 뒤 시작일(2026-10-03)부터 오늘까지
 * 모든 날짜의 점수를 새 기준으로 다시 계산해 DailyScore 시트에 덮어쓴다. 식단 미기록 날짜는 건너뜀.
 */
function recomputeDailyScoresAll(){
  const r = recomputeAllScores_(SpreadsheetApp.getActiveSpreadsheet());
  Logger.log('크레아틴 보정 ' + r.creatineFilled.length + '건, 하루 점수 재계산 ' + r.from + ' ~ ' + r.to + ' (' + r.days + '일 대상)');
}
/** 크레아틴 보정(메모 → 칸) 후 시작일~오늘 점수를 모두 다시 계산. 편집기 함수와 앱 설정탭 버튼이 같이 쓴다. */
function recomputeAllScores_(ss){
  const filled = backfillMealCreatine_(ss);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const dates = [];
  let d = DAILY_SCORE_START_DATE_;
  while(d <= today){ dates.push(d); d = dsDateMinus_(d, -1); }
  refreshDailyScoresForDates_(ss, dates);
  const rows = readSheet_(ss, SHEETS.dailyScore).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  return {creatineFilled: filled, from: dates[0], to: dates[dates.length - 1], days: dates.length,
          latest: rows.slice(0, 3).map(r => ({date: r.date, score: r.score}))};
}
/** 앱 설정탭 "점수 다시 계산" 버튼용 — 항상 CORS 안전한 JSON 반환(handleTriggerStatus_와 같은 방식) */
function handleRecomputeScores_(){
  try{
    const r = recomputeAllScores_(SpreadsheetApp.getActiveSpreadsheet());
    return ContentService.createTextOutput(JSON.stringify({ok:true, result:r})).setMimeType(ContentService.MimeType.JSON);
  } catch(e){
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(e)})).setMimeType(ContentService.MimeType.JSON);
  }
}








/**
 * [2026-08-04 추가] Drive 인박스 파일 하나(JSON)가 처리된 직후 호출 — 그 파일에 담긴
 * inbody/workouts/meals 내용을 즉시 알림으로 발송("상세형" 알림의 즉시알림 부분).
 * 한 파일에 여러 항목이 있으면 항목별로 각각 메시지를 보냄(너무 긴 메시지 하나보다
 * 짧은 여러 메시지가 텔레그램에서 더 읽기 편함).
 * [2026-08-04 수정] 식단 알림에는 "방금 등록된 내용"과 별개로, 시트에서 그날 데이터를
 * 다시 읽어와 "오늘 누적" 한 줄과 "오늘 운동 이력"을 함께 붙여서 한눈에 보이도록 확장.
 * [2026-08-05 수정] "오늘 누적" 줄 아래에 칼로리/단백질/탄수화물 목표 대비 델타를 추가.
 * [2026-08-06 수정(1,2,3,7번)]
 * - 누적합계에 round1_ 적용(1번)
 * - 인바디 메시지에 전일대비/MA7대비/규칙기반 분석 코멘트 추가(2,7번)
 * - 순수 유산소 운동 알림에 Zone2 준수 여부 추가(3번)
 * [2026-09-24 수정] 인바디 메시지 작성부에서 ma7.muscle/ma7.fat/ma7.fatPct가 null일 수
 * 있게 됐으므로(computeInbodyMA7Compare_ 수정 참고), null이면 "MA7 판단보류(최근7건
 * 유효값부족)"로 표시하도록 방어 로직 추가. 체중(ma7.weight)은 결측 없는 필드라 기존과
 * 동일하게 항상 값이 있다고 가정해도 되지만, 동일한 방어 패턴으로 통일함.
 * [2026-10-02 수정] 운동 알림 끝에 buildWorkoutSummaryLine_(볼륨·종목/세트/횟수·시간) 한 줄 추가.
 */
function notifyImmediate_(ss, data){
  // [2026-09-19 추가, 개선안 20선 2번] 텔레그램 메시지 작성 전 항상 최신 goals를 반영.
  applyGoalsOverride_(ss);
  if(data.inbody && data.inbody.length){
    const allInbody = readSheet_(ss, SHEETS.inbody);
    const startRec = getStartInbody_(allInbody);
    data.inbody.forEach(r => {
      const prevRec = findPrevInbody_(allInbody, r.date);
      const ma7 = computeInbodyMA7Compare_(allInbody, r.date);








      let msg = `📊 <b>인바디 등록</b> (${r.date})\n`;








      msg += `체중 ${r.weight}kg`;
      if(prevRec) msg += ` (전일 ${formatSignedDelta_(round1_(r.weight - prevRec.weight))})`;
      if(ma7 && ma7.weight) msg += ` / MA7 ${round1_(ma7.weight.current)}kg, ${formatSignedDelta_(round1_(ma7.weight.delta))}`;
      else if(ma7) msg += ` / MA7 판단보류(최근7건 유효값부족)`;








      msg += `\n골격근 ${r.muscle}kg`;
      if(prevRec) msg += ` (전일 ${formatSignedDelta_(round1_(r.muscle - prevRec.muscle))})`;
      if(ma7 && ma7.muscle) msg += ` / MA7 ${round1_(ma7.muscle.current)}kg, ${formatSignedDelta_(round1_(ma7.muscle.delta))}`;
      else if(ma7) msg += ` / MA7 판단보류(최근7건 유효값부족)`;








      msg += `\n체지방 ${r.fat}kg`;
      if(prevRec) msg += ` (전일 ${formatSignedDelta_(round1_(r.fat - prevRec.fat))})`;
      if(ma7 && ma7.fat) msg += ` / MA7 ${round1_(ma7.fat.current)}kg, ${formatSignedDelta_(round1_(ma7.fat.delta))}`;
      else if(ma7) msg += ` / MA7 판단보류(최근7건 유효값부족)`;








      msg += `\n체지방률 ${r.fatPct}%`;
      if(prevRec) msg += ` (전일 ${formatSignedDelta_(round1_(r.fatPct - prevRec.fatPct))}%p)`;
      if(ma7 && ma7.fatPct) msg += ` / MA7 ${round1_(ma7.fatPct.current)}%, ${formatSignedDelta_(round1_(ma7.fatPct.delta))}%p`;
      else if(ma7) msg += ` / MA7 판단보류(최근7건 유효값부족)`;








      if(r.bmr) msg += `\nBMR ${r.bmr}kcal`;








      const analysis = buildInbodyAnalysisComment_(r, prevRec, ma7, startRec);
      if(analysis) msg += `\n\n📊 분석\n${analysis}`;
      sendTelegramMessage_(msg);
    });
  }








  if(data.workouts && data.workouts.length){
    data.workouts.forEach(r => {
      let msg = `🏋️ <b>운동 등록</b> (${r.date})\n` +
        `${r.name || ''}` +
        (r.part ? ` · ${r.part}` : '') +
        (r.calories ? ` · ${r.calories}kcal` : '');








      // 3번: 순수 유산소(part==='유산소') 세션에만 Zone2 준수 여부 표시.
      // 혼합 세션(예: '상체+유산소')은 note 안에 여러 평균심박이 섞여있을 수 있어 제외.
      if(r.part === '유산소'){
        const hr = extractAvgHeartRate_(r.note);
        msg += formatZoneStatus_(hr);
      }
      // [2026-10-02 추가] 볼륨·종목/세트/횟수·시간 요약 한 줄(값이 없으면 빈 문자열이라 기존 알림과 동일)
      msg += buildWorkoutSummaryLine_(r);








      sendTelegramMessage_(msg);
    });
  }








  if(data.meals && data.meals.length){
    // 같은 파일에 여러 날짜가 섞여 있을 수 있으니 날짜별로 한 번씩만 요약 발송
    const dates = [...new Set(data.meals.map(m => m.date))];
    const allWorkouts = readSheet_(ss, SHEETS.workouts);
    const allInbody = readSheet_(ss, SHEETS.inbody);
    const prVolumeKg = allWorkouts.reduce((max,w) => Math.max(max, parseVolume_(w.volume)), 0);








    dates.forEach(date => {
      const justRegistered = data.meals.find(m => m.date === date);
      const todaysMeals = readSheet_(ss, SHEETS.meals).filter(r => r.date === date);
      const todaysWorkouts = allWorkouts.filter(r => r.date === date);








      // 1번: 누적합계에 round1_ 적용해 부동소수점 오차 제거
      const totalCal = round1_(todaysMeals.reduce((s,m) => s + (Number(m.calories) || 0), 0));
      const totalProt = round1_(todaysMeals.reduce((s,m) => s + (Number(m.protein) || 0), 0));
      const totalCarb = round1_(todaysMeals.reduce((s,m) => s + (Number(m.carbs) || 0), 0));








      // 목표 계산용 값 산출
      const bmr = bmrForTargetOn_(allInbody, date);
      const eatKcal = todaysWorkouts.reduce((s,w) => s + (Number(w.calories) || 0), 0);
      const todayVolumeKg = todaysWorkouts.reduce((s,w) => s + parseVolume_(w.volume), 0);
      const hasStrengthToday = todayVolumeKg > 0;








      const calT = computeCalorieTarget_(bmr, eatKcal);
      let msg = `🍽 <b>식단 등록</b> (${date})\n` +
        `${justRegistered.calories!=null ? justRegistered.calories+'kcal' : '-'} · 단백 ${justRegistered.protein!=null ? justRegistered.protein+'g' : '-'} · 탄수 ${justRegistered.carbs!=null ? justRegistered.carbs+'g' : '-'}\n\n` +
        `📊 오늘 누적 식단: ${totalCal}kcal · 단백 ${totalProt}g · 탄수 ${totalCarb}g`;








      const kt_ = kcalWeekTargetOn_(ss, date);
      msg += `\n· 칼로리는 하루가 아니라 이번 주 평균 ${kt_.mid.toLocaleString()}kcal(${kt_.low.toLocaleString()}~${kt_.high.toLocaleString()}, 운동 가산 +${kt_.add})로 봐요 — 오늘 누적 ${totalCal}kcal`;
      msg += `\n· 단백질 목표 ${PROTEIN_TARGET_RANGE_[0]}~${PROTEIN_TARGET_RANGE_[1]}g (${formatDelta_(totalProt, PROTEIN_TARGET_RANGE_[0], PROTEIN_TARGET_RANGE_[1])})`;








      if(todaysWorkouts.length){
        msg += `\n\n🏋️ 오늘 운동 ${todaysWorkouts.length}건\n`;
        msg += todaysWorkouts.map(w => `· ${w.name || ''}${w.calories ? ` (${w.calories}kcal)` : ''}`).join('\n');
      } else {
        msg += `\n\n🏋️ 오늘 운동 기록 없음`;
      }








      sendTelegramMessage_(msg);
    });
  }
}








/**
 * [2026-08-04 추가] 저녁 요약 알림("상세형" 알림의 요약 부분).
 * Apps Script 트리거(시간 기반, 예: 매일 21시)로 이 함수를 직접 실행하도록 등록해야 함
 * — 코드 배포만으로는 자동 등록되지 않고, 편집기의 "트리거" 메뉴에서 한 번 수동 등록 필요
 * (파일 상단 "텔레그램 연동 설정" 안내 6번 참고).
 * [2026-08-05 수정] notifyImmediate_와 동일하게 칼로리/단백질/탄수화물 목표·델타 표시 추가.
 * [2026-08-06 수정(1,5번)] 누적합계 round1_ 적용, "오늘 N목표 중 M개 달성" 한 줄 요약 추가.
 * [2026-10-04 수정] 맨 아래에 "하루 점수(100점)" 블록 추가(기존 본문은 그대로). 점수는 이 시점에
 * 계산해 DailyScore 시트에도 '잠정'으로 저장한다(밤에 기록이 더 들어오면 applyIncoming_가 덮어씀).
 * 점수 계산·저장이 실패해도 기존 저녁 요약 발송은 막지 않는다.
 */
function sendEveningDigest(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // [2026-09-19 추가, 개선안 20선 2번] 텔레그램 메시지 작성 전 항상 최신 goals를 반영.
  applyGoalsOverride_(ss);
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const inbody = readSheet_(ss, SHEETS.inbody).filter(r => r.date === today);
  const workouts = readSheet_(ss, SHEETS.workouts).filter(r => r.date === today);
  const meals = readSheet_(ss, SHEETS.meals).filter(r => r.date === today);
  const allInbody = readSheet_(ss, SHEETS.inbody);
  const allWorkouts = readSheet_(ss, SHEETS.workouts);
  const prVolumeKg = allWorkouts.reduce((max,w) => Math.max(max, parseVolume_(w.volume)), 0);








  let summaryLine = '';
  let mealSection = '';








  if(meals.length){
    const totalCal = round1_(meals.reduce((s,m) => s + (Number(m.calories) || 0), 0));
    const totalProt = round1_(meals.reduce((s,m) => s + (Number(m.protein) || 0), 0));
    const totalCarb = round1_(meals.reduce((s,m) => s + (Number(m.carbs) || 0), 0));








    const bmr = bmrForTargetOn_(allInbody, today);
    const eatKcal = workouts.reduce((s,w) => s + (Number(w.calories) || 0), 0);
    const todayVolumeKg = workouts.reduce((s,w) => s + parseVolume_(w.volume), 0);
    const hasStrengthToday = todayVolumeKg > 0;
    const calT = computeCalorieTarget_(bmr, eatKcal);
    const calDelta = calT ? formatDelta_(totalCal, calT.targetLow, calT.targetHigh) : null;
    const protDelta = formatDelta_(totalProt, PROTEIN_TARGET_RANGE_[0], PROTEIN_TARGET_RANGE_[1]);








    // [2026-11-07] 하루 목표 요약은 단백질만(칼로리는 주 평균, 탄수 목표 폐지)
    summaryLine = `✨ 오늘 단백질 ${protDelta === '범위내' ? '목표 달성' : goalStatusLabel_(protDelta)}\n\n`;








    mealSection = `🍽 식단 합계: ${totalCal}kcal · 단백 ${totalProt}g · 탄수 ${totalCarb}g`;
    const kt_ = kcalWeekTargetOn_(ss, today);
    mealSection += `\n· 칼로리는 이번 주 평균 ${kt_.mid.toLocaleString()}kcal(${kt_.low.toLocaleString()}~${kt_.high.toLocaleString()}, 운동 가산 +${kt_.add}) 기준 — 오늘 ${totalCal}kcal`;
    mealSection += `\n· 단백질 목표 ${PROTEIN_TARGET_RANGE_[0]}~${PROTEIN_TARGET_RANGE_[1]}g (${protDelta})`;
  } else {
    mealSection = `🍽 식단 기록 없음`;
  }








  let msg = `🌙 <b>${today} 하루 요약</b>\n\n${summaryLine}`;








  if(inbody.length){
    const r = inbody[0];
    msg += `📊 인바디: 체중 ${r.weight}kg · 골격근 ${r.muscle}kg · 체지방 ${r.fat}kg(${r.fatPct}%)\n\n`;
  }








  if(workouts.length){
    msg += `🏋️ 운동 ${workouts.length}건\n`;
    workouts.forEach(w => { msg += `· ${w.name || ''}${w.calories ? ` (${w.calories}kcal)` : ''}\n`; });
    msg += '\n';
  } else {
    msg += `🏋️ 운동 기록 없음\n\n`;
  }
  msg += mealSection;








  // [2026-10-04 추가] 하루 점수 블록(2026-10-03분부터). 실패해도 위 요약은 그대로 발송.
  try{
    if(today >= DAILY_SCORE_START_DATE_){
      const scoreRes = computeDailyScoreForDate_(today, allInbody, allWorkouts, readSheet_(ss, SHEETS.meals));
      const hourLabel = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'H') + '시 기준 잠정';
      saveDailyScore_(ss, scoreRes, '잠정');
      // [2026-11-07] 저녁 요약에는 하루 점수 대신 이번 주 점수를 붙인다(하루 점수는 시트에만 계속 저장)
      const wsRes_ = computeWeeklyScore_(wsWeekStart_(today), allWorkouts, readSheet_(ss, SHEETS.meals), today);
      msg += '\n\n' + formatWeeklyScoreBlock_(wsRes_, hourLabel);
      if(wsRes_) saveWeeklyScore_(ss, wsRes_);
    }
  } catch(scoreErr){
    Logger.log('하루 점수 계산/저장 실패(저녁 요약은 그대로 발송): ' + scoreErr);
  }
  sendTelegramMessage_(msg);
}








// [2026-10-18] GitHub 자동배포 함수(getGithubConfig_/deployFileToGithub_/processDeploy_/chunkPropKey_/processDeployChunk_) 삭제 — 파일 상단 변경 기록 참고.








/**
 * [2026-09-14 추가] aiAnalysis 텍스트-구조화데이터 불일치 감지.
 * 실제 사고 사례(2026-09-13): Claude 세션이 그날 체중(70.9kg 등)을 aiAnalysis 코멘트
 * 문장 안에는 적어서 업로드했지만, 같은 날짜의 구조화 inbody 레코드({"inbody":[...]}）는
 * 함께 올리는 걸 빠뜨림. 그 결과 값이 Meta 시트의 자유텍스트 안에만 존재하게 되어,
 * 이동평균/기간비교 등 구조화 데이터 기반 계산에서 그 날짜가 통째로 누락됨(발견은
 * 다음날 사용자가 "어제 대비 비교" 요청했을 때 수동 확인으로만 가능했음).
 * 코드로 숫자를 다시 정규식 파싱해서 자동 채우는 방식은 이 프로젝트에서 반복적으로
 * 문제를 일으켰던 패턴(트레드밀 걸음수, 유산소 심박 등)이라 여기서도 쓰지 않음 —
 * 대신 "그 날짜에 구조화 inbody 데이터가 있는지" 존재 여부만 확인해서, 없으면 텔레그램
 * 경고만 보냄(값 추정/자동 보정은 하지 않음 — 반드시 확인 후 사람이 수동 업로드).
 * aiAnalysisDate가 없으면(=오늘 날짜로 대체되는 경우) 검사를 건너뜀 — 스킵 사유가
 * 명확하지 않은 채로 오탐 경고를 보내는 것을 방지하기 위함.
 */
function checkAiAnalysisInbodyGap_(ss, data){
  if(!data.aiAnalysisDate) return;
  const targetDate = String(data.aiAnalysisDate).slice(0, 10);
  // [2026-11-03 추가] 인바디를 일부러 안 쟀다고 표시한 업로드({"inbodySkipped":true})는 경고하지 않는다(음주 다음날 등).
  if(data.inbodySkipped === true || data.inbodySkipped === 'true') return;
  // [2026-11-03 추가] 같은 날짜 경고는 하루에 딱 한 번만(Meta 'aiGapAlertedDate'에 날짜 기록). 분석 글을 고쳐 다시 올려도 반복 경고 없음.
  if(String(getMeta_(ss, 'aiGapAlertedDate') || '') === targetDate) return;
  const hasInPayload = Array.isArray(data.inbody) && data.inbody.some(r => r && r.date === targetDate);
  if(hasInPayload) return; // 같은 배치에 구조화 데이터가 함께 왔으면 정상
  const existing = readSheet_(ss, SHEETS.inbody).find(r => r.date === targetDate);
  if(existing) return; // 이미 시트에 있으면 정상(과거 분석 재업로드 등)
  setMeta_(ss, 'aiGapAlertedDate', targetDate); // 2026-11-03: 발송 전에 먼저 기록(발송이 느려져도 중복 방지)
  sendTelegramMessage_(
    `⚠️ <b>aiAnalysis-인바디 불일치 감지</b> (${targetDate})\n` +
    `이 날짜의 분석 코멘트는 등록됐지만, 같은 날짜의 구조화 인바디 데이터(체중 등)는 ` +
    `시트에 없습니다. 분석 텍스트 안에 수치가 언급됐다면 확인 후 구조화 데이터로 별도 ` +
    `업로드가 필요할 수 있습니다.`
  );
}








/**
 * [2026-09-18 추가, 6-A 자동화] aiAnalysis/comprehensiveReport를 새 값으로 덮어쓰기 직전에,
 * "지금까지 저장돼 있던 값"을 ReportHistory 시트에 한 줄 보관.
 * 배경: notion-integration-analysis.md에서 확인된 구조적 한계 — Meta 'aiAnalysis'/
 * 'comprehensiveReport'는 매번 완전히 덮어써지는 구조라 지난 분석이 영구 소실됨(히스토리
 * 없음). 덮어쓰기 로직 자체는 그대로 두고(기존 앱 동작과 완전히 동일하게 유지), 덮어써지기
 * "직전"의 값만 별도 시트에 자동으로 옮겨 적재 — 사람이 매번 복사해둘 필요가 없다.
 * 완전히 동일한 내용이 반복 저장되는 경우(예: 같은 날 재동기화)는 직전 아카이브 행과
 * 비교해서 중복 적재하지 않음.
 */
function archiveReportBeforeOverwrite_(ss, metaKey, dateKey, typeLabel){
  const existing = getMeta_(ss, metaKey);
  if(!existing) return; // 처음 작성되는 경우 보관할 이전 값이 없음
  const sh = getOrCreateSheet_(ss, SHEETS.reportHistory.name, SHEETS.reportHistory.cols);
  const values = sh.getDataRange().getValues();
  const lastRow = values.length > 1 ? values[values.length-1] : null;
  if(lastRow && lastRow[1]===typeLabel && lastRow[2]===existing) return; // 직전 아카이브와 완전히 동일 — 중복 적재 방지
  const existingDate = getMeta_(ss, dateKey) || '';
  sh.appendRow([existingDate, typeLabel, existing]);
  invalidateSheetCache_(SHEETS.reportHistory.name);
}








/**
 * [2026-09-18 추가, 1-B 자동화] 운동 데이터 수신 시 종목별 추정 1RM(Epley 공식: 무게×(1+횟수/30))을
 * 계산해 역대 최고치와 비교, 새 PR이면 텔레그램으로 즉시 알림.
 * 배경: 2026-09-13 aiAnalysis 텍스트에서 Claude가 종목별 1RM을 매번 수동으로(그것도 "비교 시점이
 * 오래돼 직접비교 신뢰도 낮음" 수준으로 부정확하게) 비교하고 있었음 — exercises 배열에 이미
 * name/sets/reps/weight가 구조화돼 저장되고 있으므로, 그 원시 데이터로 서버가 자동 비교할 수 있음.
 * 반드시 "이번 배치를 시트에 반영(upsertSheet_)하기 전"에 호출해야 함 — 반영 후에 호출하면
 * 방금 들어온 값이 "기존 최고기록"에 섞여 자기 자신과 비교하는 꼴이 되어 PR을 놓친다.
 */
function estimate1RM_(weight, reps){
  const w = Number(weight), r = Number(reps);
  if(!w || !r || w<=0 || r<=0) return null;
  return w * (1 + r/30); // Epley 공식
}
/**
 * [2026-10-05 추가] 종목 1개의 "이번 세션 최고 추정 1RM"과 그 세트(무게×횟수)를 구함. 계산 불가면 null.
 * 실제 업로드 형식: {name, part, maxWeight, oneRM, sets:[{weight,reps}, ...]} — 세트별로 계산해 최댓값을 취함
 * (저장돼 있는 oneRM 필드는 반올림된 값이라 쓰지 않고 sets 원본에서 다시 계산).
 * 제외 대상: ①어시스티드(이름에 '어시스티드'/assist, 또는 세트에 assist 필드 — assist는 덜어준 무게라 의미가 반대)
 * ②sets가 배열이 아닌 옛 평평한 형식(reps가 총 횟수라 그대로 계산하면 1RM이 부풀음).
 */
function bestOneRMFromExercise_(ex){
  if(!ex || !Array.isArray(ex.sets)) return null;
  if(/어시스티드|assist/i.test(String(ex.name || ''))) return null;
  let best = null;
  ex.sets.forEach(st => {
    if(!st || typeof st !== 'object') return;
    if(st.assist !== undefined && st.assist !== null && st.assist !== '') return;
    const oneRM = estimate1RM_(st.weight, st.reps);
    if(oneRM == null) return;
    if(!best || oneRM > best.oneRM) best = {oneRM: oneRM, weight: Number(st.weight), reps: Number(st.reps)};
  });
  return best;
}
// [2026-11-11] 앱은 최근 14일 운동을 매번 보내므로, 이미 검사한 운동(날짜|이름|세트 내용 서명이 같음)은 건너뛴다.
// 서명이 바뀐(수정된) 운동이나 처음 보는 운동만 검사한다. 값은 스크립트 속성 prSeen(최근 80건)에 저장.
function prKey_(w){ return String(w.date || '').slice(0, 10) + '|' + String(w.name || '').trim(); }
function prSig_(w){
  const s = JSON.stringify((w.exercises || []).map(ex => [ex && ex.name, ex && ex.sets]));
  let h = 5381; for(let i = 0; i < s.length; i++){ h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; }
  return h.toString(36) + ':' + s.length;
}
function prSeenLoad_(){
  try{ const raw = propGet_('prSeen'); const o = raw ? JSON.parse(raw) : {}; return (o && typeof o === 'object') ? o : {}; }catch(e){ return {}; }
}
function prSeenSave_(seen){
  try{
    const keys = Object.keys(seen).sort().slice(-80); // 키는 날짜로 시작하므로 정렬하면 오래된 것부터 빠진다
    const o = {}; keys.forEach(k => { o[k] = seen[k]; });
    propSet_('prSeen', JSON.stringify(o));
  }catch(e){ Logger.log('prSeen 저장 실패(PR 검사는 정상): ' + e); }
}
function checkAndNotifyExercisePRs_(ss, incomingWorkouts){
  if(!incomingWorkouts || !incomingWorkouts.length) return;
  const withEx0_ = incomingWorkouts.filter(w => Array.isArray(w.exercises) && w.exercises.length);
  if(!withEx0_.length) return;
  const prSeen_ = prSeenLoad_();
  const withExercises = withEx0_.filter(w => prSeen_[prKey_(w)] !== prSig_(w));
  if(!withExercises.length) return; // 전부 이미 검사한 운동 — 시트를 읽지 않고 끝냄








  const existingWorkouts = readSheet_(ss, SHEETS.workouts); // 이번 배치 반영 "전" 기존 기록만
  const historyMax = {}; // 정규화된 종목명 -> {oneRM, date}
  const normName = n => String(n||'').replace(/\s+/g,'').toLowerCase();
  existingWorkouts.forEach(w => {
    if(!Array.isArray(w.exercises)) return;
    w.exercises.forEach(ex => {
      const best = bestOneRMFromExercise_(ex); // [2026-10-05] ex.weight/ex.reps 대신 sets 배열에서 계산
      if(best==null || !ex.name) return;
      const key = normName(ex.name);
      if(!historyMax[key] || best.oneRM > historyMax[key].oneRM) historyMax[key] = {oneRM: best.oneRM, date: w.date};
    });
  });








  const prHits = [];
  withExercises.forEach(w => {
    w.exercises.forEach(ex => {
      const best = bestOneRMFromExercise_(ex); // [2026-10-05] 세트 중 추정 1RM이 가장 높은 세트 기준
      if(best==null || !ex.name) return;
      const key = normName(ex.name);
      const prev = historyMax[key];
      if(!prev || best.oneRM > prev.oneRM){
        prHits.push({name: String(ex.name).trim(), oneRM: best.oneRM, prevOneRM: prev ? prev.oneRM : null, weight: best.weight, reps: best.reps, date: w.date});
        historyMax[key] = {oneRM: best.oneRM, date: w.date}; // 같은 배치 안에서 같은 종목이 여러 번 나와도 순차 비교되도록 갱신
      }
    });
  });








  if(prHits.length){
    const lines = prHits.map(h =>
      `🏆 ${h.name}: 추정 1RM ${Math.round(h.oneRM)}kg (${h.weight}kg×${h.reps}회)` +
      (h.prevOneRM ? ` — 이전 최고 ${Math.round(h.prevOneRM)}kg` : ' — 첫 기록')
    );
    sendTelegramMessage_(
      `🏆 <b>PR 경신!</b> (${withExercises[0].date})\n${lines.join('\n')}\n\n` +
      `※ Epley 공식(무게×(1+횟수/30)) 기반 추정치이며 실측 1RM과 다를 수 있어요.`
    );
  }
  withExercises.forEach(w => { prSeen_[prKey_(w)] = prSig_(w); }); // [2026-11-11] 검사 끝난 운동 표시
  prSeenSave_(prSeen_);
}








const REMINDER_ALERT_DEDUPE_PREFIX_ = 'reminderAlertDate::';
function shouldAlertOncePerDay_(key, todayStr){
  const props = PropertiesService.getScriptProperties();
  const propKey = REMINDER_ALERT_DEDUPE_PREFIX_ + key;
  if(props.getProperty(propKey) === todayStr) return false;
  props.setProperty(propKey, todayStr);
  return true;
}
function daysBetween_(dateStr, todayStr){
  return Math.round((new Date(todayStr+'T00:00:00').getTime() - new Date(dateStr+'T00:00:00').getTime()) / 86400000);
}
/**
 * [2026-09-18 추가, 7-A·8 자동화] 진짜 백그라운드 리마인더 + 데이터 신뢰도 공백 알림.
 * 기존 index.html의 checkReminders()는 "앱을 열었을 때"만 검사하는 구조라(코드 주석에도
 * "진짜 백그라운드 푸시는 이 프로젝트 범위 밖"이라 명시돼 있었음), 앱을 안 열면 인바디 2일
 * 공백/저항운동 5일 공백 리마인더가 전혀 전달되지 않았다. 이 함수는 동일한 조건 + 체성분
 * (근육/체지방) 실측 공백 조건을 서버(시간 기반 트리거)에서 검사해 텔레그램으로 직접 발송한다.
 * [2026-09-18 수정] sendEveningDigest처럼 시간 기반 트리거(매일 오전 9시대)로 실행되도록 설계된
 * 함수 — 예전엔 이걸 사람이 직접 Apps Script 편집기에서 등록해야 했지만, 이제 ensureTriggersInstalled_()가
 * doGet() 호출 시 자동으로 등록해주므로 별도 수동 등록이 필요 없음(파일 상단 "텔레그램 연동 설정"
 * 6번 참고). 같은 날 트리거가 여러 번 겹쳐 돌아도 알림이 중복
 * 발송되지 않도록 알림 종류별로 날짜 기준 dedupe 적용(reportInboxHealth_와 다른 방식 — 이쪽은
 * "장애 지속"이 아니라 "하루 1회"가 기준이라 더 단순한 날짜 비교로 충분함).
 * [2026-10-04 추가] 맨 앞에서 어제 하루 점수를 한 번 더 계산해 '확정'으로 마감한다
 * (finalizeYesterdayDailyScore_, 실패해도 아래 리마인더는 그대로 진행).
 */
// 2026-09-19 추가(20선 5번): index.html의 BODY_PARTS/EXERCISE_PART_MAP/inferPartsForEntry(w)를
// 그대로 이식 — checkDailyReminders()의 저항운동 공백판정을 클라이언트와 완전히 동일한 기준으로
// 맞추기 위함. 주의: 두 파일은 별도 배포 단위라 자동 동기화 수단이 없다 — index.html 쪽 세
// 상수/함수가 바뀌면 이 사본도 함께 수동으로 갱신해야 판정이 다시 어긋나지 않는다.
const BODY_PARTS_ = ['등','이두','하체','어깨','가슴','삼두'];
const EXERCISE_PART_MAP_ = {
  '레그프레스':'하체','머신 레그프레스':'하체','힙어브덕션':'하체','힙 어브덕션':'하체',
  '힙어덕션':'하체','힙 어덕션':'하체','핵스쿼트':'하체','머신 핵스쿼트':'하체','머신 핵 스쿼트':'하체',
  '레그익스텐션':'하체','레그 익스텐션':'하체','레그컬':'하체','런지':'하체','와이드스쿼트':'하체','바벨 와이드스쿼트':'하체',
  '랫풀다운':'등','머신 랫풀다운':'등','케이블시티드로우':'등','케이블 시티드로우':'등','시티드로우':'등',
  '풀업':'등','친업':'등','어시스티드 풀업':'등','어시스티드 친업':'등','원암로우':'등','원암 아이소레터럴로우':'등',
  '데드리프트':'등','페이스풀':'등',
  '머신플라이':'가슴','머신 플라이':'가슴','벤치프레스':'가슴','덤벨 플랫벤치프레스':'가슴','덤벨 플랫 벤치 프레스':'가슴',
  '체스트프레스':'가슴','케이블체스트프레스':'가슴','케이블 체스트프레스':'가슴','인클라인체스트프레스':'가슴',
  '숄더프레스':'어깨','시티드 덤벨 숄더프레스':'어깨','플레이트 숄더프레스':'어깨','레터럴레이즈':'어깨',
  '덤벨레터럴레이즈':'어깨','덤벨 레터럴레이즈':'어깨','프론트레이즈':'어깨','사이드레터럴레이즈':'어깨',
  '바이셉컬':'이두','덤벨바이셉컬':'이두','덤벨 바이셉컬':'이두','바벨바이셉컬':'이두','바벨 바이셉컬':'이두','케이블컬':'이두',
  '트라이셉익스텐션':'삼두','케이블로프트라이셉익스텐션':'삼두','케이블 로프 트라이셉익스텐션':'삼두','트라이셉푸시다운':'삼두','케이블트라이셉푸시다운':'삼두',
};
// [2026-10-02 수정] 앱(index.html 빌드 2026-10-02-a)의 inferPartsForEntry와 같은 규칙으로 맞춤.
// ① part가 정확히 '유산소'인 순수 유산소 세션은 note를 훑지 않는다(note의 "어깨 석회성건염 치료 중",
//    "등/이두 근력 직후 연속 진행" 같은 설명 문구가 부위로 잡혀 걷기·러닝머신이 저항운동으로 오인식됨).
// ② 종목 part가 '가슴/삼두'처럼 복합 표기면 BODY_PARTS_ 단위로 분해한다.
function inferPartsForEntry_(w){
  const parts = new Set();
  if(w.exercises && w.exercises.length){
    w.exercises.forEach(ex => {
      if(!ex.part) return;
      const exPart = String(ex.part);
      const found = BODY_PARTS_.filter(p => p === '등' ? /(^|[^가-힣])등(?![가-힣])/.test(exPart) : exPart.indexOf(p) !== -1);
      if(found.length) found.forEach(p => parts.add(p)); else parts.add(exPart);
    });
  }
  if(parts.size===0){
    const pureCardio = String(w.part||'').trim() === '유산소';
    const text = pureCardio ? `${w.name||''} ${w.part||''}` : `${w.name||''} ${w.part||''} ${w.note||''}`;
    BODY_PARTS_.forEach(p => {
      if(p === '등'){
        if(/(^|[^가-힣])등(?![가-힣])/.test(text)) parts.add(p);
      } else if(text.includes(p)){
        parts.add(p);
      }
    });
    Object.keys(EXERCISE_PART_MAP_).forEach(k => { if(text.includes(k)) parts.add(EXERCISE_PART_MAP_[k]); });
  }
  return [...parts];
}








// [2026-09-19 추가, 20선 13번] index.html computeGoalDriftInsight()의 "정체" 판정(tone:'warn')만
// 서버에도 이식 — 다른 두 tone(목표 달성/추정 도달주수)은 알림으로 보낼 만한 경보가 아니라서
// 제외. movingAverage(arr,'fatPct',7)와 동일한 "최근 win개 레코드 단순평균" 방식, 이후 최근
// 14개 지점에 대한 단순선형회귀로 추세 기울기를 구하는 계산까지 클라이언트와 동일하게 맞췄다.
function computeGoalDriftAlertServer_(allInbody, fatGoals){
  const withFatPct = allInbody.filter(r=>r.fatPct!=null && r.fatPct!=='' && !isNaN(r.fatPct)).map(r=>({...r, fatPct:Number(r.fatPct)}));
  if(withFatPct.length < 14) return null;
  const win = 7;
  const maVals = withFatPct.map((row,i) => {
    const slice = withFatPct.slice(Math.max(0,i-win+1), i+1);
    return slice.reduce((s,r)=>s+r.fatPct,0)/slice.length;
  });
  const recent = maVals.slice(-14);
  const n = recent.length;
  const xs = recent.map((_,i)=>i);
  const xMean = xs.reduce((a,b)=>a+b,0)/n;
  const yMean = recent.reduce((a,b)=>a+b,0)/n;
  let num=0, den=0;
  for(let i=0;i<n;i++){ num += (xs[i]-xMean)*(recent[i]-yMean); den += (xs[i]-xMean)*(xs[i]-xMean); }
  const slopePerPoint = den!==0 ? num/den : 0;
  const currentFat = recent[recent.length-1];
  const nextGoal = fatGoals.find(g => currentFat > g.pct);
  if(!nextGoal) return null; // 이미 모든 목표 달성 — 경보 대상 아님
  if(slopePerPoint >= -0.005){
    return {weeklyDeltaPct: -slopePerPoint*7, nextGoalLabel: nextGoal.label, nextGoalPct: nextGoal.pct};
  }
  return null;
}








/**
 * [2026-10-04 추가] 어제 하루 점수를 다시 계산해 '확정'으로 저장(오전 트리거에서 호출).
 * 밤 사이 기록이 더 들어온 경우를 반영하기 위함. 시작일 이전·식단 미기록이면 아무것도 하지 않는다.
 */
function finalizeYesterdayDailyScore_(ss, todayStr){
  const yesterday = dsDateMinus_(todayStr, 1);
  if(yesterday < DAILY_SCORE_START_DATE_) return;
  refreshDailyScoresForDates_(ss, [yesterday]);
}








function checkDailyReminders(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  // [2026-10-04 추가] 어제 점수 확정(실패해도 아래 리마인더는 그대로 진행)
  try{ finalizeYesterdayDailyScore_(ss, today); }catch(finErr){ Logger.log('어제 하루 점수 확정 실패: ' + finErr); }
  applyGoalsOverride_(ss); // [20선 13번] PROTEIN_TARGET_RANGE_/FAT_GOALS_ 등을 goals 최신값으로 갱신
  const allInbody = readSheet_(ss, SHEETS.inbody).filter(r => r.weight!=null).sort((a,b)=>a.date.localeCompare(b.date));
  const allWorkouts = readSheet_(ss, SHEETS.workouts);
  // 1) 인바디(체중 포함 아무 기록이든) 공백 2일 이상 — index.html checkReminders()와 동일 조건
  if(allInbody.length){
    const last = allInbody[allInbody.length-1];
    const gap = daysBetween_(last.date, today);
    if(gap>=2 && shouldAlertOncePerDay_('inbodyGap', today)){
      sendTelegramMessage_(`⏰ <b>인바디 기록이 ${gap}일째 없어요</b>\n오늘 측정해서 기록해두면 추세 판단이 더 정확해져요(공백이 길수록 이동평균이 흔들려요).`);
    }
  }








  // 2) [7-A] 체성분(근육/체지방) 실측 공백 — 체중은 기록됐지만(여행 중 체중계만 사용 등)
  //    체성분 실측이 오래된 경우 별도 알림. index.html 쪽 "데이터 신뢰도 배지"의 서버측 대응.
  const fullBC = allInbody.filter(r => r.muscle!=null && r.muscle!=='' && r.fat!=null && r.fat!=='');
  if(fullBC.length){
    const lastBC = fullBC[fullBC.length-1];
    const bcGap = daysBetween_(lastBC.date, today);
    if(bcGap>=3 && shouldAlertOncePerDay_('bodyCompGap', today)){
      sendTelegramMessage_(`⚠️ <b>체성분(골격근·체지방) 실측이 ${bcGap}일째 없어요</b>\n체중 기록은 있어도 골격근·체지방 이동평균 계산은 정체돼요. InBody로 측정해주세요.`);
    }
  }








  // 3) 저항운동 공백 5일 이상 — 2026-09-19 수정(20선 5번): 기존엔 "exercises 배열이 있거나
  //    part가 유산소가 아님"이라는 근사치를 썼는데, index.html checkReminders()가 실제로 쓰는
  //    inferPartsForEntry(w).length>0과 결과가 다를 수 있어(종목명 텍스트 매칭 케이스 등) 앱
  //    화면의 "공백 N일째" 배너와 텔레그램 알림이 서로 다른 날짜를 가리킬 가능성이 있었음.
  //    아래 inferPartsForEntry_는 그 클라이언트 함수를 그대로 이식한 것 — 두 판정을 완전히 통일.
  const resistanceDates = allWorkouts
    .filter(w => inferPartsForEntry_(w).length>0)
    .map(w=>w.date).sort();
  if(resistanceDates.length){
    const lastR = resistanceDates[resistanceDates.length-1];
    const rGap = daysBetween_(lastR, today);
    if(rGap>=5 && shouldAlertOncePerDay_('resistanceGap', today)){
      sendTelegramMessage_(`⏰ <b>저항운동이 ${rGap}일째 없어요</b>\n마지막 기록일: ${lastR}. 여행·부상 등 이유가 있다면 기록 시 "특이조건"으로 남겨두면 추세 비교에서 자동 보정돼요.`);
    }
  }








  // [2026-09-19 추가, 20선 13번] 아래부터는 기존 3종(인바디/체성분/저항운동 공백) 외에, index.html
  // 대시보드에는 이미 있지만 텔레그램으로는 먼저 알려주지 않던 세 가지(식사공백·칼로리단백질 미달·
  // 체지방률 추세정체)를 같은 "N일째" 패턴으로 서버에서도 능동적으로 발송한다.
  const allMeals = readSheet_(ss, SHEETS.meals);








  // 4) 식사기록 공백 2일 이상 — index.html computeSmartAlerts()의 신규 후보(20선 9번)와 동일한
  //    "N일째" 판정을 텔레그램으로도 선제 발송.
  if(allMeals.length){
    const lastMealDate = allMeals.map(m=>m.date).sort().slice(-1)[0];
    const mealGap = daysBetween_(lastMealDate, today);
    if(mealGap>=2 && shouldAlertOncePerDay_('mealGap', today)){
      sendTelegramMessage_(`⏰ <b>식사 기록이 ${mealGap}일째 없어요</b>\n마지막 식사 기록일: ${lastMealDate}. 기록이 밀리면 칼로리·단백질 목표 준수율 계산도 최신 상태를 반영하지 못해요.`);
    }
  }








  // 5) 최근 정상섭취 5끼 칼로리/단백질 목표 이탈 — index.html computeSmartAlerts()의 "최근 5끼
  //    평균, ±150kcal 여유" 로직과 동일 기준(단, 레거시 note 텍스트 키워드 폴백은 제외하고
  //    구조화 필드 specialDayType만으로 특이일을 판정 — Code.gs 쪽엔 SPECIAL_DAY_KEYWORDS 사본이
  //    없어 이 부분만 단순화했다).
  if(allInbody.length && allMeals.length >= 5){
    const lastRowBmr = allInbody[allInbody.length-1].bmr;
    // [2026-10-26] 10/27부터는 칼로리 목표와 같은 기초대사(최근 7번 평균 기준)를 쓴다. 그 전에는 예전 값 그대로.
    const lastBmr = (String(today) >= BMR_SMOOTH_START_DATE_) ? (bmrForTargetOn_(allInbody, today) || lastRowBmr) : lastRowBmr;
    if(lastBmr){
      const kt_ = kcalWeekTargetOn_(ss, today); const targetLow = kt_.low, targetHigh = kt_.high; // [2026-11-07c] 그 주 목표 밴드(운동 가산 포함)
      const sortedMealsDesc = [...allMeals].sort((a,b)=>String(b.date).localeCompare(String(a.date)));
      const normalMeals = sortedMealsDesc.filter(m => !m.specialDayType || m.specialDayType==='none');
      const recent5 = normalMeals.slice(0,5);
      if(recent5.length >= 3){
        const avgCal = recent5.reduce((s,m)=>s+(Number(m.calories)||0),0)/recent5.length;
        const avgProtein = recent5.reduce((s,m)=>s+(Number(m.protein)||0),0)/recent5.length;
        if(avgCal > targetHigh+150 && shouldAlertOncePerDay_('calorieOverAvg', today)){
          sendTelegramMessage_(`⚠️ <b>최근 섭취 칼로리가 목표보다 높아요</b>\n목표 ${targetLow}~${targetHigh}kcal인데, 최근 정상섭취 ${recent5.length}끼 평균 ${Math.round(avgCal)}kcal예요.`);
        } else if(avgCal < targetLow-150 && shouldAlertOncePerDay_('calorieUnderAvg', today)){
          sendTelegramMessage_(`⚠️ <b>최근 섭취 칼로리가 너무 낮아요</b>\n목표 ${targetLow}~${targetHigh}kcal인데, 최근 정상섭취 ${recent5.length}끼 평균 ${Math.round(avgCal)}kcal예요. 과도한 저칼로리는 근손실·대사저하 위험이 있어요.`);
        }
        if(avgProtein < PROTEIN_TARGET_RANGE_[0] && shouldAlertOncePerDay_('proteinUnderAvg', today)){
          sendTelegramMessage_(`⚠️ <b>최근 단백질 섭취가 목표에 못 미쳐요</b>\n목표 ${PROTEIN_TARGET_RANGE_[0]}~${PROTEIN_TARGET_RANGE_[1]}g인데, 최근 정상섭취 ${recent5.length}끼 평균 ${Math.round(avgProtein)}g예요.`);
        }
      }
    }
  }








  // 6) 체지방률 추세 정체(목표이탈) — computeGoalDriftAlertServer_ 참고.
  const driftAlert = computeGoalDriftAlertServer_(validInbody_(allInbody), FAT_GOALS_); // 2026-10-13: 제외 확정분은 추세에서 제외
  if(driftAlert && shouldAlertOncePerDay_('goalDrift', today)){
    sendTelegramMessage_(`📉 <b>체지방률 추세가 정체됐어요</b>\n최근 14회 측정 기준 주당 변화가 ${driftAlert.weeklyDeltaPct.toFixed(2)}%p로 거의 평평해요. ${driftAlert.nextGoalLabel}(${driftAlert.nextGoalPct}%) 도달 페이스를 예측하기 어려운 상태예요 — 칼로리·운동 강도 재검토를 권장해요.`);
  }
}
/** incoming 데이터를 InBody/Workouts/Meals/Steps/Waist/Meta에 반영하는 공통 처리
 *  [2026-07-17 재수정] meals는 date+note 매칭에서 다시 "날짜만" 매칭으로 되돌림.
 *  실제 운영 방식이 "하루 총합 1건을 매번 note까지 다시 써서 갱신 업로드"라
 *  note가 매번 바뀌면서 date+note 매칭이 매번 새 행을 만들어 중복이 발생함(실제 확인됨).
 *  운동(workouts)은 항상 개별 세션 단위로 올리므로 date+name 매칭 그대로 유지.
 *  [2026-07-29·07-31 추가 → 2026-10-18 제거] deployFiles/deployChunk(GitHub 자동배포) 처리는 삭제됨.
 *  [2026-08-04 추가] data.comprehensiveReport가 있으면 Meta에 저장(리포트 탭용).
 *  [2026-09-14 추가] aiAnalysis 처리 직후 checkAiAnalysisInbodyGap_ 호출 — 자세한 배경은
 *  그 함수 주석 참고.
 *  [2026-10-04 추가] 맨 끝에서 하루 점수(DailyScore)를 다시 계산해 저장(refreshDailyScoresForPayload_) —
 *  실패해도 데이터 반영 자체는 영향받지 않도록 try/catch로 감쌈.
 */
function applyIncoming_(ss, data, opts){
  metaCacheLoad_(ss); // [2026-11-09c] Meta를 한 번만 읽어 이번 요청 내내 재사용
  // [2026-11-11b] 앱(doPost)이 보낸 본문은 컬렉션별로 "직전에 처리한 앱 본문"과 지문이 같으면 그 시트를 읽지도 쓰지도 않는다(앱은 최근 14일을 매번 보내므로).
  // 채팅 업로드(인박스)·?push 경로는 opts가 없어 예전처럼 항상 처리한다. 지문은 성공적으로 반영한 뒤에만 저장한다.
  const fromApp_ = !!(opts && opts.fromApp);
  const fpNow_ = {};
  const same_ = (key, arr) => {
    if(!fromApp_ || !Array.isArray(arr) || !arr.length) return false;
    fpNow_[key] = fingerprint_(JSON.stringify(arr));
    return propGet_('inFp:' + key) === fpNow_[key];
  };
  const run_ = (key, arr, fn) => {
    if(same_(key, arr)) return [];
    const r = fn();
    if(fpNow_[key]) propSet_('inFp:' + key, fpNow_[key]);
    return r;
  };
  const wSame_ = same_('workouts', data.workouts);
  // [2026-09-18 추가, 1-B] 운동 시트 반영 "전"에 PR 여부를 먼저 판정해야 자기 자신과
  // 비교하는 오류가 없음 — checkAndNotifyExercisePRs_ 함수 설명 참고.
  if(!wSame_ && data.workouts && data.workouts.length){
    checkAndNotifyExercisePRs_(ss, data.workouts);
  }
  const chInbody_ = run_('inbody', data.inbody, () => upsertSheet_(ss, SHEETS.inbody, normalizeIncomingInbody_(ss, data.inbody), null, ['bodyType'])); // 2026-10-13: 제외 표시 보존·결정 시각 비교 / 2026-10-31: 인바디 유형 키가 없으면 시트 값 유지
  if(!wSame_) applyWorkoutRenames_(ss, data.workouts); // 2026-10-18: renameFrom이 있는 운동은 같은 날짜의 이전 이름 행을 새 이름으로 먼저 바꿔 중복 행 방지
  const chWorkouts_ = run_('workouts', data.workouts, () => upsertSheet_(ss, SHEETS.workouts, data.workouts, 'name'));
  const chMeals_ = run_('meals', data.meals, () => upsertSheet_(ss, SHEETS.meals, normalizeIncomingMeals_(ss, data.meals), null, ['items'])); // 2026-10-05-b: 메모의 크레아틴 인식 + 빠진 칸 유지 / 2026-10-18: items 키가 없으면 기존 items 유지
  run_('steps', data.steps, () => upsertSheet_(ss, SHEETS.steps, data.steps));
  run_('waist', data.waist, () => upsertSheet_(ss, SHEETS.waist, data.waist));
  // [2026-09-19 추가, 개선안 20선 3번] 부작용 기록 클라우드 동기화.
  run_('sideEffects', data.sideEffects, () => upsertSheet_(ss, SHEETS.sideEffects, data.sideEffects, 'symptom'));
  // [2026-11-03 수정] 앱이 동기화할 때마다 '이미 서버에 있는 분석'을 다시 보내와서(그리고 동기화가 재시도될 때마다)
  // 인바디 불일치 텔레그램 경고가 반복되던 문제. 이제 분석 글이 시트에 있는 것과 똑같으면 아무것도 하지 않는다(보관·덮어쓰기·경고 모두 생략).
  const aiUnchanged_ = !!data.aiAnalysis && String(getMeta_(ss, 'aiAnalysis') || '') === String(data.aiAnalysis);
  if(data.aiAnalysis && !aiUnchanged_){
    // [2026-09-18 추가, 6-A] 덮어쓰기 직전 값을 ReportHistory에 자동 보관.
    archiveReportBeforeOverwrite_(ss, 'aiAnalysis', 'aiAnalysisDate', 'aiAnalysis');
    setMeta_(ss, 'aiAnalysis', data.aiAnalysis);
    setMeta_(ss, 'aiAnalysisDate', data.aiAnalysisDate || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
    // [2026-09-14 추가] aiAnalysis 텍스트만 올라오고 그 날짜의 구조화 인바디 데이터가
    // 빠지는 사고 재발 방지용 확인. checkAiAnalysisInbodyGap_ 설명 참고.
    checkAiAnalysisInbodyGap_(ss, data);
  }
  if(data.comprehensiveReport){
    // [2026-09-18 추가, 6-A] 덮어쓰기 직전 값을 ReportHistory에 자동 보관.
    archiveReportBeforeOverwrite_(ss, 'comprehensiveReport', 'comprehensiveReportDate', 'comprehensiveReport');
    setMeta_(ss, 'comprehensiveReport', data.comprehensiveReport);
    setMeta_(ss, 'comprehensiveReportDate', data.comprehensiveReportDate || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  }
  // [2026-08-10 추가] 마운자로 투여 차수(MOUNJARO_DOSES) 자동화.
  // 기존엔 index.html에 하드코딩된 배열이라 매주 코드 수정+GitHub 재배포가 필요했고,
  // 실제로 8차 이후 갱신이 누락되는 사고가 있었음(2026-08-10 발견). 이제 Claude가
  // Drive 인박스에 {"mounjaroDoses":[{cycle,date,dose},...]} 를 올리면 aiAnalysis와
  // 동일한 방식으로 Meta 시트에 JSON 문자열로 저장되고, doGet() 응답에 포함되어
  // 클라이언트(cloudSync)가 그대로 반영함. 형식이 배열이 아니거나 비어있으면
  // 저장하지 않고 기존 값을 그대로 유지(잘못된 값으로 덮어써 추적관리 탭이 깨지는 것 방지).
  if(data.mounjaroDoses && Array.isArray(data.mounjaroDoses) && data.mounjaroDoses.length > 0){
    setMeta_(ss, 'mounjaroDoses', JSON.stringify(data.mounjaroDoses));
    setMeta_(ss, 'mounjaroDosesDate', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'));
  }
  // [2026-09-19 추가, 머니트레일 벤치마킹] 삭제 동기화(tombstone). 기존엔 로컬에서 기록을
  // 지워도 다음 pull 때 시트에 남은 옛 행이 그대로 다시 내려가 되살아나는 구조적 결함이 있었음
  // (mergeByDate_ 계열이 "그 날짜에 서버 데이터가 있으면 통째로 서버 값 채택"하는 방식이라,
  // 삭제는 반영할 길이 없었음 — 클라이언트 쪽 index.html 주석 참고). 클라이언트가 pull 시점에
  // 로컬·클라우드 deletedIds를 이미 병합(키별로 더 최신 삭제시각 채택)해서 보내므로, 서버는
  // 그 결과를 그대로 신뢰해 Meta에 저장만 하면 됨(이 앱의 "풀 먼저 → 병합 → 푸시" 원칙과 동일).
  // 시트의 실제 행 자체는 지우지 않고(위험도가 높은 작업이라 이번 범위에서는 제외), 클라이언트가
  // 이 목록을 기준으로 화면에서 걸러내는 방식 — 머니트레일도 동일한 방식으로 동작함.
  let deletedWorkoutDates_ = [];
  if(data.deletedIds){
    // [2026-11-07d] 저장하기 전에(이전 목록과 비교해야 하므로) 새로 삭제된 운동 행을 시트에서 지운다. 실패해도 동기화는 계속한다.
    try{ deletedWorkoutDates_ = applyWorkoutTombstones_(ss, data.deletedIds); }catch(delErr){ Logger.log('운동 삭제 반영 실패(동기화는 정상): ' + delErr); }
    setMeta_(ss, 'deletedIds', typeof data.deletedIds === 'string' ? data.deletedIds : JSON.stringify(data.deletedIds));
  }
  // [2026-09-19 기록, 20선 20번 — 보류, 코드 변경 없음] 알려진 한계: 이 삭제(tombstone) 시각은
  // Meta에만 저장되고, 삭제를 실행한 기기(A) 쪽에는 "다른 기기(B)가 다음 동기화 때 실제로 이
  // 삭제를 받아갔는지" 확인할 방법이 없다. A에서 볼 수 있는 유일한 피드백은 push 직전 뜨는
  // 데이터 급감 경고뿐인데, 이건 "내가 의도한 삭제가 맞다"는 확인이지 "B에도 반영됐다"는 확인이
  // 아니다. 지금은 한 사용자가 여러 기기를 번갈아 쓰는 패턴이라 실사용 임팩트가 작다고 판단해
  // 일부러 손대지 않고 기록만 남긴다 — 다기기 동시 사용이 늘면(예: 각 기기가 서로 다른 시점에
  // pull하는 상황이 잦아지면) 재검토할 것. 만약 구현한다면: 각 기기가 pull 시점에 "이 tombstone
  // 목록까지 반영 완료"라는 확인(ack)을 별도 Meta 키(기기별)에 남기고, A가 다음 조회 때 B의
  // ack를 확인하는 방식이 유력해 보인다.
  // [2026-09-19 추가, 개선안 20선 1번] 설정탭 목표값(goals)이 그동안 로컬(기기)에만 저장되고
  // 클라우드로 전혀 전송되지 않아, 기기를 바꾸면 커스텀 목표가 사라지는 문제가 있었음. aiAnalysis와
  // 동일하게 Meta에 JSON 문자열로 그대로 저장만 하면 되고, "더 최신 쪽 채택" 판단은 클라이언트가
  // updatedAt 필드로 이미 처리하고 보내므로 서버는 신뢰해서 저장만 한다.
  if(data.goals){
    setMeta_(ss, 'goals', typeof data.goals === 'string' ? data.goals : JSON.stringify(data.goals));
  }
  // [2026-09-19 추가, 개선안 20선 3번] 즐겨찾기(favorites)는 날짜가 없는 짧은 목록이라 시트 대신
  // goals와 동일한 Meta JSON blob 패턴({items, updatedAt})으로 저장 — "더 최신 쪽 채택" 판단은
  // 클라이언트가 updatedAt으로 이미 처리하고 보내므로 서버는 신뢰해서 저장만 한다.
  if(data.favorites){
    setMeta_(ss, 'favorites', typeof data.favorites === 'string' ? data.favorites : JSON.stringify(data.favorites));
  }
  // [2026-10-04 추가] 하루 점수 재계산(식단/운동/인바디가 들어온 날짜와 그 영향 구간). 점수 저장 실패가
  // 데이터 반영을 막으면 안 되므로 예외는 삼키고 로그만 남긴다(다음 데이터 수신 때 다시 계산됨).
  let scoresSkipped_ = false;
  try{
    // [2026-11-09c] 앱은 최근 14일을 매번 보내므로, 예전엔 매 동기화마다 14일+6일치 점수를 전부 다시 계산했다. 이제 실제로 바뀐 기록의 날짜 + 오늘(주간 점수가 날짜 경과에 따라 변하므로)만 계산한다.
    const todayKey_ = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
    // [2026-11-11] 바뀐 기록이 없고 오늘(이 점수 버전으로) 이미 계산했다면 다시 계산하지 않는다. 날짜가 바뀌었거나 점수 버전이 바뀌면 첫 저장 때 한 번 계산한다.
    const nothingChanged_ = !(chInbody_ && chInbody_.length) && !(chWorkouts_ && chWorkouts_.length) && !(chMeals_ && chMeals_.length) && !deletedWorkoutDates_.length;
    const refreshKey_ = todayKey_ + '|' + DAILY_SCORE_VERSION_ + '|' + WEEKLY_SCORE_VERSION_;
    const alreadyToday_ = propGet_('scoresRefreshedDay') === refreshKey_;
    if(nothingChanged_ && alreadyToday_){ scoresSkipped_ = true; /* 건너뜀 */ }
    else if(overBudget_()){ Logger.log('점수 재계산 보류: 저장에 ' + (Date.now() - REQ_T0_) + 'ms 걸려 시간 예산 초과(다음 저장 때 다시 계산됨)'); }
    else {
      refreshDailyScoresForPayload_(ss, {
        meals: (chMeals_ || []).concat([{date: todayKey_}]),
        inbody: chInbody_ || [],
        workouts: (chWorkouts_ || []).concat(deletedWorkoutDates_.map(d => ({date: d})))
      });
      propSet_('scoresRefreshedDay', refreshKey_); // 계산이 예외 없이 끝났을 때만 표시
    }
  } catch(scoreErr){
    Logger.log('하루 점수 재계산 실패(데이터 반영은 정상): ' + scoreErr);
  }
  propsFlush_(); // [2026-11-11b] 모아 둔 속성(prSeen·scoresRefreshedDay·앱 본문 지문)을 한 번에 저장
  return {scoresSkipped: scoresSkipped_};
}
/**
 * [2026-09-16 추가] 인박스 폴더 접근/처리 관련 인프라성 오류(Drive 서비스 일시 장애 등)의
 * 텔레그램 알림을 상태 기반으로 다듬는 헬퍼.
 * 실사고(2026-09-16): 1분 간격 트리거(checkInboxTrigger)가 도는 동안 "Service error: Drive"가
 * 약 27분에 걸쳐 간헐적으로 발생했는데, 실패할 때마다 매번 알림을 보내던 기존 로직 때문에
 * 같은 장애 에피소드 하나에 대해 텔레그램 알림이 11건 넘게 연달아 쌓임 — 실제 문제(장애
 * 자체)보다 "알림 폭주"가 더 눈에 띄는 증상이 됨.
 * Script Properties에 마지막 상태(ok/error)와 마지막 알림 시각을 기록해서,
 * - 정상 → 실패로 "전환"되는 첫 순간에만 즉시 알림
 * - 같은 장애가 계속되면 15분에 한 번만 재알림(폭주 방지, 그래도 장기 장애는 계속 인지 가능)
 * - 실패 → 정상으로 "회복"되는 순간 별도로 "정상화" 알림 1건 발송(언제 풀렸는지 알 수 있도록)
 * 이 상태는 processInbox_를 호출하는 모든 경로(1분 트리거·앱 열림·수동 동기화)가 공유함.
 */
const INBOX_ALERT_COOLDOWN_MS_ = 15 * 60 * 1000; // 15분








function reportInboxHealth_(ok, errMsg){
  const props = PropertiesService.getScriptProperties();
  const prevStatus = props.getProperty('inboxHealthStatus') || 'ok';
  const now = Date.now();








  if(ok){
    if(prevStatus === 'error'){
      sendTelegramMessage_('✅ <b>인박스 폴더 정상화</b>\n일시적 장애가 해소되어 다시 정상 처리되고 있어요.');
    }
    props.setProperty('inboxHealthStatus', 'ok');
    return;
  }








  const lastAlertAt = Number(props.getProperty('inboxLastAlertAt') || 0);
  const isNewEpisode = prevStatus !== 'error';
  const cooldownPassed = (now - lastAlertAt) >= INBOX_ALERT_COOLDOWN_MS_;
  if(isNewEpisode || cooldownPassed){
    sendTelegramMessage_(
      `⚠️ <b>인박스 폴더 접근/처리 오류</b>\n오류: ${errMsg}\n` +
      `(대부분 Google Drive 쪽 일시적 응답 지연이며 자동으로 재시도돼요. 같은 장애가 지속되는 ` +
      `동안은 15분에 한 번만 알려드리고, 복구되면 별도로 알려드려요.)`
    );
    props.setProperty('inboxLastAlertAt', String(now));
  }
  props.setProperty('inboxHealthStatus', 'error');
}
/**
 * Google Drive 수신함 처리
 * Claude가 "body-recomp-inbox" 폴더에 올려둔 JSON 파일을 찾아 시트에 반영하고,
 * 처리된 파일은 같은 폴더의 "processed" 하위 폴더로 옮겨 중복 반영을 막습니다.
 * doGet이 호출될 때마다(=앱이 열리거나 동기화될 때마다) + checkInboxTrigger 시간기반
 * 트리거(1분마다)로도 자동 실행됩니다.
 * [2026-08-04 추가] 파일 하나가 정상 처리될 때마다 notifyImmediate_로 텔레그램 즉시알림 발송.
 * [2026-08-06 추가(6번)] 파일 파싱/처리 실패 시 조용히 넘어가지 않고 텔레그램으로 실패 알림
 * 발송(파일명 + 오류 내용). 실패한 파일은 여전히 processed로 옮기지 않아 다음 실행 때 재시도됨.
 * [2026-09-16 추가] LockService로 동시 실행 방지 + reportInboxHealth_로 알림 폭주 방지.
 * 원인: doGet(앱 열림/수동 동기화)과 1분 간격 트리거가 동시에 이 함수를 호출할 수 있는데,
 * 락 없이 겹쳐 실행되면 같은 Drive 폴더에 동시 접근이 몰려 "Service error: Drive"가 발생하기
 * 쉬워짐(실제 관찰된 패턴: 짧은 간격으로 반복 실패). 락을 선점 못하면(=다른 실행이 이미 처리
 * 중) 조용히 건너뜀 — 최대 1분 후 다음 트리거나 다음 doGet 호출 때 다시 시도되므로 데이터
 * 유실은 없음(Drive 인박스 파일은 처리 전까지 그대로 남아있음).
 */
// (POST/웹훅 도구 없이도, Drive 업로드 → 앱이 열릴 때 이 폴더를 스캔하는 방식으로 자동 반영합니다)
const INBOX_FOLDER_ID = '1Fwoah7SJyO0LWEJ6qw6dIaqsJjchovfU';








function processInbox_(ss, opts){
  const fromGet_ = !!(opts && opts.fromGet); // [2026-11-10] 앱 전체 조회에서 호출됐는지(시간 예산 적용)
  const lock = LockService.getScriptLock();
  if(!lock.tryLock(3000)){
    Logger.log('processInbox_: 다른 실행이 이미 처리 중이라 이번 호출은 건너뜀(락 선점 실패)');
    return;
  }
  try{
    let folder;
    // [2026-08-14 추가, 2026-09-16 백오프 강화] Drive 서비스가 일시적으로 응답하지 않는
    // 경우(Service error: Drive)를 곧장 실패 처리하지 않고, 대기 후 최대 3회까지 재시도한다.
    // 짧은 간격의 자동동기화 특성상 일시적 오류에 부딪힐 기회가 많으므로, 진짜 장애와 일시적
    // hiccup을 구분하기 위함. 기존 1초→2초 백오프가 27분간 지속된 실사고 장애를 넘기기엔
    // 너무 짧았던 것으로 보여 2초→4초로 늘림(그래도 트리거 6분 실행제한 안에서 여유 있음).
    const maxRetries = fromGet_ ? 1 : 3; // [2026-11-10] 앱 요청 중에는 대기 재시도 안 함(1분 트리거가 재시도)
    let lastErr;
    for(let attempt = 1; attempt <= maxRetries; attempt++){
      try{
        folder = DriveApp.getFolderById(INBOX_FOLDER_ID);
        lastErr = null;
        break;
      } catch(e){
        lastErr = e;
        if(attempt < maxRetries){
          Utilities.sleep(2000 * attempt); // 2초 → 4초 백오프
        }
      }
    }
    if(lastErr){
      // 3회 재시도 후에도 실패한 경우만 진짜 장애로 보고 알림(상태 기반 폭주 방지 포함)
      reportInboxHealth_(false, String(lastErr));
      return;
    }








    try{
      const files0_ = folder.getFiles(); // [2026-11-11b] 처리할 파일이 없으면 processed 폴더 조회를 생략(대부분의 동기화)
      if(!files0_.hasNext()){ reportInboxHealth_(true); return; }
      const pfIter = folder.getFoldersByName('processed');
      const processedFolder = pfIter.hasNext() ? pfIter.next() : folder.createFolder('processed');








      const files = files0_;
      const fileList = [];
      while(files.hasNext()){ fileList.push(files.next()); }
      fileList.sort((a,b) => a.getDateCreated().getTime() - b.getDateCreated().getTime());
      fileList.forEach(f => {
        if(fromGet_ && Date.now() - REQ_T0_ > 9000) return; // [2026-11-10] 시간이 오래 걸렸으면 남은 파일은 1분 트리거가 처리(파일은 인박스에 그대로 남음)
        try{
          const text = f.getBlob().getDataAsString('UTF-8');
          const data = JSON.parse(text);
          applyIncoming_(ss, data);
          notifyImmediate_(ss, data);
          try{ recordInboxArrival_(data); }catch(arrErr){ Logger.log('수신 기록 실패(처리는 정상): ' + arrErr); } // 2026-10-13: 분석 누락 경고용
          f.moveTo(processedFolder);
        } catch(fileErr){
          sendTelegramMessage_(
            `⚠️ <b>데이터 처리 실패</b>\n` +
            `파일: ${f.getName()}\n` +
            `오류: ${String(fileErr)}`
          );
        }
      });
      reportInboxHealth_(true); // 폴더 접근+스캔이 정상 완료됨 — 직전까지 장애였다면 정상화 알림
    } catch(e){
      reportInboxHealth_(false, String(e));
    }
  } finally {
    lock.releaseLock();
  }
}
/**
 * [2026-09-18 추가] 시간 기반 트리거 자동 등록(self-installing).
 * 기존엔 checkInboxTrigger/sendEveningDigest/checkDailyReminders 전부 "Apps Script 편집기 >
 * 트리거 추가"를 사람이 매번 한 번씩 손으로 눌러줘야 등록됐음(정희님 요청: "트리거 등록 방법은
 * 머니트레일 프로젝트 참고해서 동일하게 앱에서 실행되게 수정해줘"). 실제로 머니트레일 등 기존
 * 프로젝트를 확인해본 결과 동일한 자동등록 사례는 없었지만(Apps Script 표준 패턴으로 새로 구현),
 * 요청 취지(수동 편집기 조작 없이 앱에서 자동으로 처리)에 맞춰 앱이 열릴 때(doGet 호출 시)마다
 * 이 함수가 "이미 등록된 트리거인지" getProjectTriggers()의 핸들러 함수명 기준으로 확인하고,
 * 없는 것만 새로 등록한다 — 배포 후 앱을 한 번 열기만 하면(또는 "지금 동기화"를 누르면) 편집기를
 * 열 필요 없이 전부 자동으로 셋업됨. 이미 등록된 트리거는 건드리지 않으므로 매번 호출해도
 * 중복 생성되지 않는다(멱등). Apps Script 트리거 총량 제한(스크립트당 20개)에 여유 있게 못 미침.
 */
function ensureTriggersInstalled_(){
  try{ if(CacheService.getScriptCache().get('trgChecked_')) return; }catch(cErr){} // [2026-11-10] 6시간에 한 번만 점검(ScriptApp.getProjectTriggers가 느릴 수 있음)
  try{
    const existing = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
    if(existing.indexOf('checkInboxTrigger') === -1){
      ScriptApp.newTrigger('checkInboxTrigger').timeBased().everyMinutes(1).create();
    }
    if(existing.indexOf('sendEveningDigest') === -1){
      ScriptApp.newTrigger('sendEveningDigest').timeBased().everyDays(1).atHour(21).create();
    }
    if(existing.indexOf('checkDailyReminders') === -1){
      ScriptApp.newTrigger('checkDailyReminders').timeBased().everyDays(1).atHour(9).create();
    }
    try{ CacheService.getScriptCache().put('trgChecked_', '1', 21600); }catch(cErr2){}
  } catch(e){
    // 트리거 생성 권한이 아직 승인되지 않은 경우 등 — 데이터 동기화(본 기능)를 막으면 안 되므로
    // 조용히 로그만 남기고 넘어감. 다음 번 doGet 호출(=다음 번 앱 오픈/동기화) 때 다시 시도됨.
    Logger.log('ensureTriggersInstalled_ 실패(다음 호출 때 재시도됨): ' + e);
  }
}








/**
 * [2026-09-19 추가, 09-19 재수정] 권한 승인 전용 수동 실행 함수.
 * 배경: ensureTriggersInstalled_는 이름 끝에 밑줄(_)이 있어 편집기 드롭다운에 안 나타나고, 게다가
 * 함수 내부에 자체 try/catch가 있어서(데이터 동기화를 막지 않으려는 의도) 권한 부족 예외를 조용히
 * 삼켜 Logger.log로만 남김. 정희님이 실제로 authorizeTriggerPermissions()가 ensureTriggersInstalled_()를
 * 호출하도록 만든 첫 버전을 편집기에서 실행했을 때, 실행 로그에 "정보" 레벨로만 예외가 찍히고
 * 권한 승인 팝업은 전혀 안 떴음(2026-09-19 정희님 실행 로그 스크린샷으로 실제 확인) — Apps Script
 * 편집기의 권한 승인 팝업은 예외가 아무 데서도 잡히지 않고 최상위까지 그대로 전파돼야 뜨는데,
 * 안쪽 try/catch가 그 신호를 가로채 일반 로그로 바꿔버린 게 원인. 그래서 이 함수는 절대 try/catch로
 * 감싸지 않고 ScriptApp API를 직접, 예외가 그대로 터지도록 호출한다 — 편집기에서 이 함수를 실행해
 * 권한 승인 팝업(계정 선택 → 고급 → 허용)을 완료하면, 이후 앱의 "등록"/"전체 상태 점검" 버튼도
 * 정상 동작한다(웹 앱은 같은 Google 계정의 승인 상태를 그대로 이어받으므로 재배포는 불필요).
 */
function authorizeTriggerPermissions(){
  var count = ScriptApp.getProjectTriggers().length; // 절대 try/catch로 감싸지 말 것 — 위 주석 참고
  Logger.log('현재 등록된 트리거 개수: ' + count + ' — 여기까지 오류 없이 도달했다면 권한 승인이 정상 완료된 것입니다.');
}








/**
 * [2026-09-18 추가] 앱 화면의 "트리거 상태 확인/등록" 버튼에서 호출하는 액션 2종.
 * 배경: doGet()에서 자동으로 ensureTriggersInstalled_()가 조용히 돌기는 하지만, 등록이 실제로
 * 됐는지 확인할 방법이 앱 화면에 전혀 없었음(성공해도 실패해도 아무 표시가 없었음) — 정희님이
 * 다른 프로젝트(자산관리 앱)에서 쓰던 "버튼 누르면 그 자리에서 등록되고 결과가 보이는" 패턴을
 * 그대로 적용. installTrigger는 특정 트리거 하나만 등록(이미 있으면 알려주기만 하고 건드리지
 * 않음), triggerStatus는 현재 등록 여부를 그대로 보여줌. 둘 다 doGet의 나머지 로직(인박스 처리,
 * 시트 전체 반환)보다 먼저 처리해서 즉시 응답하도록 함 — 버튼 클릭 시 불필요하게 무거운 응답을
 * 기다리지 않게.
 */
const INSTALLABLE_TRIGGERS_ = {
  checkInboxTrigger: () => ScriptApp.newTrigger('checkInboxTrigger').timeBased().everyMinutes(1).create(),
  sendEveningDigest: () => ScriptApp.newTrigger('sendEveningDigest').timeBased().everyDays(1).atHour(21).create(),
  checkDailyReminders: () => ScriptApp.newTrigger('checkDailyReminders').timeBased().everyDays(1).atHour(9).create(),
};
function handleInstallTrigger_(name){
  if(!INSTALLABLE_TRIGGERS_[name]){
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:'알 수 없는 트리거명: ' + name})).setMimeType(ContentService.MimeType.JSON);
  }
  try{
    const already = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === name);
    if(!already) INSTALLABLE_TRIGGERS_[name]();
    return ContentService.createTextOutput(JSON.stringify({ok:true, alreadyInstalled: already})).setMimeType(ContentService.MimeType.JSON);
  } catch(e){
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(e)})).setMimeType(ContentService.MimeType.JSON);
  }
}
function handleTriggerStatus_(){
  // [2026-09-18 수정] 기존엔 ScriptApp.getProjectTriggers()가 try/catch 없이 호출돼,
  // 예외 발생 시(예: 트리거 관리 권한이 아직 승인 전인 경우) doGet 밖으로 그대로 예외가
  // 전파되어 Apps Script가 CORS 헤더 없는 자체 오류 페이지를 반환 → 브라우저에서 "Failed to
  // fetch"로 표시되는 문제가 있었음(2026-09-18 정희님 실사용 중 실제 발생·발견). 같은 파일의
  // handleInstallTrigger_와 동일하게 try/catch로 감싸 항상 CORS 안전한 JSON을 반환하도록 수정.
  try{
    const handlers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
    const triggers = {};
    Object.keys(INSTALLABLE_TRIGGERS_).forEach(name => { triggers[name] = handlers.indexOf(name) !== -1; });
    return ContentService.createTextOutput(JSON.stringify({ok:true, triggers})).setMimeType(ContentService.MimeType.JSON);
  } catch(e){
    return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(e)})).setMimeType(ContentService.MimeType.JSON);
  }
}








/**
 * [2026-10-16 추가] 내 앱 허브용 읽기 전용 요약. 호출: <웹앱 URL>?summary=1
 * 반환: {ok, asOf, inbody:{date,weight,muscle,fat,fatPct}, inbodyPrev:{같은 형식}|null, ma7:{weight,muscle,fat,fatPct}, ma7Count:{...},
 *        fatPctMA7(제외 확정분 건너뛴 유효 7건 평균), mealToday:{recorded,calories,protein,carbs,estimated}, scoreToday}
 * [2026-10-20] inbody에 muscle·fat, inbodyPrev, ma7, ma7Count 추가(마이라이프 오늘 화면의 어제/7회 평균 대비 표시용).
 * 쓰기·인박스 처리·트리거 설치는 하지 않는다(허브가 자주 불러도 시트가 바뀌지 않게).
 */
function hubNum_(v){
  if(v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}
function hubIb_(r){
  return r ? {date: r.date, weight: hubNum_(r.weight), muscle: hubNum_(r.muscle), fat: hubNum_(r.fat), fatPct: hubNum_(r.fatPct)} : null;
}
function handleHubSummary_(ss){
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const ib = validInbody_(readSheet_(ss, SHEETS.inbody)).filter(r => r.weight != null)
    .sort((a,b) => String(a.date).localeCompare(String(b.date)));
  const last = ib.length ? ib[ib.length-1] : null;
  const withFat = ib.filter(r => r.fatPct != null).slice(-7);
  const ma7 = withFat.length ? Math.round(withFat.reduce((s,r) => s + Number(r.fatPct), 0) / withFat.length * 100) / 100 : null;
  // [2026-10-20] 직전 유효 측정 + 필드별 최근 유효 7건 평균(최신 포함, 값이 있는 기록만 — computeInbodyMA7Compare_의 avgValid_와 같은 방식)
  const prevRec = ib.length > 1 ? ib[ib.length-2] : null;
  const ma7Obj = {}, ma7Count = {};
  ['weight','muscle','fat','fatPct'].forEach(k => {
    const vals = ib.map(r => hubNum_(r[k])).filter(x => x !== null).slice(-7);
    ma7Count[k] = vals.length;
    ma7Obj[k] = vals.length ? Math.round(vals.reduce((s,x) => s + x, 0) / vals.length * 100) / 100 : null;
  });
  const meals = readSheet_(ss, SHEETS.meals).filter(m => m.date === today && Number(m.calories) > 0);
  const sum = k => meals.reduce((s,m) => s + (Number(m[k]) || 0), 0);
  const sc = readSheet_(ss, SHEETS.dailyScore).filter(r => r.date === today)[0] || null;
  const out = {
    ok: true,
    asOf: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    inbody: hubIb_(last),
    inbodyPrev: hubIb_(prevRec),
    ma7: ma7Obj,
    ma7Count: ma7Count,
    fatPctMA7: ma7,
    fatPctMA7Count: withFat.length,
    mealToday: {recorded: meals.length > 0, calories: meals.length ? sum('calories') : null, protein: meals.length ? sum('protein') : null, carbs: meals.length ? sum('carbs') : null,
      estimated: meals.some(m => m.estimated === true || m.estimated === 'TRUE' || /추정/.test(String(m.note || '')))},
    scoreToday: sc && sc.score !== null && sc.score !== '' ? Number(sc.score) : null,
  };
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}








function doGet(e){
  const t0_ = Date.now(); REQ_T0_ = t0_;
  const stages_ = []; const stage_ = label => stages_.push([label, Date.now() - t0_]); // [2026-11-10] 단계별 누적 소요(ms)
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  // [2026-11-09c] ?light=1: 앱이 저장 직후·화면 복귀·주기 확인 때 쓰는 가벼운 조회 — 인박스 확인·트리거 점검은 1분 트리거(checkInboxTrigger)가 이미 하므로 건너뛴다.
  // ?days=N: 운동·식단·걸음수·허리둘레·부작용을 최근 N일만 내려준다(인바디는 전부). 둘 다 없으면 예전과 똑같이 동작한다.
  const light_ = !!(e && e.parameter && e.parameter.light);
  const days_ = Number(e && e.parameter && e.parameter.days) || 0;
  if(e.parameter && e.parameter.installTrigger) return handleInstallTrigger_(e.parameter.installTrigger);
  if(e.parameter && e.parameter.triggerStatus) return handleTriggerStatus_();
  if(e.parameter && e.parameter.recomputeScores) return handleRecomputeScores_(); // 2026-10-05-b: 앱 설정탭 버튼
  if(e.parameter && e.parameter.summary) return handleHubSummary_(ss); // 2026-10-16: 앱 허브용 읽기 전용 요약(인박스 처리·트리거 확인 없이 가볍게 응답)
  if(!light_){
    ensureTriggersInstalled_(); // 앱을 그냥 열기만 해도(=버튼을 누르지 않아도) 여전히 자동으로 한 번 더 확인(이중 안전장치)
    stage_('triggers');
    processInbox_(ss, {fromGet:true});
    stage_('inbox');
  }








  // Claude가 채팅에서 분석한 당일 데이터를 GET 쿼리(base64)로 밀어넣는 경로.
  // (참고: script.google.com은 자동화 접근을 차단하는 경우가 있어 Claude가 직접 호출하지 못할 수 있습니다.
  //  그 경우에도 위 Drive 수신함 처리로 동일하게 자동 반영됩니다.)
  if(e.parameter && e.parameter.push){
    try{
      const decoded = Utilities.newBlob(Utilities.base64Decode(e.parameter.push)).getDataAsString('UTF-8');
      const data = JSON.parse(decoded);
      applyIncoming_(ss, data);
    } catch(err){
      return ContentService.createTextOutput(JSON.stringify({ok:false, error:String(err)})).setMimeType(ContentService.MimeType.JSON);
    }
  }








  const cutoff_ = days_ > 0 ? Utilities.formatDate(new Date(Date.now() - days_ * 86400000), Session.getScriptTimeZone(), 'yyyy-MM-dd') : '';
  const recent_ = rows => cutoff_ ? rows.filter(r => !r.date || String(r.date) >= cutoff_) : rows;
  // [2026-11-11] 시트별 소요시간을 stageMs에 누적값으로 남긴다(앱 동기화 배지에 'r-시트이름 값'으로 표시). 끄려면 STAGE_DETAIL_ = false
  const rd_ = (label, fn) => { const v = fn(); if(STAGE_DETAIL_) stage_('r-' + label); return v; };
  const since_ = def => cutoff_ ? readSheetSince_(ss, def, cutoff_) : readSheet_(ss, def); // ?days=N이면 그 기간 행만 읽음(행이 많은 운동·식단 시트에만 사용 — 작은 시트는 호출 횟수가 늘어 오히려 느려질 수 있어 기존 방식)
  const out = {
    ok:true,
    codeVersion: CODE_VERSION_,
    inbody: rd_('inbody', () => readSheet_(ss, SHEETS.inbody)),
    workouts: rd_('workouts', () => recent_(since_(SHEETS.workouts))),
    meals: rd_('meals', () => recent_(since_(SHEETS.meals))),
    steps: rd_('steps', () => recent_(readSheet_(ss, SHEETS.steps))),
    waist: rd_('waist', () => recent_(readSheet_(ss, SHEETS.waist))),
    // [2026-09-19 추가, 개선안 20선 3번] 부작용 기록.
    sideEffects: rd_('side', () => recent_(readSheet_(ss, SHEETS.sideEffects))),
    aiAnalysis: getMeta_(ss, 'aiAnalysis'),
    aiAnalysisDate: getMeta_(ss, 'aiAnalysisDate'),
    comprehensiveReport: getMeta_(ss, 'comprehensiveReport'),
    comprehensiveReportDate: getMeta_(ss, 'comprehensiveReportDate'),
    mounjaroDoses: getMeta_(ss, 'mounjaroDoses'),
    mounjaroDosesDate: getMeta_(ss, 'mounjaroDosesDate'),
    // [2026-09-19 추가, 머니트레일 벤치마킹] 삭제 동기화(tombstone) — 위 applyIncoming_ 설명 참고.
    deletedIds: getMeta_(ss, 'deletedIds'),
    // [2026-09-19 추가, 개선안 20선 1번] 설정탭 목표값 — 위 applyIncoming_ 설명 참고.
    goals: getMeta_(ss, 'goals'),
    // [2026-09-19 추가, 개선안 20선 3번] 즐겨찾기 — 위 applyIncoming_ 설명 참고.
    favorites: getMeta_(ss, 'favorites'),
    // [2026-09-18 추가, 6번] 최근 30건만 내려줌 — 클라이언트가 매번 전체 히스토리를 받을
    // 필요는 없고(리포트탭 드롭다운 용도), payload 크기도 아낄 수 있음.
    // [2026-09-19 명확화, 20선 17번] ReportHistory 시트 자체(archiveReportBeforeOverwrite_)는
    // 별도 정리(pruning) 없이 무제한 누적된다 — 이 slice(0,30)은 응답 payload만 줄이는 것이고
    // 시트의 오래된 기록을 지우지 않는다. 30건이 넘어가면 그 이전 기록은 앱에서 더 이상 조회할
    // 수 없고(원본 시트를 직접 열어야 확인 가능) index.html 쪽에 이를 안내하는 문구를 추가해뒀다.
    // [2026-11-11] 시트는 위에서부터 쌓이므로 끝쪽 60행만 읽어 같은 최근 30건을 만든다(시트 전체를 읽지 않음).
    reportHistory: light_ ? null : rd_('report', () => readSheetTail_(ss, SHEETS.reportHistory, 60).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,30)),
    // [2026-10-04 추가] 하루 점수(최근 30일, 날짜 내림차순) — 앱은 이 값을 표시만 하고 직접 계산하지 않는다.
    dailyScores: rd_('daily', () => readSheet_(ss, SHEETS.dailyScore).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,30)),
    // [2026-11-07 추가] 주간 점수(최근 12주, 주 시작일 내림차순) — 앱은 표시만 한다.
    weeklyScores: rd_('weekly', () => readSheet_(ss, SHEETS.weeklyScore).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,12)),
    // [2026-10-18 추가] 분석 이후 새 데이터가 들어왔는지(앱 분석 카드 표시용). 실패해도 null.
    inboxStatus: getInboxStatus_(),
  };
  stage_('read');
  out.stageMs = stages_; // [2026-11-10] 예: [["triggers",300],["inbox",1500],["read",4200]]
  try{ PropertiesService.getScriptProperties().setProperty('lastGetStages', JSON.stringify({at:new Date().toISOString(), light:light_, stages:stages_})); }catch(pErr){}
  out.serverMs = Date.now() - t0_; // [2026-11-09c] 서버가 쓴 시간(앱 동기화 배지에서 받기 소요시간과 비교용)
  hdrOkFlush_();
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}








function doPost(e){
  const t0_ = Date.now(); REQ_T0_ = t0_;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const data = JSON.parse(e.postData.contents);
  const inInfo_ = applyIncoming_(ss, data, {fromApp: true});
  // [2026-10-05 추가] 방금 저장으로 다시 계산된 하루 점수를 응답에 실어 앱이 바로 표시하게 함(별도 재조회 불필요).
  // 점수 조회가 실패해도 저장 성공(ok:true)은 그대로 — dailyScores만 빠진다.
  // [2026-11-11b] 이번 저장에서 점수 재계산을 건너뛰었다면(바뀐 기록 없음) 점수가 그대로이므로 점수 시트 2개를 읽지 않고 생략한다(앱은 응답에 점수가 없으면 가지고 있던 값을 유지).
  let dailyScores, weeklyScores;
  if(!(inInfo_ && inInfo_.scoresSkipped)){
    try{
      dailyScores = readSheet_(ss, SHEETS.dailyScore).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,30);
      weeklyScores = readSheet_(ss, SHEETS.weeklyScore).sort((a,b)=>String(b.date||'').localeCompare(String(a.date||''))).slice(0,12);
    } catch(scoreReadErr){
      Logger.log('doPost 점수 조회 실패(저장은 정상): ' + scoreReadErr);
    }
  }
  hdrOkFlush_();
  return ContentService.createTextOutput(JSON.stringify({ok:true, dailyScores: dailyScores, weeklyScores: weeklyScores, serverMs: Date.now() - t0_})).setMimeType(ContentService.MimeType.JSON);
}
function testTelegram(){
  sendTelegramMessage_('✅ 텔레그램 연동 테스트 메시지입니다. 이 메시지가 보이면 설정이 정상입니다.');
}








/**
 * [2026-08-04 추가] 앱을 열지 않아도 인박스를 자동으로 확인하기 위한 트리거 전용 함수.
 * doGet은 누군가 웹앱 URL을 호출해야만(=앱을 열거나 "지금 동기화"를 눌러야만) 실행되는
 * 구조라, Claude가 Drive에 파일을 올려도 그것만으로는 자동 처리되지 않음. 이 함수를
 * 시간 기반 트리거(1분마다)로 등록해두면, 앱을 안 열어도 최대 1분 이내에 자동으로
 * 인박스가 처리되고 텔레그램 즉시알림도 그만큼 빨리 온다("완전 실시간"은 아니지만
 * 가장 가까운 방식). doGet처럼 시트 전체를 JSON으로 응답할 필요가 없어 Drive 스캔만
 * 수행 — 처리할 파일이 없으면 사실상 즉시 종료되어 실행 비용도 낮음.
 * [2026-09-18 수정] 이 트리거 등록도 이제 사람이 손으로 할 필요 없음 — ensureTriggersInstalled_()가
 * doGet() 호출 시 자동으로 등록해준다(파일 상단 "텔레그램 연동 설정" 6번 참고).
 */
function checkInboxTrigger(){
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  processInbox_(ss);
  try{ checkAnalysisLag_(); }catch(lagErr){ Logger.log('분석 누락 검사 실패: ' + lagErr); } // 2026-10-13
}








/**
 * [2026-10-02 추가] 텔레그램 "운동 등록" 알림에 붙일 요약 한 줄(볼륨·종목/세트/횟수·시간).
 * 구조화 필드(volume/exercises/durationMin)만 사용하고 note 텍스트는 파싱하지 않는다
 * (note 정규식 파싱이 이 프로젝트에서 반복적으로 값을 놓쳤던 패턴이라 의도적으로 배제).
 * 값이 하나도 없으면 빈 문자열을 반환해 기존 알림과 똑같이 나간다.
 */
function buildWorkoutSummaryLine_(r){
  const parts = [];
  const vol = parseVolume_(r.volume);
  if(vol > 0) parts.push('볼륨 ' + String(Math.round(vol)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + 'kg');
  if(Array.isArray(r.exercises) && r.exercises.length){
    let sets = 0, reps = 0;
    r.exercises.forEach(ex => {
      (Array.isArray(ex.sets) ? ex.sets : []).forEach(st => { sets++; reps += Number(st && st.reps) || 0; });
    });
    parts.push(r.exercises.length + '종목' + (sets ? '/' + sets + '세트' : '') + (reps ? '/' + reps + '회' : ''));
  }
  if(r.durationMin) parts.push(r.durationMin + '분');
  return parts.length ? '\n' + parts.join(' · ') : '';
}
