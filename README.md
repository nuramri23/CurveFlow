# CurveFlow by anggimv_

Curve editor extension untuk After Effects, terinspirasi dari Flow dan wavy 3am.

## Fitur
- **Curve editor** — drag titik & handle untuk ubah easing
- **Double-click kurva** → tambah titik baru (keyframe baru saat Apply)
- **Right-click titik** → hapus titik
- **Snap to grid** — snap ke kelipatan 25%
- **Tampilkan nilai X/Y** di setiap titik
- **Tension slider** — sesuaikan keketatan kurva
- **Undo/Redo** — Ctrl+Z / Ctrl+Y
- **Background image/GIF** — upload gambar sebagai referensi di canvas, dengan crop 1:1
- **Preset** — built-in (Linear, Ease, Ease In, Ease Out, Overshoot, Bounce, Spring) + custom
- **Import preset dari Flow** — format `.flow` bisa dikonversi
- **Export/Import preset** — simpan & bagikan preset
- **Rename preset** — ganti nama preset yang sudah disimpan
- **Layout responsif** — mode vertikal & horizontal dengan splitter yang bisa di-drag
- **Apply** → langsung ke selected keyframes di AE

---

## Cara Install

### 1. Enable Debug Mode

**Windows:**
Tekan `Win + R` → ketik `regedit` → OK

Navigasi ke:
```
HKEY_CURRENT_USER\Software\Adobe\CSXS.11
```
Klik kanan di panel kanan → **New → String Value**
Beri nama `PlayerDebugMode`, isi value `1`

**Mac:**
Buka Terminal, ketik:
```bash
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
```

### 2. Copy folder extension

**Windows:**
```
C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\
```

**Mac:**
```
/Library/Application Support/Adobe/CEP/extensions/
```

### 3. Restart After Effects
Tutup dan buka ulang AE.

### 4. Buka panel
**Window → Extensions → CurveFlow by anggimv_**

---

## Cara Pakai
1. Select **2 atau lebih keyframe** di timeline AE
2. Edit kurva di panel — drag titik atau handle
3. Double-click di garis kurva untuk tambah titik baru
4. Klik **Apply to Keyframes**

---

## Struktur File
```
curveflow-extension/
├── index.html
├── style.css
├── js/
│   └── CSInterface.js
├── jsx/
│   └── main.jsx
└── CSXS/
    └── manifest.xml
```


## Data yang Disimpan
Background image disimpan di:
- **Windows**: `Documents\CurveFlow\bg_cache.json`
- **Mac**: `~/Documents/CurveFlow/bg_cache.json`
