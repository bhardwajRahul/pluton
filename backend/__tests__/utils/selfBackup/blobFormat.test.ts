import {
	sealBlob,
	openBlob,
	parseHeader,
	encodeHeader,
	BlobDecryptError,
	ARGON2_DEFAULTS,
	KDF_LIMITS,
	MAGIC,
	FORMAT_VERSION,
} from '../../../src/utils/selfBackup/blobFormat';

// No mocks: this module imports only node:crypto, by design.

const PASSWORD = 'correct horse battery staple';
const PAYLOAD = Buffer.from('a pretend tar payload with some bytes in it');

// argon2id at m=64MB is ~110ms per derivation, and most cases here derive twice.
jest.setTimeout(30000);

describe('blobFormat', () => {
	it('round-trips a payload through seal -> open', () => {
		const blob = sealBlob(PAYLOAD, PASSWORD);
		expect(openBlob(blob, PASSWORD)).toEqual(PAYLOAD);
	});

	it('produces a different blob each time (fresh salt and nonce)', () => {
		expect(sealBlob(PAYLOAD, PASSWORD).equals(sealBlob(PAYLOAD, PASSWORD))).toBe(false);
	});

	it('throws on the wrong key rather than returning garbage', () => {
		const blob = sealBlob(PAYLOAD, PASSWORD);
		expect(() => openBlob(blob, 'wrong-password')).toThrow(BlobDecryptError);
	});

	it('rejects a bad magic', () => {
		const blob = sealBlob(PAYLOAD, PASSWORD);
		blob.write('XXXX', 0, 4, 'ascii');
		expect(() => parseHeader(blob)).toThrow(/Not a Pluton backup blob/);
	});

	it('rejects an unknown format version', () => {
		const blob = sealBlob(PAYLOAD, PASSWORD);
		blob.writeUInt16BE(FORMAT_VERSION + 1, 4);
		expect(() => parseHeader(blob)).toThrow(/Unsupported blob format version/);
	});

	it('rejects a file too small to be a blob', () => {
		expect(() => parseHeader(Buffer.from('PLBK'))).toThrow(/too small/);
	});

	it('throws when a ciphertext byte is flipped', () => {
		const blob = sealBlob(PAYLOAD, PASSWORD);
		const { bodyOffset } = parseHeader(blob);
		blob[bodyOffset] ^= 0xff;
		expect(() => openBlob(blob, PASSWORD)).toThrow(BlobDecryptError);
	});

	it('throws when the auth tag is tampered with', () => {
		const blob = sealBlob(PAYLOAD, PASSWORD);
		blob[blob.length - 1] ^= 0xff;
		expect(() => openBlob(blob, PASSWORD)).toThrow(BlobDecryptError);
	});

	it('carries the kdf params in the header so a future KDF swap stays readable', () => {
		const blob = sealBlob(PAYLOAD, PASSWORD);
		const header = parseHeader(blob);
		expect(header.kdf).toEqual(ARGON2_DEFAULTS);
		expect(header.version).toBe(FORMAT_VERSION);
		expect(blob.toString('ascii', 0, 4)).toBe(MAGIC);
	});

	it('opens a blob using the params recorded in its header, not the current defaults', () => {
		const weakKdf = { memory: 8192, passes: 1, parallelism: 1 };
		const blob = sealBlob(PAYLOAD, PASSWORD, weakKdf);
		expect(parseHeader(blob).kdf).toEqual(weakKdf);
		expect(openBlob(blob, PASSWORD)).toEqual(PAYLOAD);
	});

	describe('kdf params from an untrusted header', () => {
		// The header is plaintext AND unauthenticated: it must be read, and the key derived from
		// it, before there is a key with which to check the GCM tag. So on any blob the user did
		// not write -- and --restore-pluton accepts an arbitrary file -- these are attacker
		// controlled, and act before there is anything to authenticate.
		const withKdfParam = (offset: number, value: number): Buffer => {
			const blob = sealBlob(PAYLOAD, PASSWORD);
			blob.writeUInt32BE(value, offset);
			return blob;
		};
		const MEMORY_OFFSET = 6;
		const PASSES_OFFSET = 10;
		const PARALLELISM_OFFSET = 14;

		it('refuses an absurd memory cost instead of asking argon2 for 4 TiB', () => {
			expect(() => parseHeader(withKdfParam(MEMORY_OFFSET, 0xffffffff))).toThrow(
				/unreasonable KDF memory cost/
			);
		});

		it('refuses an absurd pass count instead of hanging forever', () => {
			expect(() => parseHeader(withKdfParam(PASSES_OFFSET, 0xffffffff))).toThrow(
				/unreasonable KDF pass count/
			);
		});

		it('refuses an absurd parallelism', () => {
			expect(() => parseHeader(withKdfParam(PARALLELISM_OFFSET, 0xffffffff))).toThrow(
				/unreasonable KDF parallelism/
			);
		});

		it('refuses zeroed params', () => {
			expect(() => parseHeader(withKdfParam(MEMORY_OFFSET, 0))).toThrow(BlobDecryptError);
			expect(() => parseHeader(withKdfParam(PASSES_OFFSET, 0))).toThrow(BlobDecryptError);
			expect(() => parseHeader(withKdfParam(PARALLELISM_OFFSET, 0))).toThrow(BlobDecryptError);
		});

		it('leaves the defaults, and the limits themselves, comfortably in range', () => {
			// The ceilings must never reject a blob Pluton actually wrote, now or after a
			// params bump.
			expect(() => parseHeader(sealBlob(PAYLOAD, PASSWORD))).not.toThrow();
			expect(ARGON2_DEFAULTS.memory).toBeLessThan(KDF_LIMITS.maxMemory);
			expect(ARGON2_DEFAULTS.passes).toBeLessThan(KDF_LIMITS.maxPasses);
			expect(ARGON2_DEFAULTS.parallelism).toBeLessThan(KDF_LIMITS.maxParallelism);
		});
	});

	it('rejects a salt or nonce of the wrong length', () => {
		expect(() => encodeHeader(ARGON2_DEFAULTS, Buffer.alloc(8), Buffer.alloc(12))).toThrow(
			/salt must be 16 bytes/
		);
		expect(() => encodeHeader(ARGON2_DEFAULTS, Buffer.alloc(16), Buffer.alloc(8))).toThrow(
			/nonce must be 12 bytes/
		);
	});
});
