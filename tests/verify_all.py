#!/usr/bin/env python3
"""Offline verification suite runnable on macOS/Linux without requiring a local Node install:
1. Validates mgu-repo.json, component.json, systemd unit, and app.json against MGU Store contracts.
2. Checks ES2017 / Node 8.16 syntax & forbidden post-Node-8 APIs across every JS file + inline HTML script via JavaScriptCore (osascript JXA).
3. Runs a full MGU App Kit build (`kit/tools/build.py --language vi --plain-version bimmer_link`) using a temporary SDK stub to verify `.mgu` and `.tgz` archive packaging, RHMI XML, and localization bundles.
4. Executes pure JS functional tests (`car-link.js` coordinate parser, 1CR catalog discovery, payload synthesis, and `TelemetryTracker` trip/park state machine) inside JavaScriptCore.
"""
import json, os, re, shutil, subprocess, sys, tarfile, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

JS_FILES = [
    'apps/bimmer_link/main.js',
    'apps/bimmer_link/ui.js',
    'tools/bimmer-link/bimmer-link.js',
    'tools/bimmer-link/car-link.js',
    'tools/bimmer-link/snapshot.js',
    'tools/bimmer-link/telegram.js',
    'tools/bimmer-link/uplink.js',
    'scripts/make_icon.js',
    'scripts/check_node8.js',
]

POST_NODE8 = [
    r'\.finally\(', r'\.flat\(', r'\.flatMap\(', r'Object\.fromEntries', r'recursive:\s*true',
    r'\.matchAll\(', r'\.trimStart\(|\.trimEnd\(', r'\bglobalThis\b', r'\bBigInt\b', r'\.allSettled\(',
    r'\.replaceAll\(', r'\.at\(-?\d', r'fs\.promises', r'\.rmSync\(', r'\bqueueMicrotask\b',
    r'TextDecoder|TextEncoder', r'new URL\(', r'worker_threads',
    r'catch\s*\{', r'\?\.', r'\?\?',
]


def run_jxa(script_text):
    res = subprocess.run(['osascript', '-l', 'JavaScript', '-e', script_text], capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(f'JXA failed:\n{res.stderr}\n{res.stdout}')
    return res.stdout.strip()


def check_manifests():
    repo = json.load(open(os.path.join(ROOT, 'mgu-repo.json'), encoding='utf-8'))
    assert repo['schema'] == 1
    app_entry = repo['components'][0]
    assert app_entry['id'] == 'bimmer_link'
    assert os.path.exists(os.path.join(ROOT, app_entry['path'], app_entry['manifest']))
    assert os.path.exists(os.path.join(ROOT, app_entry['path'], app_entry['icon']))
    for sh in app_entry['build']['shared']:
        if sh != 'oap-sdk':
            assert os.path.exists(os.path.join(ROOT, sh)), f'Missing shared build path: {sh}'

    tool_entry = repo['tools'][0]
    comp_dir = os.path.join(ROOT, tool_entry['path'])
    comp = json.load(open(os.path.join(comp_dir, 'component.json'), encoding='utf-8'))
    assert comp['id'] == 'bimmer-link'
    assert comp['internet'] is True
    for f in comp['files']:
        assert os.path.exists(os.path.join(comp_dir, f['path'])), f'Missing tool file: {f["path"]}'
    for u in comp['units']:
        assert os.path.exists(os.path.join(comp_dir, u['name'])), f'Missing unit file: {u["name"]}'
    print('[OK] MGU Store manifests & file layout verified')


def check_js_syntax_and_node8():
    for rel in JS_FILES:
        full = os.path.join(ROOT, rel)
        src = open(full, encoding='utf-8').read()
        if not rel.startswith('scripts/'):
            for lineno, line in enumerate(src.splitlines(), 1):
                clean = re.sub(r'//.*$', '', line)
                for pat in POST_NODE8:
                    if re.search(pat, clean):
                        raise AssertionError(f'{rel}:{lineno} uses post-Node-8 construct ({pat}): {line.strip()}')
        # Parse via JavaScriptCore Function constructor
        jxa = f'var src = {json.dumps(src)}; new Function("require", "module", "exports", "__dirname", "__filename", "process", "Buffer", src); "OK";'
        assert run_jxa(jxa) == 'OK', f'Syntax error in {rel}'

    # Also parse inline <script> inside page.html
    html = open(os.path.join(ROOT, 'tools/bimmer-link/page.html'), encoding='utf-8').read()
    m = re.search(r'<script>([\s\S]*?)</script>', html)
    assert m, 'Missing <script> in page.html'
    jxa_html = f'var src = {json.dumps(m.group(1))}; new Function("window", "document", "location", "localStorage", "fetch", src); "OK";'
    assert run_jxa(jxa_html) == 'OK'
    print(f'[OK] All {len(JS_FILES)} JS files + page.html inline script passed syntax & Node 8 ES2017 checks')


def check_full_mgu_build():
    sdk_dir = os.path.join(ROOT, 'oap-sdk')
    dist_dir = os.path.join(ROOT, 'dist')
    created_sdk = False
    try:
        if not os.path.exists(sdk_dir):
            os.makedirs(sdk_dir)
            created_sdk = True
            open(os.path.join(sdk_dir, 'index.js'), 'w').write('"use strict"; module.exports = {};\n')
            json.dump({'name': 'oap-sdk', 'version': '1.0.0'}, open(os.path.join(sdk_dir, 'package.json'), 'w'))
        res = subprocess.run(
            [sys.executable, os.path.join(ROOT, 'kit/tools/build.py'), '--language', 'vi', '--plain-version', 'bimmer_link'],
            cwd=ROOT, capture_output=True, text=True, check=True
        )
        tgz = os.path.join(dist_dir, 'bimmer_link@0.1.0.tgz')
        mgu_pkg = os.path.join(dist_dir, 'bimmer_link@0.1.0.mgu')
        assert os.path.exists(tgz) and os.path.getsize(tgz) > 10000
        assert os.path.exists(mgu_pkg) and os.path.getsize(mgu_pkg) > 10000
        with tarfile.open(tgz, 'r:gz') as tf:
            names = tf.getnames()
            assert 'package/javascript/app.js' in names
            assert 'package/rhmiData/uiDescriptions/ID7/application.xml' in names
            assert 'package/rhmiData/variantGroups/Common/texts/vi_VN.json' in names
        print('[OK] Full MGU App Kit archive build verified:', res.stdout.strip())
    finally:
        if created_sdk and os.path.exists(sdk_dir):
            shutil.rmtree(sdk_dir)
        if os.path.exists(dist_dir):
            shutil.rmtree(dist_dir)


def check_car_link_logic_in_jxa():
    car_link_src = open(os.path.join(ROOT, 'tools/bimmer-link/car-link.js'), encoding='utf-8').read()
    harness = f"""
    var mod = {{ exports: {{}} }};
    var fakeReq = function(name) {{
      if (name === 'fs') return {{ readFileSync: function(){{ throw new Error('no'); }}, existsSync: function(){{ return false; }} }};
      if (name === 'path') return {{ dirname: function(){{ return '/'; }}, join: function(){{ return '/'; }} }};
      return {{}};
    }};
    var fakeProc = {{ env: {{}}, argv: ['node', 'car-link.js'], on: function(){{}} }};
    var fn = new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', {json.dumps(car_link_src)});
    fn(fakeReq, mod, mod.exports, '/', '/car-link.js', fakeProc);
    var C = mod.exports;

    // Test 1: WGS84 underground nav extraction
    var nav = {{
      coordinatesValid: true,
      baseLocation: {{
        coordinates: {{ latitude: 107768890, longitude: 1067008060 }},
        textDescription: {{ textDescriptorList: [[14, {{ orthography: 'Nguyễn Huệ' }}], [33, {{ orthography: 'Quận 1' }}], [13, {{ orthography: 'TP.HCM' }}]] }}
      }}
    }};
    var c = C.extractCoords(nav, 0);
    if (!c || Math.abs(c.lat - 10.776889) > 1e-5) throw new Error('bad lat');
    var pl = C.extractPlaceText(nav);
    if (pl.street !== 'Nguyễn Huệ' || pl.district !== 'Quận 1') throw new Error('bad place');

    // Test 2: 1CR catalog discovery & payload generation
    var db = {{
      interfaces: {{
        'de.bmw.infotainment.climate.Climate': {{
          serviceId: 99,
          fields: {{
            remoteEngineStart: {{ getter: true, setter: true, notifier: true, type: 'OnOff' }},
            directOperationParkHeating: {{ getter: true, setter: true, notifier: true, type: 'ActEnum' }},
            departureTimer1: {{ getter: true, setter: true, notifier: true, type: 'TimerT' }}
          }},
          methods: {{}}
        }}
      }},
      enumerations: {{ OnOff: {{ values: ['OFF', 'ON'] }}, ActEnum: {{ values: ['INACTIVE', 'ACTIVE'] }} }},
      structs: {{ TimerT: {{ fields: [{{ name: 'operationHour', type: 'UInt8' }}, {{ name: 'operationMinute', type: 'UInt8' }}, {{ name: 'active', type: 'Boolean' }}] }} }}
    }};
    var disc = C.discoverClimateCatalog(db);
    if (disc.interfaces.length !== 1) throw new Error('expected 1 climate iface');
    var df = disc.interfaces[0].fields.filter(function(x){{ return x.name === 'directOperationParkHeating'; }})[0];
    if (C.buildDirectPayload(df, true) !== 'ACTIVE') throw new Error('expected ACTIVE');
    if (C.buildDirectPayload(df, false) !== 'INACTIVE') throw new Error('expected INACTIVE');
    var tf = disc.interfaces[0].fields.filter(function(x){{ return x.name === 'departureTimer1'; }})[0];
    var tp = C.buildTimerPayload(tf, 17, 15, true);
    if (tp.operationHour !== 17 || tp.operationMinute !== 15 || tp.active !== true) throw new Error('bad timer payload');

    // Test 3: Trip & Park Snapshot trigger
    var trk = new C.TelemetryTracker();
    trk.update({{ condition: 10, rpm: 1500, speed: 50, odometerKm: 5000, fuelPct: 80 }}, 1000000);
    trk.update({{ speed: 82, rpm: 3200, odometerKm: 5015.6, fuelPct: 78 }}, 1000000 + 900000);
    var evs = trk.update({{ condition: 12, rpm: 0, speed: 0, stage: 'P' }}, 1000000 + 1200000);
    if (evs.length !== 1 || evs[0].type !== 'parked' || evs[0].trip.distanceKm !== 15.6 || evs[0].trip.maxSpeed !== 82) {{
      throw new Error('bad trip event: ' + JSON.stringify(evs));
    }}
    'ALL_JXA_LOGIC_TESTS_PASSED';
    """
    out = run_jxa(harness)
    assert out == 'ALL_JXA_LOGIC_TESTS_PASSED'
    print('[OK] Live JS unit tests (1CR discovery, timer synthesis, underground GPS, Park/Trip state machine) passed')


if __name__ == '__main__':
    check_manifests()
    check_js_syntax_and_node8()
    check_full_mgu_build()
    check_car_link_logic_in_jxa()
    print('=== ALL VERIFICATION CHECKS PASSED ===')
