/**
 * png-pixels.ts — decode the PNGs Chrome's `Page.captureScreenshot` returns into raw pixels,
 * and encode raw pixels back into a PNG, without an image library. Decoding accepts 8-bit RGB
 * or RGBA, not interlaced, which is what Chrome produces; anything else is refused with the
 * reason, never approximated. Encoding writes 8-bit RGB/RGBA with filter 0 on every row.
 */

import { deflateSync, inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  /** 3 (RGB) or 4 (RGBA) bytes per pixel. */
  channels: 3 | 4
  /** Row-major pixels, `width * height * channels` bytes. */
  data: Uint8Array
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('Not a PNG: the signature bytes are missing.')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = SIGNATURE.length
  let width = 0
  let height = 0
  let channels: 3 | 4 | undefined
  const compressed: Uint8Array[] = []
  while (offset + 8 <= bytes.length) {
    const start = offset
    const length = view.getUint32(start)
    const type = String.fromCharCode(bytes[start + 4], bytes[start + 5], bytes[start + 6], bytes[start + 7])
    const data = bytes.subarray(start + 8, start + 8 + length)
    offset = start + 12 + length
    if (type === 'IHDR') {
      width = view.getUint32(start + 8)
      height = view.getUint32(start + 12)
      const bitDepth = data[8]
      const colorType = data[9]
      const interlace = data[12]
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
        throw new Error(
          `Unsupported PNG: bit depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}; ` +
            'only 8-bit RGB/RGBA without interlacing (what Chrome captures) is decoded.',
        )
      }
      channels = colorType === 6 ? 4 : 3
    } else if (type === 'IDAT') {
      compressed.push(data)
    } else if (type === 'IEND') {
      break
    }
  }
  if (!channels || width === 0 || height === 0) throw new Error('Not a decodable PNG: no IHDR chunk.')
  const raw = inflateSync(Buffer.concat(compressed))
  const stride = width * channels
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`Corrupt PNG: ${raw.length} bytes of image data for ${width}×${height}×${channels}.`)
  }
  const data = new Uint8Array(height * stride)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]
    const source = row * (stride + 1) + 1
    const target = row * stride
    for (let i = 0; i < stride; i++) {
      const value = raw[source + i]
      const left = i >= channels ? data[target + i - channels] : 0
      const up = row > 0 ? data[target - stride + i] : 0
      const upLeft = row > 0 && i >= channels ? data[target - stride + i - channels] : 0
      let predicted: number
      switch (filter) {
        case 0:
          predicted = 0
          break
        case 1:
          predicted = left
          break
        case 2:
          predicted = up
          break
        case 3:
          predicted = (left + up) >> 1
          break
        case 4: {
          const estimate = left + up - upLeft
          const toLeft = Math.abs(estimate - left)
          const toUp = Math.abs(estimate - up)
          const toUpLeft = Math.abs(estimate - upLeft)
          predicted = toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
          break
        }
        default:
          throw new Error(`Corrupt PNG: unknown filter type ${filter} on row ${row}.`)
      }
      data[target + i] = (value + predicted) & 0xff
    }
  }
  return { width, height, channels, data }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** One chunk: length, type, data, CRC over type + data. */
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  out.set(data, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

export function encodePng(image: DecodedPng): Buffer {
  const { width, height, channels, data } = image
  const stride = width * channels
  if (width <= 0 || height <= 0 || data.length !== height * stride) {
    throw new Error(`Cannot encode PNG: ${data.length} bytes of pixels for ${width}×${height}×${channels}.`)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = channels === 4 ? 6 : 2
  // bytes 10-12: compression 0, filter method 0, interlace 0
  const raw = Buffer.alloc(height * (stride + 1))
  for (let row = 0; row < height; row++) {
    // Leading byte of each row is the filter type, 0 (None).
    raw.set(data.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from(SIGNATURE),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ])
}
