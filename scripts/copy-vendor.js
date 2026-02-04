const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');
const vendor = path.join(root, 'vendor');

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDir(srcDir, destDir) {
  if (!fs.existsSync(srcDir)) return;
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyDir(src, dest);
    else copyFile(src, dest);
  }
}

try {
  copyFile(
    path.join(nodeModules, 'bootstrap', 'dist', 'css', 'bootstrap.min.css'),
    path.join(vendor, 'bootstrap', 'bootstrap.min.css')
  );
  copyFile(
    path.join(nodeModules, 'bootstrap', 'dist', 'js', 'bootstrap.bundle.min.js'),
    path.join(vendor, 'bootstrap', 'bootstrap.bundle.min.js')
  );
  copyFile(
    path.join(nodeModules, 'bootstrap-icons', 'font', 'bootstrap-icons.min.css'),
    path.join(vendor, 'bootstrap-icons', 'bootstrap-icons.min.css')
  );
  copyDir(
    path.join(nodeModules, 'bootstrap-icons', 'font', 'fonts'),
    path.join(vendor, 'bootstrap-icons', 'fonts')
  );
  copyFile(
    path.join(nodeModules, 'chart.js', 'dist', 'chart.umd.min.js'),
    path.join(vendor, 'chartjs', 'chart.umd.min.js')
  );
  copyFile(
    path.join(nodeModules, 'chartjs-adapter-date-fns', 'dist', 'chartjs-adapter-date-fns.bundle.min.js'),
    path.join(vendor, 'chartjs-adapter-date-fns', 'chartjs-adapter-date-fns.bundle.min.js')
  );
  console.log('Vendor assets copied.');
} catch (err) {
  console.error('Failed to copy vendor assets:', err.message);
  process.exitCode = 1;
}
