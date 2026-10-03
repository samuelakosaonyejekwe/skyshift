// SkyShift - minimal animated GIF encoder (indexed frames, LZW).
// Frames are Uint8Array palette indices (0..255) of width*height.
export function encodeGIF(frames, width, height, palette, delayCs = 30) {
  const out = [];
  const w8 = v => out.push(v & 255);
  const w16 = v => { out.push(v & 255, (v >> 8) & 255); };
  const str = s => { for (const c of s) out.push(c.charCodeAt(0)); };
  str('GIF89a'); w16(width); w16(height);
  w8(0xF7); w8(0); w8(0);                       // global colour table, 256 entries
  for (let i = 0; i < 256; i++) { w8(palette[i * 3]); w8(palette[i * 3 + 1]); w8(palette[i * 3 + 2]); }
  // NETSCAPE loop forever
  w8(0x21); w8(0xFF); w8(11); str('NETSCAPE2.0'); w8(3); w8(1); w16(0); w8(0);
  for (const f of frames) {
    w8(0x21); w8(0xF9); w8(4); w8(0); w16(delayCs); w8(0); w8(0);
    w8(0x2C); w16(0); w16(0); w16(width); w16(height); w8(0);
    lzw(f, 8, out);
  }
  w8(0x3B);
  return new Blob([new Uint8Array(out)], { type: 'image/gif' });
}

function lzw(px, minCode, out) {
  out.push(minCode);
  const clear = 1 << minCode, eoi = clear + 1;
  let codeSize = minCode + 1, next = eoi + 1;
  let dict = new Map();
  let bitBuf = 0, bitCnt = 0;
  const block = [];
  const flushByte = b => { block.push(b); if (block.length === 255) { out.push(255, ...block); block.length = 0; } };
  const emit = c => {
    bitBuf |= c << bitCnt; bitCnt += codeSize;
    while (bitCnt >= 8) { flushByte(bitBuf & 255); bitBuf >>>= 8; bitCnt -= 8; }
  };
  emit(clear);
  let cur = px[0];
  for (let i = 1; i < px.length; i++) {
    const k = px[i];
    const key = cur * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << codeSize) && codeSize < 12) codeSize++;
    } else {
      emit(clear); dict = new Map(); codeSize = minCode + 1; next = eoi + 1;
    }
    cur = k;
  }
  emit(cur); emit(eoi);
  if (bitCnt > 0) flushByte(bitBuf & 255);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
}
