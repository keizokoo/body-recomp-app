#!/usr/bin/env node
/**
 * PR 자동 검사 (제안서 5번, 2026-11-15 도입)
 * - 스크립트 문법, 화면에 없는 id 참조(새로 생긴 것만), 버전 올렸는지, 토큰처럼 보이는 문자열이 새로 생겼는지 확인.
 * - 첫 2주는 "경고만"(정희님 지시) — 이 스크립트는 문제를 찾아도 항상 종료코드 0으로 끝나고, 결과는 PR의
 *   Job Summary(Checks 탭)에 보기 쉽게 남긴다. 병합을 막지 않는다.
 * - 2주 뒤 정말 막고 싶은 항목이 생기면, 그 항목만 `process.exitCode = 1`로 바꾸면 된다(아래 FAIL_ON 참고).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---- 저장소별 설정 (이 블록만 저장소마다 다름) ----
const CONFIG = JSON.parse(readFileSync(new URL('./config.json', import.meta.url), 'utf8'));
// ----------------------------------------------------

const BASE_REF = process.env.BASE_REF || 'origin/main';
const warnings = []; // {level: 'ok'|'warn'|'info', text}
const ok = (t) => warnings.push({ level: 'ok', text: t });
const warn = (t) => warnings.push({ level: 'warn', text: t });
const info = (t) => warnings.push({ level: 'info', text: t });

function readAt(ref, path) {
  try { return execSync(`git show ${ref}:${path}`, { maxBuffer: 1024 * 1024 * 50 }).toString('utf8'); }
  catch { return null; }
}
function fileChanged(path) {
  try {
    const out = execSync(`git diff --name-only ${BASE_REF}...HEAD -- ${path}`).toString('utf8').trim();
    return out.length > 0;
  } catch { return false; }
}
function addedLines(path) {
  try {
    const diff = execSync(`git diff ${BASE_REF}...HEAD -- ${path}`, { maxBuffer: 1024 * 1024 * 50 }).toString('utf8');
    return diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
  } catch { return []; }
}

// 1) <script> 블록 문법 검사 (HTML 파일)
function extractScripts(html) {
  const blocks = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || '';
    if (/\bsrc\s*=/.test(attrs)) continue;
    if (/type\s*=\s*["'](?!text\/javascript)[^"']+["']/.test(attrs)) continue;
    blocks.push(m[2]);
  }
  return blocks.join('\n;\n');
}
for (const htmlPath of CONFIG.htmlFiles || []) {
  if (!existsSync(htmlPath)) continue;
  const html = readFileSync(htmlPath, 'utf8');
  const code = extractScripts(html);
  const tmp = join(mkdtempSync(join(tmpdir(), 'prcheck-')), 'check.js');
  writeFileSync(tmp, code);
  try {
    execSync(`node --check ${tmp}`, { stdio: 'pipe' });
    ok(`\`${htmlPath}\` 스크립트 문법 검사 통과`);
  } catch (e) {
    warn(`\`${htmlPath}\` 스크립트 문법 오류:\n\`\`\`\n${String(e.stderr || e.message).slice(0, 1500)}\n\`\`\``);
  }
}

// 2) 서버 코드(gas/Code.gs, worker.js) 문법 검사
// node --check는 확장자로 모듈 형식을 가리므로, .gs처럼 낯선 확장자는 .js로 복사한 임시파일로 검사한다.
for (const jsPath of CONFIG.jsFiles || []) {
  if (!existsSync(jsPath)) continue;
  const tmp = join(mkdtempSync(join(tmpdir(), 'prcheck-')), 'check.js');
  writeFileSync(tmp, readFileSync(jsPath, 'utf8'));
  try {
    execSync(`node --check ${tmp}`, { stdio: 'pipe' });
    ok(`\`${jsPath}\` 문법 검사 통과`);
  } catch (e) {
    warn(`\`${jsPath}\` 문법 오류:\n\`\`\`\n${String(e.stderr || e.message).slice(0, 1500)}\n\`\`\``);
  }
}

// 3) DOM id 전수대조 — base 대비 "새로 생긴" 미참조 id만 알림(기존에 있던 건 소음이라 제외)
function domCheck(html) {
  const ids = new Set(Array.from(html.matchAll(/\bid=["']([^"']+)["']/g)).map(m => m[1]));
  const refs = new Set([
    ...Array.from(html.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)).map(m => m[1]),
    ...Array.from(html.matchAll(/\$\(\s*['"]([A-Za-z][\w-]*)['"]\s*\)/g)).map(m => m[1]),
  ]);
  return [...refs].filter(r => !ids.has(r)).sort();
}
for (const htmlPath of CONFIG.htmlFiles || []) {
  if (!existsSync(htmlPath)) continue;
  const headHtml = readFileSync(htmlPath, 'utf8');
  const baseHtml = readAt(BASE_REF, htmlPath);
  const headMissing = new Set(domCheck(headHtml));
  const baseMissing = baseHtml ? new Set(domCheck(baseHtml)) : new Set();
  const newlyMissing = [...headMissing].filter(x => !baseMissing.has(x));
  if (newlyMissing.length) warn(`\`${htmlPath}\` 에 새로 생긴 미참조 id(화면에 없는데 JS가 찾음): ${newlyMissing.map(x => '`' + x + '`').join(', ')}`);
  else ok(`\`${htmlPath}\` DOM id 전수대조 — 새로 생긴 미참조 id 없음`);
}

// 4) 버전 올렸는지 — 파일이 바뀌었는데 버전 문자열 줄은 안 바뀌었으면 경고
for (const v of CONFIG.versionChecks || []) {
  if (!fileChanged(v.file)) continue;
  const headFile = existsSync(v.file) ? readFileSync(v.file, 'utf8') : '';
  const baseFile = readAt(BASE_REF, v.file) || '';
  const re = new RegExp(v.pattern);
  const headLine = (headFile.match(re) || [null])[0];
  const baseLine = (baseFile.match(re) || [null])[0];
  if (headLine && headLine !== baseLine) ok(`\`${v.file}\` ${v.label} 올림 확인`);
  else warn(`\`${v.file}\`가 바뀌었는데 ${v.label}을(를) 못 찾았거나 그대로예요 — 배포해도 캐시가 안 바뀔 수 있어요. 확인해 주세요(패턴: \`${v.pattern}\`).`);
}

// 5) 토큰처럼 보이는 새 문자열(코드에 직접 박힌 비밀값 의심) — 추가된 줄만 검사.
// "key"라는 단어가 그냥 들어간 일반 코드(예: 일정표의 key: 'autoReflectIntraday_0905')까지 걸리지 않도록,
// 변수/속성 이름 자체가 key·token·secret 등을 포함하고 바로 그 자리에서 긴 무작위 문자열을 대입하는 경우만 본다.
const SECRET_ASSIGN_RE = /\b[A-Za-z_]*(?:api[_-]?key|token|secret|password)[A-Za-z_]*\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/gi;
// 변수 이름이 "...KEY"로 끝나되 흔한 비-비밀 용도(날짜/일정 key, 배열 key 등)는 값 자체가 사람이 읽는 평문(영문 식별자)일 때가 많다.
// 값이 무작위로 보이는지까지는 못 가리므로, 흔한 오탐원인 "key: '영문+숫자로만 된 식별자 느낌'"은 그대로 둔다(그래도 거의 안 걸림: 위 정규식이 "KEY/TOKEN/SECRET"를 포함한 "이름" 자체를 요구함).
for (const f of [...(CONFIG.htmlFiles || []), ...(CONFIG.jsFiles || [])]) {
  if (!existsSync(f)) continue;
  const added = addedLines(f);
  const hits = [];
  added.forEach(line => {
    const m = line.match(SECRET_ASSIGN_RE);
    if (m) hits.push(...m);
  });
  if (hits.length) warn(`\`${f}\`에 새로 추가된 줄에 키·토큰 이름의 변수에 긴 문자열을 바로 대입한 곳이 있어요(오탐 가능, 눈으로 확인 필요): ${[...new Set(hits)].slice(0, 5).join(', ')}`);
}
if (!warnings.some(w => w.level === 'warn' && /키·토큰/.test(w.text))) info('새로 추가된 줄에서 키·토큰 이름에 긴 문자열을 바로 대입한 곳 없음');

// ---- 결과 출력 ----
const lines = [];
lines.push(`## 🧪 PR 자동 검사 (경고 전용 — 2주 시범, 병합을 막지 않습니다)`);
lines.push('');
for (const w of warnings) {
  const icon = w.level === 'ok' ? '✅' : w.level === 'warn' ? '⚠️' : 'ℹ️';
  lines.push(`${icon} ${w.text}`);
  lines.push('');
}
const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) writeFileSync(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });

// 항상 0으로 끝난다(경고 전용 시범 기간). FAIL_ON 환경변수를 'warn'으로 주면 경고가 있을 때 실패하도록 바꿀 수 있다(2주 뒤 사용).
if (process.env.FAIL_ON === 'warn' && warnings.some(w => w.level === 'warn')) {
  process.exitCode = 1;
}
