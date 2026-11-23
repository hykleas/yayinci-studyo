// Tüm JS dosyalarının sözdizimini kontrol eder (Electron açmadan): npm run check
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'src');
const files = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); console.log('ok  ', path.relative(root, f)); }
  catch (e) { bad++; console.log('HATA', path.relative(root, f), '\n', String(e.stderr)); }
}
console.log(bad ? `\n${bad} dosyada hata var` : `\n${files.length} dosya temiz`);
process.exit(bad ? 1 : 0);
