'use strict';
/**
 * check_node8.js - verify every file deployed to the MGU head unit parses cleanly as ES2017 (Node 8.16)
 * and avoids post-Node-8 standard library APIs.
 */
const fs = require('fs');
const path = require('path');

let acorn = null;
try { acorn = require('acorn'); } catch (e) { /* fallback to vm.Script syntax check if acorn absent */ }
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const FILES = [
    'apps/bimmer_link/main.js',
    'apps/bimmer_link/ui.js',
    'tools/bimmer-link/bimmer-link.js',
    'tools/bimmer-link/car-link.js',
    'tools/bimmer-link/car-hero.js',
    'tools/bimmer-link/cam360.js',
    'tools/bimmer-link/carpaint.js',
    'tools/bimmer-link/wbm.js',
    'tools/bimmer-link/cloud.js',
    'tools/bimmer-link/snapshot.js',
    'tools/bimmer-link/telegram.js',
    'tools/bimmer-link/uplink.js',
];

const NEWER = [
    /\.finally\(/, /\.flat\(/, /\.flatMap\(/, /Object\.fromEntries/, /recursive:\s*true/,
    /\.matchAll\(/, /\.trimStart\(|\.trimEnd\(/, /globalThis/, /\bBigInt\b/, /\.allSettled\(/,
    /\.replaceAll\(/, /\.at\(-?\d/, /fs\.promises|require\(['"]fs\/promises['"]\)/, /\.rmSync\(/,
    /queueMicrotask/, /TextDecoder|TextEncoder/, /new URL\(/, /worker_threads/, /\.description\b/,
];

let bad = 0;
FILES.forEach((f) => {
    const full = path.join(ROOT, f);
    if (!fs.existsSync(full)) { console.log(f + ': missing'); bad++; return; }
    const src = fs.readFileSync(full, 'utf8');
    if (acorn) {
        try { acorn.parse(src, { ecmaVersion: 2017, sourceType: 'script' }); } catch (e) {
            console.log(f + ': not ES2017: ' + e.message); bad++;
        }
    } else {
        try { new vm.Script(src, { filename: f }); } catch (e) {
            console.log(f + ': syntax error: ' + e.message); bad++;
        }
        // Catch ES2018+ object rest/spread or optional catch binding `catch {` or optional chaining `?.` / `??`
        if (/catch\s*\{/.test(src) || /\?\./.test(src) || /\?\?/.test(src)) {
            console.log(f + ': contains post-ES2017 syntax (catch {}, ?., or ??)'); bad++;
        }
    }
    src.split('\n').forEach((line, i) => NEWER.forEach((re) => {
        if (re.test(line.replace(/\/\/.*$/, ''))) {
            console.log(f + ':' + (i + 1) + ': newer than Node 8: ' + line.trim().slice(0, 100));
            bad++;
        }
    }));
});
console.log(bad ? 'check_node8: ' + bad + ' problem(s)' : 'check_node8: ' + FILES.length + ' files ok for Node 8');
process.exit(bad ? 1 : 0);
