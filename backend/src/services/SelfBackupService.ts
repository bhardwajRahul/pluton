import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { SettingsStore } from '../stores/SettingsStore';
import { StorageStore } from '../stores/StorageStore';
import { appPaths } from '../utils/AppPaths';
import { cronLogger } from '../utils/logger';
import { configService } from './ConfigService';
import { sealBlob } from '../utils/selfBackup/blobFormat';
import { packPayload, computeFingerprint, PlutonEdition } from '../utils/selfBackup/payload';
import { readSelfBackupState, writeSelfBackupState } from '../utils/selfBackup/state';
import { resolveSelfBackup } from '../utils/selfBackup/settings';
import { rcloneCopyTo, rcloneDeleteFile, rcloneLsJson } from '../utils/rclone/helpers';
import { jobQueue } from '../jobs/JobQueue';
import { SELF_BACKUP_JOB_NAME } from '../jobs/systemJobs';
import { AppError } from '../utils/AppError';
import { IntegrationTypes, SelfBackupSettings } from '../types/settings';
import { NotificationChannelResolver } from '../notifications/channels/NotificationChannelResolver';
import { SelfBackupFailedNotification } from '../notifications/templates/email/backup/SelfBackupFailedNotification';

const RCLONE_TIMEOUT_MS = 120_000;

const BLOB_PREFIX = 'pluton-';
const BLOB_SUFFIX = '.pluton';
const BLOB_NAME_RE = /^pluton-.*\.pluton$/;
const SIDECAR_NAME = 'pluton-recovery.json';

export type SelfBackupRunStatus = 'disabled' | 'skipped' | 'uploaded';

export interface SelfBackupRunResult {
	status: SelfBackupRunStatus;
	blobName?: string;
}

export interface SelfBackupBlob {
	name: string;
	size: number;
	modTime?: string;
}

export interface SelfBackupStatus extends SelfBackupSettings {
	lastRunAt?: string;
	lastSuccessAt?: string;
	lastError?: string | null;
	lastBlobName?: string;
	running: boolean;
}

export class SelfBackupService {
	constructor(
		protected settingsStore: SettingsStore,
		protected storageStore: StorageStore,
		protected sqlite: SqliteDatabase,
		protected edition: PlutonEdition
	) {}

	protected async resolveSettings(): Promise<SelfBackupSettings> {
		const settingsRow = await this.settingsStore.getFirst();
		return resolveSelfBackup(settingsRow?.settings);
	}

	async getStatus(): Promise<SelfBackupStatus> {
		const settings = await this.resolveSettings();
		const state = readSelfBackupState();
		return {
			...settings,
			lastRunAt: state.lastRunAt,
			lastSuccessAt: state.lastSuccessAt,
			lastError: state.lastError,
			lastBlobName: state.lastBlobName,
			running: jobQueue.hasPending(SELF_BACKUP_JOB_NAME),
		};
	}

	/**
	 * Interval gate. SYSTEM_JOBS is a static array read once at startup, so a
	 * user-configurable interval can't be a cron expression. The task ticks hourly
	 * and asks this instead.
	 */
	async isDue(): Promise<boolean> {
		const settings = await this.resolveSettings();
		if (!settings.enabled) return false;

		const { lastSuccessAt } = readSelfBackupState();
		if (!lastSuccessAt) return true;

		const elapsedMs = Date.now() - new Date(lastSuccessAt).getTime();
		return elapsedMs >= settings.intervalHours * 60 * 60 * 1000;
	}

	async run(opts: { force?: boolean } = {}): Promise<SelfBackupRunResult> {
		const settings = await this.resolveSettings();
		if (!settings.enabled) {
			return { status: 'disabled' };
		}

		const fingerprint = computeFingerprint();
		if (!opts.force && fingerprint === readSelfBackupState().lastFingerprint) {
			cronLogger.info('[SelfBackup] Nothing changed since the last upload. Skipping.');
			const skippedAt = new Date().toISOString();
			writeSelfBackupState({ lastRunAt: skippedAt, lastSuccessAt: skippedAt, lastError: null });
			return { status: 'skipped' };
		}

		// The name is user-editable after save, so the zod check at save time isn't enough.
		const remoteName = await this.resolveRemoteName(settings);

		const tmpDir = await fsp.mkdtemp(path.join(appPaths.getTempDir(), 'self-backup-'));
		try {
			const blobName = `${BLOB_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}${BLOB_SUFFIX}`;
			const snapshotPath = path.join(tmpDir, 'pluton.db');

			const dbPageCount = this.vacuumInto(snapshotPath);
			const tar = await packPayload({
				dbSnapshotPath: snapshotPath,
				edition: this.edition,
				dbPageCount,
			});
			const blob = sealBlob(tar, configService.config.ENCRYPTION_KEY);

			const blobPath = path.join(tmpDir, blobName);
			await fsp.writeFile(blobPath, blob, { mode: 0o600 });

			const destDir = this.remoteDir(remoteName, settings.path);
			await rcloneCopyTo(blobPath, this.remoteFile(destDir, blobName), undefined, {
				timeoutMs: RCLONE_TIMEOUT_MS,
			});

			await this.uploadSidecar(tmpDir, destDir, blobName);
			await this.applyRetention(destDir, settings.retention);

			const finishedAt = new Date().toISOString();
			writeSelfBackupState({
				lastRunAt: finishedAt,
				lastSuccessAt: finishedAt,
				lastError: null,
				lastFingerprint: fingerprint,
				lastBlobName: blobName,
			});

			cronLogger.info(`[SelfBackup] Uploaded ${blobName} (${blob.length} bytes) to ${destDir}`);
			return { status: 'uploaded', blobName };
		} catch (error: any) {
			// Throw: JobQueue retries, and a silent failure here is only discovered during a disaster.
			writeSelfBackupState({
				lastRunAt: new Date().toISOString(),
				lastError: error?.message || 'Unknown error',
			});
			cronLogger.error(`[SelfBackup] Backup failed: ${error?.message}`);
			await this.notifyFailure(error);
			throw error;
		} finally {
			await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	/**
	 * Email the admin when a run fails, if the failure-notification toggle is on and an email
	 * integration is connected. Wrapped so a notification problem can never mask or replace the
	 * original backup error.
	 */
	protected async notifyFailure(error: any): Promise<void> {
		try {
			const settingsRow = await this.settingsStore.getFirst();
			const appSettings = settingsRow?.settings;
			const selfBackup = resolveSelfBackup(appSettings);
			if (!selfBackup.notifyOnFailure) return;

			const adminEmail = appSettings?.admin_email;
			if (!adminEmail) {
				cronLogger.warn('[SelfBackup] Failure notification is on but no admin email is set.');
				return;
			}

			const integration = appSettings?.integration ?? {};
			const emailTypes: IntegrationTypes[] = [
				'smtp',
				'sendgrid',
				'mailgun',
				'brevo',
				'resend',
				'awsSes',
			];
			const channelType = emailTypes.find(type => integration[type]?.connected);
			if (!channelType) {
				cronLogger.warn(
					'[SelfBackup] Failure notification is on but no email integration is connected.'
				);
				return;
			}

			const channel = await NotificationChannelResolver.getChannel(channelType);
			const notification = new SelfBackupFailedNotification({
				appTitle: appSettings?.title || 'Pluton',
				error: error?.message || 'Unknown error',
				hostname: os.hostname(),
				storageName: selfBackup.storageName,
				failedAt: new Date(),
			});
			const res = await channel.send(notification, { emails: adminEmail });
			if (!res?.success) {
				cronLogger.error(`[SelfBackup] Failure notification email failed: ${res?.result}`);
			} else {
				cronLogger.info('[SelfBackup] Failure notification email sent to admin.');
			}
		} catch (err: any) {
			cronLogger.error(`[SelfBackup] Could not send failure notification: ${err?.message}`);
		}
	}

	/**
	 * A read-transaction snapshot: everything committed to the WAL at this instant, in a
	 * fresh checkpointed standalone file with no -wal beside it. Never a raw file copy,
	 * which is either stale (main file only) or torn (main + wal under a live writer).
	 *
	 * Refuses an existing destination, hence the mkdtemp + unique name from the caller.
	 */
	protected vacuumInto(destPath: string): number {
		let pageCount = 0;
		try {
			const row = this.sqlite.pragma('page_count', { simple: true });
			pageCount = typeof row === 'number' ? row : 0;
		} catch {
			pageCount = 0;
		}
		this.sqlite.prepare('VACUUM INTO ?').run(destPath);
		return pageCount;
	}

	protected async resolveRemoteName(settings: SelfBackupSettings): Promise<string> {
		const storage = await this.storageStore.getById(settings.storageId);
		if (!storage) {
			throw new AppError(
				400,
				`The storage selected for Pluton backup no longer exists (id: ${settings.storageId}).`
			);
		}
		return storage.name;
	}

	protected remoteDir(remoteName: string, targetPath: string): string {
		const cleaned = targetPath.replace(/^\/+|\/+$/g, '');
		return `${remoteName}:${cleaned}`;
	}

	/**
	 * Join a filename onto a remote dir.
	 *
	 * An empty configured path makes destDir `remote:`, and a naive `${destDir}/${name}`
	 * would yield `remote:/name`, a leading slash that means the filesystem root on a
	 * local remote rather than the remote's own root.
	 */
	protected remoteFile(destDir: string, fileName: string): string {
		return destDir.endsWith(':') ? `${destDir}${fileName}` : `${destDir}/${fileName}`;
	}

	/**
	 * Lets `--list` say "a backup from this morning, host nas-01" rather than making the
	 * user know a path. No secrets in it.
	 */
	protected async uploadSidecar(tmpDir: string, destDir: string, blobName: string): Promise<void> {
		const sidecar = {
			hostname: os.hostname(),
			plutonVersion: process.env.APP_VERSION || 'unknown',
			edition: this.edition,
			updatedAt: new Date().toISOString(),
			latestBlob: blobName,
		};
		const sidecarPath = path.join(tmpDir, SIDECAR_NAME);
		await fsp.writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));
		await rcloneCopyTo(sidecarPath, this.remoteFile(destDir, SIDECAR_NAME), undefined, {
			timeoutMs: RCLONE_TIMEOUT_MS,
		});
	}

	/**
	 * List the backup blobs currently on the configured storage
	 */
	async listBackups(): Promise<SelfBackupBlob[]> {
		const settings = await this.resolveSettings();
		if (!settings.storageId) return [];

		const remoteName = await this.resolveRemoteName(settings);
		const destDir = this.remoteDir(remoteName, settings.path);
		const items = await rcloneLsJson(destDir, undefined, { timeoutMs: RCLONE_TIMEOUT_MS });
		return items
			.filter(item => !item.IsDir && BLOB_NAME_RE.test(item.Name))
			.map(item => ({ name: item.Name, size: item.Size, modTime: item.ModTime }))
			.sort((a, b) => b.name.localeCompare(a.name));
	}

	/**
	 * Copy a single backup blob down to a local temp file for streaming to the client.
	 */
	async downloadBackup(
		blobName: string
	): Promise<{ localPath: string; cleanup: () => Promise<void> }> {
		if (!BLOB_NAME_RE.test(blobName)) {
			throw new AppError(400, 'Invalid backup name.');
		}

		const settings = await this.resolveSettings();
		const remoteName = await this.resolveRemoteName(settings);
		const destDir = this.remoteDir(remoteName, settings.path);

		const tmpDir = await fsp.mkdtemp(path.join(appPaths.getTempDir(), 'self-backup-dl-'));
		const localPath = path.join(tmpDir, blobName);
		try {
			await rcloneCopyTo(this.remoteFile(destDir, blobName), localPath, undefined, {
				timeoutMs: RCLONE_TIMEOUT_MS,
			});
		} catch (error) {
			await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
			throw error;
		}

		return {
			localPath,
			cleanup: () => fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {}),
		};
	}

	/** Failures here are logged and swallowed, since the blob is already safely uploaded. */
	protected async applyRetention(destDir: string, retention: number): Promise<void> {
		try {
			const items = await rcloneLsJson(destDir, undefined, { timeoutMs: RCLONE_TIMEOUT_MS });
			const blobs = items
				.filter(item => !item.IsDir && BLOB_NAME_RE.test(item.Name))
				// Names are ISO timestamps, so lexical desc == newest first.
				.sort((a, b) => b.Name.localeCompare(a.Name));

			for (const stale of blobs.slice(retention)) {
				try {
					await rcloneDeleteFile(this.remoteFile(destDir, stale.Name), undefined, {
						timeoutMs: RCLONE_TIMEOUT_MS,
					});
					cronLogger.info(`[SelfBackup] Retention removed ${stale.Name}`);
				} catch (error: any) {
					cronLogger.error(`[SelfBackup] Could not delete ${stale.Name}: ${error?.message}`);
				}
			}
		} catch (error: any) {
			cronLogger.error(`[SelfBackup] Retention pass failed: ${error?.message}`);
		}
	}
}
