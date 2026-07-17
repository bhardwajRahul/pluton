/**
 * Self-backup blob format: encode/decode the single encrypted artifact.
 *
 * Layout:
 *   MAGIC(4) | version(u16) | memory(u32) | passes(u32) | parallelism(u32) |
 *   salt(16) | nonce(12) | ciphertext(...) | tag(16)
 *
 * The header is plaintext by design: salt and KDF params only let you re-derive
 * the key from the password, they don't reveal it.
 *
 * This module imports ONLY node:crypto. No appPaths, no configService, so it stays
 * unit-testable with zero mocks, and the CLI restore path can import it without
 * pulling in the app module graph.
 */

import * as nodeCrypto from 'node:crypto';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * argon2id landed in Node core in v24 and is present in every runtime we ship
 * (verified by probe across the pkg-bundled Node 24 builds). `@types/node@22`, which is
 * this repo's pin, does not declare it yet, so bind a local signature rather
 * than bumping the global type package for a single function.
 */
type Argon2SyncFn = (
	algorithm: 'argon2id' | 'argon2i' | 'argon2d',
	options: {
		message: Buffer;
		nonce: Buffer;
		parallelism: number;
		tagLength: number;
		memory: number;
		passes: number;
		secret?: Buffer;
		associatedData?: Buffer;
	}
) => Buffer;

const argon2Sync = (nodeCrypto as unknown as { argon2Sync?: Argon2SyncFn }).argon2Sync;

export const MAGIC = 'PLBK';
export const FORMAT_VERSION = 1;

const MAGIC_LEN = 4;
const VERSION_LEN = 2;
const KDF_PARAMS_LEN = 12; // memory(4) + passes(4) + parallelism(4)
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export const HEADER_LEN = MAGIC_LEN + VERSION_LEN + KDF_PARAMS_LEN + SALT_LEN + NONCE_LEN;

export interface KdfParams {
	/** Memory cost in KiB. */
	memory: number;
	/** Iterations. */
	passes: number;
	/** Lanes. */
	parallelism: number;
}

export const ARGON2_DEFAULTS: KdfParams = { memory: 65536, passes: 3, parallelism: 1 };

/**
 * Bounds on the KDF params we are willing to honour from a blob header.
 */
export const KDF_LIMITS = {
	/** 1 GiB, expressed in KiB to match `memory`. */
	maxMemory: 1024 * 1024,
	/** argon2's own floor is 8 KiB per lane. */
	minMemory: 8,
	maxPasses: 10,
	maxParallelism: 4,
};

function assertSaneKdfParams(kdf: KdfParams): void {
	const inRange = (value: number, min: number, max: number) =>
		Number.isInteger(value) && value >= min && value <= max;

	if (!inRange(kdf.memory, KDF_LIMITS.minMemory, KDF_LIMITS.maxMemory)) {
		throw new BlobDecryptError(
			`Blob header asks for an unreasonable KDF memory cost (${kdf.memory} KiB). ` +
				'The file is corrupt or was not written by Pluton.'
		);
	}
	if (!inRange(kdf.passes, 1, KDF_LIMITS.maxPasses)) {
		throw new BlobDecryptError(
			`Blob header asks for an unreasonable KDF pass count (${kdf.passes}). ` +
				'The file is corrupt or was not written by Pluton.'
		);
	}
	if (!inRange(kdf.parallelism, 1, KDF_LIMITS.maxParallelism)) {
		throw new BlobDecryptError(
			`Blob header asks for an unreasonable KDF parallelism (${kdf.parallelism}). ` +
				'The file is corrupt or was not written by Pluton.'
		);
	}
}

export interface ParsedHeader {
	version: number;
	kdf: KdfParams;
	salt: Buffer;
	nonce: Buffer;
	bodyOffset: number;
}

/** Thrown when a blob cannot be opened: bad magic, unknown version, wrong key, or tampering. */
export class BlobDecryptError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BlobDecryptError';
	}
}

export function encodeHeader(kdf: KdfParams, salt: Buffer, nonce: Buffer): Buffer {
	if (salt.length !== SALT_LEN) {
		throw new Error(`salt must be ${SALT_LEN} bytes, got ${salt.length}`);
	}
	if (nonce.length !== NONCE_LEN) {
		throw new Error(`nonce must be ${NONCE_LEN} bytes, got ${nonce.length}`);
	}

	const header = Buffer.alloc(HEADER_LEN);
	let offset = 0;
	header.write(MAGIC, offset, MAGIC_LEN, 'ascii');
	offset += MAGIC_LEN;
	header.writeUInt16BE(FORMAT_VERSION, offset);
	offset += VERSION_LEN;
	header.writeUInt32BE(kdf.memory, offset);
	offset += 4;
	header.writeUInt32BE(kdf.passes, offset);
	offset += 4;
	header.writeUInt32BE(kdf.parallelism, offset);
	offset += 4;
	salt.copy(header, offset);
	offset += SALT_LEN;
	nonce.copy(header, offset);

	return header;
}

export function parseHeader(buf: Buffer): ParsedHeader {
	if (buf.length < HEADER_LEN + TAG_LEN) {
		throw new BlobDecryptError('Not a Pluton backup blob: file is too small.');
	}

	let offset = 0;
	const magic = buf.toString('ascii', 0, MAGIC_LEN);
	if (magic !== MAGIC) {
		throw new BlobDecryptError(
			`Not a Pluton backup blob: expected magic '${MAGIC}', found '${magic}'.`
		);
	}
	offset += MAGIC_LEN;

	const version = buf.readUInt16BE(offset);
	offset += VERSION_LEN;
	if (version !== FORMAT_VERSION) {
		throw new BlobDecryptError(
			`Unsupported blob format version ${version}. This Pluton understands version ${FORMAT_VERSION}. ` +
				'The blob was probably written by a newer Pluton.'
		);
	}

	const memory = buf.readUInt32BE(offset);
	offset += 4;
	const passes = buf.readUInt32BE(offset);
	offset += 4;
	const parallelism = buf.readUInt32BE(offset);
	offset += 4;

	const salt = buf.subarray(offset, offset + SALT_LEN);
	offset += SALT_LEN;
	const nonce = buf.subarray(offset, offset + NONCE_LEN);
	offset += NONCE_LEN;

	const kdf: KdfParams = { memory, passes, parallelism };
	// Checked before deriveKey() can act on them: these came off an unauthenticated header.
	assertSaneKdfParams(kdf);

	return { version, kdf, salt, nonce, bodyOffset: offset };
}

/**
 * Derive a 32-byte AES key from the user's ENCRYPTION_KEY.
 */
export function deriveKey(
	password: string,
	salt: Buffer,
	kdf: KdfParams = ARGON2_DEFAULTS
): Buffer {
	if (!argon2Sync) {
		throw new Error(
			'This Node runtime has no crypto.argon2Sync (added in Node 24). ' +
				'Pluton self-backup requires it to derive the blob encryption key.'
		);
	}
	return Buffer.from(
		argon2Sync('argon2id', {
			message: Buffer.from(password, 'utf-8'),
			nonce: salt,
			parallelism: kdf.parallelism,
			tagLength: 32,
			memory: kdf.memory,
			passes: kdf.passes,
		})
	);
}

export function sealBlob(tar: Buffer, password: string, kdf: KdfParams = ARGON2_DEFAULTS): Buffer {
	const salt = randomBytes(SALT_LEN);
	const nonce = randomBytes(NONCE_LEN);
	const key = deriveKey(password, salt, kdf);

	const cipher = createCipheriv('aes-256-gcm', key, nonce);
	const ciphertext = Buffer.concat([cipher.update(tar), cipher.final()]);
	const tag = cipher.getAuthTag();

	return Buffer.concat([encodeHeader(kdf, salt, nonce), ciphertext, tag]);
}

export function openBlob(blob: Buffer, password: string): Buffer {
	const { kdf, salt, nonce, bodyOffset } = parseHeader(blob);

	const tag = blob.subarray(blob.length - TAG_LEN);
	const ciphertext = blob.subarray(bodyOffset, blob.length - TAG_LEN);

	const key = deriveKey(password, salt, kdf);
	const decipher = createDecipheriv('aes-256-gcm', key, nonce);
	// setAuthTag before final() so a wrong key throws instead of yielding garbage.
	decipher.setAuthTag(tag);

	try {
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	} catch {
		throw new BlobDecryptError(
			'Could not decrypt the blob. The encryption key is wrong, or the file is corrupt.'
		);
	}
}
