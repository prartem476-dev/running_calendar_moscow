import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const androidDir = path.join(rootDir, 'android');
const outDir = path.join(rootDir, 'rustore', 'builds');

const jdkCandidates = [
  process.env.JAVA_HOME,
  path.join(process.env.USERPROFILE || '', '.jdks', 'jbr-21.0.11'),
  'C:\\Program Files\\Android\\Android Studio\\jbr',
].filter((p) => p && fs.existsSync(path.join(p, 'bin', 'java.exe')));

const sdkCandidates = [
  process.env.ANDROID_HOME,
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
].filter((p) => p && fs.existsSync(p));

const env = { ...process.env };
if (jdkCandidates[0]) {
  env.JAVA_HOME = jdkCandidates[0];
  env.PATH = `${path.join(jdkCandidates[0], 'bin')};${env.PATH || ''}`;
}
if (sdkCandidates[0]) {
  env.ANDROID_HOME = sdkCandidates[0];
  env.ANDROID_SDK_ROOT = sdkCandidates[0];
}

console.log('1/3 Синхронизация веб-сборки с Capacitor Android...');
execSync('npx cap sync android', { stdio: 'inherit', env });

console.log('2/3 Сборка подписанных релизных APK и AAB через Gradle...');
const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
execSync(`${gradlew} assembleRelease bundleRelease`, {
  cwd: androidDir,
  stdio: 'inherit',
  env,
});

console.log('3/3 Копирование готовых пакетов в rustore/builds/...');
fs.mkdirSync(outDir, { recursive: true });

const apkSrc = path.join(
  androidDir,
  'app',
  'build',
  'outputs',
  'apk',
  'release',
  'app-release.apk'
);
const aabSrc = path.join(
  androidDir,
  'app',
  'build',
  'outputs',
  'bundle',
  'release',
  'app-release.aab'
);

const apkDest = path.join(outDir, 'moscow-run-calendar-v1.0.0-release.apk');
const aabDest = path.join(outDir, 'moscow-run-calendar-v1.0.0-release.aab');

if (fs.existsSync(apkSrc)) {
  fs.copyFileSync(apkSrc, apkDest);
  console.log(`✅ Подписанный APK: ${apkDest}`);
}
if (fs.existsSync(aabSrc)) {
  fs.copyFileSync(aabSrc, aabDest);
  console.log(`✅ Подписанный AAB: ${aabDest}`);
}
