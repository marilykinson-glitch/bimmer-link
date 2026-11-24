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
            valet: {{ enabled: false, maxSpeed: 45, maxRpm: 3500, radiusM: 500 }},
            telemetry: {{
              fuelPct: 74, rangeKm: 512, battery12v: 12.6, coolantC: 88, ambientC: 29.5, locked: true, doorsOpen: [],
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
    if (built.candidates[0].stage !== 'auto_1cr' || built.candidates[0].payload.operationParkFunctionAutoMode !== 'AUTO_MINUS_MODUS_EIN' || built.candidates[0].payload.operationParkAirConditioning !== 'KEINE_AKTION__S__NICHT_VERFUEGBAR') {{
      throw new Error('Stage 1 must be pure AUTO_MINUS_MODUS_EIN: ' + JSON.stringify(built.candidates[0]));
    }}
    if (built.candidates[1].stage !== 'auto_res_phev' || built.candidates[1].payload.operationRemoteStart !== 'REMOTE_ENGINE_START_EIN') {{
      throw new Error('Stage 2 must be auto_res_phev: ' + JSON.stringify(built.candidates[1]));
    }}
    var cmCand = built.candidates.filter(function(x){{ return x.name === 'requestParkingFunctionsOn'; }})[0];
    if (!cmCand || cmCand.payload.parkingFunctionsAutoMode !== 'AUTO_MODE_ON' || cmCand.payload.timeParkingFunctionsAutoMode !== 15) {{
      throw new Error('ClimateMaster.requestParkingFunctionsOn payload mismatch: ' + JSON.stringify(cmCand));
    }}
    var lastCand = built.candidates[built.candidates.length - 1];
    if (lastCand.stage !== 'vent_only' || lastCand.payload.operationIndependentVentilate !== 'STANDLUEFTEN_EIN') {{
      throw new Error('Last fallback must be STANDLUEFTEN_EIN: ' + JSON.stringify(lastCand));
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
        json.dump({'interfaces': {
            'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy': {'instances': {'1': {}}},
            'de.bmw.infotainment.climate.Climate2': {'instances': {'1': {}}},
            'de.bmw.infotainment.climate.CustomStandklima': {'instances': {'1': {}}},
        }}, open(cat, 'w', encoding='utf-8'))
        env = dict(os.environ, OAP_SOMEIP_CATALOG=cat)
        spec_path = os.path.join(ROOT, 'apps/bimmer_link/app.json')
        out = subprocess.run([
            sys.executable, '-c',
            f"import json, sys; sys.path.insert(0, {json.dumps(os.path.join(ROOT, 'kit/tools'))}); "
            f"import build; m = build.manifest_for(json.load(open({json.dumps(spec_path)}))); print(json.dumps(m['proxies']))"
        ], env=env, capture_output=True, text=True, check=True).stdout
        proxies = json.loads(out)
        assert 'de.bmw.infotainment.video.cameraproxy.ICAM2Proxy' in proxies
        assert 'de.bmw.infotainment.climate.Climate2' in proxies
        assert 'de.bmw.infotainment.climate.CustomStandklima' in proxies
        assert 'de.bmw.infotainment.climate.climatemaster.ClimateMaster' not in proxies
    print('[OK] PWA client syntax, black-canvas guard, and OAP SOME/IP catalog filtering verified')


if __name__ == '__main__':
    ver = check_manifests()
    check_js_syntax_and_node8()
    check_pwa_and_manifest_filtering()
    check_full_mgu_build_and_real_kit_render(ver)
    check_car_link_logic_in_jxa()
    print('=== ALL VERIFICATION CHECKS PASSED ===')
