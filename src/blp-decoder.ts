import * as zlib from "node:zlib";

const BLP2_HEADER_SIZE = 148;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) {
			c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
		}
		table[n] = c;
	}
	return table;
})();

function crc32(buf: Buffer): number {
	let crc = 0xffffffff;
	for (let i = 0; i < buf.length; i++) {
		crc = (CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
	const typeBuf = Buffer.from(type, "ascii");
	const chunk = Buffer.allocUnsafe(12 + data.length);
	chunk.writeUInt32BE(data.length, 0);
	typeBuf.copy(chunk, 4);
	data.copy(chunk, 8);
	const crc = crc32(chunk.subarray(4, 8 + data.length));
	chunk.writeUInt32BE(crc, 8 + data.length);
	return chunk;
}

function encodeRgbaToPng(rgba: Uint8Array, width: number, height: number): Buffer {
	const stride = width * 4;
	const raw = Buffer.allocUnsafe(height * (1 + stride));
	for (let y = 0; y < height; y++) {
		const dstRowStart = y * (1 + stride);
		const srcRowStart = y * stride;
		raw[dstRowStart] = 0; // Filter type 0 (None)
		Buffer.from(rgba.buffer, rgba.byteOffset + srcRowStart, stride).copy(raw, dstRowStart + 1);
	}

	const compressed = zlib.deflateSync(raw);
	const ihdr = Buffer.allocUnsafe(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // Bit depth
	ihdr[9] = 6; // Color type: RGBA
	ihdr[10] = 0; // Compression method
	ihdr[11] = 0; // Filter method
	ihdr[12] = 0; // Interlace method

	return Buffer.concat([
		PNG_SIGNATURE,
		makePngChunk("IHDR", ihdr),
		makePngChunk("IDAT", compressed),
		makePngChunk("IEND", Buffer.alloc(0)),
	]);
}

function decodeRgb565(value: number): [number, number, number] {
	const r5 = (value >> 11) & 0x1f;
	const g6 = (value >> 5) & 0x3f;
	const b5 = value & 0x1f;
	return [(r5 << 3) | (r5 >> 2), (g6 << 2) | (g6 >> 4), (b5 << 3) | (b5 >> 2)];
}

function decodeColorBlock(
	buf: Buffer,
	colorOffset: number,
	allowThreeColorAlpha: boolean,
	alphaBitForThreeColor: number,
): [number[], number[], number[]] {
	const c0 = buf.readUInt16LE(colorOffset);
	const c1 = buf.readUInt16LE(colorOffset + 2);
	const [r0, g0, b0] = decodeRgb565(c0);
	const [r1, g1, b1] = decodeRgb565(c1);

	const r = [r0, r1, 0, 0];
	const g = [g0, g1, 0, 0];
	const b = [b0, b1, 0, 0];

	if (!allowThreeColorAlpha || c0 > c1) {
		r[2] = Math.floor((2 * r0 + r1) / 3);
		g[2] = Math.floor((2 * g0 + g1) / 3);
		b[2] = Math.floor((2 * b0 + b1) / 3);
		r[3] = Math.floor((r0 + 2 * r1) / 3);
		g[3] = Math.floor((g0 + 2 * g1) / 3);
		b[3] = Math.floor((b0 + 2 * b1) / 3);
		return [r, g, b];
	}

	r[2] = Math.floor((r0 + r1) / 2);
	g[2] = Math.floor((g0 + g1) / 2);
	b[2] = Math.floor((b0 + b1) / 2);
	// Caller distinguishes code === 3 transparency when allowThreeColorAlpha && c0 <= c1
	r[3] = 0;
	g[3] = 0;
	b[3] = 0;
	void alphaBitForThreeColor;
	return [r, g, b];
}

function decodePalettedMip0(
	buf: Buffer,
	mipOffset: number,
	mipSize: number,
	width: number,
	height: number,
	alphaDepth: number,
): Uint8Array | null {
	const paletteOffset = BLP2_HEADER_SIZE;
	if (buf.length < paletteOffset + 1024) {
		return null;
	}
	const pixelCount = width * height;
	const alphaBytesNeeded =
		alphaDepth === 0
			? 0
			: alphaDepth === 1
				? Math.ceil(pixelCount / 8)
				: alphaDepth === 4
					? Math.ceil(pixelCount / 2)
					: alphaDepth === 8
						? pixelCount
						: -1;
	if (alphaBytesNeeded < 0 || mipSize < pixelCount + alphaBytesNeeded) {
		return null;
	}

	const rgba = new Uint8Array(pixelCount * 4);
	const alphaOffset = mipOffset + pixelCount;

	for (let i = 0; i < pixelCount; i++) {
		const palIdx = buf[mipOffset + i];
		const palPos = paletteOffset + palIdx * 4;
		const dst = i * 4;
		rgba[dst] = buf[palPos + 2]; // R
		rgba[dst + 1] = buf[palPos + 1]; // G
		rgba[dst + 2] = buf[palPos]; // B

		let alpha = 255;
		if (alphaDepth === 1) {
			const byteVal = buf[alphaOffset + (i >> 3)];
			alpha = ((byteVal >> (i & 7)) & 1) !== 0 ? 255 : 0;
		} else if (alphaDepth === 4) {
			const byteVal = buf[alphaOffset + (i >> 1)];
			const nibble = (i & 1) === 0 ? byteVal & 0x0f : (byteVal >> 4) & 0x0f;
			alpha = (nibble << 4) | nibble;
		} else if (alphaDepth === 8) {
			alpha = buf[alphaOffset + i];
		}
		rgba[dst + 3] = alpha;
	}

	return rgba;
}

function decodeDxtcMip0(
	buf: Buffer,
	mipOffset: number,
	mipSize: number,
	width: number,
	height: number,
	alphaDepth: number,
	alphaEncoding: number,
): Uint8Array | null {
	const blocksX = Math.max(1, Math.ceil(width / 4));
	const blocksY = Math.max(1, Math.ceil(height / 4));
	const isDxt1 = alphaEncoding === 0;
	const isDxt3 = alphaEncoding === 1;
	const isDxt5 = alphaEncoding === 7;
	if (!isDxt1 && !isDxt3 && !isDxt5) {
		return null;
	}

	const blockSize = isDxt1 ? 8 : 16;
	if (mipSize < blocksX * blocksY * blockSize) {
		return null;
	}

	const rgba = new Uint8Array(width * height * 4);
	let blockOffset = mipOffset;

	for (let by = 0; by < blocksY; by++) {
		for (let bx = 0; bx < blocksX; bx++) {
			const colorOffset = isDxt1 ? blockOffset : blockOffset + 8;
			const c0 = buf.readUInt16LE(colorOffset);
			const c1 = buf.readUInt16LE(colorOffset + 2);
			const colorBits = buf.readUInt32LE(colorOffset + 4);
			const [rPal, gPal, bPal] = decodeColorBlock(buf, colorOffset, isDxt1, alphaDepth);

			let dxt5Alphas: number[] | null = null;
			let dxt5Bits = 0n;
			if (isDxt5) {
				const a0 = buf[blockOffset];
				const a1 = buf[blockOffset + 1];
				dxt5Alphas = [a0, a1, 0, 0, 0, 0, 0, 0];
				if (a0 > a1) {
					dxt5Alphas[2] = Math.floor((6 * a0 + 1 * a1) / 7);
					dxt5Alphas[3] = Math.floor((5 * a0 + 2 * a1) / 7);
					dxt5Alphas[4] = Math.floor((4 * a0 + 3 * a1) / 7);
					dxt5Alphas[5] = Math.floor((3 * a0 + 4 * a1) / 7);
					dxt5Alphas[6] = Math.floor((2 * a0 + 5 * a1) / 7);
					dxt5Alphas[7] = Math.floor((1 * a0 + 6 * a1) / 7);
				} else {
					dxt5Alphas[2] = Math.floor((4 * a0 + 1 * a1) / 5);
					dxt5Alphas[3] = Math.floor((3 * a0 + 2 * a1) / 5);
					dxt5Alphas[4] = Math.floor((2 * a0 + 3 * a1) / 5);
					dxt5Alphas[5] = Math.floor((1 * a0 + 4 * a1) / 5);
					dxt5Alphas[6] = 0;
					dxt5Alphas[7] = 255;
				}
				dxt5Bits =
					BigInt(buf[blockOffset + 2]) |
					(BigInt(buf[blockOffset + 3]) << 8n) |
					(BigInt(buf[blockOffset + 4]) << 16n) |
					(BigInt(buf[blockOffset + 5]) << 24n) |
					(BigInt(buf[blockOffset + 6]) << 32n) |
					(BigInt(buf[blockOffset + 7]) << 40n);
			}

			for (let py = 0; py < 4; py++) {
				const y = by * 4 + py;
				if (y >= height) continue;
				for (let px = 0; px < 4; px++) {
					const x = bx * 4 + px;
					if (x >= width) continue;

					const pixelIdx = py * 4 + px;
					const code = (colorBits >>> (pixelIdx * 2)) & 0x03;

					let alpha = 255;
					if (isDxt1) {
						if (c0 <= c1 && code === 3) {
							alpha = alphaDepth > 0 ? 0 : 255;
						}
					} else if (isDxt3) {
						const alphaByte = buf[blockOffset + (pixelIdx >> 1)];
						const nibble = (pixelIdx & 1) === 0 ? alphaByte & 0x0f : (alphaByte >> 4) & 0x0f;
						alpha = (nibble << 4) | nibble;
					} else if (isDxt5 && dxt5Alphas) {
						const aCode = Number((dxt5Bits >> BigInt(pixelIdx * 3)) & 0x07n);
						alpha = dxt5Alphas[aCode];
					}

					const dst = (y * width + x) * 4;
					rgba[dst] = rPal[code];
					rgba[dst + 1] = gPal[code];
					rgba[dst + 2] = bPal[code];
					rgba[dst + 3] = alpha;
				}
			}

			blockOffset += blockSize;
		}
	}

	return rgba;
}

function decodeUncompressedMip0(
	buf: Buffer,
	mipOffset: number,
	mipSize: number,
	width: number,
	height: number,
): Uint8Array | null {
	const pixelCount = width * height;
	if (mipSize < pixelCount * 4) {
		return null;
	}
	const rgba = new Uint8Array(pixelCount * 4);
	for (let i = 0; i < pixelCount; i++) {
		const src = mipOffset + i * 4;
		const dst = i * 4;
		rgba[dst] = buf[src + 2]; // R
		rgba[dst + 1] = buf[src + 1]; // G
		rgba[dst + 2] = buf[src]; // B
		rgba[dst + 3] = buf[src + 3]; // A
	}
	return rgba;
}

/**
 * Checks whether a buffer begins with the Blizzard BLP2 signature (`BLP2`).
 */
export function isBlp2Buffer(buf: Buffer): boolean {
	return (
		buf.length >= BLP2_HEADER_SIZE &&
		buf[0] === 0x42 && // 'B'
		buf[1] === 0x4c && // 'L'
		buf[2] === 0x50 && // 'P'
		buf[3] === 0x32 // '2'
	);
}

/**
 * Decodes Mipmap level 0 of a Blizzard BLP2 texture (paletted, DXT1/3/5, or BGRA)
 * into a standard RGBA PNG buffer using only Node's built-in zlib.
 */
export function decodeBlp2ToPng(buf: Buffer): Buffer | null {
	if (!isBlp2Buffer(buf)) {
		return null;
	}

	try {
		const version = buf.readUInt32LE(4);
		if (version !== 1) {
			return null;
		}

		const colorEncoding = buf[8];
		const alphaDepth = buf[9];
		const alphaEncoding = buf[10];
		const width = buf.readUInt32LE(12);
		const height = buf.readUInt32LE(16);

		if (width === 0 || height === 0 || width > 4096 || height > 4096) {
			return null;
		}

		const mip0Offset = buf.readUInt32LE(20);
		const mip0Size = buf.readUInt32LE(84);
		if (mip0Offset < BLP2_HEADER_SIZE || mip0Size === 0 || mip0Offset + mip0Size > buf.length) {
			return null;
		}

		let rgba: Uint8Array | null = null;
		if (colorEncoding === 1) {
			rgba = decodePalettedMip0(buf, mip0Offset, mip0Size, width, height, alphaDepth);
		} else if (colorEncoding === 2) {
			rgba = decodeDxtcMip0(buf, mip0Offset, mip0Size, width, height, alphaDepth, alphaEncoding);
		} else if (colorEncoding === 3) {
			rgba = decodeUncompressedMip0(buf, mip0Offset, mip0Size, width, height);
		}

		if (!rgba) {
			return null;
		}

		return encodeRgbaToPng(rgba, width, height);
	} catch {
		return null;
	}
}
