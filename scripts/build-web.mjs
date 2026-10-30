import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const distDir = path.join(rootDir, 'dist');

// Keep running_calendar_moscow.html in sync with index.html
const indexHtmlPath = path.join(rootDir, 'index.html');
const mirrorHtmlPath = path.join(rootDir, 'running_calendar_moscow.html');
if (fs.existsSync(indexHtmlPath)) {
  fs.copyFileSync(indexHtmlPath, mirrorHtmlPath);
}

fs.mkdirSync(distDir, { recursive: true });

const filesToCopy = [
  'index.html',
  'running_calendar_moscow.html',
  'moscow_running_events.json',
  'moscow_running_events.ics',
  'privacy.html',
];

for (const file of filesToCopy) {
  const src = path.join(rootDir, file);
  const dest = path.join(distDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dest);
  }
}

console.log(`✅ Собрана папка dist/ (${filesToCopy.length} файлов) для Capacitor Android.`);
