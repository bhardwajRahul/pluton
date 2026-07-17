/**
 * Runtime state for self-backup, stored at `config/self_backup_state.json`.
 *
 * Deliberately NOT in the settings blob: `SettingsStore.update()` is a whole-blob
 * replace and the Settings UI PUTs the entire blob on every save, so blob-resident
 * `lastSuccessAt` would be silently clobbered by an unrelated tab save.
 *
 * Follows the device_settings.json / restic_global.json precedent in utils/globalSettings.ts.
 * It lives under config/, so the payload spec already ships it in the blob.
 */

import fs from 'fs';
import path from 'path';
import { appPaths } from '../AppPaths';

export interface SelfBackupState {
	lastRunAt?: string;
	lastSuccessAt?: string;
	lastError?: string | null;
	lastFingerprint?: string;
	lastBlobName?: string;
}

const getStatePath = () => path.join(appPaths.getConfigDir(), 'self_backup_state.json');

export function readSelfBackupState(): SelfBackupState {
	try {
		const filePath = getStatePath();
		if (fs.existsSync(filePath)) {
			return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SelfBackupState;
		}
	} catch (error) {
		console.error('[selfBackup] Failed to read self_backup_state.json:', error);
	}
	return {};
}

/** Read-modify-write: callers only ever supply the fields they changed. */
export function writeSelfBackupState(update: Partial<SelfBackupState>): SelfBackupState {
	const merged = { ...readSelfBackupState(), ...update };
	fs.writeFileSync(getStatePath(), JSON.stringify(merged, null, 2), { mode: 0o600 });
	return merged;
}
