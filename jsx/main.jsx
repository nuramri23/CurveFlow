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
 * anggi tools - ExtendScript (JSX)
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

        app.beginUndoGroup("anggi tools Apply");

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
        var absValDiff = 0;
        if (typeof startVal === 'number') {
            absValDiff = Math.abs(endVal - startVal);
        } else if (startVal.length) {
            var maxAbs = 0;
            for (var d = 0; d < startVal.length; d++) {
                var dv = Math.abs(endVal[d] - startVal[d]);
                if (dv > maxAbs) maxAbs = dv;
            }
            absValDiff = maxAbs;
        }

        // Cek ease di keyframe pertama (normT=0) dan terakhir (normT=1)
        var e0 = getEaseAtT(points, 0, absValDiff, duration);
        var e1 = getEaseAtT(points, 1, absValDiff, duration);

        return prop.name + ' vd:' + absValDiff.toFixed(0) + ' dur:' + duration.toFixed(2) +
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
// FLIP POINTS: Mirror kurva secara vertikal (untuk value negatif)
// ============================================================

function flipPoints(points) {
    var flipped = [];
    for (var i = 0; i < points.length; i++) {
        var pt = points[i];
        flipped.push({
            x:    pt.x,
            y:    1 - pt.y,
            cp1x: pt.cp1x,
            cp1y: 1 - pt.cp1y,
            cp2x: pt.cp2x,
            cp2y: 1 - pt.cp2y,
            isNew: pt.isNew
        });
    }
    return flipped;
}

// ============================================================
// EASING: Apply bezier ke semua keyframe dalam range waktu
// ============================================================


function applyEasingToRange(prop, startTime, endTime, points) {
    var duration = endTime - startTime;

    // Hitung valueDiff signed — AE KeyframeEase.speed bisa negatif,
    // tanda negatif menentukan arah grafik speed di graph editor.
    var startVal = null, endVal = null;
    for (var k = 1; k <= prop.numKeys; k++) {
        if (Math.abs(prop.keyTime(k) - startTime) < 0.0001) startVal = prop.keyValue(k);
        if (Math.abs(prop.keyTime(k) - endTime)   < 0.0001) endVal   = prop.keyValue(k);
    }
    var valueDiff = 0;
    if (startVal !== null && endVal !== null) {
        if (typeof startVal === 'number') {
            valueDiff = endVal - startVal;
        } else if (startVal.length) {
            var maxAbs = 0;
            for (var d = 0; d < startVal.length; d++) {
                var dv = endVal[d] - startVal[d];
                if (Math.abs(dv) > maxAbs) { maxAbs = Math.abs(dv); valueDiff = dv; }
            }
        }
    }

    var pts = points;

    for (var k = 1; k <= prop.numKeys; k++) {
        var t = prop.keyTime(k);
        if (t < startTime - 0.0001 || t > endTime + 0.0001) continue;

        var normT = (duration > 0) ? (t - startTime) / duration : 0;
        var ease  = getEaseAtT(pts, normT, valueDiff, duration);

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
    // Guard: kalau 0 pakai 1, tapi tanda negatif dibiarkan — AE speed bisa negatif.
    if (!valueDiff) valueDiff = 1;
    if (!duration  || duration <= 0) duration = 1;

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
                    outSpeed = (ody / odx) * (valueDiff / duration);
                } else {
                    outSpeed = ody / 0.001 * (valueDiff / duration);
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
                    inSpeed = (idy / idx) * (valueDiff / duration);
                } else {
                    inSpeed = idy / 0.001 * (valueDiff / duration);
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
    return normalized + '/anggi tools';
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

// Simpan gambar sebagai file asli (jpg/gif) ke Documents/anggi tools
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

// ============================================================
// PRESET SAVE/LOAD via file (Documents/anggi tools/presets.json)
// ============================================================

function savePresetsToFile(b64Str, isBase64) {
    try {
        ensureDir();
        var jsonStr = isBase64 ? b64Decode(b64Str) : b64Str;
        // b64Decode menghasilkan raw bytes, decode UTF-8 manual
        try { jsonStr = decodeURIComponent(escape(jsonStr)); } catch(e2) {}
        var file = new File(getExtDir() + '/presets.json');
        file.encoding = 'UTF-8';
        file.open('w');
        file.write(jsonStr);
        file.close();
        return 'ok';
    } catch(e) { return 'error: ' + e.toString(); }
}

function loadPresetsFromFile() {
    try {
        var file = new File(getExtDir() + '/presets.json');
        if (!file.exists) return '{}';
        file.encoding = 'UTF-8';
        file.open('r');
        var content = file.read();
        file.close();
        return content;
    } catch(e) { return '{}'; }
}

function exportPresetsToFile(jsonStr) {
    try {
        ensureDir();
        var file = new File(getExtDir() + '/presets.json');
        file.encoding = 'UTF-8';
        file.open('w');
        file.write(jsonStr);
        file.close();
        return getExtDir() + '/presets.json';
    } catch(e) { return 'error: ' + e.toString(); }
}

function exportPresetsWithDialog(b64Str) {
    try {
        var jsonStr = b64Decode(b64Str);
        try { jsonStr = decodeURIComponent(escape(jsonStr)); } catch(e2) {}
        var file = File.saveDialog('Export anggi tools Presets', '*.json');
        if (!file) return 'cancelled';
        var path = file.fsName;
        if (path.substring(path.length - 5).toLowerCase() !== '.json') {
            path = path + '.json';
            file = new File(path);
        }
        file.encoding = 'UTF-8';
        file.open('w');
        file.write(jsonStr);
        file.close();
        return path;
    } catch(e) { return 'error: ' + e.toString(); }
}

// ============================================================
// ANCHOR POINT TOOL
// ============================================================
// posKey: 'tl','tc','tr','ml','mc','mr','bl','bc','br'
function setAnchorPoint(posKey) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: 'No active composition.' });
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return JSON.stringify({ success: false, error: 'No layer selected.' });
        }

        var vChar = posKey.charAt(0); // t / m / b
        var hChar = posKey.charAt(1); // l / c / r
        var vMap = { t: 0, m: 0.5, b: 1 };
        var hMap = { l: 0, c: 0.5, r: 1 };
        if (!(vChar in vMap) || !(hChar in hMap)) {
            return JSON.stringify({ success: false, error: 'Invalid anchor position.' });
        }

        app.beginUndoGroup('Anggi Tools - Set Anchor Point');

        var affected = 0;
        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            try {
                if (!(layer.hasOwnProperty('anchorPoint'))) continue;
                var t = comp.time;
                var rect = layer.sourceRectAtTime(t, false);
                if (!rect) continue;

                var newAnchorX = rect.left + rect.width * hMap[hChar];
                var newAnchorY = rect.top + rect.height * vMap[vChar];

                var anchorProp = layer.property('ADBE Transform Group').property('ADBE Anchor Point');
                var posProp = layer.property('ADBE Transform Group').property('ADBE Position');
                var scaleProp = layer.property('ADBE Transform Group').property('ADBE Scale');

                var oldAnchor = anchorProp.value; // [x,y] atau [x,y,z]
                var scale = scaleProp ? scaleProp.value : [100,100,100];
                var sx = scale[0] / 100, sy = scale[1] / 100;

                // Selisih anchor (layer space) dikonversi ke world-space delta,
                // memperhitungkan scale, supaya posisi visual layer tidak berubah.
                var dx = (newAnchorX - oldAnchor[0]) * sx;
                var dy = (newAnchorY - oldAnchor[1]) * sy;

                // Set anchor point (pertahankan Z jika ada)
                if (oldAnchor.length > 2) {
                    anchorProp.setValue([newAnchorX, newAnchorY, oldAnchor[2]]);
                } else {
                    anchorProp.setValue([newAnchorX, newAnchorY]);
                }

                // Kompensasi Position supaya layer tidak geser secara visual.
                // Jika Position punya keyframe, set value di waktu current time
                // supaya tetap konsisten dengan animasi yang ada.
                var oldPos = posProp.value;
                var newPos;
                if (oldPos.length > 2) {
                    newPos = [oldPos[0] + dx, oldPos[1] + dy, oldPos[2]];
                } else {
                    newPos = [oldPos[0] + dx, oldPos[1] + dy];
                }

                if (posProp.dimensionsSeparated) {
                    var xProp = posProp.property(1);
                    var yProp = posProp.property(2);
                    if (xProp.numKeys > 0) xProp.setValueAtTime(t, newPos[0]); else xProp.setValue(newPos[0]);
                    if (yProp.numKeys > 0) yProp.setValueAtTime(t, newPos[1]); else yProp.setValue(newPos[1]);
                } else {
                    if (posProp.numKeys > 0) posProp.setValueAtTime(t, newPos); else posProp.setValue(newPos);
                }

                affected++;
            } catch(e) {}
        }

        app.endUndoGroup();

        if (affected === 0) {
            return JSON.stringify({ success: false, error: 'No compatible layer to modify.' });
        }
        return JSON.stringify({ success: true, affected: affected });
    } catch (e) {
        try { app.endUndoGroup(); } catch(e2) {}
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ============================================================
// ALIGN LAYERS
// ============================================================
// mode: 'left','hcenter','right','top','vcenter','bottom'
// target: 'comp' | 'selection'
function alignLayers(mode, target) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: 'No active composition.' });
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return JSON.stringify({ success: false, error: 'No layer selected.' });
        }

        var t = comp.time;

        // Hitung bounding box dunia (composition space) untuk sebuah layer,
        // memakai sourceRectAtTime + posisi + scale (rotasi diabaikan, cukup untuk kasus umum).
        function worldBounds(layer) {
            var rect = layer.sourceRectAtTime(t, false);
            var pos = layer.property('ADBE Transform Group').property('ADBE Position').value;
            var anchor = layer.property('ADBE Transform Group').property('ADBE Anchor Point').value;
            var scaleProp = layer.property('ADBE Transform Group').property('ADBE Scale');
            var scale = scaleProp ? scaleProp.value : [100,100,100];
            var sx = scale[0] / 100, sy = scale[1] / 100;

            var left   = pos[0] + (rect.left - anchor[0]) * sx;
            var top    = pos[1] + (rect.top - anchor[1]) * sy;
            var right  = left + rect.width * sx;
            var bottom = top + rect.height * sy;
            return { left: left, top: top, right: right, bottom: bottom,
                     width: right - left, height: bottom - top,
                     pos: pos };
        }

        // Target bounds: composition, atau union bounding box dari layer terpilih
        var targetBounds;
        if (target === 'selection' && sel.length > 1) {
            var minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
            for (var i = 0; i < sel.length; i++) {
                var b = worldBounds(sel[i]);
                if (b.left < minL) minL = b.left;
                if (b.top < minT) minT = b.top;
                if (b.right > maxR) maxR = b.right;
                if (b.bottom > maxB) maxB = b.bottom;
            }
            targetBounds = { left: minL, top: minT, right: maxR, bottom: maxB,
                              width: maxR - minL, height: maxB - minT };
        } else {
            targetBounds = { left: 0, top: 0, right: comp.width, bottom: comp.height,
                              width: comp.width, height: comp.height };
        }

        app.beginUndoGroup('Anggi Tools - Align Layers');

        var affected = 0;
        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            try {
                var posProp = layer.property('ADBE Transform Group').property('ADBE Position');
                var b = worldBounds(layer);
                var pos = posProp.value;
                var newX = pos[0], newY = pos[1];

                if (mode === 'left')    newX = pos[0] + (targetBounds.left - b.left);
                else if (mode === 'hcenter') newX = pos[0] + (targetBounds.left + targetBounds.width/2) - (b.left + b.width/2);
                else if (mode === 'right')   newX = pos[0] + (targetBounds.right - b.right);
                else if (mode === 'top')     newY = pos[1] + (targetBounds.top - b.top);
                else if (mode === 'vcenter') newY = pos[1] + (targetBounds.top + targetBounds.height/2) - (b.top + b.height/2);
                else if (mode === 'bottom')  newY = pos[1] + (targetBounds.bottom - b.bottom);

                var newPos = pos.length > 2 ? [newX, newY, pos[2]] : [newX, newY];

                if (posProp.dimensionsSeparated) {
                    var xProp = posProp.property(1);
                    var yProp = posProp.property(2);
                    if (xProp.numKeys > 0) xProp.setValueAtTime(t, newPos[0]); else xProp.setValue(newPos[0]);
                    if (yProp.numKeys > 0) yProp.setValueAtTime(t, newPos[1]); else yProp.setValue(newPos[1]);
                } else {
                    if (posProp.numKeys > 0) posProp.setValueAtTime(t, newPos); else posProp.setValue(newPos);
                }

                affected++;
            } catch(e) {}
        }

        app.endUndoGroup();

        if (affected === 0) {
            return JSON.stringify({ success: false, error: 'No compatible layer to modify.' });
        }
        return JSON.stringify({ success: true, affected: affected });
    } catch (e) {
        try { app.endUndoGroup(); } catch(e2) {}
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ============================================================
// SEQUENCE LAYERS
// ============================================================
// Stagger startTime layer terpilih berurutan berdasarkan urutan index (atas/bawah).
// offsetFrames: jarak frame antar grup layer
// step: jumlah layer per grup sebelum offset berikutnya diterapkan
// order: 'top' (urut dari layer paling atas) | 'bottom' (dari paling bawah)
// ============================================================
// SEQUENCE — auto-detect keyframe vs layer, anchor playhead/original, arah stacking
// ============================================================
// anchorMode: 'playhead' | 'original'
// direction: 'top' (atas->bawah, default) | 'bottom' (bawah->atas)
// offsetFrames, step: dibaca dari UI (Num / Step)

// ============================================================
// SEQUENCE HELPERS
// ============================================================

// Konversi waktu ke frame (integer) untuk perbandingan presisi
function seqTimeToFrames(time, fd) {
    return Math.round(time / fd);
}

// Selisih antara inPoint dan startTime suatu layer (buat kompensasi trim)
function seqGetStartTimeOffset(layer) {
    return layer.inPoint - layer.startTime;
}

// Cek apakah layer sudah ter-sequence — persis checkLayersForSequence + isLayersInSequence motol
function seqCheckLayersForSequence(layers) {
    if (layers.length === 1) return true;
    if (layers.length === 2) return Math.round(layers[1].inPoint / layers[1].containingComp.frameDuration) -
                                    Math.round(layers[0].inPoint / layers[1].containingComp.frameDuration);
    for (var i = 0; i < layers.length - 2; i++) {
        var fd   = layers[i].containingComp.frameDuration;
        var t0   = Math.round(layers[i].inPoint / fd);
        var t1   = Math.round(layers[i+1].inPoint / fd);
        var t2   = Math.round(layers[i+2].inPoint / fd);
        if ((t1 - t0) !== (t2 - t1)) return false;
    }
    var fd2 = layers[0].containingComp.frameDuration;
    return Math.round(layers[1].inPoint / fd2) - Math.round(layers[0].inPoint / fd2);
}

function seqIsLayersInSequence(layers, step, offsetFrames, fd) {
    if (layers.length < 2) return false;
    var inPoint0 = Math.round(layers[0].inPoint / fd);
    // Layer dalam grup ke-0 (index 0..(step-1)) harus semua sama dengan layer[0].inPoint
    var len = Math.min(step, layers.length);
    for (var i = 0; i < len; i++) {
        if (Math.round(layers[i].inPoint / fd) !== inPoint0) return false;
    }
    // Buat sub-array per-group dan cek jarak antar group konsisten
    var prewDif;
    for (var i = 0; i < len; i++) {
        var subArr = [];
        var y = i;
        while (y < layers.length) { subArr.push(layers[y]); y += step; }
        var dif = seqCheckLayersForSequence(subArr);
        if (dif === false) return false;
        if (prewDif === undefined) { prewDif = dif; }
        else if (dif !== true && dif !== prewDif) return false;
    }
    return true;
}

// Cek apakah keyframe props sudah ter-sequence
function seqCheckPropsForSequence(props) {
    if (props.length === 1) return true;
    if (props.length === 2) {
        var t0 = props[0].keys[0].time, t1 = props[1].keys[0].time;
        var fd = props[0].prop.containingLayer().containingComp.frameDuration;
        return Math.round(t1/fd) - Math.round(t0/fd);
    }
    var fd = props[0].prop.containingLayer().containingComp.frameDuration;
    for (var i = 0; i < props.length - 2; i++) {
        var a = Math.round(props[i].keys[0].time / fd);
        var b = Math.round(props[i+1].keys[0].time / fd);
        var c = Math.round(props[i+2].keys[0].time / fd);
        if ((b - a) !== (c - b)) return false;
    }
    var fa = Math.round(props[0].keys[0].time / fd);
    var fb = Math.round(props[1].keys[0].time / fd);
    return fb - fa;
}

function seqIsPropsInSequence(allProps, step, offsetFrames, fd) {
    if (allProps.length < 2) return false;
    var inPoint0 = Math.round(allProps[0].keys[0].time / fd);
    var len = Math.min(step, allProps.length);
    for (var i = 0; i < len; i++) {
        if (Math.round(allProps[i].keys[0].time / fd) !== inPoint0) return false;
    }
    var prewDif;
    for (var i = 0; i < len; i++) {
        var subArr = [];
        var y = i;
        while (y < allProps.length) { subArr.push(allProps[y]); y += step; }
        var dif = seqCheckPropsForSequence(subArr);
        if (dif === false) return false;
        if (prewDif === undefined) { prewDif = dif; }
        else if (dif !== true && dif !== prewDif) return false;
    }
    return true;
}

// Kumpulkan leaf-property yang punya keyframe terpilih per layer,
// beserta snapshot easing/interpolasi untuk preserve setelah digeser.
function collectSelectedKeyGroupsInLayer(layer) {
    var groups = [];
    function walk(pg) {
        if (pg.numProperties !== undefined && pg.numProperties > 0 &&
            pg.propertyType !== PropertyType.PROPERTY) {
            for (var i = 1; i <= pg.numProperties; i++) {
                try { walk(pg.property(i)); } catch(e) {}
            }
            return;
        }
        if (!pg.isTimeVarying) return;
        var selIdx = [];
        for (var k = 1; k <= pg.numKeys; k++) {
            if (pg.keySelected(k)) selIdx.push(k);
        }
        if (selIdx.length === 0) return;

        // Snapshot: waktu, nilai, dan semua interpolasi tiap key terpilih
        var keys = [];
        for (var k = 0; k < selIdx.length; k++) {
            var ki = selIdx[k];
            var snap = {
                time:           pg.keyTime(ki),
                value:          pg.keyValue(ki),
                inInterp:       pg.keyInInterpolationType(ki),
                outInterp:      pg.keyOutInterpolationType(ki),
                inEase:         null,
                outEase:        null,
                autoBezier:     false,
                continuous:     false,
                inSpatial:      null,
                outSpatial:     null,
                spatialAuto:    false,
                spatialCont:    false
            };
            try { snap.inEase  = pg.keyInTemporalEase(ki);  } catch(e) {}
            try { snap.outEase = pg.keyOutTemporalEase(ki); } catch(e) {}
            try { snap.autoBezier = pg.keyTemporalAutoBezier(ki); } catch(e) {}
            try { snap.continuous = pg.keyTemporalContinuous(ki); } catch(e) {}
            var isSpatial = (pg.propertyValueType === PropertyValueType.ThreeD_SPATIAL ||
                             pg.propertyValueType === PropertyValueType.TwoD_SPATIAL);
            if (isSpatial) {
                try { snap.inSpatial   = pg.keyInSpatialTangent(ki);  } catch(e) {}
                try { snap.outSpatial  = pg.keyOutSpatialTangent(ki); } catch(e) {}
                try { snap.spatialAuto = pg.keySpatialAutoBezier(ki); } catch(e) {}
                try { snap.spatialCont = pg.keySpatialContinuous(ki); } catch(e) {}
            }
            keys.push(snap);
        }
        // Urutkan berdasarkan waktu ascending
        keys.sort(function(a, b) { return a.time - b.time; });
        groups.push({ prop: pg, keys: keys });
    }
    try { walk(layer); } catch(e) {}
    return groups;
}

// Pindahkan satu keyframe ke waktu baru, lalu restore interpolasi/easing.
// Mengikuti pola motol: insert dulu di waktu baru, hapus yang lama.
function seqMoveKey(prop, snap, newTime) {
    var oldTime = snap.time;
    if (seqTimeToFrames(newTime, 0.001) === seqTimeToFrames(oldTime, 0.001)) return newTime;

    // Insert value di waktu baru
    try { prop.setValueAtTime(newTime, snap.value); } catch(e) { return oldTime; }

    // Hapus key lama
    var oldIdx = prop.nearestKeyIndex(oldTime);
    if (Math.abs(prop.keyTime(oldIdx) - oldTime) < 0.0002) {
        try { prop.removeKey(oldIdx); } catch(e) {}
    }

    // Restore interpolasi & easing di key baru
    var newIdx = prop.nearestKeyIndex(newTime);
    try {
        prop.setInterpolationTypeAtKey(newIdx, snap.inInterp, snap.outInterp);
    } catch(e) {}
    var isSpatial = (prop.propertyValueType === PropertyValueType.ThreeD_SPATIAL ||
                     prop.propertyValueType === PropertyValueType.TwoD_SPATIAL);
    if (isSpatial) {
        try { prop.setSpatialTangentsAtKey(newIdx, snap.inSpatial, snap.outSpatial); } catch(e) {}
        try { prop.setSpatialAutoBezierAtKey(newIdx, snap.spatialAuto); } catch(e) {}
        try { prop.setSpatialContinuousAtKey(newIdx, snap.spatialCont); } catch(e) {}
    }
    if (snap.inInterp === KeyframeInterpolationType.BEZIER ||
        snap.outInterp === KeyframeInterpolationType.BEZIER) {
        if (snap.inEase && snap.outEase) {
            try { prop.setTemporalEaseAtKey(newIdx, snap.inEase, snap.outEase); } catch(e) {}
        }
        try { prop.setTemporalAutoBezierAtKey(newIdx, snap.autoBezier); } catch(e) {}
        try { prop.setTemporalContinuousAtKey(newIdx, snap.continuous); } catch(e) {}
    }
    return newTime;
}

// ============================================================
// SEQUENCE LAYERS
// ============================================================
// anchorMode : 'playhead' | 'original'
// direction  : 'top' (atas→bawah) | 'bottom' (bawah→atas)
//
// MODE KEYFRAME (ada keyframe terpilih):
//   Keyframe pertama tiap layer disejajarkan ke keyframe pertama
//   layer ACUAN (layer pertama dalam urutan setelah sort), lalu
//   di-offset sebesar groupIdx * offsetFrames frame. Jarak antar
//   keyframe dalam satu layer dipertahankan. Easing di-preserve.
//
// MODE LAYER (tidak ada keyframe terpilih):
//   startTime tiap layer digeser, pakai inPoint sebagai acuan
//   (seperti motol) sehingga trim layer tidak bergeser secara visual.
// ============================================================
function sequenceLayers(offsetFrames, step, anchorMode, direction) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: 'No active composition.' });
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return JSON.stringify({ success: false, error: 'No layer selected.' });
        }

        offsetFrames = parseInt(offsetFrames, 10);
        if (isNaN(offsetFrames)) offsetFrames = 1;
        step = Math.abs(parseInt(step, 10));
        if (isNaN(step) || step < 1) step = 1;
        anchorMode = (anchorMode === 'playhead') ? 'playhead' : 'original';
        var reverse = (direction === 'bottom');

        var fd = comp.frameDuration;
        var playheadT = comp.time;

        // Urutkan berdasarkan stacking order; balik kalau bottom
        var layers = sel.slice ? sel.slice() : Array.prototype.slice.call(sel);
        layers.sort(function(a, b) { return a.index - b.index; });
        if (reverse) layers.reverse();

        app.beginUndoGroup('Anggi Tools - Sequence');

        var affected = 0;
        var mode = 'layer';

        // Kumpulkan keyframe terpilih per layer
        var perLayerKeyGroups = [];
        var anyKeySelected = false;
        for (var i = 0; i < layers.length; i++) {
            var grp = collectSelectedKeyGroupsInLayer(layers[i]);
            perLayerKeyGroups.push(grp);
            if (grp.length > 0) anyKeySelected = true;
        }

        if (anyKeySelected) {
            // ---- MODE KEYFRAME ----
            // Persis motol moveKeys (tanpa random):
            //   isPropsInSequence == false → startTime = times[0] prop pertama (susun dari awal)
            //   isPropsInSequence == true  → startTime = true (tiap prop pakai awalnya sendiri → accumulate)
            mode = 'keyframe';

            // Flatten props urut per layer
            var allProps = [];
            for (var i = 0; i < layers.length; i++) {
                var grp = perLayerKeyGroups[i];
                for (var g = 0; g < grp.length; g++) {
                    allProps.push({ prop: grp[g].prop, keys: grp[g].keys, layerIdx: i });
                }
            }

            var startTime;
            if (anchorMode === 'playhead') {
                startTime = playheadT;
            } else if (!seqIsPropsInSequence(allProps, step, offsetFrames, fd)) {
                startTime = allProps[0].keys[0].time;
            } else {
                startTime = true; // accumulate: tiap prop pakai keyframe pertamanya sendiri
            }

            var keyTimes = []; // untuk re-select
            for (var i = 0; i < allProps.length; i++) {
                keyTimes.push({ prop: allProps[i].prop, times: [] });
            }

            for (var i = 0; i < allProps.length; i++) {
                var prop     = allProps[i].prop;
                var keys     = allProps[i].keys;
                var layerIdx = allProps[i].layerIdx;

                var sT = false;
                if (startTime === true) {
                    sT = true;
                    startTime = keys[0].time;
                }

                var groupIdx   = Math.floor(layerIdx / step);
                var timeOffset = (anchorMode === 'playhead') ? 0 : groupIdx * offsetFrames * fd;

                var firstKeyTime = keys[0].time;

                // Tentukan arah geser (motol: cek apakah key perlu ke kiri atau kanan)
                var start, condition, inc;
                if (keys[0].time > (startTime + timeOffset)) {
                    start = keys.length - 1; condition = -1; inc = -1;
                } else {
                    start = 0; condition = keys.length; inc = 1;
                }

                // Snapshot newTime dulu (seperti motol: getKeyObj dulu, baru moveKey)
                var newTimes = [];
                for (var kk = 0; kk < keys.length; kk++) {
                    newTimes.push(startTime + timeOffset + (keys[kk].time - firstKeyTime));
                }

                // Geser key sesuai arah
                for (var kk = start; kk !== condition; kk += inc) {
                    seqMoveKey(prop, keys[kk], newTimes[kk]);
                }

                // Catat waktu baru untuk re-select
                for (var kk = 0; kk < newTimes.length; kk++) {
                    keyTimes[i].times.push(newTimes[kk]);
                }

                if (sT) startTime = true;
                affected++;
            }

            // Re-select
            for (var i = 0; i < keyTimes.length; i++) {
                for (var x = 0; x < keyTimes[i].times.length; x++) {
                    try {
                        var idx = keyTimes[i].prop.nearestKeyIndex(keyTimes[i].times[x]);
                        keyTimes[i].prop.setSelectedAtKey(idx, true);
                    } catch(e) {}
                }
            }

        } else {
            // ---- MODE LAYER ----
            // Persis motol doSequence layer branch:
            //   isLayersInSequence == false → startTime = inPoint layer[0] (susun dari awal)
            //   isLayersInSequence == true  → startTime = layer.inPoint sendiri (accumulate)
            mode = 'layer';

            if (anchorMode === 'playhead') {
                for (var i = 0; i < layers.length; i++) {
                    try {
                        layers[i].startTime = playheadT - seqGetStartTimeOffset(layers[i]);
                        affected++;
                    } catch(e) {}
                }
            } else {
                var inPoint   = layers[0].inPoint;
                var sequenced = seqIsLayersInSequence(layers, step, offsetFrames, fd);

                for (var i = 0; i < layers.length; i++) {
                    try {
                        var off       = Math.floor(i / step);
                        var startTime = sequenced ? layers[i].inPoint : inPoint;
                        layers[i].startTime = (startTime - seqGetStartTimeOffset(layers[i])) + (off * offsetFrames * fd);
                        affected++;
                    } catch(e) {}
                }
            }
        }

        app.endUndoGroup();

        if (affected === 0) {
            return JSON.stringify({ success: false, error: 'Nothing to sequence.' });
        }
        return JSON.stringify({ success: true, affected: affected, mode: mode });
    } catch (e) {
        try { app.endUndoGroup(); } catch(e2) {}
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ============================================================
// EXTRACT — pisah tiap top-level group di dalam shape layer jadi layer terpisah
// ============================================================
function extractShapeGroups(deleteSource) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: 'No active composition.' });
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return JSON.stringify({ success: false, error: 'No layer selected.' });
        }

        app.beginUndoGroup('Anggi Tools - Extract Shape Groups');

        var affected = 0;
        var toRemove = [];
        for (var i = 0; i < sel.length; i++) {
            var srcLayer = sel[i];
            if (!(srcLayer instanceof ShapeLayer)) continue;

            var rootContents = srcLayer.property('ADBE Root Vectors Group');
            if (!rootContents || rootContents.numProperties < 2) continue; // cuma 1 group, tidak perlu di-extract

            var groupCount = rootContents.numProperties;
            for (var g = 1; g <= groupCount; g++) {
                var srcGroup = rootContents.property(g);
                if (srcGroup.matchName !== 'ADBE Vector Group') continue;

                var newLayer = srcLayer.duplicate();
                var newRoot = newLayer.property('ADBE Root Vectors Group');
                // Hapus semua group di layer baru kecuali group ke-g
                for (var r = newRoot.numProperties; r >= 1; r--) {
                    if (r !== g) { try { newRoot.property(r).remove(); } catch(e) {} }
                }
                newLayer.name = srcGroup.name;
                affected++;
            }

            if (deleteSource) toRemove.push(srcLayer);
        }

        for (var d = 0; d < toRemove.length; d++) {
            try { toRemove[d].remove(); } catch(e) {}
        }

        app.endUndoGroup();

        if (affected === 0) {
            return JSON.stringify({ success: false, error: 'Select shape layer(s) with more than 1 group.' });
        }
        return JSON.stringify({ success: true, affected: affected });
    } catch (e) {
        try { app.endUndoGroup(); } catch(e2) {}
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ============================================================
// MERGE — gabungkan beberapa shape layer terpilih jadi satu shape layer
// ============================================================
// Salin 1 property (leaf, bukan group) dari src ke dst, termasuk keyframe & expression.
function copyLeafProperty(srcProp, dstProp) {
    try {
        if (srcProp.numKeys > 0) {
            for (var k = 1; k <= srcProp.numKeys; k++) {
                dstProp.setValueAtTime(srcProp.keyTime(k), srcProp.keyValue(k));
                try {
                    dstProp.setInterpolationTypeAtKey(k, srcProp.keyInInterpolationType(k), srcProp.keyOutInterpolationType(k));
                } catch(e) {}
            }
        } else {
            dstProp.setValue(srcProp.value);
        }
        if (srcProp.expressionEnabled) {
            try { dstProp.expression = srcProp.expression; } catch(e) {}
        }
    } catch(e) {}
}

// Salin sebuah PropertyGroup (mis. ADBE Vector Group) secara rekursif dari src ke
// parent tujuan (dstParent), dengan membuat ulang tiap sub-property/group memakai
// addProperty(matchName). Ini tidak bergantung pada clipboard UI sehingga reliable
// dipanggil murni lewat ExtendScript API.
function copyPropertyGroupRecursive(srcGroup, dstParent) {
    var newGroup;
    try {
        newGroup = dstParent.addProperty(srcGroup.matchName);
    } catch(e) { return null; }
    if (!newGroup) return null;
    try { newGroup.name = srcGroup.name; } catch(e) {}

    var count = srcGroup.numProperties;
    if (count === undefined) return newGroup;

    for (var i = 1; i <= count; i++) {
        var srcChild;
        try { srcChild = srcGroup.property(i); } catch(e) { continue; }
        if (!srcChild) continue;

        // Skip stroke
        if (srcChild.matchName === 'ADBE Vector Graphic - Stroke') continue;

        if (srcChild.numProperties !== undefined && srcChild.propertyType !== PropertyType.PROPERTY) {
            // Child adalah group lagi (mis. nested group / sub-shape) — rekursif
            copyPropertyGroupRecursive(srcChild, newGroup);
        } else {
            // Child adalah leaf property — cari counterpart di newGroup lalu salin value
            var dstChild;
            try { dstChild = newGroup.property(i); } catch(e) { dstChild = null; }
            if (dstChild && dstChild.numProperties === undefined) {
                copyLeafProperty(srcChild, dstChild);
            }
        }
    }
    return newGroup;
}

function mergeShapeLayers(deleteSource) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: 'No active composition.' });
        }
        var sel = comp.selectedLayers;
        var shapeLayers = [];
        for (var i = 0; i < sel.length; i++) {
            if (sel[i] instanceof ShapeLayer) shapeLayers.push(sel[i]);
        }
        if (shapeLayers.length < 2) {
            return JSON.stringify({ success: false, error: 'Select at least 2 shape layers.' });
        }
        shapeLayers.sort(function(a, b) { return a.index - b.index; });

        app.beginUndoGroup('Anggi Tools - Merge Shape Layers');

        var target = shapeLayers[0];
        var targetRoot = target.property('ADBE Root Vectors Group');
        var mergedGroups = 0;

        // Salin tiap top-level vector group dari layer sumber ke root target,
        // menggunakan penyalinan property rekursif murni via API (tanpa clipboard/UI).
        for (var i = 1; i < shapeLayers.length; i++) {
            var srcLayer = shapeLayers[i];
            var srcRoot = srcLayer.property('ADBE Root Vectors Group');
            if (!srcRoot || srcRoot.numProperties === 0) continue;

            // Hitung offset posisi src layer relatif ke target layer (world space)
            // supaya shape tidak geser setelah di-merge
            var t = comp.time;
            var srcPos    = srcLayer.property('ADBE Transform Group').property('ADBE Position').valueAtTime(t, false);
            var srcAnchor = srcLayer.property('ADBE Transform Group').property('ADBE Anchor Point').valueAtTime(t, false);
            var srcScale  = srcLayer.property('ADBE Transform Group').property('ADBE Scale').valueAtTime(t, false);
            var dstPos    = target.property('ADBE Transform Group').property('ADBE Position').valueAtTime(t, false);
            var dstAnchor = target.property('ADBE Transform Group').property('ADBE Anchor Point').valueAtTime(t, false);
            var dstScale  = target.property('ADBE Transform Group').property('ADBE Scale').valueAtTime(t, false);

            // Offset dalam layer space target
            var offsetX = (srcPos[0] - srcAnchor[0]) - (dstPos[0] - dstAnchor[0]);
            var offsetY = (srcPos[1] - srcAnchor[1]) - (dstPos[1] - dstAnchor[1]);
            // Koreksi scale target
            if (dstScale[0] !== 0) offsetX = offsetX / (dstScale[0] / 100);
            if (dstScale[1] !== 0) offsetY = offsetY / (dstScale[1] / 100);

            // Faktor scale relatif src → dst
            var scaleFactorX = (dstScale[0] !== 0) ? (srcScale[0] / dstScale[0]) : 1;
            var scaleFactorY = (dstScale[1] !== 0) ? (srcScale[1] / dstScale[1]) : 1;

            for (var g = 1; g <= srcRoot.numProperties; g++) {
                var srcGroup;
                try { srcGroup = srcRoot.property(g); } catch(e) { continue; }
                if (!srcGroup || srcGroup.matchName !== 'ADBE Vector Group') continue;

                var copied = copyPropertyGroupRecursive(srcGroup, targetRoot);
                if (!copied) continue;
                mergedGroups++;

                // Geser posisi group agar tetap di tempat semula secara visual
                if (offsetX !== 0 || offsetY !== 0) {
                    try {
                        var grpTransform = copied.property('ADBE Vector Transform Group');
                        var grpPos = grpTransform.property('ADBE Vector Position');
                        var curPos = grpPos.value;
                        grpPos.setValue([curPos[0] + offsetX, curPos[1] + offsetY]);
                    } catch(e) {}
                }

                // Apply scale faktor supaya ukuran shape tetap sama secara visual
                if (scaleFactorX !== 1 || scaleFactorY !== 1) {
                    try {
                        var grpTransform = copied.property('ADBE Vector Transform Group');
                        var grpScale = grpTransform.property('ADBE Vector Scale');
                        var curScale = grpScale.value;
                        grpScale.setValue([curScale[0] * scaleFactorX, curScale[1] * scaleFactorY]);
                    } catch(e) {}
                }
            }

            if (deleteSource) {
                try { srcLayer.remove(); } catch(e) {}
            } else {
                try { srcLayer.enabled = false; } catch(e) {}
            }
        }

        app.endUndoGroup();

        if (mergedGroups === 0) {
            return JSON.stringify({ success: false, error: 'Failed to merge shape layers.' });
        }
        return JSON.stringify({ success: true, affected: mergedGroups });
    } catch (e) {
        try { app.endUndoGroup(); } catch(e2) {}
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ============================================================
// ADD NULL — buat null baru & auto-parent ke layer terpilih
// ============================================================
function addNullParent() {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: 'No active composition.' });
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return JSON.stringify({ success: false, error: 'No layer selected.' });
        }

        app.beginUndoGroup('Anggi Tools - Add Null Parent');

        var t = comp.time;
        var minL = Infinity, minT = Infinity, maxR = -Infinity, maxB = -Infinity;
        var minIndex = sel[0].index;
        var minInPoint = sel[0].inPoint, maxOutPoint = sel[0].outPoint;

        for (var i = 0; i < sel.length; i++) {
            var layer = sel[i];
            if (layer.index < minIndex) minIndex = layer.index;
            if (layer.inPoint < minInPoint) minInPoint = layer.inPoint;
            if (layer.outPoint > maxOutPoint) maxOutPoint = layer.outPoint;
            try {
                var rect = layer.sourceRectAtTime(t, false);
                var pos = layer.property('ADBE Transform Group').property('ADBE Position').value;
                var anchor = layer.property('ADBE Transform Group').property('ADBE Anchor Point').value;
                var left = pos[0] + (rect.left - anchor[0]);
                var top = pos[1] + (rect.top - anchor[1]);
                var right = left + rect.width;
                var bottom = top + rect.height;
                if (left < minL) minL = left;
                if (top < minT) minT = top;
                if (right > maxR) maxR = right;
                if (bottom > maxB) maxB = bottom;
            } catch(e) {}
        }

        var nullLayer = comp.layers.addNull();
        nullLayer.name = sel.length === 1 ? ('NULL ' + sel[0].name) : 'NULL';
        nullLayer.startTime = minInPoint;
        nullLayer.outPoint = maxOutPoint;

        if (isFinite(minL) && isFinite(minT) && isFinite(maxR) && isFinite(maxB)) {
            var cx = (minL + maxR) / 2;
            var cy = (minT + maxB) / 2;
            nullLayer.property('ADBE Transform Group').property('ADBE Position').setValue([cx, cy]);
        }

        nullLayer.moveBefore(comp.layer(minIndex));

        var affected = 0;
        for (var j = 0; j < sel.length; j++) {
            try { sel[j].parent = nullLayer; affected++; } catch(e) {}
        }

        app.endUndoGroup();
        return JSON.stringify({ success: true, affected: affected });
    } catch (e) {
        try { app.endUndoGroup(); } catch(e2) {}
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// ============================================================
// CONVERT TO SHAPE — konversi text/vector layer jadi shape layer
// ============================================================
function convertToShape(deleteSource) {
    try {
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ success: false, error: 'No active composition.' });
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return JSON.stringify({ success: false, error: 'No layer selected.' });
        }

        app.beginUndoGroup('Anggi Tools - Convert to Shape');

        var affected = 0;
        var layers = sel.slice ? sel.slice() : Array.prototype.slice.call(sel);
        // Proses dari bawah ke atas supaya index tidak berubah-ubah saat layer baru disisipkan
        layers.sort(function(a, b) { return b.index - a.index; });

        for (var i = 0; i < layers.length; i++) {
            var layer = layers[i];
            if (layer.hasOwnProperty('nullLayer') && layer.nullLayer) continue;

            // Pilih command AE yang sesuai dengan tipe layer:
            // TextLayer -> "Create Shapes from Text"
            // Layer vector (Illustrator/EPS/PDF import) -> "Create Shapes from Vector Layer"
            var commandName;
            if (layer instanceof TextLayer) {
                commandName = 'Create Shapes from Text';
            } else if (layer instanceof ShapeLayer) {
                continue; // sudah shape layer, tidak perlu dikonversi
            } else {
                commandName = 'Create Shapes from Vector Layer';
            }

            var tempIndex = layer.index;
            var tempName = layer.name;

            for (var k = 0; k < comp.selectedLayers.length; k++) comp.selectedLayers[k].selected = false;
            layer.selected = true;
            try {
                var cmdId = app.findMenuCommandId(commandName);
                if (!cmdId) continue;
                app.executeCommand(cmdId);
            } catch (e) { continue; }

            var newLayer = comp.layer(tempIndex);
            if (newLayer instanceof ShapeLayer) {
                newLayer.name = tempName;
                affected++;
                if (deleteSource) {
                    try { comp.layer(tempIndex + 1).remove(); } catch(e) {}
                } else {
                    try { comp.layer(tempIndex + 1).enabled = false; } catch(e) {}
                }
            }
        }

        app.endUndoGroup();

        if (affected === 0) {
            return JSON.stringify({ success: false, error: 'No text/vector layer could be converted.' });
        }
        return JSON.stringify({ success: true, affected: affected });
    } catch (e) {
        try { app.endUndoGroup(); } catch(e2) {}
        return JSON.stringify({ success: false, error: e.toString() });
    }
}
