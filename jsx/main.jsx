// JSON polyfill untuk ExtendScript (always define untuk keamanan)
if (typeof JSON === 'undefined') JSON = {};
if (typeof JSON.parse !== 'function') {
    JSON.parse = function(str) { return eval('(' + str + ')'); };
    JSON.stringify = function(obj) {
        var t = typeof obj;
        if (t === 'undefined') return undefined;
        if (t === 'string') {
            var dq = String.fromCharCode(34); // double quote
            var bs = String.fromCharCode(92); // backslash
            var escaped = '';
            for (var si = 0; si < obj.length; si++) {
                escaped += obj[si] === dq ? bs + dq : obj[si];
            }
            return dq + escaped + dq;
        }
        if (t === 'number' || t === 'boolean') return String(obj);
        if (obj === null) return 'null';
        if (obj instanceof Array) {
            var arr = [];
            for (var i = 0; i < obj.length; i++) arr.push(JSON.stringify(obj[i]));
            return '[' + arr.join(',') + ']';
        }
        var pairs = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) pairs.push('"' + k + '":' + JSON.stringify(obj[k]));
        }
        return '{' + pairs.join(',') + '}';
    };
}

/**
 * CurveFlow - ExtendScript (JSX)
 * Smart apply logic:
 *   N = jumlah titik di curve editor
 *   K = jumlah keyframe yang dipilih
 *
 *   N == K  → redistribute posisi keyframe sesuai titik (geser)
 *   N <  K  → apply kurva per segmen antar keyframe (seperti Flow)
 *   N >  K  → tambah keyframe baru sesuai selisih (N - K) titik
 */

// ============================================================
// ENTRY POINT
// ============================================================

function applyCurve(curveDataJSON) {
    try {
        var data = JSON.parse(curveDataJSON);
        var points = data.points;
        var separateDimensions = data.separateDimensions || false;
        var debugMode = data.debugMode || false;

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: "No active composition." });
        }

        if (separateDimensions) {
            autoSeparatePosition(comp);
        }

        app.beginUndoGroup("CurveFlow Apply");

        var affected = 0;
        var debugInfo = [];
        for (var li = 1; li <= comp.numLayers; li++) {
            var layer = comp.layer(li);
            if (debugMode) {
                var d = processLayerDebug(layer, points);
                if (d) { affected++; debugInfo.push(d); }
            } else {
                if (processLayer(layer, points)) affected++;
            }
        }

        app.endUndoGroup();

        if (affected === 0) {
            return JSON.stringify({ success: false, error: "No selected keyframes found. Select at least 2 keyframes." });
        }

        if (debugMode) {
            return JSON.stringify({ success: true, affected: affected, debug: debugInfo.join(' | ') });
        }
        return JSON.stringify({ success: true, affected: affected });

    } catch (e) {
        try { app.endUndoGroup(); } catch(e2) {}
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// Cek apakah ada Position keyframe terpilih yang belum separate dimensions
// Auto-separate Position dimensions pada layer yang punya keyframe Position terpilih
function autoSeparatePosition(comp) {
    try {
        for (var li = 1; li <= comp.numLayers; li++) {
            var layer = comp.layer(li);
            try {
                var transform = layer.property('ADBE Transform Group');
                var pos = transform.property('ADBE Position');
                if (!pos || pos.dimensionsSeparated) continue;
                // Cek apakah ada keyframe terpilih di Position
                var hasSelected = false;
                for (var k = 1; k <= pos.numKeys; k++) {
                    if (pos.keySelected(k)) { hasSelected = true; break; }
                }
                if (!hasSelected) continue;
                // Auto-separate — AE otomatis split ke X Position, Y Position, Z Position
                pos.dimensionsSeparated = true;
            } catch(e) {}
        }
    } catch(e) {}
}

// ============================================================
// LAYER TRAVERSAL
// ============================================================

function processLayer(layer, points) {
    var affected = false;
    for (var pi = 1; pi <= layer.numProperties; pi++) {
        if (processProperty(layer.property(pi), points)) affected = true;
    }
    return affected;
}

function processLayerDebug(layer, points) {
    var logs = [];
    for (var pi = 1; pi <= layer.numProperties; pi++) {
        var d = processPropertyDebug(layer.property(pi), points);
        if (d) logs.push(d);
    }
    return logs.length ? logs.join(';') : null;
}

function processPropertyDebug(prop, points) {
    try {
        if (prop.numProperties !== undefined && prop.numProperties > 0) {
            var logs = [];
            for (var i = 1; i <= prop.numProperties; i++) {
                var d = processPropertyDebug(prop.property(i), points);
                if (d) logs.push(d);
            }
            return logs.length ? logs.join(';') : null;
        }
        if (!prop.isTimeVarying || prop.numKeys < 2) return null;
        var selKeys = [];
        for (var k = 1; k <= prop.numKeys; k++) {
            if (prop.keySelected(k)) selKeys.push(k);
        }
        if (selKeys.length < 2) return null;

        var startTime = prop.keyTime(selKeys[0]);
        var endTime   = prop.keyTime(selKeys[selKeys.length-1]);
        var duration  = endTime - startTime;
        var startVal  = prop.keyValue(selKeys[0]);
        var endVal    = prop.keyValue(selKeys[selKeys.length-1]);
        var valueDiff = 0;
        if (typeof startVal === 'number') {
            valueDiff = Math.abs(endVal - startVal);
        } else if (startVal.length) {
            for (var d = 0; d < startVal.length; d++) {
                var dv = Math.abs(endVal[d] - startVal[d]);
                if (dv > valueDiff) valueDiff = dv;
            }
        }

        // Cek ease di keyframe pertama (normT=0) dan terakhir (normT=1)
        var e0 = getEaseAtT(points, 0, valueDiff, duration);
        var e1 = getEaseAtT(points, 1, valueDiff, duration);

        return prop.name + ' vd:' + valueDiff.toFixed(0) + ' dur:' + duration.toFixed(2) +
            ' OUT[inf:' + e0.outInfluence.toFixed(2) + ' spd:' + e0.outSpeed.toFixed(0) + ']' +
            ' IN[inf:' + e1.inInfluence.toFixed(2) + ' spd:' + e1.inSpeed.toFixed(0) + ']';
    } catch(e) { return null; }
}


function processProperty(prop, points) {
    try {
        // Recurse into property groups
        if (prop.numProperties !== undefined && prop.numProperties > 0) {
            var affected = false;
            for (var i = 1; i <= prop.numProperties; i++) {
                if (processProperty(prop.property(i), points)) affected = true;
            }
            return affected;
        }

        if (!prop.isTimeVarying) return false;
        if (prop.numKeys < 2) return false;

        // Collect selected keyframe indices
        var selKeys = [];
        for (var k = 1; k <= prop.numKeys; k++) {
            if (prop.keySelected(k)) selKeys.push(k);
        }

        if (selKeys.length < 2) return false;

        var N = points.length; // titik di kurva
        var K = selKeys.length; // keyframe dipilih

        if (N === K) {
            // REDISTRIBUTE: geser keyframe sesuai posisi titik
            redistributeKeyframes(prop, selKeys, points);
        } else if (N < K) {
            // PER SEGMEN: apply kurva ke tiap pasang keyframe
            applyPerSegment(prop, selKeys, points);
        } else {
            // ADD KEYFRAMES: tambah keyframe sesuai selisih
            addAndApply(prop, selKeys, points);
        }

        return true;

    } catch (e) {
        return false;
    }
}

// ============================================================
// MODE 1: N == K — REDISTRIBUTE
// Geser posisi keyframe sesuai distribusi titik kurva
// ============================================================

function redistributeKeyframes(prop, selKeys, points) {
    var firstKey  = selKeys[0];
    var lastKey   = selKeys[selKeys.length - 1];
    var startTime = prop.keyTime(firstKey);
    var endTime   = prop.keyTime(lastKey);
    var startVal  = prop.keyValue(firstKey);
    var endVal    = prop.keyValue(lastKey);
    var duration  = endTime - startTime;

    // Hanya geser keyframe TENGAH (bukan pertama dan terakhir)
    // Catat nilai baru untuk titik tengah
    var newKeyData = [];
    for (var i = 1; i < points.length - 1; i++) {
        var pt = points[i];
        newKeyData.push({
            time: startTime + pt.x * duration,
            val:  interpolateValue(startVal, endVal, pt.y)
        });
    }

    // Hapus keyframe tengah lama (dari belakang agar index tidak geser)
    for (var i = selKeys.length - 2; i >= 1; i--) {
        prop.removeKey(selKeys[i]);
    }

    // Insert keyframe baru di posisi titik tengah
    for (var i = 0; i < newKeyData.length; i++) {
        prop.setValueAtTime(newKeyData[i].time, newKeyData[i].val);
    }

    // Apply easing, tapi JANGAN geser keyframe pertama dan terakhir
    applyEasingToRange(prop, startTime, endTime, points);
}

// ============================================================
// MODE 2: N < K — PER SEGMEN
// Apply kurva yang sama ke tiap segmen antar keyframe
// ============================================================

function applyPerSegment(prop, selKeys, points) {
    for (var i = 0; i < selKeys.length - 1; i++) {
        var segStart = prop.keyTime(selKeys[i]);
        var segEnd   = prop.keyTime(selKeys[i + 1]);
        applyEasingToRange(prop, segStart, segEnd, points);
    }
}

// ============================================================
// MODE 3: N > K — ADD KEYFRAMES
// Tambah keyframe baru sesuai titik extra
// ============================================================

function addAndApply(prop, selKeys, points) {
    var firstKey  = selKeys[0];
    var lastKey   = selKeys[selKeys.length - 1];
    var startTime = prop.keyTime(firstKey);
    var endTime   = prop.keyTime(lastKey);
    var startVal  = prop.keyValue(firstKey);
    var endVal    = prop.keyValue(lastKey);
    var duration  = endTime - startTime;

    var N = points.length;
    var K = selKeys.length;
    var toAdd = N - K; // jumlah keyframe yang perlu ditambah

    // Kumpulkan titik tengah yang belum ada keyframe-nya
    // Urutkan berdasarkan jarak ke keyframe existing (ambil yang paling jauh dari existing)
    var candidates = [];
    for (var pi = 1; pi < points.length - 1; pi++) {
        var pt = points[pi];
        var newTime = startTime + pt.x * duration;
        // Cek apakah sudah ada keyframe di sekitar waktu ini
        var alreadyExists = false;
        for (var ki = 0; ki < selKeys.length; ki++) {
            if (Math.abs(prop.keyTime(selKeys[ki]) - newTime) < 0.0333) {
                alreadyExists = true;
                break;
            }
        }
        if (!alreadyExists) {
            candidates.push({ time: newTime, val: interpolateValue(startVal, endVal, pt.y) });
        }
    }

    // Tambah hanya sejumlah toAdd keyframe
    var addCount = Math.min(toAdd, candidates.length);
    for (var i = 0; i < addCount; i++) {
        prop.setValueAtTime(candidates[i].time, candidates[i].val);
    }

    // Apply easing ke seluruh range
    applyEasingToRange(prop, startTime, endTime, points);
}

// ============================================================
// EASING: Apply bezier ke semua keyframe dalam range waktu
// ============================================================


function applyEasingToRange(prop, startTime, endTime, points) {
    var duration = endTime - startTime;

    // Hitung valueDiff untuk segment ini (untuk speed calculation)
    var startVal = null, endVal = null;
    for (var k = 1; k <= prop.numKeys; k++) {
        if (Math.abs(prop.keyTime(k) - startTime) < 0.0001) startVal = prop.keyValue(k);
        if (Math.abs(prop.keyTime(k) - endTime)   < 0.0001) endVal   = prop.keyValue(k);
    }
    var valueDiff = 0;
    if (startVal !== null && endVal !== null) {
        if (typeof startVal === 'number') {
            valueDiff = Math.abs(endVal - startVal);
        } else if (startVal.length) {
            for (var d = 0; d < startVal.length; d++) {
                var dv = Math.abs(endVal[d] - startVal[d]);
                if (dv > valueDiff) valueDiff = dv;
            }
        }
    }

    for (var k = 1; k <= prop.numKeys; k++) {
        var t = prop.keyTime(k);
        if (t < startTime - 0.0001 || t > endTime + 0.0001) continue;

        var normT = (duration > 0) ? (t - startTime) / duration : 0;
        var ease  = getEaseAtT(points, normT, valueDiff, duration);

        try {
            prop.setInterpolationTypeAtKey(k,
                KeyframeInterpolationType.BEZIER,
                KeyframeInterpolationType.BEZIER
            );
        } catch(e2) {}

        try {
            var newIn  = new KeyframeEase(ease.inSpeed,  Math.max(0.1, Math.min(99.9, ease.inInfluence)));
            var newOut = new KeyframeEase(ease.outSpeed, Math.max(0.1, Math.min(99.9, ease.outInfluence)));

            // Helper: build array of KeyframeEase dengan dimensi tertentu
            function mkArr(e, dim) {
                var arr = [];
                for (var d = 0; d < dim; d++) arr.push(e);
                return arr;
            }

            try {
                prop.setTemporalEaseAtKey(k, mkArr(newIn, 1), mkArr(newOut, 1));
            } catch(e2) {
                try {
                    prop.setTemporalEaseAtKey(k, mkArr(newIn, 2), mkArr(newOut, 2));
                } catch(e3) {
                    try {
                        prop.setTemporalEaseAtKey(k, mkArr(newIn, 3), mkArr(newOut, 3));
                    } catch(e4) {}
                }
            }
        } catch(e2) {}
    }
}


// ============================================================
// CURVE MATH: Hitung easing dari kurva bezier pada t (0-1)
// valueDiff = selisih nilai keyframe (buat konversi speed ke unit/detik)
// duration  = durasi segment dalam detik
// ============================================================

function getEaseAtT(points, t, valueDiff, duration) {
    var TEPS = 0.0005;
    if (!valueDiff || valueDiff <= 0) valueDiff = 1;
    if (!duration  || duration  <= 0) duration  = 1;

    // OUT ease: cp2 dari titik START segment
    var outInfluence = 33, outSpeed = 0;
    for (var i = 0; i < points.length - 1; i++) {
        if (Math.abs(points[i].x - t) < TEPS) {
            var p0 = points[i], p1 = points[i + 1];
            var segDur = p1.x - p0.x;
            if (segDur > TEPS) {
                var odx = p0.cp2x - p0.x;
                var ody = p0.cp2y - p0.y;
                outInfluence = Math.abs(odx) / segDur * 100;
                if (Math.abs(odx) > 0.001) {
                    outSpeed = Math.abs(ody / odx) * (valueDiff / duration);
                } else {
                    // handle vertikal: slope sangat besar
                    outSpeed = Math.abs(ody) / 0.001 * (valueDiff / duration);
                }
            }
            break;
        }
    }

    // IN ease: cp1 dari titik END segment sebelumnya
    var inInfluence = 33, inSpeed = 0;
    for (var j = 0; j < points.length - 1; j++) {
        if (Math.abs(points[j + 1].x - t) < TEPS) {
            var p0 = points[j], p1 = points[j + 1];
            var segDur = p1.x - p0.x;
            if (segDur > TEPS) {
                var idx = p1.x - p1.cp1x;
                var idy = p1.y - p1.cp1y;
                inInfluence = Math.abs(idx) / segDur * 100;
                if (Math.abs(idx) > 0.001) {
                    inSpeed = Math.abs(idy / idx) * (valueDiff / duration);
                } else {
                    // handle vertikal: slope sangat besar
                    inSpeed = Math.abs(idy) / 0.001 * (valueDiff / duration);
                }
            }
            break;
        }
    }

    return {
        outInfluence: Math.max(0.1, Math.min(99.9, outInfluence)),
        inInfluence:  Math.max(0.1, Math.min(99.9, inInfluence)),
        outSpeed:     outSpeed,
        inSpeed:      inSpeed
    };
}

// ============================================================
// VALUE INTERPOLATION
// ============================================================

function interpolateValue(startVal, endVal, t) {
    if (typeof startVal === "number") {
        return startVal + t * (endVal - startVal);
    }
    var result = [];
    for (var i = 0; i < startVal.length; i++) {
        result.push(startVal[i] + t * (endVal[i] - startVal[i]));
    }
    return result;
}

// ============================================================
// UTILITY
// ============================================================

function findKeyByTime(prop, time) {
    for (var k = 1; k <= prop.numKeys; k++) {
        if (Math.abs(prop.keyTime(k) - time) < 0.0001) return k;
    }
    return -1;
}

function getSelectedKeyframesInfo() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: "No active composition." });
        }

        var maxCount = 0;
        for (var li = 1; li <= comp.numLayers; li++) {
            var c = countSelectedKeysInProp(comp.layer(li));
            if (c > maxCount) maxCount = c;
        }

        return JSON.stringify({ success: true, keyCount: maxCount });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// Cek apakah semua property yang punya keyframe terpilih sudah separated (atau bukan Position)
// Return true = aman langsung apply, false = perlu tanya separate dulu
function checkSelectedAreSeparated() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) return false;
        for (var li = 1; li <= comp.numLayers; li++) {
            var layer = comp.layer(li);
            try {
                var transform = layer.property('ADBE Transform Group');
                if (!transform) continue;
                var pos = transform.property('ADBE Position');
                if (!pos) continue;
                // Kalau Position belum separated, cek apakah ada keyframe terpilih di sini
                if (!pos.dimensionsSeparated) {
                    for (var k = 1; k <= pos.numKeys; k++) {
                        if (pos.keySelected(k)) {
                            // Ada keyframe terpilih di Position yang belum separated → perlu alert
                            return JSON.stringify({ separated: false });
                        }
                    }
                }
            } catch(e) {}
        }
        // Semua position sudah separated, atau keyframe terpilih bukan di Position
        return JSON.stringify({ separated: true });
    } catch(e) {
        return JSON.stringify({ separated: false });
    }
}

function countSelectedKeysInProp(prop) {
    try {
        if (prop.numProperties !== undefined && prop.numProperties > 0) {
            var max = 0;
            for (var i = 1; i <= prop.numProperties; i++) {
                var c = countSelectedKeysInProp(prop.property(i));
                if (c > max) max = c;
            }
            return max;
        }
        if (!prop.isTimeVarying) return 0;
        var count = 0;
        for (var k = 1; k <= prop.numKeys; k++) {
            if (prop.keySelected(k)) count++;
        }
        return count;
    } catch(e) { return 0; }
}

// ============================================================
// BG IMAGE SAVE/LOAD via file (base64 encoded untuk keamanan transfer)
// ============================================================

function getExtDir() {
    var base = Folder.myDocuments.fsName;
    // Normalize backslash ke forward slash
    var normalized = '';
    for (var i = 0; i < base.length; i++) {
        normalized += base.charCodeAt(i) === 92 ? '/' : base[i];
    }
    return normalized + '/CurveFlow';
}

function ensureDir() {
    var dir = new Folder(getExtDir());
    if (!dir.exists) dir.create();
}

// Base64 encode/decode untuk ExtendScript
function b64Encode(str) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var out = '';
    for (var i = 0; i < str.length; i += 3) {
        var b0 = str.charCodeAt(i);
        var b1 = i+1 < str.length ? str.charCodeAt(i+1) : 0;
        var b2 = i+2 < str.length ? str.charCodeAt(i+2) : 0;
        out += chars[b0 >> 2];
        out += chars[((b0 & 3) << 4) | (b1 >> 4)];
        out += i+1 < str.length ? chars[((b1 & 15) << 2) | (b2 >> 6)] : '=';
        out += i+2 < str.length ? chars[b2 & 63] : '=';
    }
    return out;
}

function b64Decode(str) {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    var out = '';
    for (var i = 0; i < str.length; i += 4) {
        var e0 = chars.indexOf(str[i]);
        var e1 = chars.indexOf(str[i+1]);
        var e2 = chars.indexOf(str[i+2]);
        var e3 = chars.indexOf(str[i+3]);
        out += String.fromCharCode((e0 << 2) | (e1 >> 4));
        if (e2 !== 64) out += String.fromCharCode(((e1 & 15) << 4) | (e2 >> 2));
        if (e3 !== 64) out += String.fromCharCode(((e2 & 3) << 6) | e3);
    }
    return out;
}

// Simpan gambar sebagai file asli (jpg/gif) ke Documents/CurveFlow
function saveBgToFile(b64payload) {
    try {
        ensureDir();
        var decoded = b64Decode(b64payload);
        var parsed = eval('(' + decoded + ')');
        var dataUrl = parsed.bg;
        var isGif = parsed.isGif;
        // Ambil base64 data dari dataURL (hapus prefix "data:image/...;base64,")
        var commaIdx = dataUrl.indexOf(',');
        var base64Data = commaIdx >= 0 ? dataUrl.substring(commaIdx + 1) : dataUrl;
        var binary = b64Decode(base64Data);
        var ext = isGif ? 'gif' : 'jpg';
        // Hapus file lama
        var oldJpg = new File(getExtDir() + '/bg.jpg');
        var oldGif = new File(getExtDir() + '/bg.gif');
        if (oldJpg.exists) oldJpg.remove();
        if (oldGif.exists) oldGif.remove();
        // Tulis file baru
        var filePath = getExtDir() + '/bg.' + ext;
        var file = new File(filePath);
        file.encoding = 'binary';
        file.open('w');
        file.write(binary);
        file.close();
        // Simpan metadata - path dan isGif
        var meta = new File(getExtDir() + '/bg_meta.json');
        meta.encoding = 'UTF-8';
        meta.open('w');
        meta.write('{"path":' + JSON.stringify(filePath) + ',"isGif":' + (isGif ? 'true' : 'false') + '}');
        meta.close();
        return filePath;
    } catch(e) { return 'error:' + e.toString(); }
}

function loadBgFromFile() {
    try {
        var meta = new File(getExtDir() + '/bg_meta.json');
        if (!meta.exists) return '';
        meta.encoding = 'UTF-8';
        meta.open('r');
        var raw = meta.read();
        meta.close();
        var parsed = eval('(' + raw + ')');
        var rawPath = parsed.path;
        var normalPath = '';
        for (var pi = 0; pi < rawPath.length; pi++) {
            normalPath += rawPath.charCodeAt(pi) === 92 ? '/' : rawPath[pi];
        }
        var file = new File(normalPath);
        if (!file.exists) return '';
        var cropStr = parsed.crop || '0|0|100';
        return normalPath + '||' + (parsed.isGif ? '1' : '0') + '||' + cropStr;
    } catch(e) { return ''; }
}

// GIF chunked save
var _gifChunkBuffer = '';

// Copy GIF langsung dari path asli + simpan crop info
function copyBgGifFromPath(srcPath, cropInfo) {
    try {
        ensureDir();
        var src = new File(srcPath);
        if (!src.exists) return 'error: source not found: ' + srcPath;
        var oldJpg = new File(getExtDir() + '/bg.jpg');
        var oldGif = new File(getExtDir() + '/bg.gif');
        if (oldJpg.exists) oldJpg.remove();
        if (oldGif.exists) oldGif.remove();
        var destPath = getExtDir() + '/bg.gif';
        src.copy(destPath);
        // Simpan metadata + crop info (px|py|scale)
        var cropStr = cropInfo || '0|0|100';
        var meta = new File(getExtDir() + '/bg_meta.json');
        meta.encoding = 'UTF-8';
        meta.open('w');
        meta.write('{"path":"' + destPath + '","isGif":true,"crop":"' + cropStr + '"}');
        meta.close();
        return destPath;
    } catch(e) { return 'error:' + e.toString(); }
}

function saveBgGifInit() {
    _gifChunkBuffer = '';
    return 'ok';
}

function saveBgGifChunk(chunk) {
    _gifChunkBuffer += chunk;
    return 'ok';
}

function saveBgGifFinalize() {
    try {
        ensureDir();
        var binary = b64Decode(_gifChunkBuffer);
        _gifChunkBuffer = '';
        var oldJpg = new File(getExtDir() + '/bg.jpg');
        var oldGif = new File(getExtDir() + '/bg.gif');
        if (oldJpg.exists) oldJpg.remove();
        if (oldGif.exists) oldGif.remove();
        var filePath = getExtDir() + '/bg.gif';
        var file = new File(filePath);
        file.encoding = 'binary';
        file.open('w');
        file.write(binary);
        file.close();
        var meta = new File(getExtDir() + '/bg_meta.json');
        meta.encoding = 'UTF-8';
        meta.open('w');
        meta.write('{"path":"' + filePath + '","isGif":true}');
        meta.close();
        return filePath;
    } catch(e) { return 'error:' + e.toString(); }
}

function clearBgFromFile() {
    try {
        var jpg = new File(getExtDir() + '/bg.jpg');
        var gif = new File(getExtDir() + '/bg.gif');
        var meta = new File(getExtDir() + '/bg_meta.json');
        if (jpg.exists) jpg.remove();
        if (gif.exists) gif.remove();
        if (meta.exists) meta.remove();
        return 'ok';
    } catch(e) { return 'error: ' + e.toString(); }
}
