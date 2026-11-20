#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

// Exact closed SVG path from Google Antigravity's img/logo.svg (viewBox="0 0 113 113")
const CUBIC_SEGMENTS = [
  { p0: [89.6992, 93.695], p1: [94.3659, 97.195], p2: [101.366, 94.8617], p3: [94.9492, 88.445] },
  { p0: [94.9492, 88.445], p1: [75.6992, 69.7783], p2: [79.7825, 18.445], p3: [55.8659, 18.445] },
  { p0: [55.8659, 18.445], p1: [31.9492, 18.445], p2: [36.0325, 69.7783], p3: [16.7825, 88.445] },
  { p0: [16.7825, 88.445], p1: [9.78251, 95.445], p2: [17.3658, 97.195], p3: [22.0325, 93.695] },
  { p0: [22.0325, 93.695], p1: [40.1159, 81.445], p2: [38.9492, 59.8617], p3: [55.8659, 59.8617] },
  { p0: [55.8659, 59.8617], p1: [72.7825, 59.8617], p2: [71.6159, 81.445], p3: [89.6992, 93.695] },
];

const UPM = 300;
const GLYPH_CHAR = 0xe001;

function lerpPt(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function splitCubicSubsegment(p0, p1, p2, p3, t0, t1) {
  // Blossom / de Casteljau reparameterization from [0,1] onto [t0, t1]
  const evalCubic = (t) => {
    const mt = 1 - t;
    return [
      mt ** 3 * p0[0] + 3 * mt ** 2 * t * p1[0] + 3 * mt * t ** 2 * p2[0] + t ** 3 * p3[0],
      mt ** 3 * p0[1] + 3 * mt ** 2 * t * p1[1] + 3 * mt * t ** 2 * p2[1] + t ** 3 * p3[1],
    ];
  };
  const deriv = (t) => {
    const mt = 1 - t;
    return [
      3 * mt ** 2 * (p1[0] - p0[0]) + 6 * mt * t * (p2[0] - p1[0]) + 3 * t ** 2 * (p3[0] - p2[0]),
      3 * mt ** 2 * (p1[1] - p0[1]) + 6 * mt * t * (p2[1] - p1[1]) + 3 * t ** 2 * (p3[1] - p2[1]),
    ];
  };
  const dt = t1 - t0;
  const a = evalCubic(t0);
  const d = evalCubic(t1);
  const da = deriv(t0);
  const dd = deriv(t1);
  const b = [a[0] + (da[0] * dt) / 3, a[1] + (da[1] * dt) / 3];
  const c = [d[0] - (dd[0] * dt) / 3, d[1] - (dd[1] * dt) / 3];
  return [a, b, c, d];
}

function svgToFontPoint(pt) {
  // Center SVG around (56.5, 57) with 1.22x scale into 300x300 box, flipping Y for TrueType y-up
  const scale = (UPM / 113) * 1.22;
  const x = Math.round(UPM / 2 + (pt[0] - 56) * scale);
  const y = Math.round(UPM / 2 + (57 - pt[1]) * scale);
  return [x, y];
}

function buildLogoContourPoints() {
  const pts = [];
  const subdivisions = 4;
  for (const seg of CUBIC_SEGMENTS) {
    for (let i = 0; i < subdivisions; i += 1) {
      const t0 = i / subdivisions;
      const t1 = (i + 1) / subdivisions;
      const [a, b, c, d] = splitCubicSubsegment(seg.p0, seg.p1, seg.p2, seg.p3, t0, t1);
      // Quadratic control point approximating sub-cubic [a,b,c,d]
      const qCtrl = [(3 * (b[0] + c[0]) - (a[0] + d[0])) / 4, (3 * (b[1] + c[1]) - (a[1] + d[1])) / 4];
      const onStart = svgToFontPoint(a);
      const offCtrl = svgToFontPoint(qCtrl);
      if (pts.length === 0 || pts[pts.length - 1].x !== onStart[0] || pts[pts.length - 1].y !== onStart[1]) {
        pts.push({ x: onStart[0], y: onStart[1], onCurve: true });
      }
      pts.push({ x: offCtrl[0], y: offCtrl[1], onCurve: false });
    }
  }
  return pts;
}

function computeTableChecksum(buf) {
  const paddedLen = Math.ceil(buf.length / 4) * 4;
  const padded = Buffer.alloc(paddedLen);
  buf.copy(padded);
  let sum = 0;
  for (let i = 0; i < paddedLen; i += 4) {
    sum = (sum + padded.readUInt32BE(i)) >>> 0;
  }
  return sum;
}

function encodeSignedCoordArray(deltas) {
  const bytes = [];
  for (const d of deltas) {
    bytes.push((d >> 8) & 0xff, d & 0xff);
  }
  return Buffer.from(bytes);
}

function buildGlyfEntry(points) {
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const pt of points) {
    xMin = Math.min(xMin, pt.x);
    yMin = Math.min(yMin, pt.y);
    xMax = Math.max(xMax, pt.x);
    yMax = Math.max(yMax, pt.y);
  }

  const header = Buffer.alloc(10);
  header.writeInt16BE(1, 0); // numberOfContours
  header.writeInt16BE(xMin, 2);
  header.writeInt16BE(yMin, 4);
  header.writeInt16BE(xMax, 6);
  header.writeInt16BE(yMax, 8);

  const endPts = Buffer.alloc(2);
  endPts.writeUInt16BE(points.length - 1, 0);

  const instrLen = Buffer.alloc(2);
  instrLen.writeUInt16BE(0, 0);

  const flags = Buffer.from(points.map((pt) => (pt.onCurve ? 0x01 : 0x00)));
  const dx = [];
  const dy = [];
  let prevX = 0;
  let prevY = 0;
  for (const pt of points) {
    dx.push(pt.x - prevX);
    dy.push(pt.y - prevY);
    prevX = pt.x;
    prevY = pt.y;
  }

  const raw = Buffer.concat([header, endPts, instrLen, flags, encodeSignedCoordArray(dx), encodeSignedCoordArray(dy)]);
  const paddedLen = Math.ceil(raw.length / 4) * 4;
  const padded = Buffer.alloc(paddedLen);
  raw.copy(padded);
  return { buffer: padded, bbox: { xMin, yMin, xMax, yMax } };
}

function buildFontBuffer() {
  const points = buildLogoContourPoints();
  const { buffer: glyph1Buf, bbox } = buildGlyfEntry(points);

  // glyf: glyph 0 (.notdef empty), glyph 1 (U+E001)
  const glyf = Buffer.from(glyph1Buf);

  // loca (short format: offsets / 2 for 2 glyphs + sentinel = 3 uint16)
  const loca = Buffer.alloc(6);
  loca.writeUInt16BE(0, 0); // glyph 0 offset = 0
  loca.writeUInt16BE(0, 2); // glyph 1 offset = 0
  loca.writeUInt16BE(glyf.length / 2, 4); // end offset

  // head (54 bytes)
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0); // version 1.0
  head.writeUInt32BE(0x00010000, 4); // fontRevision
  head.writeUInt32BE(0, 8); // checkSumAdjustment placeholder
  head.writeUInt32BE(0x5f0f3cf5, 12); // magicNumber
  head.writeUInt16BE(0x000b, 16); // flags
  head.writeUInt16BE(UPM, 18);
  // created/modified = 0
  head.writeInt16BE(bbox.xMin, 36);
  head.writeInt16BE(bbox.yMin, 38);
  head.writeInt16BE(bbox.xMax, 40);
  head.writeInt16BE(bbox.yMax, 42);
  head.writeUInt16BE(0, 44); // macStyle
  head.writeUInt16BE(8, 46); // lowestRecPPEM
  head.writeInt16BE(2, 48); // fontDirectionHint
  head.writeInt16BE(0, 50); // indexToLocFormat = 0 (short)
  head.writeInt16BE(0, 52); // glyphDataFormat = 0

  // hhea (36 bytes)
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(UPM, 4); // ascent
  hhea.writeInt16BE(0, 6); // descent
  hhea.writeInt16BE(0, 8); // lineGap
  hhea.writeUInt16BE(UPM, 10); // advanceWidthMax
  hhea.writeInt16BE(Math.min(0, bbox.xMin), 12); // minLeftSideBearing
  hhea.writeInt16BE(UPM - bbox.xMax, 14); // minRightSideBearing
  hhea.writeInt16BE(bbox.xMax, 16); // xMaxExtent
  hhea.writeInt16BE(1, 18); // caretSlopeRise
  hhea.writeUInt16BE(2, 34); // numberOfHMetrics

  // maxp (32 bytes)
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(2, 4); // numGlyphs
  maxp.writeUInt16BE(points.length, 6); // maxPoints
  maxp.writeUInt16BE(1, 8); // maxContours

  // OS/2 (96 bytes, version 4)
  const os2 = Buffer.alloc(96);
  os2.writeUInt16BE(4, 0); // version
  os2.writeInt16BE(UPM, 2); // xAvgCharWidth
  os2.writeUInt16BE(400, 4); // usWeightClass
  os2.writeUInt16BE(5, 6); // usWidthClass
  os2.writeUInt16BE(0, 8); // fsType (installable)
  os2.writeInt16BE(Math.round(UPM * 0.65), 10); // ySubscriptXSize
  os2.writeInt16BE(Math.round(UPM * 0.7), 12); // ySubscriptYSize
  os2.writeInt16BE(Math.round(UPM * 0.14), 16); // ySubscriptYOffset
  os2.writeInt16BE(Math.round(UPM * 0.65), 18); // ySuperscriptXSize
  os2.writeInt16BE(Math.round(UPM * 0.7), 20); // ySuperscriptYSize
  os2.writeInt16BE(Math.round(UPM * 0.48), 24); // ySuperscriptYOffset
  os2.writeInt16BE(15, 26); // yStrikeoutSize
  os2.writeInt16BE(Math.round(UPM * 0.25), 28); // yStrikeoutPosition
  os2.write('AGYH', 58, 'ascii'); // achVendID
  os2.writeUInt16BE(0x0040, 62); // fsSelection = REGULAR
  os2.writeUInt16BE(GLYPH_CHAR, 64); // usFirstCharIndex
  os2.writeUInt16BE(GLYPH_CHAR, 66); // usLastCharIndex
  os2.writeInt16BE(UPM, 68); // sTypoAscender
  os2.writeInt16BE(0, 70); // sTypoDescender
  os2.writeInt16BE(0, 72); // sTypoLineGap
  os2.writeUInt16BE(UPM, 74); // usWinAscent
  os2.writeUInt16BE(0, 76); // usWinDescent
  os2.writeUInt32BE(1, 78); // ulCodePageRange1
  os2.writeInt16BE(Math.round(UPM * 0.5), 86); // sxHeight
  os2.writeInt16BE(Math.round(UPM * 0.75), 88); // sCapHeight
  os2.writeUInt16BE(0, 90); // usDefaultChar
  os2.writeUInt16BE(32, 92); // usBreakChar
  os2.writeUInt16BE(1, 94); // usMaxContext

  // hmtx (8 bytes: 2 glyphs * 4 bytes)
  const hmtx = Buffer.alloc(8);
  hmtx.writeUInt16BE(UPM, 0);
  hmtx.writeInt16BE(0, 2);
  hmtx.writeUInt16BE(UPM, 4);
  hmtx.writeInt16BE(bbox.xMin, 6);

  // cmap format 4 subtable for 2 segments: [0xE001..0xE001] -> glyph 1, [0xFFFF..0xFFFF] -> glyph 0
  const segCount = 2;
  const searchRange = 4; // 2 * 2^floor(log2(2)) = 4
  const entrySelector = 1; // log2(2)
  const rangeShift = 0; // 2*segCount - searchRange = 0
  const format4Len = 16 + 8 * segCount; // 32 bytes
  const format4 = Buffer.alloc(format4Len);
  format4.writeUInt16BE(4, 0); // format
  format4.writeUInt16BE(format4Len, 2); // length
  format4.writeUInt16BE(0, 4); // language
  format4.writeUInt16BE(segCount * 2, 6);
  format4.writeUInt16BE(searchRange, 8);
  format4.writeUInt16BE(entrySelector, 10);
  format4.writeUInt16BE(rangeShift, 12);
  // endCode: [0xE001, 0xFFFF]
  format4.writeUInt16BE(GLYPH_CHAR, 14);
  format4.writeUInt16BE(0xffff, 16);
  // reservedPad: 0 at 18
  // startCode: [0xE001, 0xFFFF]
  format4.writeUInt16BE(GLYPH_CHAR, 20);
  format4.writeUInt16BE(0xffff, 22);
  // idDelta: [(1 - 0xE001) mod 65536 = 0x2000, 1]
  format4.writeUInt16BE((1 - GLYPH_CHAR + 0x10000) & 0xffff, 24);
  format4.writeUInt16BE(1, 26);
  // idRangeOffset: [0, 0] at 28, 30

  const cmapHeaderLen = 4 + 2 * 8; // 2 encodings pointing to same format4 subtable
  const cmap = Buffer.alloc(cmapHeaderLen + format4Len);
  cmap.writeUInt16BE(0, 0); // version
  cmap.writeUInt16BE(2, 2); // numTables
  // record 0: Unicode BMP (platform 0, encoding 3)
  cmap.writeUInt16BE(0, 4);
  cmap.writeUInt16BE(3, 6);
  cmap.writeUInt32BE(cmapHeaderLen, 8);
  // record 1: Windows Unicode BMP (platform 3, encoding 1)
  cmap.writeUInt16BE(3, 12);
  cmap.writeUInt16BE(1, 14);
  cmap.writeUInt32BE(cmapHeaderLen, 16);
  format4.copy(cmap, cmapHeaderLen);

  // name table (platform 1 mac roman + platform 3 windows UTF-16BE)
  const nameEntries = [
    [1, 0, 0, 1, Buffer.from('AntigravityIcons', 'ascii')],
    [1, 0, 0, 2, Buffer.from('Regular', 'ascii')],
    [1, 0, 0, 4, Buffer.from('AntigravityIcons', 'ascii')],
    [1, 0, 0, 6, Buffer.from('AntigravityIcons', 'ascii')],
    [3, 1, 0x0409, 1, Buffer.from('AntigravityIcons', 'utf16le').swap16()],
    [3, 1, 0x0409, 2, Buffer.from('Regular', 'utf16le').swap16()],
    [3, 1, 0x0409, 4, Buffer.from('AntigravityIcons', 'utf16le').swap16()],
    [3, 1, 0x0409, 6, Buffer.from('AntigravityIcons', 'utf16le').swap16()],
  ];
  const stringData = Buffer.concat(nameEntries.map((e) => e[4]));
  const nameHeaderSize = 6 + nameEntries.length * 12;
  const name = Buffer.alloc(nameHeaderSize + stringData.length);
  name.writeUInt16BE(0, 0); // format
  name.writeUInt16BE(nameEntries.length, 2);
  name.writeUInt16BE(nameHeaderSize, 4);
  let strOff = 0;
  nameEntries.forEach(([plat, enc, lang, nameId, buf], idx) => {
    const off = 6 + idx * 12;
    name.writeUInt16BE(plat, off);
    name.writeUInt16BE(enc, off + 2);
    name.writeUInt16BE(lang, off + 4);
    name.writeUInt16BE(nameId, off + 6);
    name.writeUInt16BE(buf.length, off + 8);
    name.writeUInt16BE(strOff, off + 10);
    buf.copy(name, nameHeaderSize + strOff);
    strOff += buf.length;
  });

  // post (32 bytes, format 3.0)
  const post = Buffer.alloc(32);
  post.writeUInt32BE(0x00030000, 0);
  post.writeUInt32BE(1, 16); // isFixedPitch

  const tablesMap = [
    ['OS/2', os2],
    ['cmap', cmap],
    ['glyf', glyf],
    ['head', head],
    ['hhea', hhea],
    ['hmtx', hmtx],
    ['loca', loca],
    ['maxp', maxp],
    ['name', name],
    ['post', post],
  ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const numTables = tablesMap.length;
  const entrySelectorSfnt = Math.floor(Math.log2(numTables));
  const searchRangeSfnt = Math.pow(2, entrySelectorSfnt) * 16;
  const rangeShiftSfnt = numTables * 16 - searchRangeSfnt;

  const dirSize = 12 + numTables * 16;
  const chunks = [Buffer.alloc(dirSize)];
  chunks[0].writeUInt32BE(0x00010000, 0);
  chunks[0].writeUInt16BE(numTables, 4);
  chunks[0].writeUInt16BE(searchRangeSfnt, 6);
  chunks[0].writeUInt16BE(entrySelectorSfnt, 8);
  chunks[0].writeUInt16BE(rangeShiftSfnt, 10);

  let currentOffset = dirSize;
  let headFileOffset = 0;

  tablesMap.forEach(([tag, data], idx) => {
    const paddedLen = Math.ceil(data.length / 4) * 4;
    const padded = Buffer.alloc(paddedLen);
    data.copy(padded);
    if (tag === 'head') {
      headFileOffset = currentOffset;
    }
    const recOff = 12 + idx * 16;
    chunks[0].write(tag, recOff, 4, 'ascii');
    chunks[0].writeUInt32BE(computeTableChecksum(padded), recOff + 4);
    chunks[0].writeUInt32BE(currentOffset, recOff + 8);
    chunks[0].writeUInt32BE(data.length, recOff + 12);
    chunks.push(padded);
    currentOffset += paddedLen;
  });

  const fullFont = Buffer.concat(chunks);
  const totalSum = computeTableChecksum(fullFont);
  const adjustment = (0xb1b0afba - totalSum) >>> 0;
  fullFont.writeUInt32BE(adjustment, headFileOffset + 8);

  return { fullFont, pointsCount: points.length, bbox };
}

const outDir = path.resolve(__dirname, '..', 'media');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'antigravity.ttf');
const { fullFont, pointsCount, bbox } = buildFontBuffer();
fs.writeFileSync(outFile, fullFont);
console.log(`[build-icon-font] Wrote ${outFile} (${fullFont.length} bytes, points=${pointsCount}, bbox=${JSON.stringify(bbox)})`);
