/**
 * `pluton --restore-pluton <blob>`: restore Pluton's config and history from a self-backup
 * blob, against a stopped server. A short-lived CLI process, not a flow inside the server.
 *
 * Steps 1-5 are read-only. A wrong key, corrupt blob, foreign edition, newer version, or a
 * running server all fail before the data dir is touched.
 */

import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { appPaths } from './AppPaths';
import { prompt } from './cliPrompt';
import { openBlob, BlobDecryptError } from './selfBackup/blobFormat';
import { unpackPayload, PayloadManifest, PlutonEdition } from './selfBackup/payload';
import { getDrizzleJournalTag } from './migrations';
import {
	writeEncryptionKeyToEnvFile,
	isLinuxInstalledRuntime,
	getEncEnvFilePath,
} from './envFileHelpers';
import { isDockerMode } from './installHelpers';
import { configService } from '../services/ConfigService';

export interface RestoreArgs {
	blobPath: string | null;
	force: boolean;
}

export interface RestoreDeps {
	/** The live handle this process opened, injected so we close the right one (see below). */
	sqlite: SqliteDatabase;
	dbFilePath: string;
	edition: PlutonEdition;
}

export function parseRestoreArgs(argv: string[]): RestoreArgs {
	const flagIndex = argv.indexOf('--restore-pluton');
	const next = flagIndex === -1 ? undefined : argv[flagIndex + 1];
	const blobPath = next && !next.startsWith('--') ? next : null;
	return { blobPath, force: argv.includes('--force') };
}

/** Any response on /api/health means a live Pluton. A negative is namespace-scoped (see guard). */
export async function isServerRunning(port: number): Promise<boolean> {
	try {
		await fetch(`http://127.0.0.1:${port}/api/health`, {
			signal: AbortSignal.timeout(2000),
		});
		return true;
	} catch {
		return false;
	}
}

export type GuardVerdict = { allowed: true; warning?: string } | { allowed: false; reason: string };

/**
 * A probe response is authoritative; silence is not. Under Docker the restore container has its
 * own network namespace, so the probe stays silent even when the server is live on the same
 * volume -- undetectable, so refuse unless --force.
 */
export function evaluateInstanceGuard(opts: {
	serverResponding: boolean;
	isDocker: boolean;
	force: boolean;
	port: number;
}): GuardVerdict {
	if (opts.serverResponding) {
		if (!opts.force) {
			return {
				allowed: false,
				reason:
					`Pluton is still running on port ${opts.port}. Stop the Pluton service before restoring, ` +
					'then run this command again.\n' +
					'   (If the port is held by something else, re-run with --force.)',
			};
		}
		return {
			allowed: true,
			warning: `A server is responding on port ${opts.port}, but --force was given. Continuing.`,
		};
	}

	if (opts.isDocker) {
		if (!opts.force) {
			return {
				allowed: false,
				reason:
					'Running inside a container, Pluton cannot tell whether your Pluton container is still up:\n' +
					'   this restore container has its own network namespace, so the health check here proves nothing.\n' +
					'   Restoring while Pluton is running will corrupt the database.\n\n' +
					'   Stop it first:\n' +
					'     docker compose down\n\n' +
					'   Then re-run this command with --force to confirm it is stopped.',
			};
		}
		return {
			allowed: true,
			warning:
				'Could not verify that Pluton is stopped (running inside a container). ' +
				'Proceeding because --force was given.',
		};
	}

	return { allowed: true };
}

export interface SkewCheckResult {
	ok: boolean;
	reason?: string;
}

/** Refuse a newer blob into older Pluton (no down migrations). Caller MUST check edition first. */
export function checkVersionSkew(
	manifest: Pick<PayloadManifest, 'plutonVersion' | 'drizzleJournalTag'>,
	local: { plutonVersion: string; drizzleJournalTag: string | null }
): SkewCheckResult {
	const cmp = compareSemver(manifest.plutonVersion, local.plutonVersion);
	if (cmp > 0) {
		return {
			ok: false,
			reason:
				`This blob was written by Pluton ${manifest.plutonVersion}, but this install is ${local.plutonVersion}. ` +
				'Restoring a newer backup into an older Pluton is not supported (there are no down migrations). ' +
				'Upgrade Pluton to at least the blob version, then restore again.',
		};
	}

	if (
		manifest.drizzleJournalTag &&
		local.drizzleJournalTag &&
		compareJournalTag(manifest.drizzleJournalTag, local.drizzleJournalTag) > 0
	) {
		return {
			ok: false,
			reason:
				`This blob's database schema (${manifest.drizzleJournalTag}) is newer than this install's (${local.drizzleJournalTag}). ` +
				'Restoring it would leave the database ahead of the code. Upgrade Pluton, then restore again.',
		};
	}

	return { ok: true };
}

export function checkEdition(
	manifestEdition: string | undefined,
	localEdition: PlutonEdition
): SkewCheckResult {
	if (!manifestEdition) {
		return {
			ok: false,
			reason:
				'This blob does not record which Pluton edition produced it, so it cannot be safely restored.',
		};
	}
	if (manifestEdition !== localEdition) {
		return {
			ok: false,
			reason:
				`This blob is from the "${manifestEdition}" edition of Pluton, but this install is "${localEdition}". ` +
				'Cross-edition restore is not supported. Version and schema numbering differ between editions.',
		};
	}
	return { ok: true };
}

/** Numeric-segment compare; non-numeric suffixes are ignored. Returns -1 / 0 / 1. */
function compareSemver(a: string, b: string): number {
	const parse = (v: string) =>
		v
			.replace(/^v/, '')
			.split(/[.\-+]/)
			.map(part => parseInt(part, 10))
			.filter(n => !Number.isNaN(n));

	const left = parse(a);
	const right = parse(b);
	// An unparseable version ('unknown', a dev build) can't be ordered, so don't block on it.
	if (left.length === 0 || right.length === 0) return 0;

	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const l = left[i] ?? 0;
		const r = right[i] ?? 0;
		if (l !== r) return l > r ? 1 : -1;
	}
	return 0;
}

/** Drizzle tags are `NNNN_name`; the numeric prefix is the ordering. */
function compareJournalTag(a: string, b: string): number {
	const idx = (tag: string) => parseInt(tag.split('_')[0], 10);
	const left = idx(a);
	const right = idx(b);
	if (Number.isNaN(left) || Number.isNaN(right)) return 0;
	if (left === right) return 0;
	return left > right ? 1 : -1;
}

// Scratch holds the decrypted payload (keys.json included); process.exit() skips finally, so
// every exit path cleans up through here.
let scratchToClean: string | null = null;

function cleanScratch(): void {
	if (!scratchToClean) return;
	try {
		fs.rmSync(scratchToClean, { recursive: true, force: true });
	} catch {
		// best effort
	}
	scratchToClean = null;
}

/** Per-install next steps: env-injected key/password override what we restored, except on desktop. */
export function buildCompletionMessage(env: {
	isDocker: boolean;
	isLinuxInstalled: boolean;
}): string {
	const done = '\n✅ Restore complete.\n';

	if (env.isDocker) {
		return (
			done +
			'\n   REQUIRED: open the .env next to your docker-compose.yml and set\n' +
			'\n     ENCRYPTION_KEY=<the same key you just entered>\n' +
			'\n   The key is deliberately NOT stored in the data volume, so compose is the only\n' +
			'   place Pluton can get it. Without it the container will refuse to start.\n' +
			'   If it is set but does not match the backup, Pluton starts and every restored plan\n' +
			'   points at a repository it can no longer read, so check it now.\n' +
			'\n   While you are in that file, USER_NAME and USER_PASSWORD are your login: they\n' +
			'   override the restored account, so set them to what you want to log in with.\n' +
			'\n   Then: docker compose up -d\n' +
			'   Log in with the USER_NAME / USER_PASSWORD from that .env, not your old password.\n'
		);
	}

	if (env.isLinuxInstalled) {
		return (
			done +
			'\n   The encryption key from your backup was written to /etc/pluton/pluton.enc.env,\n' +
			'   which the service reads on start. Nothing more to do for the key.\n' +
			'\n   Then: sudo systemctl start pluton\n' +
			'   Log in with the PLUTON_USER_NAME / PLUTON_USER_PASSWORD in /etc/pluton/pluton.env.\n' +
			'   Those override the restored account, so they are your credentials now, not the old ones.\n'
		);
	}

	return done + '\n   Start the Pluton service and log in with your old password.\n';
}

/**
 * Desktop/Server: write pluton.enc.env so the key takes effect. Docker: write nothing and delete
 * any copy -- compose owns the key, and a leftover OLDER key would silently boot against the
 * wrong key instead of failing loudly. Safe to delete: the caller just decrypted with it.
 */
export async function applyEncryptionKey(opts: {
	dataDir: string;
	key: string;
	isDocker: boolean;
}): Promise<void> {
	if (opts.isDocker) {
		await fsp.rm(getEncEnvFilePath(opts.dataDir), { force: true });
		return;
	}
	writeEncryptionKeyToEnvFile(opts.dataDir, opts.key);
}

function fail(message: string): never {
	cleanScratch();
	console.error(`❌ ${message}`);
	process.exit(1);
}

function succeed(message: string): never {
	cleanScratch();
	console.log(message);
	process.exit(0);
}

async function copyTree(srcDir: string, destDir: string): Promise<void> {
	await fsp.cp(srcDir, destDir, { recursive: true, force: true });
}

/** Transient errno codes Windows raises for a momentarily-held file (AV, indexer, memory-map). */
const TRANSIENT_FS_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE']);

/**
 * Close the DB handle and clear pluton.db + its WAL sidecars. On Windows a naive close()-unlink
 * races the -shm teardown and AV/indexer scans and hits EBUSY, so: switch out of WAL before
 * closing (deletes -wal/-shm with the handle still held), retry the unlink, then rename aside
 * for a clean slot. Throws only if all three fail; the caller aborts before copying.
 */
export async function releaseDatabaseFiles(
	sqlite: SqliteDatabase,
	dbFilePath: string
): Promise<void> {
	// A downstream edition injects its own handle, but core's db/index.ts also loads here, leaving
	// a SECOND open handle that would make the unlink fail. Close it too. Lazy import keeps the
	// pure pieces off the db graph; the guard avoids double-closing when it already IS the injected one.
	try {
		const coreDb = await import('../db');
		if (coreDb.sqlite !== sqlite && coreDb.sqlite.open) {
			coreDb.sqlite.close();
		}
	} catch {
		// core's db may not be loaded here, or already closed
	}

	try {
		sqlite.pragma('journal_mode = DELETE'); // deletes -wal/-shm before we drop the handle
	} catch {
		// switch failed; still close and lean on the retry/rename below
	}
	sqlite.close();

	const rmOpts = { force: true, maxRetries: 10, retryDelay: 200 } as const;

	for (const suffix of ['-wal', '-shm']) {
		await fsp.rm(`${dbFilePath}${suffix}`, rmOpts);
	}

	try {
		await fsp.rm(dbFilePath, rmOpts);
		return;
	} catch (error: any) {
		if (!TRANSIENT_FS_CODES.has(error?.code)) throw error;
	}

	// Still locked: rename aside. An inert DB with no sidecars is ignored by SQLite.
	const aside = `${dbFilePath}.restore-old-${process.pid}`;
	await fsp.rename(dbFilePath, aside);
	fsp.rm(aside, rmOpts).catch(() => {});
}

/** `deps.sqlite` is injected, not imported, so releaseDatabaseFiles closes the right handle. */
export async function handleSelfRestore(deps: RestoreDeps): Promise<never> {
	console.log('\n🛟  Pluton Restore\n');

	// Show the target while still read-only. A service sets PLUTON_DATA_DIR but the operator's
	// shell often doesn't inherit it, and then the path falls back to the default.
	const dataDir = appPaths.getDataDir();
	console.log(`Restoring into data directory: ${dataDir}`);
	const isRealInstall = Boolean((process as any).pkg) || process.env.NODE_ENV === 'production';
	if (isRealInstall && !isDockerMode() && !process.env.PLUTON_DATA_DIR) {
		console.warn(
			'⚠️  PLUTON_DATA_DIR is not set in this shell, so the path above is the default location.\n' +
				'   If this Pluton runs as a service with a custom data directory, stop the service and set\n' +
				'   PLUTON_DATA_DIR to match it before restoring, or you will restore into the wrong place.\n'
		);
	}

	// ---- 1. Parse
	const { blobPath, force } = parseRestoreArgs(process.argv);
	if (!blobPath) {
		fail('Usage: pluton --restore-pluton <path-to-blob> [--force]');
	}
	if (!fs.existsSync(blobPath)) {
		fail(`No such file: ${blobPath}`);
	}

	// ---- 2. Running-instance guard
	const port = configService.config.SERVER_PORT || 5173;
	const verdict = evaluateInstanceGuard({
		serverResponding: await isServerRunning(port),
		isDocker: isDockerMode(),
		force,
		port,
	});
	if (!verdict.allowed) {
		fail(verdict.reason);
	}
	if (verdict.warning) {
		console.warn(`⚠️  ${verdict.warning}`);
	}

	// ---- 3. Key
	const key = await obtainEncryptionKey();

	// ---- 4. Decrypt (wrong key fails here, before anything is touched)
	console.log('Decrypting blob...');
	let tar: Buffer;
	try {
		tar = openBlob(await fsp.readFile(blobPath), key);
	} catch (error: any) {
		if (error instanceof BlobDecryptError) {
			fail(`${error.message}\n   Nothing has been modified.`);
		}
		throw error;
	}

	// ---- 5. Unpack to scratch, then guard edition before version
	const scratchDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pluton-restore-'));
	scratchToClean = scratchDir;
	try {
		const manifest = await unpackPayload(tar, scratchDir);

		const editionCheck = checkEdition(manifest.edition, deps.edition);
		if (!editionCheck.ok) {
			fail(`${editionCheck.reason}\n   Nothing has been modified.`);
		}

		const skewCheck = checkVersionSkew(manifest, {
			plutonVersion: process.env.APP_VERSION || 'unknown',
			drizzleJournalTag: getDrizzleJournalTag(),
		});
		if (!skewCheck.ok) {
			fail(`${skewCheck.reason}\n   Nothing has been modified.`);
		}

		console.log(
			`Blob looks good. Written ${manifest.createdAt} on host "${manifest.hostname}" ` +
				`by Pluton ${manifest.plutonVersion} (${manifest.edition}).`
		);

		// ================= past this line we mutate =================

		// ---- 6/7. Close the DB and clear pluton.db + its WAL sidecars (Windows-safe; see helper)
		console.log('Applying restore...');
		try {
			await releaseDatabaseFiles(deps.sqlite, deps.dbFilePath);
		} catch (error: any) {
			// Nothing copied yet, so the data dir is intact -- safe to abort.
			fail(
				`Could not replace the database file (${error?.code || error?.message || error}).\n` +
					`   Something still holds ${deps.dbFilePath} open. On Windows this is almost always\n` +
					'   antivirus or the Search indexer scanning it, or a Pluton process that did not fully\n' +
					'   stop. Confirm no "pluton" process is running (Task Manager, or `Get-Process pluton`),\n' +
					'   then run this command again. Your existing data has not been modified.'
			);
		}

		// ---- 8. Unpack over the data dir
		await copyTree(scratchDir, appPaths.getDataDir());
		await fsp.rm(path.join(appPaths.getDataDir(), 'manifest.json'), { force: true });

		// ---- 9. Get the key where this install reads it from (nowhere, on Docker)
		await applyEncryptionKey({
			dataDir: appPaths.getDataDir(),
			key,
			isDocker: isDockerMode(),
		});

		// ---- 10. Mark setup complete so the wizard doesn't reappear
		await fsp.writeFile(path.join(appPaths.getDataDir(), '.setup_complete'), '');

		succeed(
			buildCompletionMessage({
				isDocker: isDockerMode(),
				isLinuxInstalled: isLinuxInstalledRuntime(),
			})
		);
	} catch (error) {
		// An unexpected throw (not a fail()) still must not leave the decrypted payload behind.
		cleanScratch();
		throw error;
	}
}

/** No --encryption-key flag (argv leaks to ps/history); use PLUTON_ENCRYPTION_KEY or the prompt. */
async function obtainEncryptionKey(): Promise<string> {
	const fromEnv = process.env.PLUTON_ENCRYPTION_KEY || process.env.ENCRYPTION_KEY;
	if (fromEnv) {
		console.log('Using encryption key from the environment.');
		return fromEnv;
	}

	if (!process.stdin.isTTY) {
		fail(
			'An encryption key is required. Run this in an interactive terminal, ' +
				'or set PLUTON_ENCRYPTION_KEY.'
		);
	}

	const key = await prompt('Enter your Pluton encryption key: ', true);
	if (!key) {
		fail('Encryption key cannot be empty.');
	}
	return key;
}
