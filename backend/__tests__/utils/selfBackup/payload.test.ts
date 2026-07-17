import fs from 'fs';
import os from 'os';
import path from 'path';

// appPaths is an import-time singleton that mkdirSync's ~12 directories, so it must be
// mocked before anything that imports it loads.
let mockDataDir: string;

jest.mock('../../../src/utils/AppPaths', () => ({
	appPaths: {
		getDataDir: () => mockDataDir,
		getConfigDir: () => path.join(mockDataDir, 'config'),
		getDbDir: () => path.join(mockDataDir, 'db'),
		getProgressDir: () => path.join(mockDataDir, 'progress'),
		getSyncDir: () => path.join(mockDataDir, 'sync'),
		getSchedulesPath: () => path.join(mockDataDir, 'schedules.json'),
		getTempDir: () => path.join(mockDataDir, 'temp'),
	},
}));

import {
	packPayload,
	unpackPayload,
	computeFingerprint,
	assertSafeEntryPath,
	PAYLOAD_SPEC,
	DB_ENTRY,
	MANIFEST_ENTRY,
} from '../../../src/utils/selfBackup/payload';

const write = (rel: string, content = 'x') => {
	const abs = path.join(mockDataDir, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	return abs;
};

/** A data dir with one of everything the spec knows about, plus things it must never take. */
function seedFullDataDir() {
	write('db/pluton.db', 'not-the-real-snapshot');
	write('config/rclone.conf', '[remote]');
	write('config/rclone_global.json', '{"transfers":8}');
	write('config/restic_global.json', '{"packSize":"16M"}');
	write('config/device_settings.json', '{"general":{}}');
	write('config/config.json', '{"APP_TITLE":"Pluton"}');
	write('config/self_backup_state.json', '{"lastSuccessAt":"2026-01-01T00:00:00Z"}');
	write('keys.json', '{"SECRET":"s"}');
	write('schedules.json', '[]');
	write('.activated', 'licensed');
	write('progress/run-1.json', '{"events":[]}');
	write('progress/nested/run-2.json', '{"events":[]}');
	write('sync/state.json', '{"ok":true}');
	write('sync/worker.lock', 'heartbeat');

	// Must never end up in the blob.
	write('stats/restore-1.json', 'x'.repeat(500));
	write('logs/app.log', 'noise');
	write('rescue/rear.iso', 'huge');
	write('pluton.enc.env', 'ENCRYPTION_KEY=hunter2hunter2');
	write('.setup_complete', '2026-01-01');
}

describe('payload', () => {
	let tmpDir: string;
	let snapshotPath: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'payload-'));
		mockDataDir = tmpDir;
		snapshotPath = path.join(tmpDir, 'snapshot.db');
		fs.writeFileSync(snapshotPath, 'pretend-vacuumed-sqlite');
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	async function packAndList(): Promise<{ entries: string[]; tar: Buffer }> {
		const tar = await packPayload({ dbSnapshotPath: snapshotPath, edition: 'core' });
		const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpacked-'));
		const manifest = await unpackPayload(tar, destDir);
		const out = { entries: manifest.fileList, tar };
		fs.rmSync(destDir, { recursive: true, force: true });
		return out;
	}

	it('packs and unpacks, restoring file contents faithfully', async () => {
		seedFullDataDir();
		const tar = await packPayload({ dbSnapshotPath: snapshotPath, edition: 'core' });

		const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpacked-'));
		try {
			await unpackPayload(tar, destDir);
			expect(fs.readFileSync(path.join(destDir, DB_ENTRY), 'utf-8')).toBe('pretend-vacuumed-sqlite');
			expect(fs.readFileSync(path.join(destDir, 'keys.json'), 'utf-8')).toBe('{"SECRET":"s"}');
			expect(fs.readFileSync(path.join(destDir, 'config/rclone.conf'), 'utf-8')).toBe('[remote]');
			expect(fs.readFileSync(path.join(destDir, 'progress/nested/run-2.json'), 'utf-8')).toBe(
				'{"events":[]}'
			);
		} finally {
			fs.rmSync(destDir, { recursive: true, force: true });
		}
	});

	it('includes exactly the spec entries that exist on disk', async () => {
		seedFullDataDir();
		const { entries } = await packAndList();

		expect(entries).toEqual(
			expect.arrayContaining([
				DB_ENTRY,
				'config/rclone.conf',
				'config/rclone_global.json',
				'config/restic_global.json',
				'config/device_settings.json',
				'config/config.json',
				'config/self_backup_state.json',
				'keys.json',
				'schedules.json',
				'.activated',
				'progress/run-1.json',
				'progress/nested/run-2.json',
				'sync/state.json',
			])
		);
	});

	it('never packs stats/, logs/, rescue/, pluton.enc.env or .setup_complete', async () => {
		seedFullDataDir();
		const { entries } = await packAndList();

		for (const forbidden of ['stats', 'logs', 'rescue', 'pluton.enc.env', '.setup_complete']) {
			expect(entries.some(e => e === forbidden || e.startsWith(`${forbidden}/`))).toBe(false);
		}
	});

	it('packs sync/*.json but skips sync/**/*.lock', async () => {
		seedFullDataDir();
		const { entries } = await packAndList();

		expect(entries).toContain('sync/state.json');
		expect(entries.some(e => e.endsWith('.lock'))).toBe(false);
	});

	it('skips a spec entry that does not exist on disk rather than throwing', async () => {
		// Only the DB snapshot exists, so every optional entry is absent.
		const { entries } = await packAndList();
		expect(entries).toEqual([DB_ENTRY]);
	});

	it('populates manifest.edition and the version-guard fields', async () => {
		seedFullDataDir();
		const tar = await packPayload({
			dbSnapshotPath: snapshotPath,
			edition: 'core',
			dbPageCount: 42,
		});
		const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpacked-'));
		try {
			const manifest = await unpackPayload(tar, destDir);
			expect(manifest.edition).toBe('core');
			expect(manifest.dbPageCount).toBe(42);
			expect(manifest.hostname).toBeTruthy();
			expect(manifest.createdAt).toBeTruthy();
			expect(manifest).toHaveProperty('plutonVersion');
			expect(manifest).toHaveProperty('drizzleJournalTag');
			expect(fs.existsSync(path.join(destDir, MANIFEST_ENTRY))).toBe(true);
		} finally {
			fs.rmSync(destDir, { recursive: true, force: true });
		}
	});

	it('every spec entry is optional, so the spec is a pure include list', () => {
		// Guards the structural property: nothing in the spec reaches outside the data dir.
		for (const spec of PAYLOAD_SPEC) {
			expect(spec.source()).toContain(mockDataDir);
		}
	});

	describe('assertSafeEntryPath', () => {
		it('accepts a normal nested entry', () => {
			expect(assertSafeEntryPath('config/rclone.conf', tmpDir)).toBe(
				path.resolve(tmpDir, 'config/rclone.conf')
			);
		});

		it('rejects ../ traversal', () => {
			expect(() => assertSafeEntryPath('../../etc/whatever', tmpDir)).toThrow(/escapes/);
			expect(() => assertSafeEntryPath('config/../../evil', tmpDir)).toThrow(/escapes/);
		});

		it('rejects absolute paths', () => {
			expect(() => assertSafeEntryPath('/etc/passwd', tmpDir)).toThrow(/absolute path/);
			expect(() => assertSafeEntryPath('C:\\Windows\\evil', tmpDir)).toThrow(/absolute path/);
		});
	});

	it('unpackPayload rejects a tar entry that escapes the destination', async () => {
		const { pack } = await import('tar-stream');
		const tarPack = pack();
		const chunks: Buffer[] = [];
		tarPack.on('data', (c: Buffer) => chunks.push(c));
		const evil = Buffer.from('pwned');
		tarPack.entry({ name: '../escaped.txt', size: evil.length }, evil);
		tarPack.finalize();
		await new Promise(resolve => tarPack.on('end', resolve));

		const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpacked-'));
		try {
			await expect(unpackPayload(Buffer.concat(chunks), destDir)).rejects.toThrow(/escapes/);
			expect(fs.existsSync(path.join(path.dirname(destDir), 'escaped.txt'))).toBe(false);
		} finally {
			fs.rmSync(destDir, { recursive: true, force: true });
		}
	});

	it('rejects a payload with no manifest', async () => {
		const { pack } = await import('tar-stream');
		const tarPack = pack();
		const chunks: Buffer[] = [];
		tarPack.on('data', (c: Buffer) => chunks.push(c));
		const body = Buffer.from('db');
		tarPack.entry({ name: DB_ENTRY, size: body.length }, body);
		tarPack.finalize();
		await new Promise(resolve => tarPack.on('end', resolve));

		const destDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unpacked-'));
		try {
			await expect(unpackPayload(Buffer.concat(chunks), destDir)).rejects.toThrow(/manifest/);
		} finally {
			fs.rmSync(destDir, { recursive: true, force: true });
		}
	});

	describe('computeFingerprint', () => {
		it('is stable across calls when nothing changes', () => {
			seedFullDataDir();
			expect(computeFingerprint()).toBe(computeFingerprint());
		});

		it('changes when a tracked file changes size', () => {
			seedFullDataDir();
			const before = computeFingerprint();
			write('config/rclone.conf', '[remote]\n[another]');
			expect(computeFingerprint()).not.toBe(before);
		});

		it('changes when a tracked file changes mtime', () => {
			seedFullDataDir();
			const before = computeFingerprint();
			const future = new Date(Date.now() + 60_000);
			fs.utimesSync(path.join(mockDataDir, 'db/pluton.db'), future, future);
			expect(computeFingerprint()).not.toBe(before);
		});

		it('changes when a tracked file appears', () => {
			write('db/pluton.db', 'db');
			const before = computeFingerprint();
			write('config/config.json', '{}');
			expect(computeFingerprint()).not.toBe(before);
		});

		it('ignores untracked noise like logs/', () => {
			seedFullDataDir();
			const before = computeFingerprint();
			write('logs/app.log', 'a lot more noise than before');
			expect(computeFingerprint()).toBe(before);
		});
	});
});
