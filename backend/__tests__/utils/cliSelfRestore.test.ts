import fs from 'fs';
import os from 'os';
import path from 'path';

// cliSelfRestore imports payload -> AppPaths (an import-time singleton that mkdirSync's
// ~12 dirs) and ConfigService. Both are mocked so the pure pieces can be tested in isolation.
const mockDataDir = path.join(__dirname, '__unused__');

// writeEncryptionKeyToEnvFile applies a Windows ACL via icacls; keep it out of tests.
jest.mock('child_process', () => ({ execSync: jest.fn() }));

jest.mock('../../src/utils/AppPaths', () => ({
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

jest.mock('../../src/services/ConfigService', () => ({
	configService: { config: { SERVER_PORT: 5173 } },
}));

import Database from 'better-sqlite3';
import {
	parseRestoreArgs,
	checkVersionSkew,
	checkEdition,
	isServerRunning,
	evaluateInstanceGuard,
	buildCompletionMessage,
	applyEncryptionKey,
	releaseDatabaseFiles,
} from '../../src/utils/cliSelfRestore';

const local = { plutonVersion: '1.4.0', drizzleJournalTag: '0042_stable_tag' };

describe('parseRestoreArgs', () => {
	it('reads the blob path that follows the flag', () => {
		expect(parseRestoreArgs(['node', 'pluton', '--restore-pluton', './b.pluton'])).toEqual({
			blobPath: './b.pluton',
			force: false,
		});
	});

	it('picks up --force in any position', () => {
		expect(parseRestoreArgs(['node', 'pluton', '--force', '--restore-pluton', './b.pluton'])).toEqual(
			{ blobPath: './b.pluton', force: true }
		);
	});

	it('returns a null path when the flag has no argument', () => {
		expect(parseRestoreArgs(['node', 'pluton', '--restore-pluton'])).toEqual({
			blobPath: null,
			force: false,
		});
	});

	it('does not swallow a following flag as the blob path', () => {
		expect(parseRestoreArgs(['node', 'pluton', '--restore-pluton', '--force'])).toEqual({
			blobPath: null,
			force: true,
		});
	});

	it('returns a null path when the flag is absent', () => {
		expect(parseRestoreArgs(['node', 'pluton']).blobPath).toBeNull();
	});
});

describe('evaluateInstanceGuard', () => {
	const base = { serverResponding: false, isDocker: false, force: false, port: 5173 };

	it('refuses when the server answers the probe', () => {
		const v = evaluateInstanceGuard({ ...base, serverResponding: true });
		expect(v.allowed).toBe(false);
		expect((v as any).reason).toMatch(/still running on port 5173/);
	});

	it('allows a responding server through --force, but warns', () => {
		const v = evaluateInstanceGuard({ ...base, serverResponding: true, force: true });
		expect(v.allowed).toBe(true);
		expect((v as any).warning).toMatch(/--force/);
	});

	it('allows a silent probe on a non-docker install, where loopback is trustworthy', () => {
		expect(evaluateInstanceGuard(base)).toEqual({ allowed: true });
	});

	it('refuses a silent probe under docker, where the restore container has its own loopback', () => {
		// The motivating bug: without this the guard fails OPEN in exactly the install type
		// where it cannot see the server, and the user silently corrupts a live database.
		const v = evaluateInstanceGuard({ ...base, isDocker: true });
		expect(v.allowed).toBe(false);
		expect((v as any).reason).toMatch(/docker compose down/);
	});

	it('tells the docker user what to do rather than just refusing', () => {
		const reason = (evaluateInstanceGuard({ ...base, isDocker: true }) as any).reason;
		expect(reason).toMatch(/cannot tell whether/i);
		expect(reason).toMatch(/--force/);
	});

	it('lets a docker user proceed with --force, warning that it could not verify', () => {
		const v = evaluateInstanceGuard({ ...base, isDocker: true, force: true });
		expect(v.allowed).toBe(true);
		expect((v as any).warning).toMatch(/[Cc]ould not verify/);
	});

	it('prefers the concrete "still running" message when docker DOES answer the probe', () => {
		// docker exec / --network=host land in the server's namespace, so the probe works
		// and the user deserves the specific message, not the generic docker one.
		const v = evaluateInstanceGuard({ ...base, isDocker: true, serverResponding: true });
		expect(v.allowed).toBe(false);
		expect((v as any).reason).toMatch(/still running on port/);
		expect((v as any).reason).not.toMatch(/docker compose down/);
	});
});

describe('applyEncryptionKey', () => {
	let dataDir: string;
	let encEnvPath: string;
	const KEY = 'the-key-from-the-blob';

	beforeEach(() => {
		dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'applykey-'));
		encEnvPath = path.join(dataDir, 'pluton.enc.env');
	});

	afterEach(() => {
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	it('writes the key on desktop/server, where nothing else supplies it', async () => {
		await applyEncryptionKey({ dataDir, key: KEY, isDocker: false });

		expect(fs.existsSync(encEnvPath)).toBe(true);
		expect(fs.readFileSync(encEnvPath, 'utf-8')).toContain(`ENCRYPTION_KEY=${KEY}`);
	});

	it('writes NOTHING into the data dir on docker', async () => {
		// ENCRYPTION_KEY is RESTIC_PASSWORD for every repo. Compose is the only source of
		// truth on docker, so a copy here would just be a plaintext master key at rest.
		await applyEncryptionKey({ dataDir, key: KEY, isDocker: true });

		expect(fs.existsSync(encEnvPath)).toBe(false);
	});

	it('removes a pre-existing key file on docker, rather than leaving it', async () => {
		fs.writeFileSync(encEnvPath, 'ENCRYPTION_KEY=a-stale-key-from-an-older-restore\n');

		await applyEncryptionKey({ dataDir, key: KEY, isDocker: true });

		// Left in place, ConfigService would silently prefer it whenever compose passes an
		// empty ENCRYPTION_KEY, booting Pluton against the WRONG key. Loud failure is better.
		expect(fs.existsSync(encEnvPath)).toBe(false);
	});

	it('never leaves the key on disk in docker, whatever was there before', async () => {
		fs.writeFileSync(encEnvPath, `ENCRYPTION_KEY=${KEY}\n`);

		await applyEncryptionKey({ dataDir, key: KEY, isDocker: true });

		const leaked = fs
			.readdirSync(dataDir)
			.filter(f => fs.readFileSync(path.join(dataDir, f), 'utf-8').includes(KEY));
		expect(leaked).toEqual([]);
	});

	it('is a no-op on docker when there is no key file to begin with', async () => {
		await expect(applyEncryptionKey({ dataDir, key: KEY, isDocker: true })).resolves.toBeUndefined();
		expect(fs.readdirSync(dataDir)).toEqual([]);
	});

	it('overwrites a stale key file on desktop/server instead of removing it', async () => {
		fs.writeFileSync(encEnvPath, 'ENCRYPTION_KEY=an-old-key\n');

		await applyEncryptionKey({ dataDir, key: KEY, isDocker: false });

		const content = fs.readFileSync(encEnvPath, 'utf-8');
		expect(content).toContain(`ENCRYPTION_KEY=${KEY}`);
		expect(content).not.toContain('an-old-key');
	});
});

describe('buildCompletionMessage', () => {
	// Measured: ConfigService only reads pluton.enc.env when ENCRYPTION_KEY is absent from the
	// env, and hashPasswordIfNeeded re-hashes USER_PASSWORD over the restored PASSWORD_HASH.
	// So the restored key/password only apply where nothing injects env vars.
	const docker = { isDocker: true, isLinuxInstalled: false };
	const server = { isDocker: false, isLinuxInstalled: true };
	const desktop = { isDocker: false, isLinuxInstalled: false };

	it('tells docker users to set ENCRYPTION_KEY in their compose .env', () => {
		const msg = buildCompletionMessage(docker);
		expect(msg).toMatch(/ENCRYPTION_KEY/);
		expect(msg).toMatch(/docker-compose\.yml/);
		expect(msg).toMatch(/same key you just entered/i);
	});

	it('presents the docker .env key as required, not advisory', () => {
		// There is no longer a key file in the volume to fall back on, so omitting it is
		// not a "you probably should" but a "the container will not start".
		const msg = buildCompletionMessage(docker);
		expect(msg).toMatch(/REQUIRED/);
		expect(msg).toMatch(/refuse to start/);
	});

	it('tells docker users the key is deliberately not in the volume', () => {
		expect(buildCompletionMessage(docker)).toMatch(/NOT stored in the data volume/);
	});

	it('warns docker users what a mismatched key costs them', () => {
		expect(buildCompletionMessage(docker)).toMatch(/no longer read/);
	});

	it('does NOT tell docker users to use their old password', () => {
		// It would be wrong: compose's USER_PASSWORD overwrites the restored hash on boot.
		const msg = buildCompletionMessage(docker);
		expect(msg).toMatch(/not your old password/);
		expect(msg).toMatch(/USER_PASSWORD/);
	});

	it('tells server users the key is already handled, since systemd reads the file we wrote', () => {
		const msg = buildCompletionMessage(server);
		expect(msg).toMatch(/etc\/pluton\/pluton\.enc\.env/);
		expect(msg).toMatch(/Nothing more to do for the key/);
	});

	it('points server users at pluton.env for credentials, not the old password', () => {
		const msg = buildCompletionMessage(server);
		expect(msg).toMatch(/etc\/pluton\/pluton\.env/);
		expect(msg).toMatch(/not the old ones/);
	});

	it('gives each install type its own start command', () => {
		expect(buildCompletionMessage(docker)).toMatch(/docker compose up -d/);
		expect(buildCompletionMessage(server)).toMatch(/systemctl start pluton/);
	});

	it('only promises the old password on desktop, where no env vars override it', () => {
		const msg = buildCompletionMessage(desktop);
		expect(msg).toMatch(/log in with your old password/i);
		expect(msg).not.toMatch(/docker compose/);
		expect(msg).not.toMatch(/systemctl/);
	});

	it('says restore is complete in every case', () => {
		for (const env of [docker, server, desktop]) {
			expect(buildCompletionMessage(env)).toMatch(/Restore complete/);
		}
	});
});

describe('checkEdition', () => {
	it('accepts a matching edition', () => {
		expect(checkEdition('core', 'core').ok).toBe(true);
	});

	it('refuses a foreign edition, in both directions', () => {
		const fromPro = checkEdition('pro', 'core');
		expect(fromPro.ok).toBe(false);
		expect(fromPro.reason).toMatch(/different|edition/i);
		expect(checkEdition('core', 'pro').ok).toBe(false);
	});

	it('refuses a blob that does not record its edition', () => {
		expect(checkEdition(undefined, 'core').ok).toBe(false);
	});

	it('says "edition", not "version", since a misleading message sends the user down the wrong path', () => {
		const result = checkEdition('pro', 'core');
		expect(result.reason).toContain('edition');
		expect(result.reason).not.toMatch(/upgrade pluton/i);
	});
});

describe('checkVersionSkew', () => {
	it('accepts an older blob, because migrations run forward. This is the normal path', () => {
		expect(
			checkVersionSkew({ plutonVersion: '1.2.0', drizzleJournalTag: '0031_older' }, local).ok
		).toBe(true);
	});

	it('accepts an equal version', () => {
		expect(
			checkVersionSkew({ plutonVersion: '1.4.0', drizzleJournalTag: '0042_stable_tag' }, local).ok
		).toBe(true);
	});

	it('refuses a newer blob version, because there are no down migrations', () => {
		const result = checkVersionSkew({ plutonVersion: '1.5.0', drizzleJournalTag: null }, local);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/newer/);
	});

	it('refuses a blob whose schema is ahead even when the version is not', () => {
		const result = checkVersionSkew(
			{ plutonVersion: '1.4.0', drizzleJournalTag: '0043_newer' },
			local
		);
		expect(result.ok).toBe(false);
		expect(result.reason).toMatch(/schema/);
	});

	it('compares version segments numerically, not lexically', () => {
		// '1.10.0' < '1.9.0' as strings; it must not be treated as older.
		expect(
			checkVersionSkew({ plutonVersion: '1.10.0', drizzleJournalTag: null }, local).ok
		).toBe(false);
		expect(
			checkVersionSkew(
				{ plutonVersion: '1.9.0', drizzleJournalTag: null },
				{ plutonVersion: '1.10.0', drizzleJournalTag: null }
			).ok
		).toBe(true);
	});

	it('does not block on an unparseable version (dev builds report "unknown")', () => {
		expect(checkVersionSkew({ plutonVersion: 'unknown', drizzleJournalTag: null }, local).ok).toBe(
			true
		);
		expect(
			checkVersionSkew(
				{ plutonVersion: '9.9.9', drizzleJournalTag: null },
				{ plutonVersion: 'unknown', drizzleJournalTag: null }
			).ok
		).toBe(true);
	});

	it('does not compare journal tags when either side is missing one', () => {
		expect(
			checkVersionSkew({ plutonVersion: '1.0.0', drizzleJournalTag: '0099_x' }, {
				plutonVersion: '1.4.0',
				drizzleJournalTag: null,
			}).ok
		).toBe(true);
	});
});

describe('isServerRunning', () => {
	const realFetch = global.fetch;
	afterEach(() => {
		global.fetch = realFetch;
	});

	it('reports running on any HTTP response, since deleting the DB under a live server is corruption', async () => {
		global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as any;
		expect(await isServerRunning(5173)).toBe(true);
	});

	it('reports running even on a non-200, since something is still holding the port', async () => {
		global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as any;
		expect(await isServerRunning(5173)).toBe(true);
	});

	it('reports not running on ECONNREFUSED', async () => {
		global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as any;
		expect(await isServerRunning(5173)).toBe(false);
	});

	it('probes the unauthenticated health endpoint on loopback', async () => {
		const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
		global.fetch = fetchMock as any;
		await isServerRunning(9999);
		expect(fetchMock).toHaveBeenCalledWith(
			'http://127.0.0.1:9999/api/health',
			expect.objectContaining({ signal: expect.anything() })
		);
	});
});

// The automated form of the design doc's "sqlite.close() on Windows" spike (§9): open a REAL
// WAL database with a real handle, then assert releaseDatabaseFiles closes it and clears the
// file plus both sidecars, rather than racing close() against unlink.
describe('releaseDatabaseFiles', () => {
	let tmp: string;
	let dbPath: string;

	beforeEach(() => {
		tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pluton-dbrelease-'));
		dbPath = path.join(tmp, 'pluton.db');
	});

	afterEach(() => {
		fs.rmSync(tmp, { recursive: true, force: true });
	});

	// Open a WAL db and force a -wal (and -shm) into existence with an uncheckpointed write.
	const openWalDbWithSidecars = () => {
		const sqlite = new Database(dbPath);
		sqlite.pragma('journal_mode = WAL');
		sqlite.pragma('wal_autocheckpoint = 0'); // keep the write in -wal so the sidecar survives
		sqlite.exec('CREATE TABLE t (id INTEGER); INSERT INTO t (id) VALUES (1);');
		return sqlite;
	};

	it('closes the handle and clears pluton.db, -wal and -shm', async () => {
		const sqlite = openWalDbWithSidecars();
		expect(fs.existsSync(`${dbPath}-wal`)).toBe(true);

		await releaseDatabaseFiles(sqlite, dbPath);

		expect(sqlite.open).toBe(false);
		expect(fs.existsSync(dbPath)).toBe(false);
		expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
		expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
	});

	it('is a no-op on the sidecars when the DB was never in WAL mode', async () => {
		const sqlite = new Database(dbPath);
		sqlite.exec('CREATE TABLE t (id INTEGER);');

		await expect(releaseDatabaseFiles(sqlite, dbPath)).resolves.toBeUndefined();
		expect(fs.existsSync(dbPath)).toBe(false);
	});

	it('leaves nothing that could replay a stale WAL onto the restored DB', async () => {
		// The whole point of clearing the sidecars: a leftover -wal beside a fresh pluton.db
		// would replay onto it at next open. Assert the db dir holds no db artifacts afterward.
		const sqlite = openWalDbWithSidecars();
		await releaseDatabaseFiles(sqlite, dbPath);

		const leftovers = fs.readdirSync(tmp).filter(f => f.startsWith('pluton.db'));
		expect(leftovers).toEqual([]);
	});
});
