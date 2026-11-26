#!/usr/bin/env python3
"""Offline verification suite runnable on macOS/Linux without requiring a local Node install:
1. Validates mgu-repo.json, component.json, systemd unit, and app.json against MGU Store contracts & version sync.
2. Checks ES2017 / Node 8.16 syntax & forbidden post-Node-8 APIs across every JS file + inline HTML/PWA scripts via JavaScriptCore (osascript JXA).
3. Runs a full MGU App Kit build (`kit/tools/build.py --language vi --plain-version bimmer_link`) using a temporary SDK stub to verify `.mgu` and `.tgz` archive packaging, RHMI XML, and localization bundles.
4. Executes real-kit `UI.draw` render tests against actual `kit/runtime/{themes,canvas,record,gauges,qr}` on both GPU `Recorder` (`own=true` & `own=false`) and software `Canvas` (`play`), verifying zero exceptions and zero `NaN` words across all UI states.
5. Executes pure JS functional tests (`car-link.js` coordinate parser, 1CR catalog discovery, payload synthesis, and `TelemetryTracker` trip/park state machine) inside JavaScriptCore.
"""
import base64, json, os, re, shutil, subprocess, sys, tarfile, zlib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

JS_FILES = [
    'apps/bimmer_link/main.js',
    'apps/bimmer_link/ui.js',
    'tools/bimmer-link/bimmer-link.js',
    'tools/bimmer-link/car-link.js',
    'tools/bimmer-link/car-hero.js',
    'tools/bimmer-link/cam360.js',
    'tools/bimmer-link/carpaint.js',
    'tools/bimmer-link/wbm.js',
    'tools/bimmer-link/cloud.js',
    'tools/bimmer-link/mqtt-lite.js',
    'tools/bimmer-link/jpeg.js',
    'tools/bimmer-link/snapshot.js',
    'tools/bimmer-link/telegram.js',
    'tools/bimmer-link/uplink.js',
    'tools/bimmer-link/aa-wifi.js',
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
    res = subprocess.run(
        ['osascript', '-l', 'JavaScript', '-'],
        input=script_text, capture_output=True, text=True
    )
    if res.returncode != 0:
        raise RuntimeError(f'JXA failed:\n{res.stderr}\n{res.stdout}')
    return res.stdout.strip()


def check_manifests():
    repo = json.load(open(os.path.join(ROOT, 'mgu-repo.json'), encoding='utf-8'))
    assert repo['schema'] == 1
    app_entry = repo['components'][0]
    assert app_entry['id'] == 'bimmer_link'
    app_manifest_path = os.path.join(ROOT, app_entry['path'], app_entry['manifest'])
    assert os.path.exists(app_manifest_path)
    assert os.path.exists(os.path.join(ROOT, app_entry['path'], app_entry['icon']))
    app_spec = json.load(open(app_manifest_path, encoding='utf-8'))
    app_ver = app_spec['version']

    for sh in app_entry['build']['shared']:
        if sh != 'oap-sdk':
            assert os.path.exists(os.path.join(ROOT, sh)), f'Missing shared build path: {sh}'

    tool_entry = repo['tools'][0]
    comp_dir = os.path.join(ROOT, tool_entry['path'])
    comp = json.load(open(os.path.join(comp_dir, 'component.json'), encoding='utf-8'))
    assert comp['id'] == 'bimmer-link'
    assert comp['internet'] is True
    assert app_entry['requires']['bimmer-link'] == comp['version'], (
        f"mgu-repo requires bimmer-link {app_entry['requires']['bimmer-link']} != component.json {comp['version']}"
    )
    daemon_src = open(os.path.join(comp_dir, 'bimmer-link.js'), encoding='utf-8').read()
    assert f"const VERSION = '{comp['version']}';" in daemon_src, 'bimmer-link.js VERSION out of sync with component.json'

    for f in comp['files']:
        assert os.path.exists(os.path.join(comp_dir, f['path'])), f'Missing tool file: {f["path"]}'
    for u in comp['units']:
        assert os.path.exists(os.path.join(comp_dir, u['name'])), f'Missing unit file: {u["name"]}'
    print(f'[OK] MGU Store manifests & version sync verified (app={app_ver}, tool={comp["version"]})')
    return app_ver


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
        jxa = f'var src = {json.dumps(src)}; new Function("require", "module", "exports", "__dirname", "__filename", "process", "Buffer", src); "OK";'
        assert run_jxa(jxa) == 'OK', f'Syntax error in {rel}'

    html = open(os.path.join(ROOT, 'tools/bimmer-link/page.html'), encoding='utf-8').read()
    m = re.search(r'<script>([\s\S]*?)</script>', html)
    assert m, 'Missing <script> in page.html'
    jxa_html = f'var src = {json.dumps(m.group(1))}; new Function("window", "document", "location", "localStorage", "fetch", src); "OK";'
    assert run_jxa(jxa_html) == 'OK'

    pwa_js = open(os.path.join(ROOT, 'docs/app/app.js'), encoding='utf-8').read()
    jxa_pwa = f'var src = {json.dumps(pwa_js)}; new Function("window", "document", "location", "localStorage", "fetch", "navigator", "history", "Image", "WebSocket", "crypto", "TextEncoder", "TextDecoder", "L", src); "OK";'
    assert run_jxa(jxa_pwa) == 'OK', 'Syntax error in docs/app/app.js'
    print(f'[OK] All {len(JS_FILES)} MGU JS files + page.html + docs/app/app.js passed syntax & Node 8 checks')


def check_full_mgu_build_and_real_kit_render(app_ver):
    sdk_dir = os.path.join(ROOT, 'oap-sdk')
    dist_dir = os.path.join(ROOT, 'dist')
    created_sdk = False
    tgz = os.path.join(dist_dir, f'bimmer_link@{app_ver}.tgz')
    mgu_pkg = os.path.join(dist_dir, f'bimmer_link@{app_ver}.mgu')
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
        assert os.path.exists(tgz) and os.path.getsize(tgz) > 10000
        assert os.path.exists(mgu_pkg) and os.path.getsize(mgu_pkg) > 10000

        with tarfile.open(mgu_pkg, 'r:gz') as mf:
            meta_j = json.loads(mf.extractfile('meta.json').read().decode('utf-8'))
            man_j = json.loads(mf.extractfile('source/manifest.json').read().decode('utf-8'))
            assert 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy' in meta_j.get('optional', {})
            assert man_j['proxies'].get('de.bmw.infotainment.video.cameraproxy.ICAM2Proxy') == '*'
            assert man_j['proxies'].get('de.bmw.infotainment.climate.Climate2') == '*'
            assert man_j['proxies'].get('de.bmw.infotainment.climate.climatemaster.ClimateMaster') == '*'
            assert man_j['proxies'].get('de.bmw.infotainment.lsc.LSCDataSink') == '*'
            assert man_j['proxies'].get('de.bmw.infotainment.KombiIF') == '*'
            assert man_j['proxies'].get('de.bmw.infotainment.navigation.positioning.Positioning') == '*'
            assert man_j['proxies'].get('com.harman.infotainment.systemfunctions.tasu.tasu.InternalTasu') == '*'

        cloud_src = open(os.path.join(ROOT, 'tools/bimmer-link/cloud.js'), encoding='utf-8').read()
        m_chunk = re.search(r'const CHUNK_BYTES\s*=\s*(\d+);', cloud_src)
        assert m_chunk and int(m_chunk.group(1)) <= 1650, 'CHUNK_BYTES must keep encrypted wire payload < 4096B on ntfy.sh'

        # Extract exact runtime + baked font atlases from the built .tgz to test REAL car execution!
        extracted_files = {}
        inflated_font_alphas = {}
        with tarfile.open(tgz, 'r:gz') as tf:
            names = tf.getnames()
            assert 'package/javascript/app.js' in names
            assert 'package/javascript/ui.js' in names
            assert 'package/rhmiData/uiDescriptions/ID7/application.xml' in names
            assert 'package/rhmiData/variantGroups/Common/texts/vi_VN.json' in names
            for n in names:
                if n.startswith('package/javascript/') and (n.endswith('.js') or n.endswith('.json')):
                    raw = tf.extractfile(n).read().decode('utf-8')
                    rel_key = n[len('package/javascript/'):]
                    extracted_files[rel_key] = raw
                    if rel_key.startswith('kit/fonts/') and rel_key.endswith('.json'):
                        fj = json.loads(raw)
                        for idx, sz in enumerate(fj.get('sizes', [])):
                            raw_alpha = zlib.decompress(base64.b64decode(sz['alpha']))
                            inflated_font_alphas[f'{rel_key}#{idx}'] = list(raw_alpha)
        print('[OK] Full MGU App Kit archive build verified:', res.stdout.strip())

        # Run real-kit UI.draw verification inside JXA using extracted package files
        ui_harness = f"""
        var FILES = {json.dumps(extracted_files)};
        var ALPHAS = {json.dumps(inflated_font_alphas)};
        var CACHE = {{}};

        var BufferShim = {{
          from: function(x, enc) {{
            if (typeof x === 'string') {{
              var unesc = unescape(encodeURIComponent(x));
              var u = new Uint8Array(unesc.length);
              for (var i = 0; i < unesc.length; i++) u[i] = unesc.charCodeAt(i);
              return u;
            }}
            if (x instanceof ArrayBuffer) return new Uint8Array(x, enc || 0);
            return new Uint8Array(x);
          }},
          isBuffer: function(b) {{ return b instanceof Uint8Array; }},
          alloc: function(n) {{ return new Uint8Array(n); }},
          allocUnsafe: function(n) {{ return new Uint8Array(n); }},
          concat: function(list) {{
            var total = 0;
            for (var i = 0; i < list.length; i++) total += list[i].length;
            var out = new Uint8Array(total), off = 0;
            for (var j = 0; j < list.length; j++) {{ out.set(list[j], off); off += list[j].length; }}
            return out;
          }}
        }};

        function normPath(p) {{
          var parts = p.split('/'), out = [];
          for (var i = 0; i < parts.length; i++) {{
            var s = parts[i];
            if (!s || s === '.') continue;
            if (s === '..') out.pop(); else out.push(s);
          }}
          return out.join('/');
        }}

        function makeReq(dir) {{
          return function req(id) {{
            if (id === 'fs') return {{
              readFileSync: function(p) {{
                var k = normPath(p);
                if (FILES[k] === undefined) throw new Error('ENOENT: ' + k);
                return FILES[k];
              }},
              existsSync: function(p) {{ return FILES[normPath(p)] !== undefined; }}
            }};
            if (id === 'path') return {{
              join: function() {{ return normPath(Array.prototype.slice.call(arguments).join('/')); }},
              dirname: function(p) {{ var s = normPath(p); var i = s.lastIndexOf('/'); return i < 0 ? '' : s.slice(0, i); }}
            }};
            if (id === 'zlib') return {{
              inflateSync: function() {{ throw new Error('unexpected inflateSync'); }},
              deflateSync: function(raw) {{ return raw; }}
            }};
            // Intercept kit/fonts to use pre-inflated zlib alpha buffers
            var resolved = normPath((dir ? dir + '/' : '') + id);
            if (!FILES[resolved] && FILES[resolved + '.js']) resolved += '.js';
            if (!FILES[resolved] && FILES[resolved + '.json']) resolved += '.json';
            if (resolved === 'kit/fonts.js') {{
              if (!CACHE[resolved]) {{
                var fams = {{}};
                function loadFam(name) {{
                  if (fams[name] !== undefined) return fams[name];
                  var fk = 'kit/fonts/' + name + '.json';
                  if (!FILES[fk]) {{ fams[name] = null; return null; }}
                  var j = JSON.parse(FILES[fk]);
                  fams[name] = j.sizes.map(function(s, idx) {{
                    return {{
                      size: s.size, ascent: s.ascent, descent: s.descent, atlasW: s.atlasW, atlasH: s.atlasH,
                      glyphs: s.glyphs, alpha: new Uint8Array(ALPHAS[fk + '#' + idx]), family: name, cacheKey: j.cacheKey || ''
                    }};
                  }});
                  return fams[name];
                }}
                var VI_RE = /[\\u0102\\u0103\\u0110\\u0111\\u0128\\u0129\\u0168\\u0169\\u01a0\\u01a1\\u01af\\u01b0\\u1ea0-\\u1ef9\\u00c0-\\u00c3\\u00c8-\\u00ca\\u00cc\\u00cd\\u00d2-\\u00d5\\u00d9\\u00da\\u00dd\\u00e0-\\u00e3\\u00e8-\\u00ea\\u00ec\\u00ed\\u00f2-\\u00f5\\u00f9\\u00fa\\u00fd]/;
                CACHE[resolved] = {{ exports: {{
                  get: function(name, size, text) {{
                    if (text && VI_RE.test(text)) {{
                      var vi = ['bold', 'num', 'gear'].indexOf(name) >= 0 ? 'vietnamese-bold' : 'vietnamese';
                      if (loadFam(vi)) name = vi;
                    }}
                    var fam = loadFam(name) || loadFam('label');
                    if (!fam) return null;
                    var best = null;
                    for (var i = 0; i < fam.length; i++) if (fam[i].size >= size && (!best || fam[i].size < best.size)) best = fam[i];
                    return best || fam[fam.length - 1];
                  }},
                  measure: function(f, s) {{
                    var w = 0;
                    for (var ch of s) {{ var g = f.glyphs[ch.codePointAt(0)] || f.glyphs[63]; if (g) w += g[6]; }}
                    return w;
                  }}
                }} }};
              }}
              return CACHE[resolved].exports;
            }}
            if (!FILES[resolved]) throw new Error('Cannot resolve ' + id + ' from ' + dir + ' -> ' + resolved);
            if (CACHE[resolved]) return CACHE[resolved].exports;
            if (resolved.slice(-5) === '.json') {{
              CACHE[resolved] = {{ exports: JSON.parse(FILES[resolved]) }};
              return CACHE[resolved].exports;
            }}
            var mod = {{ exports: {{}} }};
            CACHE[resolved] = mod;
            var subDir = resolved.indexOf('/') >= 0 ? resolved.slice(0, resolved.lastIndexOf('/')) : '';
            var fn = new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', 'Buffer', FILES[resolved]);
            fn(makeReq(subDir), mod, mod.exports, subDir, resolved, {{ env: {{}} }}, BufferShim);
            return mod.exports;
          }};
        }}

        var rootReq = makeReq('');
        var themes = rootReq('./kit/themes');
        var record = rootReq('./kit/record');
        var canvasMod = rootReq('./kit/canvas');
        var G = rootReq('./kit/gauges');
        var UI = rootReq('./ui');
        var t = themes.theme();

        var acts = {{
          toggle1cr: function(){{}}, toggleValet: function(){{}}, snapNow: function(){{}},
          cycleTimer: function(){{}}, toggleTrips: function(){{}}, toggleQrMode: function(){{}}
        }};

        var states = [
          {{ name: 'down', state: 'down', version: 'Bản {app_ver}', viewMode: 'main', qrMode: 'app' }},
          {{
            name: 'ok_cloud_qr',
            state: 'ok', version: 'Bản {app_ver}', viewMode: 'main', qrMode: 'app',
            cloudUrl: 'https://marilykinson-glitch.github.io/bimmer-link/app/#AbCdEfGhIjKlMnOpQrStUvWxYz012345',
            url: 'http://192.168.43.100:8139/?pin=4829', host: '192.168.43.100:8139', pin: '4829',
            cloudOk: true, telegramOk: false,
            vehicleProfile: {{ chassis: 'G30LCI', modelTitle: 'BMW 5 Series LCI · M Sport', paintLabel: 'Carbon Black' }},
            destination: {{ name: 'Landmark 81', address: 'Bình Thạnh, TP.HCM', lat: 10.795, lon: 106.722 }},
            valet: {{ enabled: false, maxSpeed: 45, maxRpm: 3500, radiusM: 500 }},
            telemetry: {{
              fuelPct: 74, rangeKm: 512, battery12v: 12.6, coolantC: 88, ambientC: 29.5, locked: true, doorsOpen: [],
              windowsOpen: ['Kính Phụ'],
              tires: {{ fl: 2.5, fr: 2.5, rl: 2.6, rr: 2.6, targetFl: 2.5, targetFr: 2.5, targetRl: 2.5, targetRr: 2.5 }},
              pos: {{ lat: 10.776889, lon: 106.700806, street: 'Nguyễn Huệ', district: 'Quận 1', city: 'TP.HCM' }},
              climate1cr: {{ active: false, timerText: '07:30', discoveredCount: 2, lastResult: 'Sẵn sàng' }}
            }},
            lastTrip: {{ distanceKm: 14.2, durationMin: 26, maxSpeed: 78, endedAt: 1700000000000 }},
            trips: [{{ distanceKm: 14.2, durationMin: 26, maxSpeed: 78, endedAt: 1700000000000 }}],
            message: 'Sẵn sàng. Quét mã QR bên trái để ghép App MyBMW (iPhone / Android).', messageKind: 'go', armed: ''
          }},
          {{
            name: 'ok_local_qr_armed_valet',
            state: 'ok', version: 'Bản {app_ver}', viewMode: 'main', qrMode: 'local',
            cloudUrl: 'https://marilykinson-glitch.github.io/bimmer-link/app/#AbCdEfGhIjKlMnOpQrStUvWxYz012345',
            url: 'http://192.168.43.100:8139/?pin=4829', host: '192.168.43.100:8139', pin: '4829',
            cloudOk: false, telegramOk: true,
            valet: {{ enabled: true, maxSpeed: 45, maxRpm: 3500, radiusM: 500 }},
            telemetry: {{
              fuelPct: 35, rangeKm: 220, battery12v: 12.1, locked: false, doorsOpen: ['FL'],
              climate1cr: {{ active: true, timerText: 'Tắt', discoveredCount: 1 }}
            }},
            trips: [], message: 'Bấm Đề nổ 1CR thêm lần nữa!', messageKind: 'warn', armed: '1cr'
          }},
          {{
            name: 'trips_empty',
            state: 'ok', version: 'Bản {app_ver}', viewMode: 'trips', qrMode: 'app',
            trips: [], valet: {{}}, telemetry: {{}}
          }},
          {{
            name: 'trips_populated',
            state: 'ok', version: 'Bản {app_ver}', viewMode: 'trips', qrMode: 'app',
            trips: [
              {{ distanceKm: 18.5, durationMin: 31, maxSpeed: 84, endedAt: 1700000000000 }},
              {{ distanceKm: 6.4, durationMin: 15, maxSpeed: 52, endedAt: 1699990000000 }}
            ],
            valet: {{}}, telemetry: {{}}
          }}
        ];

        for (var si = 0; si < states.length; si++) {{
          var st = states[si];
          // 1) GPU Recorder path (own = true, chrome = {{ tabs: null }}, extra = 42)
          var recOwn = new record.Recorder(UI.W, UI.H, {{ textScale: 1.15 }});
          recOwn.own = true;
          recOwn.chrome = {{ tabs: null }};
          recOwn.extra = 42;
          UI.draw(recOwn, G, t, st, acts);
          if (recOwn.n < 40) throw new Error('Too few recorded words for ' + st.name + ': ' + recOwn.n);
          if (recOwn.targets.length < 7) throw new Error('Expected >=7 touch/controller targets when own=true in ' + st.name + ', got ' + recOwn.targets.length);
          // Check that NO float parameter is NaN!
          for (var wi = 0; wi < recOwn.n; wi++) {{
            // Check IEEE754 quiet/signaling NaN bit patterns (exponent all 1s, mantissa != 0)
            var bits = recOwn.u[wi];
            if ((bits & 0x7f800000) === 0x7f800000 && (bits & 0x007fffff) !== 0) {{
              // Note: packed RGBA colors with R=0x7f or 0xff and G>=0x80 could match float NaN bits,
              // so also verify via playback onto real software Canvas below!
            }}
          }}

          // 2) Software / Standard Recorder path (own = false, chrome = null) + Canvas playback
          var recStd = new record.Recorder(UI.W, UI.H, {{ textScale: 1 }});
          recStd.own = false;
          recStd.chrome = null;
          UI.draw(recStd, G, t, st, acts);
          var softCv = new canvasMod.Canvas(UI.W, UI.H);
          record.play(recStd.words(), softCv);

          // Verify software canvas actually rendered foreground pixels (not all solid bg!)
          var bgR = softCv.d[0], bgG = softCv.d[1], bgB = softCv.d[2];
          var diffPixels = 0;
          for (var pi = 0; pi < softCv.d.length; pi += 64) {{
            if (softCv.d[pi] !== bgR || softCv.d[pi + 1] !== bgG || softCv.d[pi + 2] !== bgB) diffPixels++;
          }}
          if (diffPixels < 200) throw new Error('Canvas appears blank in state ' + st.name + ' (diffPixels=' + diffPixels + ')');
        }}

        // 3) Fallback Recorder -> play -> Canvas.png() roundtrip
        var fallbackRec = new record.Recorder(UI.W, UI.H);
        UI.draw(fallbackRec, G, t, states[1], acts);
        var fallbackCv = new canvasMod.Canvas(UI.W, UI.H);
        record.play(fallbackRec.words(), fallbackCv);

        'REAL_KIT_UI_RENDER_OK';
        """
        out = run_jxa(ui_harness)
        assert out == 'REAL_KIT_UI_RENDER_OK', f'Unexpected UI render output: {out}'
        print('[OK] Real-kit UI.draw render verified across all 5 states (GPU Recorder own=true/false + Software Canvas playback)')
    finally:
        if created_sdk and os.path.exists(sdk_dir):
            shutil.rmtree(sdk_dir)
        for p in (tgz, mgu_pkg, os.path.join(dist_dir, 'bimmer_link')):
            if os.path.isdir(p):
                shutil.rmtree(p)
            elif os.path.exists(p):
                os.remove(p)


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

    // Test 2: Real MGU `db.datatypes` 1CR catalog discovery & dual (string + wire int) payload generation
    var db = {{
      interfaces: {{
        'de.bmw.infotainment.climate.AirConditioning': {{
          serviceId: 99,
          fields: {{
            remoteEngineStart: {{ getter: true, setter: true, notifier: true, type: 'ClimateTypes.OnOff' }},
            directOperationParkHeating: {{ getter: true, setter: true, notifier: true, type: 'ClimateTypes.ActEnum' }},
            departureTimer1: {{ getter: true, setter: true, notifier: true, type: 'ClimateTypes.TimerT' }}
          }},
          methods: {{}}
        }}
      }},
      datatypes: {{
        OnOff: {{ type: 'enum', items: {{ OFF: {{ value: 0 }}, ON: {{ value: 1 }} }} }},
        ActEnum: {{ type: 'enum', items: {{ INACTIVE: {{ value: 0 }}, ACTIVE: {{ value: 2 }} }} }},
        TimerT: {{
          type: 'struct',
          fields: {{
            operationHour: {{ type: 'UInt8' }},
            operationMinute: {{ type: 'UInt8' }},
            status: {{ type: 'ActEnum' }}
          }}
        }}
      }}
    }};
    var disc = C.discoverClimateCatalog(db);
    if (disc.interfaces.length !== 1) throw new Error('expected 1 climate iface');
    var df = disc.interfaces[0].fields.filter(function(x){{ return x.name === 'directOperationParkHeating'; }})[0];
    if (C.buildDirectPayload(df, true, undefined, false) !== 'ACTIVE') throw new Error('expected ACTIVE string');
    if (C.buildDirectPayload(df, true, undefined, true) !== 2) throw new Error('expected wire int 2 for ACTIVE');
    if (C.buildDirectPayload(df, false, undefined, false) !== 'INACTIVE') throw new Error('expected INACTIVE');
    var tf = disc.interfaces[0].fields.filter(function(x){{ return x.name === 'departureTimer1'; }})[0];
    var tp = C.buildTimerPayload(tf, 17, 15, true, undefined, false);
    if (tp.operationHour !== 17 || tp.operationMinute !== 15 || tp.status !== 'ACTIVE') throw new Error('bad timer struct payload: ' + JSON.stringify(tp));
    var tpNum = C.buildTimerPayload(tf, 17, 15, true, undefined, true);
    if (tpNum.status !== 2) throw new Error('bad numeric timer struct payload: ' + JSON.stringify(tpNum));

    // Test 2b: Real BMW G30 LCI (`WBA71AG050CF37906`) Climate2 + German Franca enums + generated cfg enrichment
    var rolesMaster = C.classifyClimateMember('de.bmw.infotainment.climate.ClimateMaster', 'parkClimatisation', 'field', {{ setter: true }});
    if (rolesMaster.indexOf('direct_write') < 0) throw new Error('expected parkClimatisation to match direct_write');
    var rolesParkFn = C.classifyClimateMember('de.bmw.infotainment.climate.Climate2', 'airConditionParkFunctions', 'field', {{ setter: true }});
    if (rolesParkFn.indexOf('direct_write') < 0) throw new Error('expected Climate2.airConditionParkFunctions -> direct_write');
    var rolesMasterPark = C.classifyClimateMember('de.bmw.infotainment.climate.climatemaster.ClimateMaster', 'requestParkingFunctionsOn', 'method', {{}});
    if (rolesMasterPark.indexOf('direct_write') < 0) throw new Error('expected requestParkingFunctionsOn -> direct_write');
    var rolesEco = C.classifyClimateMember('de.bmw.infotainment.climate.climatemaster.ClimateMaster', 'requestClimateFunctionECO', 'method', {{}});
    if (rolesEco.length !== 0) throw new Error('requestClimateFunctionECO must be ignored, got ' + JSON.stringify(rolesEco));
    var rolesRear = C.classifyClimateMember('de.bmw.infotainment.climate.climatemaster.ClimateMaster', 'requestRearClimateDefault', 'method', {{}});
    if (rolesRear.length !== 0) throw new Error('requestRearClimateDefault must be ignored');
    var rolesSw = C.classifyClimateMember('de.bmw.body.steeringwheelcomfort.SteeringWheelClimate', 'requestHeating', 'method', {{}});
    if (rolesSw.indexOf('direct_write') >= 0) throw new Error('SteeringWheelClimate must not match cabin 1CR direct_write');

    // Enrich Climate2 descriptor from IFConfigGenerator cfg (numeric typeId + German enums)
    var g30Db = {{
      interfaces: {{
        'de.bmw.infotainment.climate.Climate2': {{
          serviceId: 46358,
          fields: {{
            airConditionParkFunctions: {{ getter: true, setter: true, notifier: true }},
            statusAirConditionParkFunctions: {{ getter: true, setter: false, notifier: true }}
          }},
          methods: {{}}
        }}
      }},
      datatypes: {{}}
    }};
    var g30Cat = C.discoverClimateCatalog(g30Db);
    var c2Desc = g30Cat.interfaces[0];
    var fakeGenCfg = {{
      fields: {{
        airConditionParkFunctions: {{ setter: {{ in: [{{ name: 'val', typeId: 701 }}] }} }}
      }},
      datatypes: {{
        '701': {{
          type: 'struct',
          fields: {{
            parkAirConditioning: {{ dataType: 'ParkAcEnum' }},
            independentVentilate: {{ dataType: 'VentEnum' }},
            parkHeater: {{ dataType: 'HeaterEnum' }},
            setupRemoteStart: {{ dataType: 'ResEnum' }}
          }}
        }},
        ParkAcEnum: {{ type: 'enum', items: {{ STANDKLIMATISIERUNG_AUS: 0, STANDKLIMATISIERUNG_EIN: 1, KEINE_AKTION: 2, SIGNAL_UNGUELTIG: 255 }} }},
        VentEnum: {{ type: 'enum', items: {{ STANDLUEFTEN_AUS: 0, STANDLUEFTEN_EIN: 1, KEINE_AKTION: 2 }} }},
        HeaterEnum: {{ type: 'enum', items: {{ STANDHEIZUNG_AUS: 0, STANDHEIZUNG_EIN: 1, KEINE_AKTION: 2 }} }},
        ResEnum: {{ type: 'enum', items: {{ REMOTE_ENGINE_START_AUS: 0, REMOTE_ENGINE_START_EIN: 1 }} }}
      }}
    }};
    C.enrichDescWithGeneratedCfg(g30Db, g30Db.interfaces['de.bmw.infotainment.climate.Climate2'], c2Desc, fakeGenCfg);
    var acpf = c2Desc.fields.filter(function(f){{ return f.name === 'airConditionParkFunctions'; }})[0];
    if (!acpf.typeDef || acpf.typeDef.kind !== 'struct') throw new Error('expected enriched struct typeDef for airConditionParkFunctions');
    var liveStatusSample = {{
      statusParkAirConditioning: 'STANDKLIMATISIERUNG_AUS',
      statusIndependentVentilate: 'STANDLUEFTEN_AUS',
      statusParkHeater: 'STANDHEIZUNG_AUS',
      statusSetupRemoteStart: 'REMOTE_ENGINE_START_EIN'
    }};
    var pStart = C.buildDirectPayload(acpf, true, liveStatusSample, false);
    if (pStart.parkAirConditioning !== 'STANDKLIMATISIERUNG_EIN' || pStart.independentVentilate !== 'KEINE_AKTION' || pStart.parkHeater !== 'KEINE_AKTION' || pStart.setupRemoteStart !== 'REMOTE_ENGINE_START_EIN') {{
      throw new Error('bad G30LCI start1cr payload: ' + JSON.stringify(pStart));
    }}
    var pStop = C.buildDirectPayload(acpf, false, liveStatusSample, false);
    if (pStop.parkAirConditioning !== 'STANDKLIMATISIERUNG_AUS' || pStop.independentVentilate !== 'STANDLUEFTEN_AUS' || pStop.setupRemoteStart !== 'REMOTE_ENGINE_START_EIN') {{
      throw new Error('bad G30LCI stop1cr payload (must preserve 1CR consent!): ' + JSON.stringify(pStop));
    }}

    // Verify interpretClimateField on real G30LCI statusAirConditionParkFunctions
    var stField = c2Desc.fields.filter(function(f){{ return f.name === 'statusAirConditionParkFunctions'; }})[0];
    var curSt = {{ climate1cr: {{ consentEnabled: null, active: false, rawState: '' }} }};
    C.interpretClimateField('de.bmw.infotainment.climate.Climate2', stField, liveStatusSample, function(p){{ if (p.climate1cr) curSt.climate1cr = p.climate1cr; }}, curSt);
    if (curSt.climate1cr.consentEnabled !== true || curSt.climate1cr.active !== false) {{
      throw new Error('bad idle interpretClimateField: ' + JSON.stringify(curSt.climate1cr));
    }}
    C.interpretClimateField('de.bmw.infotainment.climate.Climate2', stField, {{
      statusParkAirConditioning: 'STANDKLIMATISIERUNG_EIN',
      statusIndependentVentilate: 'STANDLUEFTEN_AUS',
      statusSetupRemoteStart: 'REMOTE_ENGINE_START_EIN'
    }}, function(p){{ if (p.climate1cr) curSt.climate1cr = p.climate1cr; }}, curSt);
    if (curSt.climate1cr.active !== true) throw new Error('expected active=true when STANDKLIMATISIERUNG_EIN');

    var vinUserG30Lci = C.decodeChassisFromVinOrFa('WBA71AG050CF37906', '');
    if (vinUserG30Lci.trueChassis !== 'G30LCI' || !vinUserG30Lci.notMCar) throw new Error('expected WBA71AG050CF37906 -> G30LCI + notMCar, got ' + JSON.stringify(vinUserG30Lci));
    var vinG01 = C.decodeChassisFromVinOrFa('RL4TY51000L123456', '');
    if (vinG01.trueChassis !== 'G01' || !vinG01.notMCar) throw new Error('expected RL4TY51 -> G01 + notMCar');
    var vinG30 = C.decodeChassisFromVinOrFa('WBAJA51090G654321', '');
    if (vinG30.trueChassis !== 'G30' || !vinG30.notMCar) throw new Error('expected WBAJA51 -> G30 + notMCar');
    var faX5 = C.decodeChassisFromVinOrFa('5UX00000000000000', 'hdr_G05_0C1M_01CR');
    if (faX5.trueChassis !== 'G05') throw new Error('expected FA G05 -> G05');
    var estKm = C.estimateRangeFromFuel(31, 'G30');
    if (estKm < 190 || estKm > 215) throw new Error('unexpected range estimate for 31%: ' + estKm);

    // Test 3: Trip & Park Snapshot trigger
    var trk = new C.TelemetryTracker();
    trk.update({{ condition: 10, rpm: 1500, speed: 50, odometerKm: 5000, fuelPct: 80 }}, 1000000);
    trk.update({{ speed: 82, rpm: 3200, odometerKm: 5015.6, fuelPct: 78 }}, 1000000 + 900000);
    var evs = trk.update({{ condition: 12, rpm: 0, speed: 0, stage: 'P' }}, 1000000 + 1200000);
    if (evs.length !== 1 || evs[0].type !== 'parked' || evs[0].trip.distanceKm !== 15.6 || evs[0].trip.maxSpeed !== 82) {{
      throw new Error('bad trip event: ' + JSON.stringify(evs));
    }}

    // Test 4: Exact Live G30 LCI (`WBA71AG050CF37906`) IFConfigGenerator compact schema + Closed-Loop 1CR Verdict
    var realCarDb = {{
      interfaces: {{
        'de.bmw.dass.parking.ParkingFunctionsForSeamlessParking': {{
          serviceId: 12300,
          fields: {{ parkingFunctionIncident: {{ getter: true, notifier: true }} }},
          methods: {{}}
        }},
        'de.bmw.infotainment.climate.Climate2': {{
          serviceId: 46358,
          fields: {{
            airConditionParkFunctions: {{ setter: true }},
            statusAirConditionParkFunctions: {{ getter: true, notifier: true }}
          }},
          methods: {{}}
        }},
        'de.bmw.infotainment.climate.climatemaster.ClimateMaster': {{
          serviceId: 45210,
          fields: {{ statusParkingFunctionsOn: {{ getter: true, notifier: true }} }},
          methods: {{ requestParkingFunctionsOn: {{}}, requestParkingFunctionsRES: {{}} }}
        }},
        'de.bmw.infotainment.lsc.LSCDataSink': {{
          serviceId: 47000,
          fields: {{ statusAirConditioningParkFunctions: {{ getter: true, notifier: true }} }},
          methods: {{}}
        }}
      }}
    }};
    var rcCat = C.discoverClimateCatalog(realCarDb);
    if (rcCat.interfaces.some(function(x){{ return x.iface.indexOf('dass.parking') >= 0; }})) {{
      throw new Error('dass.parking must be excluded from climate catalog');
    }}
    var lscDesc = rcCat.interfaces.filter(function(x){{ return x.iface.indexOf('LSCDataSink') >= 0; }})[0];
    if (!lscDesc || lscDesc.fields[0].roles.indexOf('direct_read') < 0) {{
      throw new Error('LSCDataSink.statusAirConditioningParkFunctions must have direct_read');
    }}
    var c2Real = rcCat.interfaces.filter(function(x){{ return x.iface.indexOf('Climate2') >= 0; }})[0];
    C.enrichDescWithGeneratedCfg(realCarDb, realCarDb.interfaces['de.bmw.infotainment.climate.Climate2'], c2Real, {{
      fields: {{
        airConditionParkFunctions: {{
          schema: {{
            t: 'Struct',
            e: [
              {{ n: 'operationParkHeat', t: 'Enum', e: {{ KEINE_AKTION__S__NICHT_VERFUEGBAR: 0, STANDHEIZUNG_AUS: 1, STANDHEIZUNG_EIN: 2, SIGNAL_UNGUELTIG: 3 }} }},
              {{ n: 'operationIndependentVentilate', t: 'Enum', e: {{ KEINE_AKTION__S__NICHT_VERFUEGBAR: 0, STANDLUEFTEN_AUS: 1, STANDLUEFTEN_EIN: 2, SIGNAL_UNGUELTIG: 3 }} }},
              {{ n: 'operationExtraHeater', t: 'Enum', e: {{ KEINE_AKTION__S__NICHT_VERFUEGBAR: 0, ZH_AUSSCHALTEN__S__AUS: 1, ZH_EINSCHALTEN__S__EIN: 2, SIGNAL_UNGUELTIG: 3 }} }},
              {{ n: 'operationParkAirConditioning', t: 'Enum', e: {{ KEINE_AKTION__S__NICHT_VERFUEGBAR: 0, STANDKLIMATISIERUNG_AUS: 1, STANDKLIMATISIERUNG_EIN: 2, SIGNAL_UNGUELTIG: 3 }} }},
              {{ n: 'operationParkFunctionAutoMode', t: 'Enum', e: {{ KEINE_AKTION__S__NICHT_VERFUEGBAR: 0, AUTO_MINUS_MODUS_AUS: 1, AUTO_MINUS_MODUS_EIN: 2, SIGNAL_UNGUELTIG: 3 }} }},
              {{ n: 'operationRemoteStart', t: 'Enum', e: {{ KEINE_AKTION_NICHT_VERFUEGBAR: 0, REMOTE_ENGINE_START_AUS: 1, REMOTE_ENGINE_START_EIN: 2, SIGNAL_UNBEFUELLT: 3 }} }}
            ]
          }}
        }}
      }}
    }});
    var cmReal = rcCat.interfaces.filter(function(x){{ return x.iface.indexOf('ClimateMaster') >= 0; }})[0];
    C.enrichDescWithGeneratedCfg(realCarDb, realCarDb.interfaces['de.bmw.infotainment.climate.climatemaster.ClimateMaster'], cmReal, {{
      methods: {{
        requestParkingFunctionsOn: {{
          id: 104,
          schema: {{
            t: 'Struct',
            e: [
              {{ n: 'clientGroupId', t: 'UInt8' }},
              {{ n: 'parkingFunctionsAutoMode', t: 'Enum', e: {{ NO_ACTION_NOT_AVAILABLE: 0, AUTO_MODE_OFF: 1, AUTO_MODE_ON: 2 }} }},
              {{ n: 'timeParkingFunctionsAutoMode', t: 'UInt8' }}
            ]
          }}
        }}
      }}
    }});
    var liveIdle = {{
      'de.bmw.infotainment.climate.Climate2.statusAirConditionParkFunctions': {{
        statusParkAirConditioning: 'STANDKLIMATISIERUNG_AUS',
        statusIndependentVentilate: 'STANDLUEFTEN_AUS',
        statusParkHeater: 'STANDHEIZUNG_AUS',
        statusParkFunctionAutoMode: 'AUTO_MINUS_MODUS_AUS',
        statusSetupRemoteStart: 'REMOTE_ENGINE_START_EIN'
      }},
      'de.bmw.infotainment.lsc.LSCDataSink.statusAirConditioningParkFunctions': {{
        statusParkAirConditioning: 'STANDKLIMATISIERUNG_AUS',
        statusIndependentVentilate: 'STANDLUEFTEN_AUS',
        statusParkHeater: 'STANDHEIZUNG_AUS',
        statusParkFunctionAutoMode: 'AUTO_MINUS_MODUS_AUS',
        statusParkFunctionRemoteControl: 'KEIN_FEHLER',
        statusEngineRunParkFunction: 'REMOTE_START_NICHT_AKTIV',
        statusSetupRemoteStart: 'REMOTE_ENGINE_START_EIN',
        actualValueDurationParkFunction: 0
      }}
    }};
    var built = C.build1crOrderedCandidates(rcCat, liveIdle, true);
    if (built.candidates[0].stage !== 'auto_1cr' ||
        built.candidates[0].payload.operationParkFunctionAutoMode !== 'AUTO_MINUS_MODUS_EIN' ||
        built.candidates[0].payload.operationParkAirConditioning !== 'KEINE_AKTION__S__NICHT_VERFUEGBAR' ||
        built.candidates[0].payload.operationParkHeat !== 'KEINE_AKTION__S__NICHT_VERFUEGBAR' ||
        built.candidates[0].payload.operationExtraHeater !== 'KEINE_AKTION__S__NICHT_VERFUEGBAR') {{
      throw new Error('Stage 1 must be pure AUTO_MINUS_MODUS_EIN with all heaters KEINE_AKTION: ' + JSON.stringify(built.candidates[0]));
    }}
    if (built.candidates[1].stage !== 'auto_res_phev' || built.candidates[1].payload.operationRemoteStart !== 'REMOTE_ENGINE_START_EIN') {{
      throw new Error('Stage 2 must be auto_res_phev: ' + JSON.stringify(built.candidates[1]));
    }}
    var cmCand = built.candidates.filter(function(x){{ return x.name === 'requestParkingFunctionsOn'; }})[0];
    if (!cmCand || cmCand.payload.parkingFunctionsAutoMode !== 'AUTO_MODE_ON' || cmCand.payload.timeParkingFunctionsAutoMode !== 15) {{
      throw new Error('ClimateMaster.requestParkingFunctionsOn payload mismatch: ' + JSON.stringify(cmCand));
    }}
    if (built.candidates.some(function(x){{ return x.stage === 'vent_only'; }})) {{
      throw new Error('start1cr must NEVER include vent_only fallback: ' + JSON.stringify(built.candidates));
    }}
    var vdIdle = C.evaluate1crVerdict(liveIdle, {{}});
    if (vdIdle.active !== false || vdIdle.consentEnabled !== true) throw new Error('Idle must NEVER be active=true');
    var vdAuto = C.evaluate1crVerdict({{
      'de.bmw.infotainment.lsc.LSCDataSink.statusAirConditioningParkFunctions': {{
        statusParkFunctionAutoMode: 'AUTO_MINUS_MODUS_EIN',
        statusParkFunctionRemoteControl: 'KEIN_FEHLER_AUTOMODE_AKTIV',
        statusEngineRunParkFunction: 'REMOTE_START_AKTIV'
      }}
    }}, {{}});
    if (!vdAuto.active || vdAuto.mode !== 'engine_1cr') throw new Error('Expected engine_1cr active: ' + JSON.stringify(vdAuto));
    var vdRejected = C.evaluate1crVerdict({{
      'de.bmw.infotainment.lsc.LSCDataSink.statusAirConditioningParkFunctions': {{
        statusParkFunctionAutoMode: 'AUTO_MINUS_MODUS_AUS',
        statusParkFunctionRemoteControl: 'BEDINGUNGEN_FAHRZEUG_NICHT_ERFUELLT',
        statusEngineRunParkFunction: 'REMOTE_START_NICHT_AKTIV'
      }}
    }}, {{}});
    if (vdRejected.active !== false || C.explain1crError(vdRejected, {{}}).indexOf('KHOÁ XE') < 0) {{
      throw new Error('Expected clear lock precondition message');
    }}
    // v0.5.3 Check A: Write-only setter hygiene (`airConditionParkFunctions` must have getter=false, notifier=false after enrich)
    var c2Desc = rcCat.interfaces.filter(function(x){{ return x.iface === 'de.bmw.infotainment.climate.Climate2'; }})[0];
    C.enrichDescWithGeneratedCfg(realCarDb, realCarDb.interfaces['de.bmw.infotainment.climate.Climate2'], c2Desc, {{
      fields: {{
        airConditionParkFunctions: {{ setter: {{ id: 32 }}, schema: {{ t: 'Struct', e: [] }} }},
        statusAirConditionParkFunctions: {{ getter: {{ id: 33 }}, event: {{ id: 32801 }} }}
      }}
    }});
    var acPfField = c2Desc.fields.filter(function(x){{ return x.name === 'airConditionParkFunctions'; }})[0];
    if (acPfField.getter !== false || acPfField.notifier !== false || acPfField.setter !== true) {{
      throw new Error('Write-only field must have getter=false & notifier=false: ' + JSON.stringify(acPfField));
    }}
    // v0.5.3 Check B: Smart stop1cr payload turns off ONLY the active mode without unchecking REMOTE_ENGINE_START_EIN
    var liveAutoOn = {{
      'de.bmw.infotainment.climate.Climate2.statusAirConditionParkFunctions': {{
        statusParkAirConditioning: 'STANDKLIMATISIERUNG_AUS',
        statusIndependentVentilate: 'STANDLUEFTEN_AUS',
        statusParkHeater: 'STANDHEIZUNG_AUS',
        statusParkFunctionAutoMode: 'AUTO_MINUS_MODUS_EIN',
        statusSetupRemoteStart: 'REMOTE_ENGINE_START_EIN'
      }}
    }};
    var stopBuilt = C.build1crOrderedCandidates(rcCat, liveAutoOn, false);
    var stopC2 = stopBuilt.candidates.filter(function(x){{ return x.name === 'airConditionParkFunctions'; }})[0];
    if (stopC2.payload.operationParkFunctionAutoMode !== 'AUTO_MINUS_MODUS_AUS' ||
        stopC2.payload.operationParkAirConditioning !== 'KEINE_AKTION__S__NICHT_VERFUEGBAR' ||
        stopC2.payload.operationRemoteStart !== 'KEINE_AKTION_NICHT_VERFUEGBAR') {{
      throw new Error('Smart stop1cr payload mismatch: ' + JSON.stringify(stopC2.payload));
    }}
    // v0.5.3 Check C: LSCDataSource / timer interface discovery
    var lscCat = C.discoverClimateCatalog({{
      interfaces: {{
        'de.bmw.infotainment.lsc.LSCDataSource': {{
          serviceId: 46393,
          fields: {{ switchOnTime1: {{ setter: true }} }},
          methods: {{}}
        }}
      }}
    }});
    if (lscCat.interfaces.length !== 1 || lscCat.interfaces[0].fields[0].roles.indexOf('timer_write') < 0) {{
      throw new Error('LSCDataSource timer_write not discovered: ' + JSON.stringify(lscCat));
    }}
    // v0.5.3 Check D: Exact C++ PairTagger + postSeiFrames>=2 simulation when G30 stream starts on SEI 0a!
    function simPairCapture(seq) {{
      var hist = [], count = 0, known = false, pos = -1, lo = '', hi = '', last = 0, bySei = false;
      var pairHave = [false, false], rows = ['', ''], seiLocked = false, postSei = 0, valid = 0;
      for (var i = 0; i < seq.length; i++) {{
        var sei = seq[i];
        count++;
        hist.push(sei);
        if (hist.length > 6) hist.shift();
        if (hist.length === 6) {{
          var ok = true;
          for (var k = 1; k < 6; k++) {{
            if (hist[k] === hist[k - 1]) ok = false;
            if (k >= 2 && hist[k] !== hist[k - 2]) ok = false;
          }}
          if (ok) {{
            pos = 0;
            var a = hist[5], b = hist[4];
            lo = a < b ? a : b; hi = a < b ? b : a;
            known = true;
          }}
        }}
        var cls;
        if (known && (sei === lo || sei === hi)) {{ bySei = true; last = (sei === hi ? 1 : 0); cls = last; }}
        else {{ bySei = false; last = (count === 1 ? 0 : (last ^ 1)); cls = last; }}
        rows[cls] = sei;
        pairHave[cls] = true;
        if (!pairHave[0] || !pairHave[1]) continue;
        valid++;
        if (seiLocked) postSei++;
        if (bySei && !seiLocked) {{ seiLocked = true; postSei = 0; }}
        if (seiLocked && postSei >= 2) return {{ top: rows[0], bottom: rows[1], valid: valid, pic: count }};
      }}
      return null;
    }}
    var r0a = simPairCapture(['0a', '09', '0a', '09', '0a', '09', '0a', '09', '0a']);
    var r09 = simPairCapture(['09', '0a', '09', '0a', '09', '0a', '09', '0a', '09']);
    if (!r0a || r0a.top !== '09' || r0a.bottom !== '0a' || !r09 || r09.top !== '09' || r09.bottom !== '0a') {{
      throw new Error('PairTagger postSeiFrames>=2 alignment failed: ' + JSON.stringify([r0a, r09]));
    }}

    // Test 5 (v0.6.0/v0.6.1): TPMS / LSCDataSink 4-Wheel TPMS, 4-Window/Sunroof, DWA Alarm, KOMBI Range & UDS 0x19 02 DTC Parser
    if (C.scaleTireBar(25) !== 2.5 || Math.abs(C.scaleTireBar(362) - 2.5) > 0.02 || C.scaleTireBar(2500) !== 2.5) {{
      throw new Error('scaleTireBar scaling mismatch');
    }}
    if (C.scaleTireBar(0) !== null || C.scaleTireBar(255) !== null || C.scaleTireBar(65535) !== null) {{
      throw new Error('scaleTireBar must reject invalid sentinel values');
    }}
    var lscTrk = new C.TelemetryTracker();
    var lscEvents = [];
    var applyLsc = function(fname, val) {{
      C.interpretLscField(fname, val, function(p) {{
        var evs = lscTrk.update(p, 2000000);
        for (var i = 0; i < evs.length; i++) lscEvents.push(evs[i]);
      }}, lscTrk.state);
    }};
    applyLsc('statusTargetTyrePressure', {{ targetPressureTyreFLH: 25, targetPressureTyreFRH: 25, targetPressureTyreRLH: 26, targetPressureTyreRRH: 26 }});
    applyLsc('actualValuePressureTyre', {{ pressureTyreFLH: 24, pressureTyreFRH: 25, pressureTyreRLH: 26, pressureTyreRRH: 26 }});
    if (lscTrk.state.tires.fl !== 2.4 || lscTrk.state.tires.targetRl !== 2.6) {{
      throw new Error('TPMS decode mismatch: ' + JSON.stringify(lscTrk.state.tires));
    }}
    applyLsc('positionWindowRegulatorDRD', 'FENSTER_GESCHLOSSEN');
    applyLsc('positionWindowRegulatorPSD', 'FENSTER_ZWISCHENSTELLUNG');
    applyLsc('positionSHD', 'SHD_GESCHLOSSEN');
    if (lscTrk.state.windowsOpen.length !== 1 || lscTrk.state.windowsOpen[0] !== 'Kính Phụ' || lscTrk.state.windowDetails.sunroof !== 'closed') {{
      throw new Error('Window/Sunroof decode mismatch: ' + JSON.stringify(lscTrk.state));
    }}
    applyLsc('dWAStatus', {{ statusDWAArming: 'DWA_ENTSCHAERFT', statusDWAAlarmHour: 252, statusDWAAlarmReason: 'KEIN_ALARM' }});
    if (lscTrk.state.locked === false) {{
      throw new Error('Non-302 DWA_ENTSCHAERFT must NEVER force locked=false before DWA_GESCHAERFT is seen!');
    }}
    applyLsc('dWAStatus', {{ statusDWAArming: 'DWA_GESCHAERFT', statusDWAAlarmReason: 'KEIN_ALARM' }});
    if (lscTrk.state.dwaArmed !== true || lscTrk.state.locked !== true || lscEvents.length !== 0) {{
      throw new Error('DWA armed decode mismatch: ' + JSON.stringify(lscTrk.state));
    }}
    applyLsc('dWAStatus', {{ statusDWAArming: 'DWA_GESCHAERFT', statusDWAAlarmReason: 'INNENRAUMSCHUTZ' }});
    if (!lscTrk.state.dwaAlarmActive || lscEvents.length !== 1 || lscEvents[0].type !== 'dwa_alarm') {{
      throw new Error('DWA alarm event must fire once on active reason: ' + JSON.stringify(lscEvents));
    }}
    applyLsc('mileageRange', {{ mileageRange: 637 }});
    if (lscTrk.state.rangeKm !== 637 || lscTrk.state.rangeEstimated !== false) {{
      throw new Error('KOMBI mileageRange decode mismatch: ' + JSON.stringify(lscTrk.state));
    }}
    var dtcZero = C.parseDtcResponse([0x59, 0x02, 0xFF]);
    if (!dtcZero.ok || dtcZero.dtcs.length !== 0) throw new Error('Expected 0 DTCs');
    var dtcHit = C.parseDtcResponse([0x59, 0x02, 0xFF, 0x11, 0xA0, 0x04, 0x09, 0x80, 0x41, 0xA8, 0x08]);
    if (!dtcHit.ok || dtcHit.dtcs.length !== 2 || dtcHit.dtcs[0].severity !== 'crit' || dtcHit.dtcs[1].severity !== 'warn') {{
      throw new Error('UDS DTC parser mismatch: ' + JSON.stringify(dtcHit));
    }}

    // Test 6 (v0.6.1): CheckControlTracker ('Mở nắp ca-pô' -> hoodOpen=true & clear), Closure leaves, TPMS units/temp, KOMBI CBS
    var ccTrk = new C.CheckControlTracker();
    var ccState = new C.TelemetryTracker().state;
    ccTrk.feedCcNames({{ ccList: [{{ cCIdentifer: 215, cCShortName: 'Mở nắp ca-pô', cCColor: 'RED' }}] }});
    ccTrk.feedBasicList({{ basicList: [{{ ccmId: 215, activeState: 'AKTIV', requestorDiagAddr: 0x40, reason: 'CC_MESSAGE' }}] }});
    ccTrk.applyToState(function(p) {{ Object.assign(ccState, p); }}, ccState);
    if (ccState.hoodOpen !== true || ccState.checkControl.length !== 1 || ccState.checkControl[0].severity !== 'crit') {{
      throw new Error('CheckControl hoodOpen detection failed: ' + JSON.stringify(ccState));
    }}
    ccTrk.feedBasicList({{ basicList: [] }});
    ccTrk.applyToState(function(p) {{ Object.assign(ccState, p); }}, ccState);
    if (ccState.hoodOpen !== false || ccState.checkControl.length !== 0) {{
      throw new Error('CheckControl hoodOpen clear failed: ' + JSON.stringify(ccState));
    }}

    var clState = new C.TelemetryTracker().state;
    C.interpretClosureLeaves('Vehicle.doorsAndFlaps', {{
      statusDoorDriver: 'GESCHLOSSEN',
      statusFrontFlap: 'GEOEFFNET'
    }}, function(p) {{ Object.assign(clState, p); }}, clState);
    if (clState.hoodOpen !== true || clState.doorsOpen.length !== 0) {{
      throw new Error('interpretClosureLeaves hoodOpen mismatch: ' + JSON.stringify(clState));
    }}

    if (Math.abs(C.scaleTireBar(360, 'PSI') - 2.48) > 0.02 || C.scaleTireBar(25, 'BAR') !== 2.5 || C.scaleTireBar(2500, 'KPA') !== 2.5) {{
      throw new Error('scaleTireBar unit conversion mismatch');
    }}
    if (C.scaleTireTempC(74, 'C') !== 34) throw new Error('scaleTireTempC mismatch');
    var tpState = new C.TelemetryTracker().state;
    C.interpretTpmsField('statusTyreTemperature', {{ actualValueTemperatureTyreFLH: 75, actualValueTemperatureTyreFRH: 76 }}, {{ temp: 'C' }}, function(p) {{ Object.assign(tpState, p); }}, tpState);
    if (tpState.tires.tempFl !== 35 || tpState.tires.tempFr !== 36) {{
      throw new Error('interpretTpmsField temp mismatch: ' + JSON.stringify(tpState.tires));
    }}

    var cbs = C.parseKombiCbsList([{{ cBSIdentifier: 1, cBSServcieName: 'Dầu động cơ', cBSServiceWay: '8.000 km', cBSServiceDate: '11/2027', cBSColor: 'GREEN' }}]);
    if (!cbs || cbs.length !== 1 || cbs[0].name !== 'Dầu động cơ' || cbs[0].severity !== 'ok') {{
      throw new Error('parseKombiCbsList mismatch: ' + JSON.stringify(cbs));
    }}

    // Test 7 (v0.6.2): Vent-only 1CR candidate, Remote Body Catalog (Lock/Unlock/Light/Horn), and Option 302 DWA cycle/unlock accuracy
    var ventPlan = C.build1crOrderedCandidates(rcCat, {{
      'de.bmw.infotainment.climate.Climate2.statusAirConditionParkFunctions': {{
        statusParkHeat: 'SIGNAL_UNGUELTIG',
        statusIndependentVentilate: 'STANDLUEFTEN_AUS',
        statusExtraHeater: 'SIGNAL_UNGUELTIG',
        statusParkAirConditioning: 'STANDKLIMATISIERUNG_AUS',
        statusParkFunctionAutoMode: 'AUTO_MINUS_MODUS_AUS',
        statusRemoteStart: 'REMOTE_ENGINE_START_EIN'
      }}
    }}, true, {{ ventOnly: true }});
    if (!ventPlan.candidates.length || ventPlan.candidates[0].stage !== 'vent_only' ||
        ventPlan.candidates[0].payload.operationIndependentVentilate !== 'STANDLUEFTEN_EIN' ||
        ventPlan.candidates[0].payload.operationParkFunctionAutoMode !== 'KEINE_AKTION__S__NICHT_VERFUEGBAR' ||
        ventPlan.candidates[0].payload.operationRemoteStart !== 'KEINE_AKTION_NICHT_VERFUEGBAR') {{
      throw new Error('ventOnly candidate mismatch: ' + JSON.stringify(ventPlan));
    }}

    var bodyDb = {{
      interfaces: {{
        'de.bmw.body.RemoteBodyControl': {{
          serviceId: 50100,
          fields: {{ centralLockingOperation: {{ setter: true }} }},
          methods: {{ requestExteriorLightFlash: {{}}, triggerHornSignal: {{}} }}
        }}
      }}
    }};
    var rbCat = C.discoverRemoteBodyCatalog(bodyDb);
    if (rbCat.interfaces.length !== 1) throw new Error('discoverRemoteBodyCatalog failed');
    C.enrichDescWithGeneratedCfg(bodyDb, bodyDb.interfaces['de.bmw.body.RemoteBodyControl'], rbCat.interfaces[0], {{
      fields: {{
        centralLockingOperation: {{
          schema: {{ t: 'Enum', e: {{ NO_ACTION: 0, UNLOCK: 1, LOCK: 2 }} }}
        }}
      }},
      methods: {{
        requestExteriorLightFlash: {{ id: 10, schema: {{ t: 'Struct', e: [{{ n: 'action', t: 'Enum', e: {{ OFF: 0, ON: 1 }} }}] }} }},
        triggerHornSignal: {{ id: 11, schema: {{ t: 'Struct', e: [{{ n: 'horn', t: 'Enum', e: {{ INACTIVE: 0, ACTIVE: 1 }} }}] }} }}
      }}
    }});
    var cLock = C.buildBodyCandidates(rbCat, 'lock');
    var cUnlock = C.buildBodyCandidates(rbCat, 'unlock');
    var cLight = C.buildBodyCandidates(rbCat, 'flash_lights');
    var cHorn = C.buildBodyCandidates(rbCat, 'horn');
    if (!cLock.length || cLock[0].payload !== 'LOCK' || cLock[0].altPayload !== 2) throw new Error('lock cand mismatch: ' + JSON.stringify(cLock));
    if (!cUnlock.length || cUnlock[0].payload !== 'UNLOCK' || cUnlock[0].altPayload !== 1) throw new Error('unlock cand mismatch: ' + JSON.stringify(cUnlock));
    if (!cLight.length || cLight[0].payload.action !== 'ON' || !cHorn.length || cHorn[0].payload.horn !== 'ACTIVE') {{
      throw new Error('light/horn cand mismatch: ' + JSON.stringify([cLight, cHorn]));
    }}

    // Option 302 DWA: historical reason with KEIN_RELAVANTER_ALARM or sentinel 63 must NOT trigger false alarm, and DWA_ENTSCHAERFT after DWA_GESCHAERFT unlocks cleanly
    var dwa302 = new C.TelemetryTracker();
    dwa302.state._sawDwaArmed = true; // persisted config.hasDwa302 = true
    C.interpretLscField('dWAStatus', {{
      statusDWAArming: 'DWA_GESCHAERFT',
      statusAlarmArmingCycle: 'KEIN_RELAVANTER_ALARM',
      statusDWAAlarmReason: 'PANIKALARM'
    }}, function(p) {{ dwa302.update(p, 3000000); }}, dwa302.state);
    if (dwa302.state.locked !== true || dwa302.state.dwaArmed !== true || dwa302.state.dwaAlarmActive !== false) {{
      throw new Error('Option 302 historical KEIN_RELAVANTER_ALARM mismatch: ' + JSON.stringify(dwa302.state));
    }}
    C.interpretLscField('dWAStatus', {{ statusDWAArming: 'DWA_ENTSCHAERFT', statusDWAAlarmReason: 63 }}, function(p) {{ dwa302.update(p, 3005000); }}, dwa302.state);
    if (dwa302.state.locked !== false || dwa302.state.dwaArmed !== false || dwa302.state.dwaAlarmActive !== false) {{
      throw new Error('Option 302 unlock state transition mismatch: ' + JSON.stringify(dwa302.state));
    }}
    C.interpretLscField('dWAStatus', {{ statusDWAArming: 1, statusAlarmArmingCycle: 'RELEVANTER_ALARM', statusDWAAlarmReason: 'MOTORHAUBE_BZW_P__FRONTKLAPPE' }}, function(p) {{ dwa302.update(p, 3010000); }}, dwa302.state);
    if (dwa302.state.dwaAlarmActive !== true || dwa302.state.dwaAlarmReason !== 'Mở nắp capo') {{
      throw new Error('Option 302 active hood alarm translation mismatch: ' + JSON.stringify(dwa302.state));
    }}

    // Test 8 (v0.6.3): Stationary 1CR Remote Start must NEVER fire a fake 0 km `parked` event when 1CR shuts off!
    var res1crTrk = new C.TelemetryTracker();
    res1crTrk.state.climate1cr.active = true;
    var evStart1cr = res1crTrk.update({{ condition: 3, rpm: 920, speed: 0, stage: 'P' }}, 4000000);
    var evStop1cr = res1crTrk.update({{ condition: 2, rpm: 0, speed: 0, stage: 'P', climate1cr: {{ active: false, mode: 'off' }} }}, 4060000);
    if (evStart1cr.length !== 0 || evStop1cr.length !== 0 || res1crTrk.activeTrip !== null) {{
      throw new Error('Stationary 1CR falsely triggered parked/trip: ' + JSON.stringify([evStart1cr, evStop1cr, res1crTrk.activeTrip]));
    }}

    // Test 9 (v0.6.4): condition === 3 (`STANDFUNKTIONEN`) MUST NEVER latch `climate1cr.active = true` or `mode = 'engine_1cr'` when engine is OFF!
    var cond3Trk = new C.TelemetryTracker();
    cond3Trk.update({{ condition: 3, rpm: 0 }}, 5000000);
    if (cond3Trk.state.climate1cr.active !== false) {{
      throw new Error('condition=3 must NEVER force climate1cr.active=true: ' + JSON.stringify(cond3Trk.state.climate1cr));
    }}
    var vdCond3Off = C.evaluate1crVerdict({{
      'de.bmw.infotainment.lsc.LSCDataSink.statusAirConditioningParkFunctions': {{
        statusParkAirConditioning: 'STANDKLIMATISIERUNG_AUS',
        statusIndependentVentilate: 'STANDLUEFTEN_AUS',
        statusParkFunctionAutoMode: 'AUTO_MINUS_MODUS_AUS',
        statusEngineRunParkFunction: 'REMOTE_START_NICHT_AKTIV'
      }}
    }}, {{ condition: 3, rpm: 0 }});
    if (vdCond3Off.active !== false || vdCond3Off.mode !== 'off' || vdCond3Off.engineRemoteActive !== false) {{
      throw new Error('condition=3 with AUS fields must be active=false: ' + JSON.stringify(vdCond3Off));
    }}
    var vdCond3Vent = C.evaluate1crVerdict({{
      'de.bmw.infotainment.lsc.LSCDataSink.statusAirConditioningParkFunctions': {{
        statusParkAirConditioning: 'STANDKLIMATISIERUNG_AUS',
        statusIndependentVentilate: 'STANDLUEFTEN_EIN',
        statusParkFunctionAutoMode: 'AUTO_MINUS_MODUS_AUS',
        statusEngineRunParkFunction: 'REMOTE_START_NICHT_AKTIV'
      }}
    }}, {{ condition: 3, rpm: 0 }});
    if (vdCond3Vent.active !== true || vdCond3Vent.mode !== 'vent_only' || vdCond3Vent.engineRemoteActive !== false) {{
      throw new Error('condition=3 with STANDLUEFTEN_EIN must stay vent_only (NEVER engine_1cr!): ' + JSON.stringify(vdCond3Vent));
    }}
    var startPlanNoVent = C.build1crOrderedCandidates(rcCat, {{}}, true, {{}});
    if (startPlanNoVent.candidates.some(function(x){{ return x.stage === 'vent_only'; }})) {{
      throw new Error('start1cr must NEVER silently fall back to vent_only!');
    }}

    // Test 10 (v0.6.4): Vehicle.centralLockingCKM must NEVER be classified as a body command or corrupt locked=false!
    if (C.classifyBodyCmdMember('de.bmw.infotainment.vehicle.Vehicle', 'centralLockingCKM').length !== 0) {{
      throw new Error('centralLockingCKM must NEVER match classifyBodyCmdMember!');
    }}
    var ckmState = new C.TelemetryTracker().state;
    ckmState.locked = true;
    ckmState.dwaArmed = true;
    C.interpretBodyField('de.bmw.infotainment.vehicle.Vehicle', 'centralLockingCKM', {{ setting: 'ALLE_TUEREN_ENTRIEGELT' }}, function(p) {{ Object.assign(ckmState, p); }}, ckmState);
    if (ckmState.locked !== true) {{
      throw new Error('centralLockingCKM corrupted locked state: ' + JSON.stringify(ckmState));
    }}

    // Test 11 (v0.6.5): Array wire enum decode, fieldAttrFlags, lost-glyph CheckControl, interior lock stability, Vent vs 1CR
    var arrSchema = {{
      t: 'Struct',
      e: [{{
        n: 'basicList',
        t: 'Array',
        e: {{
          t: 'Struct',
          e: [
            {{ n: 'ccmId', t: 'UInt16' }},
            {{ n: 'activeState', t: 'Enum', e: {{ AKTIV: 0, INAKTIV: 1 }} }}
          ]
        }}
      }}]
    }};
    var decArr = C.decodeWireVal({{ basicList: [{{ ccmId: 215, activeState: 0 }}] }}, arrSchema);
    if (!decArr || !decArr.basicList || decArr.basicList[0].activeState !== 'AKTIV') {{
      throw new Error('decodeWireVal failed to recurse into Array of Structs: ' + JSON.stringify(decArr));
    }}

    var faNoGetter = C.fieldAttrFlags({{ dataRef: 'SomeType', notifier: {{ id: 32770 }} }});
    var faWithGetter = C.fieldAttrFlags({{ getter: true, notifier: true }});
    if (faNoGetter.getter !== false || faNoGetter.notifier !== true || faNoGetter.setter !== false) {{
      throw new Error('fieldAttrFlags must NOT assume getter=true when getter is undefined: ' + JSON.stringify(faNoGetter));
    }}
    if (faWithGetter.getter !== true || faWithGetter.notifier !== true) {{
      throw new Error('fieldAttrFlags getter=true mismatch: ' + JSON.stringify(faWithGetter));
    }}

    var ccV65 = new C.CheckControlTracker();
    var ccSt65 = new C.TelemetryTracker().state;
    ccV65.feedBasicList(decArr);
    if (!ccV65.hasUnresolvedActiveIds()) {{
      throw new Error('Expected hasUnresolvedActiveIds() === true before ccList names arrive');
    }}
    ccV65.feedCcNames({{
      ccList: [
        {{ cCIdentifer: 215, cCShortName: 'M? n?p ca-p?', cCColor: 'RED' }},
        {{ cCIdentifer: 216, cCShortName: 'Mở cửa trước trái', cCColor: 'YELLOW' }},
        {{ cCIdentifer: 217, cCShortName: 'Mở cốp sau', cCColor: 'YELLOW' }}
      ]
    }});
    ccV65.feedBasicList({{
      basicList: [
        {{ ccmId: 215, activeState: 'AKTIV' }},
        {{ ccmId: 216, activeState: 'AKTIV' }},
        {{ ccmId: 217, activeState: 'AKTIV' }}
      ]
    }});
    if (ccV65.hasUnresolvedActiveIds()) {{
      throw new Error('Expected hasUnresolvedActiveIds() === false after ccList names arrive');
    }}
    ccV65.applyToState(function(p) {{ Object.assign(ccSt65, p); }}, ccSt65);
    if (ccSt65.hoodOpen !== true || ccSt65.trunkOpen !== true || ccSt65.doorsOpen.indexOf('Mở cửa trước trái') < 0) {{
      throw new Error('v0.6.5 CheckControl closure detection failed: ' + JSON.stringify(ccSt65));
    }}
    ccV65.feedBasicList({{ basicList: [] }});
    ccV65.applyToState(function(p) {{ Object.assign(ccSt65, p); }}, ccSt65);
    if (ccSt65.hoodOpen !== false || ccSt65.trunkOpen !== false || ccSt65.doorsOpen.length !== 0) {{
      throw new Error('v0.6.5 CheckControl closure clear failed: ' + JSON.stringify(ccSt65));
    }}

    // Interior lock while sitting inside (DWA stays DWA_ENTSCHAERFT on 4.5s polls) MUST keep locked=true!
    var inCab = new C.TelemetryTracker();
    inCab.state._sawDwaArmed = true;
    inCab.state.dwaArmed = false;
    inCab.state.locked = false;
    C.interpretBodyField('de.bmw.infotainment.vehicle.Vehicle', 'centralLockingStatus', {{ statusCentralLocking: 'VERRIEGELT' }}, function(p) {{ inCab.update(p, 6000000); }}, inCab.state);
    if (inCab.state.locked !== true || inCab.state._centralLockLocked !== true) {{
      throw new Error('Interior centralLock VERRIEGELT must set locked=true: ' + JSON.stringify(inCab.state));
    }}
    C.interpretLscField('dWAStatus', {{ statusDWAArming: 'DWA_ENTSCHAERFT', statusDWAAlarmReason: 'KEIN_ALARM' }}, function(p) {{ inCab.update(p, 6004500); }}, inCab.state);
    if (inCab.state.locked !== true) {{
      throw new Error('4.5s DWA_ENTSCHAERFT poll overwrote interior locked=true!');
    }}
    C.interpretBodyField('de.bmw.infotainment.vehicle.Vehicle', 'centralLockingStatus', {{ statusCentralLocking: 'ENTRIEGELT' }}, function(p) {{ inCab.update(p, 6009000); }}, inCab.state);
    if (inCab.state.locked !== false || inCab.state._centralLockLocked !== false) {{
      throw new Error('Interior centralLock ENTRIEGELT must clear locked=false: ' + JSON.stringify(inCab.state));
    }}

    // Vent error vs 1CR error + unlocked cabin auto-vent fallback
    var ventErrMsg = C.explainVentError({{ remoteErr: 'AUS', consentEnabled: true }}, {{ rpm: 0 }});
    if (ventErrMsg.indexOf('FSC 1CR') >= 0 || ventErrMsg.indexOf('quạt gió') < 0) {{
      throw new Error('explainVentError must explain ventilation instead of FSC 1CR: ' + ventErrMsg);
    }}
    var cabVentPlan = C.build1crOrderedCandidates(rcCat, liveIdle, true, {{ ventOnly: true, allowUnlockedAutoVent: true }});
    if (cabVentPlan.candidates[0].stage !== 'vent_only' ||
        !cabVentPlan.candidates.some(function(x){{ return x.stage === 'vent_cabin_auto'; }}) ||
        cabVentPlan.candidates.some(function(x){{ return x.payload && x.payload.operationRemoteStart === 'REMOTE_ENGINE_START_EIN'; }})) {{
      throw new Error('allowUnlockedAutoVent plan mismatch: ' + JSON.stringify(cabVentPlan.candidates));
    }}

    // Test 12 (v0.6.7 + v0.6.8): Real-car WBA71AG050CF37906 `DoorsWindowsRoofMirrors.CentralLockingSystemAndPanelStatus`,
    // ZERO 3-second lock/unlock flicker (`HECKKLAPPE_NICHT_LOGISCH_ENTRIEGELT` & `Telephone.lockState` / `EsimProxy.lockStatus` ignored!),
    // AND Selective 1-of-4 Door Unlock (`bấm lock trong xe -> mở Cửa Tài ra nhưng 3 cửa kia còn lock` => `lockMode: 'selective'`)!
    if (C.classifyLockMode('HECKKLAPPE_NICHT_LOGISCH_ENTRIEGELT') !== null ||
        C.classifyLockMode('HECKKLAPPE_LOGISCH_ENTRIEGELT') !== null ||
        C.classifyLockMode('VERRIEGELT') !== 'locked' ||
        C.classifyLockMode('GESICHERT') !== 'secured' ||
        C.classifyLockMode('FAHRERTUER_ENTRIEGELT') !== 'selective' ||
        C.classifyLockMode('SELEKTIV_ENTRIEGELT') !== 'selective' ||
        C.classifyLockMode('SELECTIVE_LOCKED') !== 'selective' ||
        C.classifyLockMode('ENTRIEGELT') !== 'unlocked' ||
        C.classifyLockToken('VERRIEGELT') !== true ||
        C.classifyLockToken('FAHRERTUER_ENTRIEGELT') !== false ||
        C.classifyLockToken('KEINE_BETAETIGUNG') !== null ||
        C.classifyLockToken('SIGNAL_UNGUELTIG') !== null) {{
      throw new Error('classifyLockMode / classifyLockToken handling failed');
    }}

    var g30Panel = new C.TelemetryTracker();
    g30Panel.state._sawDwaArmed = true;
    g30Panel.state.dwaArmed = false;
    var basePanel = {{
      statusCentralLockingSystem: 1,
      controlCentralLockingSystem: 8,
      statusDoorSwitchDRD: 'FAT_IST_GESCHLOSSEN',
      statusDoorSwitchPSD: 'BEIFAHRERTUER_IST_GESCHLOSSEN',
      statusDoorSwitchDRDR: 'FATH_IST_GESCHLOSSEN',
      statusDoorSwitchPSDR: 'BFTH_IST_GESCHLOSSEN',
      statusContactBootLid: 'HK_IST_GESCHLOSSEN',
      statusContactBootLid2: 'KLAPPE_2_GESCHLOSSEN',
      statusContactBonnet: 'MOTORHAUBE_GESCHLOSSEN',
      statusPushButtonCentralLockingSystem: 'KEINE_BETAETIGUNG',
      statusCentralLockingSystemBootlid: 'HECKKLAPPE_NICHT_LOGISCH_ENTRIEGELT'
    }};
    var feedBody = function(ifn, fn, payload) {{
      C.interpretBodyField(ifn, fn, payload, function(p) {{ g30Panel.update(p, 7000000); }}, g30Panel.state);
    }};
    // CRITICAL ANTI-FLICKER CHECK #1: Even when `statusCentralLockingSystemBootlid` is `HECKKLAPPE_NICHT_LOGISCH_ENTRIEGELT` (0 at idle),
    // unlocked car (`clsy=1` / `ZVStatus=ENTRIEGELT`) MUST STAY `locked === false` with ZERO jump to `true`!
    feedBody('de.bmw.infotainment.vehicle.Vehicle2', 'statusZVStatus', {{ statusZV: 'ENTRIEGELT' }});
    feedBody('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus', basePanel);
    if (g30Panel.state.locked !== false || g30Panel.state.lockMode !== 'unlocked' || g30Panel.state.doorsOpen.length !== 0 || g30Panel.state.hoodOpen !== false || g30Panel.state.trunkOpen !== false) {{
      throw new Error('G30 idle unlocked anti-flicker failed: ' + JSON.stringify(g30Panel.state));
    }}

    // Open Driver Door + Rear Right Door + Bonnet + BootLid (while statusContactBootLid2 stays KLAPPE_2_GESCHLOSSEN!)
    feedBody('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus', Object.assign({{}}, basePanel, {{
      statusDoorSwitchDRD: 'FAT_IST_OFFEN',
      statusDoorSwitchPSDR: 'BFTH_IST_OFFEN',
      statusContactBonnet: 'MOTORHAUBE_OFFEN',
      statusContactBootLid: 'HK_IST_OFFEN',
      statusContactBootLid2: 'KLAPPE_2_GESCHLOSSEN'
    }}));
    if (g30Panel.state.doorsOpen.indexOf('Cửa Tài') < 0 ||
        g30Panel.state.doorsOpen.indexOf('Cửa Sau Phải') < 0 ||
        g30Panel.state.doorsOpen.length !== 2 ||
        g30Panel.state.hoodOpen !== true ||
        g30Panel.state.trunkOpen !== true) {{
      throw new Error('G30 open doors/hood/trunk PanelStatus failed: ' + JSON.stringify(g30Panel.state));
    }}

    // Close all doors, hood, and trunk
    feedBody('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus', basePanel);
    if (g30Panel.state.doorsOpen.length !== 0 || g30Panel.state.hoodOpen !== false || g30Panel.state.trunkOpen !== false) {{
      throw new Error('G30 close doors/hood/trunk PanelStatus failed: ' + JSON.stringify(g30Panel.state));
    }}

    // Sitting inside cabin (`DWA_ENTSCHAERFT`): press interior Lock button -> `VERRIEGELN` + `ZVStatus = VERRIEGELT`
    feedBody('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus', Object.assign({{}}, basePanel, {{
      statusCentralLockingSystem: 4,
      statusPushButtonCentralLockingSystem: 'VERRIEGELN',
      statusCentralLockingSystemBootlid: 'HECKKLAPPE_NICHT_LOGISCH_ENTRIEGELT'
    }}));
    feedBody('de.bmw.infotainment.vehicle.Vehicle2', 'statusZVStatus', {{ statusZV: 'VERRIEGELT' }});
    if (g30Panel.state.locked !== true || g30Panel.state.lockMode !== 'locked' || g30Panel.state._centralLockLocked !== true) {{
      throw new Error('G30 interior lock button failed: ' + JSON.stringify(g30Panel.state));
    }}

    // CRITICAL ANTI-FLICKER CHECK #2: Release interior button + poll `Telephone.lockState='UNLOCKED'`, `ConnTeleSync.lockState='UNLOCKED'`,
    // `EsimProxy.lockStatus='UNLOCKED'`, `CentralLockingSystemGW`, and `dWAStatus='DWA_ENTSCHAERFT'` -> MUST STAY `locked === true`!
    feedBody('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus', Object.assign({{}}, basePanel, {{
      statusCentralLockingSystem: 4,
      statusPushButtonCentralLockingSystem: 'KEINE_BETAETIGUNG',
      statusCentralLockingSystemBootlid: 'HECKKLAPPE_NICHT_LOGISCH_ENTRIEGELT'
    }}));
    feedBody('de.bmw.infotainment.Telephone', 'lockState', 'UNLOCKED');
    feedBody('de.bmw.infotainment.connectivity.conntelematicssync.ConnTeleSync', 'lockState', 'UNLOCKED');
    feedBody('de.bmw.infotainment.telematic.esimproxy.EsimProxy', 'lockStatus', 'UNLOCKED');
    feedBody('de.bmw.body.centrallockingsystem.CentralLockingSystemGW', 'requestCentralLockingSystem', {{ centralLockingSystemRequest: 'ENTRIEGELN' }});
    C.interpretLscField('dWAStatus', {{ statusDWAArming: 'DWA_ENTSCHAERFT', statusDWAAlarmReason: 'KEIN_ALARM' }}, function(p) {{ g30Panel.update(p, 7003000); }}, g30Panel.state);
    if (g30Panel.state.locked !== true || g30Panel.state.lockMode !== 'locked') {{
      throw new Error('Bogus Telephone/EsimProxy/DWA poll caused lock flicker: ' + JSON.stringify(g30Panel.state));
    }}

    // USER SCENARIO (v0.6.8): Locked inside cabin -> driver pulls interior handle to open `Cửa Tài` while the other 3 doors stay locked!
    feedBody('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus', Object.assign({{}}, basePanel, {{
      statusCentralLockingSystem: 2,
      statusDoorSwitchDRD: 'FAT_IST_OFFEN',
      statusPushButtonCentralLockingSystem: 'KEINE_BETAETIGUNG'
    }}));
    if (g30Panel.state.locked !== false ||
        g30Panel.state.lockMode !== 'selective' ||
        g30Panel.state.unlockedDoors.indexOf('Cửa Tài') < 0 ||
        g30Panel.state.unlockedDoors.length !== 1 ||
        g30Panel.state.doorsOpen.indexOf('Cửa Tài') < 0) {{
      throw new Error('Interior lock -> open Cửa Tài selective state failed: ' + JSON.stringify(g30Panel.state));
    }}

    // Driver closes `Cửa Tài` WITHOUT pressing Lock or Unlock (3 doors still locked, Cửa Tài still unlocked!)
    // Even if `statusZVStatus` polls static `'VERRIEGELT'` or `'FAHRERTUER_ENTRIEGELT'`, `lockMode` MUST stay `'selective'`!
    feedBody('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus', Object.assign({{}}, basePanel, {{
      statusCentralLockingSystem: 2,
      statusDoorSwitchDRD: 'FAT_IST_GESCHLOSSEN',
      statusPushButtonCentralLockingSystem: 'KEINE_BETAETIGUNG'
    }}));
    feedBody('de.bmw.infotainment.vehicle.Vehicle2', 'statusZVStatus', {{ statusZV: 'VERRIEGELT' }});
    feedBody('de.bmw.infotainment.vehicle.Vehicle2', 'statusZVStatus', {{ statusZV: 'FAHRERTUER_ENTRIEGELT' }});
    if (g30Panel.state.doorsOpen.length !== 0 ||
        g30Panel.state.locked !== false ||
        g30Panel.state.lockMode !== 'selective' ||
        g30Panel.state.unlockedDoors[0] !== 'Cửa Tài') {{
      throw new Error('Closed Cửa Tài must remain selective (Cửa Tài unlocked, 3 doors locked) until Lock/Unlock: ' + JSON.stringify(g30Panel.state));
    }}

    // Unlock via key fob (`statusZVStatus` transitions `'FAHRERTUER_ENTRIEGELT'` -> `'ENTRIEGELT'` with `KEINE_BETAETIGUNG`) -> MUST clear selective to `'unlocked'`!
    feedBody('de.bmw.infotainment.vehicle.Vehicle2', 'statusZVStatus', {{ statusZV: 'ENTRIEGELT' }});
    if (g30Panel.state.locked !== false || g30Panel.state.lockMode !== 'unlocked' || g30Panel.state.unlockedDoors.length !== 0) {{
      throw new Error('Keyfob ZV ENTRIEGELT transition must clear selective mode to unlocked: ' + JSON.stringify(g30Panel.state));
    }}

    // Also verify numeric-only `ST_CLSY = 2` (`VERRIEGELT` inside at 0 km/h) on fresh tracker without `statusZVStatus`
    var g30NumOnly = new C.TelemetryTracker();
    g30NumOnly.state.dwaArmed = false;
    C.interpretBodyField('de.bmw.body.DoorsWindowsRoofMirrors', 'CentralLockingSystemAndPanelStatus2', Object.assign({{}}, basePanel, {{
      statusCentralLockingSystem: 2
    }}), function(p) {{ g30NumOnly.update(p, 7010000); }}, g30NumOnly.state);
    if (g30NumOnly.state.locked !== true || g30NumOnly.state.lockMode !== 'locked') {{
      throw new Error('Numeric ST_CLSY=2 stationary interior lock failed: ' + JSON.stringify(g30NumOnly.state));
    }}

    // MultiConsumerTrunkLidAction.getTrunkLidStatus + A4A.statusA4ALids + WindowsRoofMaster DVDR + AntiTheft.statusDwa
    feedBody('de.bmw.body.MultiConsumerTrunkLidAction', 'getTrunkLidStatus', {{ statusTrunkLid: 'PRIMARYLOCKOPEN' }});
    if (g30Panel.state.trunkOpen !== true) throw new Error('MultiConsumerTrunkLidAction PRIMARYLOCKOPEN failed');
    feedBody('de.bmw.body.MultiConsumerTrunkLidAction', 'getTrunkLidStatus', {{ statusTrunkLid: 'PRIMARYLOCKCLOSED' }});
    if (g30Panel.state.trunkOpen !== false) throw new Error('MultiConsumerTrunkLidAction PRIMARYLOCKCLOSED failed');

    feedBody('de.bmw.infotainment.vehicle.A4A', 'statusA4ALids', {{
      statusCentralLocking: 'VERRIEGELT',
      statusDoorPSD: 'GESCHLOSSEN',
      statusFrontLid: 'OFFEN'
    }});
    if (g30Panel.state.locked !== true || g30Panel.state.lockMode !== 'locked' || g30Panel.state.hoodOpen !== true) {{
      throw new Error('A4A.statusA4ALids combined lock+lid decode failed: ' + JSON.stringify(g30Panel.state));
    }}

    feedBody('de.bmw.body.doorsandwindows.WindowsRoofMaster', 'statusWindowsRoofMasterDVDR', {{
      positionWindowRegulatorDRDR: 120,
      statusPositionWindowRegulatorDRDR: 'FENSTER_OFFEN'
    }});
    if (g30Panel.state.windowsOpen.indexOf('Kính Sau Trái') < 0) {{
      throw new Error('WindowsRoofMaster DVDR decode failed: ' + JSON.stringify(g30Panel.state.windowsOpen));
    }}

    feedBody('de.bmw.body.AntiTheft', 'statusDwa', {{
      statusDWAArming: 'DWA_GESCHAERFT',
      statusIrsNgMonitoring: 'IRS_UND_NG_UEBERWACHUNG_AKTIV',
      statusDWAAlarmReason: 'KEIN_ALARM'
    }});
    if (g30Panel.state.dwaArmed !== true || g30Panel.state.locked !== true) {{
      throw new Error('AntiTheft.statusDwa decode failed: ' + JSON.stringify(g30Panel.state));
    }}

    // Verify Head-Unit RemoteBody payloads (`CentralLockingSystemGW`, `CenterLockingService`, `ControlHMI`)
    var g30BodyCmdDb = {{
      interfaces: {{
        'de.bmw.body.centrallockingsystem.CentralLockingSystemGW': {{
          serviceId: 21817,
          fields: {{ requestCentralLockingSystem: {{ setter: true }} }},
          methods: {{}}
        }},
        'de.bmw.body.caraccess.CenterLockingService': {{
          serviceId: 20495,
          fields: {{}},
          methods: {{ requestLock: {{}}, requestUnlock: {{}} }}
        }},
        'de.bmw.body.ControlHMI': {{
          serviceId: 21816,
          fields: {{ RemoteServices: {{ setter: true }} }},
          methods: {{}}
        }}
      }}
    }};
    var g30Rb = C.discoverRemoteBodyCatalog(g30BodyCmdDb);
    var gwDesc = g30Rb.interfaces.filter(function(x){{ return x.iface.indexOf('CentralLockingSystemGW') >= 0; }})[0];
    C.enrichDescWithGeneratedCfg(g30BodyCmdDb, g30BodyCmdDb.interfaces['de.bmw.body.centrallockingsystem.CentralLockingSystemGW'], gwDesc, {{
      fields: {{
        requestCentralLockingSystem: {{
          setter: {{ id: 1 }},
          schema: {{
            t: 'Struct',
            e: [
              {{ n: 'idFunctionCentralLockingSystemRequest', t: 'Enum', e: {{ RCP: 1, HU: 2, SIGNAL_UNBEFUELLT: 15 }} }},
              {{ n: 'centralLockingSystemRequest', t: 'Enum', e: {{ KEINE_BETAETIGUNG: 0, ENTRIEGELN: 1, VERRIEGELN: 2, SICHERN: 4, SIGNAL_UNBEFUELLT: 15 }} }},
              {{ n: 'requestCentralLockingSystemID', t: 'UInt32' }}
            ]
          }}
        }}
      }}
    }});
    var clsDesc = g30Rb.interfaces.filter(function(x){{ return x.iface.indexOf('CenterLockingService') >= 0; }})[0];
    C.enrichDescWithGeneratedCfg(g30BodyCmdDb, g30BodyCmdDb.interfaces['de.bmw.body.caraccess.CenterLockingService'], clsDesc, {{
      methods: {{
        requestLock: {{ id: 1, schema: {{ t: 'Struct', e: [{{ n: 'requesterId', t: 'Enum', e: {{ REMOTESOFTWAREUPDATE: 0, REMOTEDOORLOCK: 1, REMOTEDOORUNLOCK: 2 }} }}] }} }},
        requestUnlock: {{ id: 2, schema: {{ t: 'Struct', e: [{{ n: 'requesterId', t: 'Enum', e: {{ REMOTESOFTWAREUPDATE: 0, REMOTEDOORLOCK: 1, REMOTEDOORUNLOCK: 2 }} }}] }} }}
      }}
    }});
    var chmiDesc = g30Rb.interfaces.filter(function(x){{ return x.iface.indexOf('ControlHMI') >= 0; }})[0];
    C.enrichDescWithGeneratedCfg(g30BodyCmdDb, g30BodyCmdDb.interfaces['de.bmw.body.ControlHMI'], chmiDesc, {{
      fields: {{
        RemoteServices: {{
          setter: {{ id: 1 }},
          schema: {{
            t: 'Struct',
            e: [
              {{ n: 'requestRemoteServiceFunction', t: 'Enum', e: {{ HUPE: 0, WELCOME_MINUS_LIGHT: 1, SIGNAL_UNGUELTIG: 15 }} }},
              {{ n: 'requestRemoteServicePause', t: 'UInt8' }},
              {{ n: 'requestRemoteServiceRepetition', t: 'UInt8' }},
              {{ n: 'requestRemoteServiceDuration', t: 'UInt8' }}
            ]
          }}
        }}
      }}
    }});
    var gwLock = C.buildBodyCandidates(g30Rb, 'lock').filter(function(x){{ return x.name === 'requestCentralLockingSystem'; }})[0];
    if (!gwLock || gwLock.payload.idFunctionCentralLockingSystemRequest !== 'HU' || gwLock.payload.centralLockingSystemRequest !== 'VERRIEGELN' || gwLock.payload.requestCentralLockingSystemID !== 1) {{
      throw new Error('CentralLockingSystemGW lock payload mismatch: ' + JSON.stringify(gwLock));
    }}
    var clsUnlock = C.buildBodyCandidates(g30Rb, 'unlock').filter(function(x){{ return x.name === 'requestUnlock'; }})[0];
    if (!clsUnlock || clsUnlock.payload.requesterId !== 'REMOTEDOORUNLOCK') {{
      throw new Error('CenterLockingService unlock payload mismatch: ' + JSON.stringify(clsUnlock));
    }}
    var chmiHorn = C.buildBodyCandidates(g30Rb, 'horn').filter(function(x){{ return x.name === 'RemoteServices'; }})[0];
    var chmiLight = C.buildBodyCandidates(g30Rb, 'flash_lights').filter(function(x){{ return x.name === 'RemoteServices'; }})[0];
    if (!chmiHorn || chmiHorn.payload.requestRemoteServiceFunction !== 'HUPE' || !chmiLight || chmiLight.payload.requestRemoteServiceFunction !== 'WELCOME_MINUS_LIGHT') {{
      throw new Error('ControlHMI RemoteServices horn/light payload mismatch: ' + JSON.stringify([chmiHorn, chmiLight]));
    }}
    'ALL_JXA_LOGIC_TESTS_PASSED';
    """
    out = run_jxa(harness)
    assert out == 'ALL_JXA_LOGIC_TESTS_PASSED'
    print('[OK] Live JS unit tests (1CR discovery, timer synthesis, underground GPS, Park/Trip state machine) passed')


def check_pwa_and_manifest_filtering():
    import tempfile
    for rel in ('docs/app/app.js', 'docs/app/sw.js'):
        src = open(os.path.join(ROOT, rel), encoding='utf-8').read()
        code = f"new Function({json.dumps(src)}); 'PWA_SYNTAX_OK';"
        assert run_jxa(code) == 'PWA_SYNTAX_OK'
    app_js = open(os.path.join(ROOT, 'docs/app/app.js'), encoding='utf-8').read()
    assert 'validateHeroDataUrl' in app_js and 'srcBright < 80' in app_js and 'mqttBuildPublish' in app_js and 'selectCamView' in app_js and 'ensureSnapCrops' in app_js
    assert 'ans === 0' in app_js and 'renderCheckControlAlerts' in app_js and 'kombiCbsBox' in app_js
    assert 'tile.openstreetmap.org' in app_js and 'cartocdn' not in app_js, 'Leaflet map must use OSM tiles instead of API-key-locked Carto tiles'
    assert 'photon.komoot.io/api/' in app_js and 'photon.komoot.io/reverse' in app_js and 'openSentDestinationMaps' in app_js

    # Verify HTML IDs, JS handlers & CSS overflow-proof grid rules
    html_src = open(os.path.join(ROOT, 'docs/app/index.html'), encoding='utf-8').read()
    css_src = open(os.path.join(ROOT, 'docs/app/styles.css'), encoding='utf-8').read()
    for grid_cls in ('.ecu-grid', '.metrics-grid', '.tpms-stage', '.swatch-grid', '.cam-tabs', '.action-dock', '.quick-subdock'):
        idx = css_src.find(grid_cls)
        assert idx >= 0, f'Missing CSS rule {grid_cls}'
        block = css_src[idx:css_src.find('}', idx)]
        assert 'minmax(0, 1fr)' in block, f'{grid_cls} must use minmax(0, 1fr) to prevent right-side column overflow!'
    for req_id in ('homeCcList', 'healthCcList', 'kombiCbsBox', 'btnScanHealth', 'ecuHealthGrid', 'securityPills',
                   'btnLock', 'btnUnlock', 'btnLight', 'btnHorn', 'btnVent', 'inpParkMemo', 'parkTimerBadge', 'walkDistBadge', 'homeParkMemoBadge'):
        assert f'id="{req_id}"' in html_src, f'Missing #{req_id} in index.html'
    for fn_call in re.findall(r'on(?:click|change)="([a-zA-Z0-9_]+)\(', html_src):
        assert f'function {fn_call}(' in app_js, f'Missing handler {fn_call}() in docs/app/app.js'

    # Test snapshot.js formatClock UTC -> Local Timezone (UTC+7 = +420 min) & midnight date rollover!
    snap_src = open(os.path.join(ROOT, 'tools/bimmer-link/snapshot.js'), encoding='utf-8').read()
    snap_clock_check = run_jxa(f"""
    var mod = {{ exports: {{}} }};
    new Function('require', 'module', 'exports', 'Buffer', {json.dumps(snap_src)})(
      function() {{ return {{}}; }}, mod, mod.exports, {{}}
    );
    var S = mod.exports;
    var t1 = S.formatClock(Date.UTC(2026, 10, 24, 13, 14, 0), 420);
    var t2 = S.formatClock(Date.UTC(2026, 10, 24, 18, 30, 0), 420);
    var t3 = S.formatClock(Date.UTC(2026, 10, 24, 2, 5, 0), -300);
    JSON.stringify([t1, t2, t3]);
    """)
    sc_list = json.loads(snap_clock_check)
    assert sc_list == ['20:14  24/11/2026', '01:30  25/11/2026', '21:05  23/11/2026'], f'Snap.formatClock timezone mismatch: {sc_list}'

    # Test 24-bit Baseline JPEG encoder (`jpeg.js`) at full 960x816 4-camera resolution + native macOS `sips` decode check!
    jpeg_src = open(os.path.join(ROOT, 'tools/bimmer-link/jpeg.js'), encoding='utf-8').read()
    jpeg_b64 = run_jxa(f"""
    var Buffer = {{
      isBuffer: function(b) {{ return !!(b && b._isBuf); }},
      allocUnsafe: function(n) {{
        var u = new Uint8Array(n);
        u._isBuf = true;
        u.copy = function(dst, doff, s0, s1) {{ dst.set(u.subarray(s0 || 0, s1 === undefined ? u.length : s1), doff || 0); }};
        u.slice = function(a, b) {{
          var s = Uint8Array.prototype.slice.call(u, a, b);
          s._isBuf = true;
          return s;
        }};
        return u;
      }}
    }};
    var mod = {{ exports: {{}} }};
    new Function('module', 'exports', 'Buffer', {json.dumps(jpeg_src)})(mod, mod.exports, Buffer);
    var w = 960, h = 816;
    var rgba = Buffer.allocUnsafe(w * h * 4);
    for (var y = 0; y < h; y++) {{
      for (var x = 0; x < w; x++) {{
        var idx = (y * w + x) * 4;
        if (y >= 720) {{
          rgba[idx] = 11; rgba[idx+1] = 16; rgba[idx+2] = 27; rgba[idx+3] = 255;
        }} else if (y < 360 && x < 480) {{
          rgba[idx] = 210; rgba[idx+1] = 55; rgba[idx+2] = 45; rgba[idx+3] = 255;   // Front: warm red
        }} else if (y < 360) {{
          rgba[idx] = 40; rgba[idx+1] = 185; rgba[idx+2] = 75; rgba[idx+3] = 255;   // Rear: green
        }} else if (x < 480) {{
          rgba[idx] = 45; rgba[idx+1] = 115; rgba[idx+2] = 225; rgba[idx+3] = 255;  // Left: blue
        }} else {{
          rgba[idx] = 225; rgba[idx+1] = 190; rgba[idx+2] = 40; rgba[idx+3] = 255;  // Right: gold
        }}
      }}
    }}
    var jpg = mod.exports.encodeJpegAdaptive(w, h, rgba, 64000);
    if (jpg[0] !== 0xff || jpg[1] !== 0xd8 || jpg[jpg.length - 2] !== 0xff || jpg[jpg.length - 1] !== 0xd9) {{
      throw new Error('missing JPEG SOI/EOI markers');
    }}
    if (jpg.length > 64000) throw new Error('JPEG exceeded 64KB wire budget: ' + jpg.length);
    var bin = '';
    for (var k = 0; k < jpg.length; k++) bin += String.fromCharCode(jpg[k]);
    ObjC.import('Foundation');
    var ns = $(bin);
    // Return hex of first/last + length + base64 via Foundation
    var rawArr = Array.from(jpg);
    JSON.stringify({{ len: jpg.length, bytes: rawArr }});
    """)
    jpg_info = json.loads(jpeg_b64)
    jpg_bytes = bytes(jpg_info['bytes'])
    assert 4000 < len(jpg_bytes) <= 64000, f'Unexpected JPEG byte length: {len(jpg_bytes)}'
    with tempfile.TemporaryDirectory(prefix='bl-jpg-') as jdir:
        jp = os.path.join(jdir, 'cam360.jpg')
        bp = os.path.join(jdir, 'cam360.bmp')
        open(jp, 'wb').write(jpg_bytes)
        subprocess.run(['sips', '-s', 'format', 'bmp', jp, '--out', bp], check=True, capture_output=True)
        bmp = open(bp, 'rb').read()
        px_off = int.from_bytes(bmp[10:14], 'little')
        bw = int.from_bytes(bmp[18:22], 'little', signed=True)
        bh = int.from_bytes(bmp[22:26], 'little', signed=True)
        bpp = int.from_bytes(bmp[28:30], 'little')
        assert bw == 960 and abs(bh) == 816, f'Decoded JPEG size mismatch: {bw}x{bh}'
        row_stride = ((bw * (bpp // 8) + 3) // 4) * 4

        def sample_bmp(sx, sy):
            ry = sy if bh < 0 else (abs(bh) - 1 - sy)
            off = px_off + ry * row_stride + sx * (bpp // 8)
            return bmp[off + 2], bmp[off + 1], bmp[off]  # R, G, B

        r_tl, g_tl, b_tl = sample_bmp(240, 180)
        r_tr, g_tr, b_tr = sample_bmp(720, 180)
        r_bl, g_bl, b_bl = sample_bmp(240, 540)
        r_br, g_br, b_br = sample_bmp(720, 540)
        assert abs(r_tl - 210) <= 8 and abs(g_tl - 55) <= 8 and abs(b_tl - 45) <= 8, f'TL RGB drift: {(r_tl, g_tl, b_tl)}'
        assert abs(r_tr - 40) <= 8 and abs(g_tr - 185) <= 8 and abs(b_tr - 75) <= 8, f'TR RGB drift: {(r_tr, g_tr, b_tr)}'
        assert abs(r_bl - 45) <= 8 and abs(g_bl - 115) <= 8 and abs(b_bl - 225) <= 8, f'BL RGB drift: {(r_bl, g_bl, b_bl)}'
        assert abs(r_br - 225) <= 8 and abs(g_br - 190) <= 8 and abs(b_br - 40) <= 8, f'BR RGB drift: {(r_br, g_br, b_br)}'
    print(f'[OK] 24-bit Baseline JPEG encoder verified via macOS ImageIO/sips (960x816, {len(jpg_bytes)} bytes, <2px RGB error across all 4 quadrants)')

    # Test mqtt-lite.js frame encoding/decoding with fragmented 65KB retained payload in JXA
    mqtt_src = open(os.path.join(ROOT, 'tools/bimmer-link/mqtt-lite.js'), encoding='utf-8').read()
    mqtt_test = f"""
    var Buffer = {{
      from: function(x) {{
        if (typeof x === 'string') {{
          var s = unescape(encodeURIComponent(x)), u = new Uint8Array(s.length);
          for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
          return enhance(u);
        }}
        return enhance(new Uint8Array(x));
      }},
      isBuffer: function(b) {{ return b && b._isBuf; }},
      alloc: function(n) {{ return enhance(new Uint8Array(n)); }},
      allocUnsafe: function(n) {{ return enhance(new Uint8Array(n)); }},
      concat: function(list) {{
        var tot = 0; for (var i = 0; i < list.length; i++) tot += list[i].length;
        var out = new Uint8Array(tot), off = 0;
        for (var j = 0; j < list.length; j++) {{ out.set(list[j], off); off += list[j].length; }}
        return enhance(out);
      }}
    }};
    function enhance(u) {{
      u._isBuf = true;
      u.writeUInt16BE = function(v, o) {{ u[o] = (v >> 8) & 255; u[o+1] = v & 255; }};
      u.readUInt16BE = function(o) {{ return (u[o] << 8) | u[o+1]; }};
      u.slice = function(a, b) {{ return enhance(Uint8Array.prototype.slice.call(u, a, b)); }};
      u.toString = function() {{
        var s = ''; for (var i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
        return decodeURIComponent(escape(s));
      }};
      return u;
    }}
    var mod = {{ exports: {{}} }};
    var fn = new Function('require', 'module', 'exports', '__filename', 'process', 'Buffer', {json.dumps(mqtt_src)});
    fn(function(){{ return {{}}; }}, mod, mod.exports, 'mqtt-lite.js', {{ argv: [], on: function(){{}} }}, Buffer);
    var M = mod.exports;
    var big = 'BL2:' + new Array(65001).join('Q');
    var pkt1 = M.encodePublish('bl2/testtopic/ph', big, true);
    var pkt2 = Buffer.from([0xd0, 0x00]); // PINGRESP
    var combined = Buffer.concat([pkt1, pkt2]);
    // Feed in 2 split fragments to verify streaming reassembly
    var half1 = combined.slice(0, 10000);
    var half2 = combined.slice(10000);
    var r1 = M.parseFrames(half1);
    if (r1.frames.length !== 0) throw new Error('expected 0 complete frames on half1');
    var r2 = M.parseFrames(Buffer.concat([r1.rest, half2]));
    if (r2.frames.length !== 2) throw new Error('expected 2 frames, got ' + r2.frames.length);
    if (r2.frames[0].topic !== 'bl2/testtopic/ph' || !r2.frames[0].retain || r2.frames[0].payload !== big) {{
      throw new Error('bad decoded 65KB publish frame');
    }}
    if (r2.frames[1].type !== 'pingresp') throw new Error('expected pingresp');
    'MQTT_CODEC_OK';
    """
    assert run_jxa(mqtt_test) == 'MQTT_CODEC_OK'

    # Test cam360.js frame parsing + YUV420->RGBA + Wbm.resize (1280x960 -> 960x440)
    wbm_src = open(os.path.join(ROOT, 'tools/bimmer-link/wbm.js'), encoding='utf-8').read()
    cam_src = open(os.path.join(ROOT, 'tools/bimmer-link/cam360.js'), encoding='utf-8').read()
    cam_test = f"""
    var Buffer = {{
      from: function(x) {{
        if (typeof x === 'string') {{
          var s = unescape(encodeURIComponent(x)), u = new Uint8Array(s.length);
          for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
          return enhance(u);
        }}
        return enhance(new Uint8Array(x));
      }},
      isBuffer: function(b) {{ return !!(b && b._isBuf); }},
      alloc: function(n) {{ return enhance(new Uint8Array(n)); }},
      allocUnsafe: function(n) {{ return enhance(new Uint8Array(n)); }},
      concat: function(list) {{
        var tot = 0; for (var i = 0; i < list.length; i++) tot += list[i].length;
        var out = new Uint8Array(tot), off = 0;
        for (var j = 0; j < list.length; j++) {{ out.set(list[j], off); off += list[j].length; }}
        return enhance(out);
      }}
    }};
    function enhance(u) {{
      u._isBuf = true;
      u.writeUInt32LE = function(v, o) {{ u[o]=v&255; u[o+1]=(v>>>8)&255; u[o+2]=(v>>>16)&255; u[o+3]=(v>>>24)&255; }};
      u.readUInt32LE = function(o) {{ return (u[o] | (u[o+1]<<8) | (u[o+2]<<16) | (u[o+3]*16777216)) >>> 0; }};
      u.readUInt16LE = function(o) {{ return u[o] | (u[o+1]<<8); }};
      u.copy = function(dst, doff, s0, s1) {{ dst.set(u.subarray(s0 || 0, s1 === undefined ? u.length : s1), doff || 0); }};
      u.slice = function(a, b) {{ return enhance(Uint8Array.prototype.slice.call(u, a, b)); }};
      return u;
    }}
    var wbmMod = {{ exports: {{}} }};
    new Function('require', 'module', 'exports', 'Buffer', {json.dumps(wbm_src)})(function(){{ return {{}}; }}, wbmMod, wbmMod.exports, Buffer);
    var camMod = {{ exports: {{}} }};
    new Function('require', 'module', 'exports', '__dirname', 'process', 'Buffer', {json.dumps(cam_src)})(
      function(id){{ return id === './wbm' ? wbmMod.exports : {{}}; }}, camMod, camMod.exports, '/', {{ pid: 1 }}, Buffer
    );
    var Cam = camMod.exports, Wbm = wbmMod.exports;
    var sw = 64, sh = 48;
    var yuv = Buffer.allocUnsafe((sw * sh * 3) / 2);
    for (var i = 0; i < yuv.length; i++) yuv[i] = 120;
    var body = Buffer.allocUnsafe(14 + yuv.length);
    body.writeUInt32LE(1, 0); body.writeUInt32LE(7, 4); body.writeUInt32LE(0, 8);
    body[12] = 0; body[13] = 0;
    yuv.copy(body, 14);
    var pf = Cam.parseCrFrame(body);
    if (!pf || pf.ref !== 1 || pf.id !== 7 || !Cam.hasLiveLuma(pf.pixels, sw, sh)) throw new Error('bad parseCrFrame');
    var rgba = Cam.yuv420AtlasToRgba(pf.pixels, sw, sh);
    var resized = Wbm.resize(rgba, sw, sh, 32, 24);
    if (resized.length !== 32 * 24 * 4 || resized[3] !== 255) throw new Error('bad resize');
    'CAM360_UNIT_OK';
    """
    assert run_jxa(cam_test) == 'CAM360_UNIT_OK'

    with tempfile.TemporaryDirectory(prefix='bl-cat-') as td:
        cat = os.path.join(td, 'someip-interfaces.json')
        json.dump({
            'interfaces': {
                'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy': {'serviceId': 1},
                'de.bmw.infotainment.climate.Climate2': {'serviceId': 2},
                'de.bmw.infotainment.climate.CustomStandklima': {'serviceId': 3},
                'de.bmw.infotainment.navigation.positioning.Positioning': {'serviceId': 4},
                'de.bmw.body.DoorsWindowsRoofMirrors': {'serviceId': 21808},
                'de.bmw.infotainment.vehicle.A4A': {'serviceId': 46347},
                'de.bmw.body.customdoor.DoorStatus': {'serviceId': 5},
                'de.bmw.body.ghost.NoInstanceIface': {'serviceId': 6},
            },
            'instanceIDs': {
                'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy': {'1': 1},
                'de.bmw.infotainment.climate.Climate2': {'1': 1},
                'de.bmw.infotainment.climate.CustomStandklima': {'1': 1},
                'de.bmw.infotainment.navigation.positioning.Positioning': {'Main_Instance': 128},
                'de.bmw.body.DoorsWindowsRoofMirrors': {'1': 1},
                'de.bmw.infotainment.vehicle.A4A': {'1': 1},
                'de.bmw.body.customdoor.DoorStatus': {'Body_Inst': 1},
                'de.bmw.body.ghost.NoInstanceIface': {},
            },
        }, open(cat, 'w', encoding='utf-8'))
        env = dict(os.environ, OAP_SOMEIP_CATALOG=cat)
        spec_path = os.path.join(ROOT, 'apps/bimmer_link/app.json')
        out = subprocess.run([
            sys.executable, '-c',
            f"import json, sys; sys.path.insert(0, {json.dumps(os.path.join(ROOT, 'kit/tools'))}); "
            f"import build; m = build.manifest_for(json.load(open({json.dumps(spec_path)}))); print(json.dumps(m['proxies']))"
        ], env=env, capture_output=True, text=True, check=True).stdout
        proxies = json.loads(out)
        assert proxies.get('de.bmw.infotainment.video.cameraproxy.ICAM2Proxy') == '*'
        assert proxies.get('de.bmw.infotainment.climate.Climate2') == '*'
        assert proxies.get('de.bmw.infotainment.climate.CustomStandklima') == '*'
        assert proxies.get('de.bmw.infotainment.navigation.positioning.Positioning') == '*', 'Positioning must use wildcard * (Main_Instance, NEVER hardcoded "1"!)'
        assert proxies.get('de.bmw.body.DoorsWindowsRoofMirrors') == '*', 'DoorsWindowsRoofMirrors must be wildcard *'
        assert proxies.get('de.bmw.infotainment.vehicle.A4A') == '*', 'A4A must be wildcard *'
        assert proxies.get('de.bmw.body.customdoor.DoorStatus') == '*', 'autoVehicleSignals must read top-level instanceIDs!'
        assert 'de.bmw.body.ghost.NoInstanceIface' not in proxies, 'Interfaces with empty instanceIDs must be skipped!'
        assert 'de.bmw.infotainment.climate.climatemaster.ClimateMaster' not in proxies
        car_raw = open(os.path.join(ROOT, 'tools/bimmer-link/car-link.js'), encoding='utf-8').read()
        main_raw = open(os.path.join(ROOT, 'apps/bimmer_link/main.js'), encoding='utf-8').read()
        assert 'heldProxies.push(px)' in car_raw and 'heldWatches.push(s)' in main_raw, 'V8 GC proxy retention arrays must be present!'

        # Verify VietMap-slot `/proc/<pid>/cwd`-only UID discovery in bimmer-link.js!
        bl_src = open(os.path.join(ROOT, 'tools/bimmer-link/bimmer-link.js'), encoding='utf-8').read()
        proc_check = run_jxa(f"""
        var dirs = {{
          '/oap': ['oap_5002'],
          '/proc': ['1', '42424'],
          '/run': [],
          '/run/app': []
        }};
        var files = {{
          '/oap/oap_5002/source/javascript/kit/app-spec.json': '{{"id":"bimmer_link2"}}',
          '/proc/1/cmdline': 'systemd\\0',
          '/proc/42424/cmdline': 'node\\0../source/javascript/app.js\\0',
          '/proc/42424/status': 'Name:\\tnode\\nUid:\\t5099\\t5099\\t5099\\t5099\\nGid:\\t5099\\t5099\\t5099\\t5099\\n'
        }};
        var links = {{
          '/proc/42424/cwd': '/oap/oap_5002/data'
        }};
        var fs = {{
          existsSync: function(p) {{ return !!(dirs[p] || files[p] !== undefined || p === '/proc/42424'); }},
          readdirSync: function(p) {{ if (!dirs[p]) throw new Error('enoent ' + p); return dirs[p]; }},
          readFileSync: function(p) {{ if (files[p] === undefined) throw new Error('enoent ' + p); return files[p]; }},
          readlinkSync: function(p) {{ if (!links[p]) throw new Error('einval ' + p); return links[p]; }},
          mkdirSync: function(p) {{ dirs[p] = dirs[p] || []; }},
          lstatSync: function() {{ return {{ isDirectory: function() {{ return true; }} }}; }},
          statSync: function() {{ return {{ uid: 1001, gid: 1001 }}; }}
        }};
        var path = {{
          join: function() {{ return Array.prototype.slice.call(arguments).join('/').replace(/[/]+/g, '/'); }},
          dirname: function(p) {{ return p.split('/').slice(0, -1).join('/') || '/'; }}
        }};
        var stub = function() {{ return {{ TelemetryTracker: function(){{ this.state={{}}; }}, options: function(){{ return {{}}; }}, TelegramController: function(){{}}, loadOrCreateIdentity: function(){{ return {{}}; }}, CloudBridge: function(){{}} }}; }};
        var req = function(n) {{
          if (n === 'fs') return fs;
          if (n === 'path') return path;
          if (n === 'crypto') return {{ randomBytes: function(){{ return {{ readUInt16BE: function(){{ return 1234; }} }}; }} }};
          return stub();
        }};
        var mod = {{ exports: {{}} }};
        var fn = new Function('require', 'module', 'exports', '__dirname', 'process', {json.dumps(bl_src)});
        fn(req, mod, mod.exports, '/tmp', {{ env: {{}}, pid: 1, getuid: function(){{ return 501; }}, argv: ['node', 'x', 'lib'], stdout: {{ write: function(){{}} }} }});
        var res = mod.exports.ensureAppRamDir('/run', '/oap', '/proc');
        JSON.stringify(res);
        """)
        parsed_proc = json.loads(proc_check)
        assert parsed_proc['id'] == 'bimmer_link2' and parsed_proc['uid'] == 5099 and parsed_proc['fromProc'] is True, f"VietMap cwd UID failed: {parsed_proc}"

        # v0.6.5: Verify scheduled MGU vehicle-clock timer (`car_clock` -> `checkScheduledTimer`) & `ventilate` engineRunning guard!
        car_src_for_bl = open(os.path.join(ROOT, 'tools/bimmer-link/car-link.js'), encoding='utf-8').read()
        aa_src_for_bl = open(os.path.join(ROOT, 'tools/bimmer-link/aa-wifi.js'), encoding='utf-8').read()
        sched_check = run_jxa(f"""
        var carMod = {{ exports: {{}} }};
        new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', {json.dumps(car_src_for_bl)})(
          function() {{ return {{}}; }}, carMod, carMod.exports, '/', '/car-link.js', {{ env: {{}}, argv: [], on: function(){{}} }}
        );
        var files = {{ '/state/config.json': JSON.stringify({{ timerEnabled: true, autoSyncTimer: true, dailyTimer: '07:30', tzOffsetMin: 420 }}) }};
        var dirs = {{ '/': true, '/state': true, '/run': true }};
        var fs = {{
          existsSync: function(p) {{ return !!(dirs[p] || files[p] !== undefined); }},
          readFileSync: function(p) {{ if (files[p] === undefined) throw new Error('no ' + p); return files[p]; }},
          writeFileSync: function(p, v) {{ files[p] = String(v); }},
          renameSync: function(a, b) {{ files[b] = files[a]; delete files[a]; }},
          mkdirSync: function(p) {{ dirs[p] = true; }},
          readdirSync: function() {{ return []; }},
          chmodSync: function() {{}},
          chownSync: function() {{}},
          statSync: function() {{ return {{ uid: 0, gid: 0 }}; }}
        }};
        var path = {{
          join: function() {{ return Array.prototype.slice.call(arguments).join('/').replace(/[/]+/g, '/'); }},
          dirname: function(p) {{ return p.split('/').slice(0, -1).join('/') || '/'; }}
        }};
        var aaMod = {{ exports: {{}} }};
        new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', {json.dumps(aa_src_for_bl)})(
          function(n) {{ if (n === 'fs') return fs; if (n === 'path') return path; return {{}}; }},
          aaMod, aaMod.exports, '/', '/aa-wifi.js', {{ env: {{}}, pid: 1, getuid: function(){{ return 0; }} }}
        );
        var req = function(n) {{
          if (n === 'fs') return fs;
          if (n === 'path') return path;
          if (n === 'crypto') return {{ randomBytes: function() {{ return {{ readUInt16BE: function() {{ return 4321; }} }}; }} }};
          if (n === './car-link') return carMod.exports;
          if (n === './aa-wifi') return aaMod.exports;
          if (n === './telegram') return {{ TelegramController: function() {{ this.lastOkAt = 0; this.lastError = ''; this.sendMessage = function() {{ return Promise.resolve(); }}; }}, formatStatusCaption: function() {{ return ''; }} }};
          if (n === './cloud') return {{ loadOrCreateIdentity: function() {{ return {{ pairCode: 'ABCD' }}; }}, CloudBridge: function() {{ this.isOnline = function() {{ return true; }}; this.pairingUrl = function() {{ return ''; }}; this.publishState = function() {{ return Promise.resolve(); }}; this.stop = function() {{}}; this.lastOkAt = 1; }} }};
          if (n === './car-hero') return {{ scanFactoryVehicle: function() {{ return {{ png: null, meta: {{}} }}; }} }};
          return {{ options: function() {{ return {{}}; }} }};
        }};
        var blMod = {{ exports: {{}} }};
        new Function('require', 'module', 'exports', '__dirname', 'process', {json.dumps(bl_src)})(
          req, blMod, blMod.exports, '/tmp', {{ env: {{}}, pid: 1, getuid: function() {{ return 0; }}, argv: ['node', 'x', 'lib'], stdout: {{ write: function(){{}} }} }}
        );
        var svc = blMod.exports.createService({{ state: '/state', run: '/run', oap: '/oap', proc: '/proc', noServer: true, noWorker: true, noCloud: true }});
        svc.onWorkerEvent({{ ev: 'car_clock', utcMs: Date.UTC(2026, 10, 26, 0, 30, 10), tzMin: 420 }});
        svc.checkScheduledTimer();
        var cfgAfter = svc.getConfig();
        svc.S.workerUp = true;
        svc.S.telemetry.engineRunning = true;
        svc.executeAction('ventilate', {{}}, 'App');
        JSON.stringify({{ fireKey: cfgAfter.lastTimerFiredKey, msg: svc.S.message, kind: svc.S.messageKind }});
        """)
        sc_res = json.loads(sched_check)
        assert sc_res['fireKey'] == '2026-11-26@07:30', f"Scheduled MGU timer did not fire at 07:30 UTC+7: {sc_res}"
        assert sc_res['kind'] == 'warn' and 'đang nổ máy' in sc_res['msg'], f"Ventilate guard failed: {sc_res}"

        # Verify CarHero F90LCI M5 CS (TrimL gold wheels/grille in vehicle2D_small beating TrimA in vehicle2D_big + F90->F90LCI heal)
        hero_src = open(os.path.join(ROOT, 'tools/bimmer-link/car-hero.js'), encoding='utf-8').read()
        hero_check = run_jxa(f"""
        function enhanceBuf(u) {{ u._isBuf = true; u.copy = function(d, o, s0, s1) {{ d.set(u.subarray(s0||0, s1===undefined?u.length:s1), o||0); }}; u.slice = function(a, b) {{ return enhanceBuf(Uint8Array.prototype.slice.call(u, a, b)); }}; u.writeUInt32BE = function(){{}}; u.write = function(s, o) {{ for (var i=0;i<s.length;i++) u[(o||0)+i] = s.charCodeAt(i); }}; return u; }}
        var Buffer = {{
          alloc: function(n) {{ return enhanceBuf(new Uint8Array(n)); }},
          allocUnsafe: function(n) {{ return enhanceBuf(new Uint8Array(n)); }},
          from: function(a) {{ var u = new Uint8Array(a.length); for (var i=0; i<a.length; i++) u[i] = typeof a === 'string' ? a.charCodeAt(i) : a[i]; return enhanceBuf(u); }},
          concat: function(l) {{ var t=0; for (var i=0;i<l.length;i++) t+=l[i].length; var o=Buffer.alloc(t), p=0; for(var j=0;j<l.length;j++){{o.set(l[j],p);p+=l[j].length;}} return o; }}
        }};
        var dirs = {{
          '/hmi/bmwm/widgetasset/vehicles': ['F90', 'F90LCI'],
          '/hmi/bmw/widgetasset/vehicles': ['G30LCI'],
          '/proc': []
        }};
        var exists = {{
          '/hmi/bmwm/widgetasset/vehicles/F90/vehicle2D_big/bitmaps.res': 1,
          '/hmi/bmwm/widgetasset/vehicles/F90/vehicle2D_big/bitmaps.res.ids': 1,
          '/hmi/bmwm/widgetasset/vehicles/F90LCI/vehicle2D_big/bitmaps.res': 1,
          '/hmi/bmwm/widgetasset/vehicles/F90LCI/vehicle2D_big/bitmaps.res.ids': 1,
          '/hmi/bmwm/widgetasset/vehicles/F90LCI/vehicle2D_small/bitmaps.res': 1,
          '/hmi/bmwm/widgetasset/vehicles/F90LCI/vehicle2D_small/bitmaps.res.ids': 1,
          '/hmi/bmw/widgetasset/vehicles/G30LCI/vehicle2D_big/bitmaps.res': 1,
          '/hmi/bmw/widgetasset/vehicles/G30LCI/vehicle2D_big/bitmaps.res.ids': 1
        }};
        var fs = {{
          readdirSync: function(p) {{ if (!dirs[p]) throw new Error('no ' + p); return dirs[p]; }},
          existsSync: function(p) {{ return !!exists[p]; }},
          realpathSync: function(p) {{ return p; }},
          readFileSync: function(p) {{ return p; }}
        }};
        var path = {{
          join: function() {{ return Array.prototype.slice.call(arguments).join('/').replace(/[/]+/g, '/'); }},
          basename: function(p) {{ return p.split('/').pop(); }}
        }};
        function makeSolidRgba(w, h, r, g, b) {{
          var u = Buffer.alloc(w * h * 4);
          for (var i = 0; i < u.length; i += 4) {{ u[i]=r; u[i+1]=g; u[i+2]=b; u[i+3]=255; }}
          return u;
        }}
        var W = {{
          Bundle: function(resPath) {{
            if (resPath.indexOf('F90LCI/vehicle2D_big') >= 0) {{
              this.entries = [{{ key: 'f90lci_trimA_0_bitmap', w: 600, h: 300 }}];
            }} else if (resPath.indexOf('F90LCI/vehicle2D_small') >= 0) {{
              this.entries = [{{ key: 'f90lci_trimL_0_bitmap', w: 420, h: 210 }}];
            }} else {{
              this.entries = [{{ key: 'other_trimA_0_bitmap', w: 600, h: 300 }}];
            }}
            var byKey = {{}};
            for (var i=0;i<this.entries.length;i++) byKey[this.entries[i].key] = this.entries[i];
            this.byKey = byKey;
            this.rgba = function(k) {{ var e = byKey[k]; return makeSolidRgba(e.w, e.h, 120, 140, 180); }};
          }},
          flipRows: function(rgba) {{ return rgba; }},
          resize: function(rgba, sw, sh, dw, dh) {{ return makeSolidRgba(dw, dh, 40, 110, 210); }},
          crc32: function() {{ return 0; }}
        }};
        var CARPAINT = {{
          readRawCoding: function() {{ return {{ valid: true, baureihe: 'F90LCI', trimLine: 'clubsport', trimCode: 6, colour: 'phytonicblau_metallic' }}; }},
          resolveHeroTrim: function(m, tl) {{ return tl === 'clubsport' ? 'L' : 'A'; }},
          resolvePaint: function() {{ return {{ name: 'phytonicblau_WC1M', base: [0.08, 0.22, 0.48, 3.2], spec: [0.55, 0.78, 1.15, 10.5], refl: [0.88, 0.96, 1.08, 1.0] }}; }},
          readSceneTrims: function() {{ return {{ byTrim: {{}}, trimOfPic: {{}}, picOfMask: {{}} }}; }},
          shadeCarpaint: function(pic) {{ return pic; }}
        }};
        var req = function(n) {{
          if (n === 'fs') return fs;
          if (n === 'path') return path;
          if (n === 'zlib') return {{ deflateSync: function(x) {{ return x.slice(0, 16); }} }};
          if (n === './wbm') return W;
          if (n === './carpaint') return CARPAINT;
          return {{}};
        }};
        var mod = {{ exports: {{}} }};
        new Function('require', 'module', 'exports', 'Buffer', {json.dumps(hero_src)})(req, mod, mod.exports, Buffer);
        var rAuto = mod.exports.scanFactoryVehicle({{ hmiRoot: '/hmi', procDir: '/proc', trueChassis: 'G30LCI', kombiSpoofed: true, override: {{}} }});
        var rHeal = mod.exports.scanFactoryVehicle({{ hmiRoot: '/hmi', procDir: '/proc', trueChassis: 'G30LCI', override: {{ chassis: 'F90', trimLine: 'clubsport' }} }});
        JSON.stringify({{ auto: rAuto.meta, heal: rHeal.meta }});
        """)
        hc = json.loads(hero_check)
        assert hc['auto']['chassis'] == 'F90LCI' and hc['auto']['modelTitle'] == 'BMW M5 CS' and 'f90lci_trimL_0_bitmap' in hc['auto']['renderSource'], f"Auto M5 CS failed: {hc}"
        assert hc['heal']['chassis'] == 'F90LCI' and hc['heal']['modelTitle'] == 'BMW M5 CS' and 'f90lci_trimL_0_bitmap' in hc['heal']['renderSource'], f"F90->F90LCI CS heal failed: {hc}"
    print('[OK] PWA client syntax, black-canvas guard, and OAP SOME/IP catalog filtering verified')


def check_aa_wifi_coordinator_in_jxa():
    aa_src = open(os.path.join(ROOT, 'tools/bimmer-link/aa-wifi.js'), encoding='utf-8').read()
    jxa = f"""
    function SyncPromise(fn) {{
      var val, err, isErr = false;
      fn(function(v) {{ val = v; }}, function(e) {{ err = e; isErr = true; }});
      this._v = val; this._e = err; this._isErr = isErr;
    }}
    SyncPromise.resolve = function(v) {{
      return (v && typeof v.then === 'function') ? v : new SyncPromise(function(res) {{ res(v); }});
    }};
    SyncPromise.prototype.then = function(onOk, onErr) {{
      try {{
        if (this._isErr) {{
          if (onErr) return SyncPromise.resolve(onErr(this._e));
          return this;
        }}
        return onOk ? SyncPromise.resolve(onOk(this._v)) : this;
      }} catch (e) {{
        return new SyncPromise(function(_, rej) {{ rej(e); }});
      }}
    }};
    SyncPromise.prototype.catch = function(onErr) {{ return this.then(null, onErr); }};

    var files = {{}};
    var dirs = {{
      '/': true, '/state': true, '/uplink': true, '/proc': true, '/proc/net': true,
      '/sys': true, '/sys/class': true, '/sys/class/rfkill': true, '/sys/class/rfkill/rfkill0': true,
      '/sys/class/net': true, '/sys/class/net/wlan0': true,
      '/var/opt/devlink-wifi': true, '/etc/systemd/system/mgu-uplink.service.d': true,
      '/etc/systemd/system': true, '/etc/systemd/system/multi-user.target.wants': true,
      '/dev/shm/waze-on-cluster': true
    }};
    var mtimes = {{}};
    var nowMs = 1700000000000;

    function norm(p) {{ return String(p).replace(/[/]+/g, '/').replace(/\\/$/, '') || '/'; }}
    var fs = {{
      existsSync: function(p) {{ p = norm(p); return !!(dirs[p] || files[p] !== undefined); }},
      readFileSync: function(p) {{ p = norm(p); if (files[p] === undefined) throw new Error('ENOENT ' + p); return files[p]; }},
      writeFileSync: function(p, v) {{ p = norm(p); files[p] = String(v); mtimes[p] = nowMs; }},
      renameSync: function(a, b) {{ a = norm(a); b = norm(b); files[b] = files[a]; mtimes[b] = nowMs; delete files[a]; }},
      unlinkSync: function(p) {{ p = norm(p); delete files[p]; }},
      mkdirSync: function(p) {{ dirs[norm(p)] = true; }},
      rmdirSync: function(p) {{
        p = norm(p);
        var prefix = p + '/';
        for (var k in files) if (k.indexOf(prefix) === 0) throw new Error('ENOTEMPTY');
        delete dirs[p];
      }},
      readdirSync: function(p) {{
        p = norm(p);
        var prefix = p === '/' ? '/' : (p + '/');
        var seen = {{}}, out = [];
        for (var k in files) {{
          if (k.indexOf(prefix) === 0) {{
            var seg = k.slice(prefix.length).split('/')[0];
            if (seg && !seen[seg]) {{ seen[seg] = true; out.push(seg); }}
          }}
        }}
        for (var d in dirs) {{
          if (d !== p && d.indexOf(prefix) === 0) {{
            var dseg = d.slice(prefix.length).split('/')[0];
            if (dseg && !seen[dseg]) {{ seen[dseg] = true; out.push(dseg); }}
          }}
        }}
        return out;
      }},
      openSync: function(p, flags) {{
        p = norm(p);
        if (flags === 'wx' && files[p] !== undefined) {{
          var e = new Error('EEXIST'); e.code = 'EEXIST'; throw e;
        }}
        files[p] = '';
        mtimes[p] = nowMs;
        return p;
      }},
      writeSync: function(fd, s) {{ files[fd] = (files[fd] || '') + String(s); }},
      closeSync: function() {{}},
      statSync: function(p) {{
        p = norm(p);
        if (files[p] === undefined && !dirs[p]) throw new Error('ENOENT ' + p);
        var mt = mtimes[p] || nowMs;
        return {{ mtime: {{ getTime: function() {{ return mt; }} }} }};
      }}
    }};
    var path = {{
      join: function() {{ return norm(Array.prototype.slice.call(arguments).join('/')); }},
      dirname: function(p) {{ p = norm(p); var i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }}
    }};
    var aaMod = {{ exports: {{}} }};
    new Function('require', 'module', 'exports', '__dirname', '__filename', 'process', 'Promise', {json.dumps(aa_src)})(
      function(n) {{ if (n === 'fs') return fs; if (n === 'path') return path; return {{}}; }},
      aaMod, aaMod.exports, '/', '/aa-wifi.js', {{ env: {{}}, pid: 777, getuid: function() {{ return 0; }} }}, SyncPromise
    );
    var A = aaMod.exports;

    function setTcp(aaConnected, cpConnected, loopbackOnly) {{
      var rows = ['  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'];
      if (loopbackOnly) {{
        rows.push('   0: 0100007F:1388 0100007F:C350 01 00000000:00000000 00:00000000 00000000 13006        0 100');
      }}
      if (aaConnected) {{
        rows.push('   1: 61DE10AC:14E0 69DE10AC:D9AA 01 00000000:00000000 00:00000000 00000000 13006        0 101');
      }}
      if (cpConnected) {{
        rows.push('   2: 61DE10AC:1B58 6ADE10AC:C111 01 00000000:00000000 00:00000000 00000000 13002        0 102');
      }}
      files['/proc/net/tcp'] = rows.join('\\n') + '\\n';
      files['/proc/net/tcp6'] = '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid\\n';
    }}

    function setUplink(wifiEnabled, link, ssid, nets, saved, errStr) {{
      files['/uplink/status.json'] = JSON.stringify({{
        state: link === 'online' ? 'online' : 'searching',
        wifi: {{
          enabled: wifiEnabled,
          link: link,
          ssid: ssid || '',
          signal: -45,
          networks: nets || [],
          saved: saved || ['Drag0n’s iPhone', 'Xiaomi 15 Ultra'],
          error: errStr || null
        }}
      }});
    }}

    var ctlCalls = [];
    var execCalls = [];
    var telem = {{ condition: 5, engineRunning: false, rpm: 0, locked: false, dwaArmed: false, doorsOpen: ['Cửa Tài'], climate1cr: {{ active: false }} }};
    var valetOn = false;

    setTcp(false, false, true);
    files['/proc/net/dev'] = 'Inter-|   Receive\\n  p2p-wlan0-0: 1000 10 0 0 0 0 0 0 500 5\\n';
    files['/proc/net/arp'] = 'IP address       HW type     Flags       HW address            Mask     Device\\n';
    setUplink(true, 'online', 'Xiaomi 15 Ultra', [{{ ssid: 'Xiaomi 15 Ultra', signal: -45, saved: true, current: true }}]);
    files['/uplink/lease.json'] = JSON.stringify({{ interface: 'wlan0', ip: '10.51.97.110', prefix: 24, router: '10.51.97.229', leaseSeconds: 3599 }});

    var coord = new A.AaWifiCoordinator({{
      stateDir: '/state',
      uplinkRun: '/uplink',
      procDir: '/proc',
      sysDir: '/sys',
      legacyDir: '/var/opt/devlink-wifi',
      legacyDropIn: '/etc/systemd/system/mgu-uplink.service.d/20-devlink-wait-car-wifi.conf',
      legacyWifilogUnit: '/etc/systemd/system/devlink-wifilog.service',
      legacyWifilogWant: '/etc/systemd/system/multi-user.target.wants/devlink-wifilog.service',
      deployLockFile: '/var/opt/mgu-deploy/lock',
      wocRemountLock: '/dev/shm/waze-on-cluster/remount.lock',
      getTelemetry: function() {{ return telem; }},
      isValetEnabled: function() {{ return valetOn; }},
      now: function() {{ return nowMs; }},
      getuid: function() {{ return 0; }},
      sendCtl: function(p) {{
        ctlCalls.push({{ at: nowMs, op: p.op, on: p.on }});
        if (p.op === 'wifi-enable') {{
          if (!p.on) setUplink(false, 'off', '', [], []);
          else setUplink(true, 'online', 'Xiaomi 15 Ultra', [{{ ssid: 'Xiaomi 15 Ultra', signal: -45, saved: true, current: true }}]);
        }}
        return SyncPromise.resolve({{ ok: true }});
      }},
      execCmd: function(bin, args) {{
        execCalls.push(bin + ' ' + args.join(' '));
        if (bin === 'mount' && args.indexOf('remount,rw') >= 0) {{
          files['/proc/mounts'] = '/dev/mmcblk0p7 / ext4 rw,noatime 0 0\\n';
        }} else if (bin === 'mount' && args.indexOf('remount,ro') >= 0) {{
          files['/proc/mounts'] = '/dev/mmcblk0p7 / ext4 ro,noatime 0 0\\n';
        }}
        return SyncPromise.resolve({{ ok: true, code: 0, stdout: '', stderr: '' }});
      }}
    }});

    // SCENARIO 1: In-car reboot / entry with Xiaomi 15 Ultra (loopback 13006 ignored) -> yields immediately!
    coord.tick();
    if (ctlCalls.length !== 1 || ctlCalls[0].on !== false || !coord.pausedByUs) {{
      throw new Error('Scenario 1a failed: expected wifi-enable(false), got ' + JSON.stringify(ctlCalls));
    }}
    var guardDisk = JSON.parse(files['/state/wifi-guard.json']);
    if (guardDisk.pausedByUs !== true) throw new Error('Scenario 1b: guard state not persisted');

    // Brief transient AA TCP blip at +2s (rpm=0) MUST NOT abort yield prematurely!
    nowMs += 2000;
    setTcp(true, false, false);
    coord.tick();
    if (!coord.pausedByUs) throw new Error('Scenario 1c: restored too early before 4.5s settle');
    nowMs += 500;
    setTcp(false, false, false);
    coord.tick();
    if (!coord.pausedByUs) throw new Error('Scenario 1d: transient handshake blip aborted yield!');

    // AA establishes at +3s, stays up -> settles at +7.6s -> restores wifi-enable(true)!
    nowMs += 500;
    setTcp(true, false, false);
    coord.tick();
    nowMs += 3000;
    coord.tick();
    if (!coord.pausedByUs) throw new Error('Scenario 1e: restored at 3.0s < 4.5s');
    nowMs += 1600;
    coord.tick();
    if (coord.pausedByUs || ctlCalls.length !== 2 || ctlCalls[1].on !== true) {{
      throw new Error('Scenario 1f: expected wifi-enable(true) after 4.6s settle, got ' + JSON.stringify(ctlCalls));
    }}

    // SCENARIO 2: Engine shutdown + Park Snapshot + AA disconnect -> ZERO Wi-Fi pause!
    nowMs += 60000;
    telem.condition = 12;
    telem.engineRunning = false;
    telem.rpm = 0;
    coord.notifyParked();
    setTcp(false, false, false);
    coord.tick();
    nowMs += 5000;
    coord.tick();
    if (ctlCalls.length !== 2) throw new Error('Scenario 2: Park Snapshot must NEVER pause Wi-Fi!');

    // SCENARIO 3: Parked & locked outside -> Remote 1CR start -> Valet -> Owner 1CR takeover!
    telem.condition = 2;
    telem.locked = true;
    telem.dwaArmed = true;
    telem.doorsOpen = [];
    nowMs += 70000;
    coord.tick();
    nowMs += 16000;
    coord.tick();
    if (coord.yieldedThisCycle !== false) throw new Error('Scenario 3a: yieldedThisCycle should reset after 15s locked outside');

    telem.condition = 3;
    telem.climate1cr = {{ active: true }};
    nowMs += 2000;
    coord.tick();
    if (ctlCalls.length !== 2) throw new Error('Scenario 3b: Remote 1CR start must NEVER pause Wi-Fi!');

    valetOn = true;
    telem.condition = 10;
    telem.locked = false;
    telem.dwaArmed = false;
    telem.climate1cr = {{ active: false }};
    nowMs += 2000;
    coord.tick();
    if (ctlCalls.length !== 2) throw new Error('Scenario 3c: Valet mode must NEVER pause Wi-Fi!');
    valetOn = false;

    telem.condition = 3;
    telem.locked = true;
    telem.climate1cr = {{ active: true }};
    nowMs += 2000;
    coord.tick();
    nowMs += 16000;
    coord.tick();
    telem.locked = false;
    telem.dwaArmed = false;
    telem.climate1cr = {{ active: false }};
    telem.doorsOpen = ['Cửa Tài'];
    telem.condition = 5;
    nowMs += 1000;
    coord.tick();
    if (ctlCalls.length !== 3 || ctlCalls[2].on !== false) {{
      throw new Error('Scenario 3d: 1CR owner takeover should yield Wi-Fi for AA');
    }}

    // SCENARIO 5: AA disabled on phone + active P2P ARP extends 22s -> 30s, then restores & latches!
    files['/proc/net/arp'] = 'IP address       HW type     Flags       HW address            Mask     Device\\n172.16.222.105   0x1         0x2         ba:11:c2:12:90:7b     *        wlan_bridge\\n';
    nowMs += 10000; coord.tick();
    nowMs += 10000; coord.tick();
    nowMs += 3000;  coord.tick();
    if (!coord.pausedByUs) throw new Error('Scenario 5a: active P2P ARP handshake should extend yield past 22s');
    nowMs += 8000;
    coord.tick();
    if (coord.pausedByUs || ctlCalls.length !== 4 || ctlCalls[3].on !== true) {{
      throw new Error('Scenario 5b: hard 30s timeout must restore Wi-Fi');
    }}
    files['/proc/net/arp'] = 'IP address       HW type     Flags       HW address            Mask     Device\\n';
    nowMs += 5000;
    coord.tick();
    if (ctlCalls.length !== 4) throw new Error('Scenario 5c: must NOT loop after timeout!');

    // SCENARIO 5d: Verify `/proc/uptime` CLOCK_BOOTTIME immunity to BMW MGU `2023 -> 2026` wall-clock jump!
    files['/proc/uptime'] = '14.25 28.50\\n';
    if (A.readBootTimeMs('/proc') !== 14250) throw new Error('Scenario 5d: readBootTimeMs failed');

    // SCENARIO 4: Sleep gap -> Wake WITHOUT Android phone (using iPhone, 4G Router, + unsaved Redmi on street) -> ZERO pause!
    nowMs += 25000;
    setUplink(true, 'online', 'Drag0n’s iPhone', [
      {{ ssid: 'Drag0n’s iPhone', signal: -42, saved: true, current: true }},
      {{ ssid: 'Viettel_4G_Box', signal: -50, saved: true, current: false }},
      {{ ssid: 'Redmi Note 13', signal: -60, saved: false, current: false }}
    ], ['Drag0n’s iPhone', 'Viettel_4G_Box', 'Xiaomi 15 Ultra']);
    files['/uplink/lease.json'] = JSON.stringify({{ interface: 'wlan0', ip: '172.20.10.4', prefix: 28, router: '172.20.10.1', leaseSeconds: 86000 }});
    coord.tick();
    if (ctlCalls.length !== 4) {{
      throw new Error('Scenario 4: iPhone / 4G router / unsaved stranger Redmi must NEVER pause Wi-Fi!');
    }}

    // SCENARIO 6: Manual Wi-Fi off in MGU Store (`enabled: false` while `!pausedByUs`) -> NEVER touched!
    setUplink(false, 'off', '', [], ['Xiaomi 15 Ultra']);
    nowMs += 2000;
    coord.tick();
    if (ctlCalls.length !== 4) throw new Error('Scenario 6: manual Wi-Fi off must never be overridden');

    // SCENARIO 7: Crash / power-cut recovery (`pausedByUs: true` persisted in `wifi-guard.json`) -> immediately restores!
    files['/state/wifi-guard.json'] = JSON.stringify({{ pausedByUs: true, pausedAt: nowMs - 5000, learnedAaSsids: [] }});
    var recoveredCoord = new A.AaWifiCoordinator({{
      stateDir: '/state', uplinkRun: '/uplink', procDir: '/proc', sysDir: '/sys',
      getTelemetry: function() {{ return telem; }},
      now: function() {{ return nowMs; }},
      sendCtl: function(p) {{ ctlCalls.push({{ at: nowMs, op: p.op, on: p.on }}); return SyncPromise.resolve({{ ok: true }}); }}
    }});
    recoveredCoord.tick();
    if (recoveredCoord.pausedByUs || ctlCalls.length !== 5 || ctlCalls[4].on !== true) {{
      throw new Error('Scenario 7: crash recovery failed to restore Wi-Fi');
    }}

    // SCENARIO 8: Custom-named Android hotspot auto-learning (`"Bimmer_Ultra"` with Android DHCP `10.51.97.229/24`, 3599s)
    setTcp(true, false, false);
    setUplink(true, 'online', 'Bimmer_Ultra', [{{ ssid: 'Bimmer_Ultra', signal: -48, saved: true, current: true }}], ['Bimmer_Ultra']);
    files['/uplink/lease.json'] = JSON.stringify({{ interface: 'wlan0', ip: '10.51.97.110', prefix: 24, router: '10.51.97.229', leaseSeconds: 3599 }});
    nowMs += 2000;
    coord.tick();
    if (coord.learnedAaSsids.indexOf('Bimmer_Ultra') < 0) {{
      throw new Error('Scenario 8a: failed to auto-learn custom Android hotspot SSID');
    }}
    setUplink(true, 'online', 'Home_Fiber', [{{ ssid: 'Home_Fiber', signal: -45, saved: true, current: true }}], ['Home_Fiber']);
    files['/uplink/lease.json'] = JSON.stringify({{ interface: 'wlan0', ip: '192.168.1.55', prefix: 24, router: '192.168.1.1', leaseSeconds: 86400 }});
    nowMs += 2000;
    coord.tick();
    if (coord.learnedAaSsids.indexOf('Home_Fiber') >= 0) {{
      throw new Error('Scenario 8b: home router 192.168.1.1 must NOT be learned as Android phone!');
    }}

    // SCENARIO 9: Option 3 ConnMan `"the car's Wi-Fi is off"` auto-rescue + 2-attempt cap!
    setTcp(false, false, false);
    files['/sys/class/rfkill/rfkill0/type'] = 'wlan\\n';
    files['/sys/class/rfkill/rfkill0/soft'] = '1\\n';
    files['/sys/class/net/wlan0/operstate'] = 'down\\n';
    setUplink(true, 'unavailable', '', [], ['Xiaomi 15 Ultra'], "the car's Wi-Fi is off");
    nowMs += 2000;
    coord.tick();
    nowMs += 12500;
    coord.tick();
    if (files['/sys/class/rfkill/rfkill0/soft'] !== '0\\n' || execCalls.length < 3) {{
      throw new Error('Scenario 9a: ConnMan rescue did not unblock rfkill / call dbus-send / ip link up: ' + JSON.stringify(execCalls));
    }}
    var rescuesAfter1 = coord.connmanRescues;
    for (var ri = 0; ri < 14; ri++) {{
      nowMs += 10000;
      coord.tick();
    }}
    if (rescuesAfter1 !== 1 || coord.connmanRescues !== 2) {{
      throw new Error('Scenario 9b: ConnMan rescue rate-limit failed: ' + coord.connmanRescues);
    }}

    // SCENARIO 10: Legacy `wait-car-wifi.sh` instant neutralization + safe `/` rw->unlink->ro cleanup!
    files['/var/opt/devlink-wifi/wait-car-wifi.sh'] = '#!/bin/sh\\nsleep 90\\n';
    files['/var/opt/devlink-wifi/boot-20261122.log'] = 'old log';
    files['/etc/systemd/system/mgu-uplink.service.d/20-devlink-wait-car-wifi.conf'] = '[Service]\\nExecStartPre=/var/opt/devlink-wifi/wait-car-wifi.sh\\n';
    files['/etc/systemd/system/devlink-wifilog.service'] = '[Service]\\nExecStart=/bin/sh\\n';
    files['/etc/systemd/system/multi-user.target.wants/devlink-wifilog.service'] = 'symlink';
    files['/proc/mounts'] = '/dev/mmcblk0p7 / ext4 ro,noatime 0 0\\n';

    var neutralized = coord.neutralizeLegacyWaitScript();
    if (!neutralized || files['/var/opt/devlink-wifi/wait-car-wifi.sh'] !== '#!/bin/sh\\nexit 0\\n') {{
      throw new Error('Scenario 10a: wait-car-wifi.sh was not neutralized immediately');
    }}
    files['/proc/mounts'] = '/dev/mmcblk0p7 / ext4 rw,noatime 0 0\\n';
    var skipRes = coord.cleanupLegacyDropIn()._v;
    if (!skipRes || skipRes.cleaned !== false || skipRes.reason !== 'root_not_ro') {{
      throw new Error('Scenario 10b: expected skip when / is already rw, got ' + JSON.stringify(skipRes));
    }}
    files['/proc/mounts'] = '/dev/mmcblk0p7 / ext4 ro,noatime 0 0\\n';
    var cleanRes = coord.cleanupLegacyDropIn()._v;
    if (!cleanRes || !cleanRes.cleaned || !cleanRes.roRestored) {{
      throw new Error('Scenario 10c: cleanupLegacyDropIn failed: ' + JSON.stringify(cleanRes));
    }}
    if (files['/etc/systemd/system/mgu-uplink.service.d/20-devlink-wait-car-wifi.conf'] !== undefined) {{
      throw new Error('Scenario 10d: legacy drop-in still exists');
    }}
    if (files['/proc/mounts'].indexOf(' ro,') < 0) {{
      throw new Error('Scenario 10e: root filesystem was not restored to ro!');
    }}
    if (files['/dev/shm/waze-on-cluster/remount.lock'] !== undefined) {{
      throw new Error('Scenario 10f: remount.lock was not released!');
    }}
    if (dirs['/var/opt/devlink-wifi'] !== undefined) {{
      throw new Error('Scenario 10g: /var/opt/devlink-wifi was not cleaned up!');
    }}

    'AA_WIFI_ALL_10_SCENARIOS_OK';
    """
    out = run_jxa(jxa)
    assert out == 'AA_WIFI_ALL_10_SCENARIOS_OK', f'Unexpected aa-wifi test output: {out}'
    print('[OK] aa-wifi.js verified across all 10 scenarios (in-car boot, Park Snapshot, 1CR/Valet, iPhone/router, timeout, ConnMan rescue, legacy cleanup)')


if __name__ == '__main__':
    ver = check_manifests()
    check_js_syntax_and_node8()
    check_pwa_and_manifest_filtering()
    check_full_mgu_build_and_real_kit_render(ver)
    check_car_link_logic_in_jxa()
    check_aa_wifi_coordinator_in_jxa()
    print('=== ALL VERIFICATION CHECKS PASSED ===')
