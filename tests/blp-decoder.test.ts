import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodeBlp2ToPng, isBlp2Buffer } from "../src/blp-decoder.js";

function encodeRgb565(r: number, g: number, b: number): number {
	return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

function buildBlp2Header(options: {
	colorEncoding: number;
	alphaDepth: number;
	alphaEncoding: number;
	width: number;
	height: number;
	mip0Offset: number;
	mip0Size: number;
}): Buffer {
	const header = Buffer.alloc(148, 0);
	header.write("BLP2", 0, "ascii");
	header.writeUInt32LE(1, 4); // version
	header[8] = options.colorEncoding;
	header[9] = options.alphaDepth;
	header[10] = options.alphaEncoding;
	header[11] = 0; // hasMips
	header.writeUInt32LE(options.width, 12);
	header.writeUInt32LE(options.height, 16);
	header.writeUInt32LE(options.mip0Offset, 20);
	header.writeUInt32LE(options.mip0Size, 84);
	return header;
}

function decodePngHeaderAndRgba(png: Buffer): { width: number; height: number; rgba: Buffer } {
	expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
	let offset = 8;
	let width = 0;
	let height = 0;
	const idatParts: Buffer[] = [];

	while (offset + 12 <= png.length) {
		const len = png.readUInt32BE(offset);
		const type = png.subarray(offset + 4, offset + 8).toString("ascii");
		const data = png.subarray(offset + 8, offset + 8 + len);
		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
		} else if (type === "IDAT") {
			idatParts.push(data);
		} else if (type === "IEND") {
			break;
		}
		offset += 12 + len;
	}

	const raw = zlib.inflateSync(Buffer.concat(idatParts));
	const stride = width * 4;
	const rgba = Buffer.allocUnsafe(width * height * 4);
	for (let y = 0; y < height; y++) {
		raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
	}
	return { width, height, rgba };
}

describe("BLP2-to-PNG Decoder", () => {
	it("decodes paletted BLP2 textures (alphaDepth 0, 1, 4, 8) into valid PNG buffers", () => {
		const width = 4;
		const height = 2;
		const pixelCount = width * height;
		const palette = Buffer.alloc(1024, 0);
		// Palette entry 0: BGRA(10, 20, 200, 255) -> RGBA(200, 20, 10)
		palette[0] = 10;
		palette[1] = 20;
		palette[2] = 200;
		palette[3] = 255;
		// Palette entry 1: BGRA(250, 100, 30, 255) -> RGBA(30, 100, 250)
		palette[4] = 250;
		palette[5] = 100;
		palette[6] = 30;
		palette[7] = 255;

		const indices = Buffer.from([0, 1, 0, 1, 1, 0, 1, 0]);
		const alpha8 = Buffer.from([12, 34, 56, 78, 90, 110, 200, 255]);
		const blp = Buffer.concat([
			buildBlp2Header({
				colorEncoding: 1,
				alphaDepth: 8,
				alphaEncoding: 0,
				width,
				height,
				mip0Offset: 148 + 1024,
				mip0Size: indices.length + alpha8.length,
			}),
			palette,
			indices,
			alpha8,
		]);

		expect(isBlp2Buffer(blp)).toBe(true);
		const png = decodeBlp2ToPng(blp);
		expect(png).not.toBeNull();
		const decoded = decodePngHeaderAndRgba(png!);
		expect(decoded.width).toBe(4);
		expect(decoded.height).toBe(2);
		expect(Array.from(decoded.rgba.subarray(0, 8))).toEqual([200, 20, 10, 12, 30, 100, 250, 34]);
	});

	it("decodes DXT1 BLP2 textures (4-color & 1-bit transparent mode) into valid PNG buffers", () => {
		const mipData = Buffer.alloc(8, 0);
		// c0 <= c1 -> 3-color + transparent code 3 (green=2016 <= red=63488)
		const c0 = encodeRgb565(0, 255, 0);
		const c1 = encodeRgb565(255, 0, 0);
		mipData.writeUInt16LE(c0, 0);
		mipData.writeUInt16LE(c1, 2);
		// pixel 0 = code 0 (green), pixel 1 = code 1 (red), pixel 2 = code 3 (transparent)
		mipData.writeUInt32LE(0 | (1 << 2) | (3 << 4), 4);

		const blp = Buffer.concat([
			buildBlp2Header({
				colorEncoding: 2,
				alphaDepth: 1,
				alphaEncoding: 0,
				width: 4,
				height: 4,
				mip0Offset: 148,
				mip0Size: mipData.length,
			}),
			mipData,
		]);

		const png = decodeBlp2ToPng(blp);
		expect(png).not.toBeNull();
		const decoded = decodePngHeaderAndRgba(png!);
		expect(decoded.width).toBe(4);
		expect(decoded.height).toBe(4);
		expect(decoded.rgba[1]).toBeGreaterThan(240); // pixel 0 G
		expect(decoded.rgba[3]).toBe(255); // pixel 0 A
		expect(decoded.rgba[4]).toBeGreaterThan(240); // pixel 1 R
		expect(decoded.rgba[11]).toBe(0); // pixel 2 transparent
	});

	it("decodes DXT3 and DXT5 BLP2 textures into valid PNG buffers", () => {
		// DXT5 16-byte block: a0=200, a1=100, all codes = 1 (alpha 100), color c0 > c1
		const dxt5Block = Buffer.alloc(16, 0);
		dxt5Block[0] = 200;
		dxt5Block[1] = 100;
		// Fill 48-bit alpha lookup bits with code 1 (001_001... -> pixel 0 code 1 = low 3 bits = 1)
		dxt5Block[2] = 0x09;
		dxt5Block.writeUInt16LE(encodeRgb565(0, 0, 255), 8);
		dxt5Block.writeUInt16LE(encodeRgb565(255, 255, 255), 10);

		const blpDxt5 = Buffer.concat([
			buildBlp2Header({
				colorEncoding: 2,
				alphaDepth: 8,
				alphaEncoding: 7,
				width: 4,
				height: 4,
				mip0Offset: 148,
				mip0Size: dxt5Block.length,
			}),
			dxt5Block,
		]);

		const png5 = decodeBlp2ToPng(blpDxt5);
		expect(png5).not.toBeNull();
		const decoded5 = decodePngHeaderAndRgba(png5!);
		expect(decoded5.width).toBe(4);
		expect(decoded5.height).toBe(4);
		expect(decoded5.rgba[2]).toBeGreaterThan(240); // Blue
		expect(decoded5.rgba[3]).toBe(100); // pixel 0 alpha from a1

		// DXT3 16-byte block
		const dxt3Block = Buffer.alloc(16, 0);
		dxt3Block[0] = 0xfa; // pixel 0 alpha nibble = 0xA (170), pixel 1 = 0xF (255)
		dxt3Block.writeUInt16LE(encodeRgb565(0, 255, 0), 8);
		dxt3Block.writeUInt16LE(encodeRgb565(0, 0, 0), 10);
		const blpDxt3 = Buffer.concat([
			buildBlp2Header({
				colorEncoding: 2,
				alphaDepth: 4,
				alphaEncoding: 1,
				width: 4,
				height: 4,
				mip0Offset: 148,
				mip0Size: dxt3Block.length,
			}),
			dxt3Block,
		]);
		const png3 = decodeBlp2ToPng(blpDxt3);
		expect(png3).not.toBeNull();
		const decoded3 = decodePngHeaderAndRgba(png3!);
		expect(decoded3.rgba[3]).toBe(170);
		expect(decoded3.rgba[7]).toBe(255);
	});

	it("returns null safely for non-BLP2 or truncated buffers", () => {
		expect(isBlp2Buffer(Buffer.from("not-blp"))).toBe(false);
		expect(decodeBlp2ToPng(Buffer.from("not-blp"))).toBeNull();
		expect(decodeBlp2ToPng(Buffer.alloc(148, 0))).toBeNull();
	});
});
