import { useState } from 'react';
import { toast } from 'react-toastify';
import Icon from '../../common/Icon/Icon';
import Toggle from '../../common/form/Toggle/Toggle';
import NumberInput from '../../common/form/NumberInput/NumberInput';
import StoragePicker from '../../common/form/StoragePicker/StoragePicker';
import { useGetSelfBackupStatus, useRunSelfBackup } from '../../../services/settings';
import BackupsListModal from './BackupsListModal';
import classes from './SelfBackupSettings.module.scss';

interface SelfBackupSettingsProps {
   settingsID: number;
   settings: Record<string, any>;
   onUpdate: (settings: Record<string, any>) => void;
}

export const SELF_BACKUP_DEFAULTS = {
   enabled: false,
   storageId: '',
   storageName: '',
   path: '',
   intervalHours: 12,
   retention: 10,
   notifyOnFailure: false,
};

// Any connected email integration can carry the failure notification. Ntfy is push, not email.
const EMAIL_INTEGRATIONS = ['smtp', 'sendgrid', 'mailgun', 'brevo', 'resend', 'awsSes'];

function formatRelative(iso?: string): string {
   if (!iso) return 'never';
   const diffMs = Date.now() - new Date(iso).getTime();
   if (Number.isNaN(diffMs)) return 'unknown';

   const minutes = Math.floor(diffMs / 60000);
   if (minutes < 1) return 'just now';
   if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
   const hours = Math.floor(minutes / 60);
   if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
   const days = Math.floor(hours / 24);
   return `${days} day${days === 1 ? '' : 's'} ago`;
}

const SelfBackupSettings = ({ settings, settingsID, onUpdate }: SelfBackupSettingsProps) => {
   const selfBackup = { ...SELF_BACKUP_DEFAULTS, ...(settings?.selfBackup || {}) };
   const { data } = useGetSelfBackupStatus(settingsID ? String(settingsID) : '');
   const runMutation = useRunSelfBackup();
   const status = data?.result;
   const [showBackups, setShowBackups] = useState(false);

   const update = (patch: Record<string, any>) => onUpdate({ ...settings, selfBackup: { ...selfBackup, ...patch } });

   // This is the one backup whose failure would otherwise be discovered during a disaster,
   // so a stale or failed run is surfaced loudly rather than tucked away in a log.
   const isStale =
      !!status?.enabled && (!status.lastSuccessAt || Date.now() - new Date(status.lastSuccessAt).getTime() > 2 * status.intervalHours * 3600 * 1000);

   // The POST only queues the job and returns 202, so its own isPending covers just that
   // round trip. `status.running` is what reports the actual run, straight from the job queue.
   const isRunning = runMutation.isPending || !!status?.running;

   // Two hard prerequisites for the failure-notification toggle: a connected email integration
   // (only ever marked `connected` after a successful test send) and an admin email to send to.
   const emailConnected = EMAIL_INTEGRATIONS.some((type) => settings?.integration?.[type]?.connected);
   const adminEmailSet = !!String(settings?.admin_email || '').trim();
   const canNotifyOnFailure = emailConnected && adminEmailSet;

   // Only the title text, coloured by type — no background. Replaced while a run is in flight.
   const statusView = (() => {
      if (isRunning) return { text: 'Backing up Pluton…', className: classes.statusMuted };
      if (status?.lastError) return { text: 'Last backup failed', className: classes.statusWarn };
      if (isStale) return { text: 'No recent backup', className: classes.statusWarn };
      return { text: `Last backed up ${formatRelative(status?.lastSuccessAt)}`, className: classes.statusOk };
   })();

   const runNow = () => {
      runMutation.mutate(String(settingsID), {
         onSuccess: () => toast.success('Backup queued. This page will update when it finishes.', { autoClose: 5000 }),
         onError: (error: Error) => toast.error('Could not start backup. ' + (error?.message || '')),
      });
   };

   return (
      <div>
         <div className={classes.field}>
            <Toggle
               label="Back up Pluton's configuration"
               fieldValue={selfBackup.enabled}
               onUpdate={(val) => update({ enabled: val })}
               inline={true}
               hint={`Backs up Pluton's own configuration (plans, storages, credentials and history) as a single encrypted file.`}
            />
         </div>

         {selfBackup.enabled && (
            <>
               <div className={classes.field}>
                  <label>Where to store backups</label>
                  <StoragePicker
                     storageId={selfBackup.storageId}
                     storagePath={selfBackup.path}
                     onUpdate={({ storage, path }) => update({ storageId: storage.id, storageName: storage.name, path })}
                  />
               </div>
               <div className={classes.field}>
                  <NumberInput
                     label="Back up every (hours)"
                     fieldValue={selfBackup.intervalHours}
                     onUpdate={(val) => update({ intervalHours: val })}
                     min={1}
                     hint="Pluton only uploads when something has actually changed."
                     inline={false}
                  />
               </div>
               <div className={classes.field}>
                  <NumberInput
                     label="Number of backups to keep"
                     fieldValue={selfBackup.retention}
                     onUpdate={(val) => update({ retention: val })}
                     min={1}
                     hint="Older backups beyond this count are deleted from the storage."
                     inline={false}
                  />
               </div>
               <div className={classes.field}>
                  <Toggle
                     label="Email me if a backup fails"
                     fieldValue={selfBackup.notifyOnFailure}
                     onUpdate={(val) => update({ notifyOnFailure: val })}
                     inline={true}
                     disabled={!canNotifyOnFailure}
                     hint={
                        canNotifyOnFailure
                           ? `Sends an email to the admin address (${settings?.admin_email}) whenever a backup run fails.`
                           : !adminEmailSet
                             ? 'Set an Admin Email under the General tab to enable failure notifications.'
                             : 'Connect an email integration under the Integrations tab to enable failure notifications.'
                     }
                  />
               </div>
               <div className={classes.actions}>
                  <button className={classes.backupNowBtn} onClick={runNow} disabled={isRunning || !status?.enabled}>
                     <Icon type={isRunning ? 'loading' : 'backup'} size={12} />
                     {isRunning ? 'Backing up...' : 'Backup now'}
                  </button>
                  <button className={classes.viewBackupsBtn} onClick={() => setShowBackups(true)}>
                     <Icon type="rows" size={12} />
                     View backups
                  </button>
                  {status?.enabled && <span className={`${classes.statusText} ${statusView.className}`}>{statusView.text}</span>}
               </div>
            </>
         )}

         {showBackups && <BackupsListModal settingsID={String(settingsID)} closeModal={() => setShowBackups(false)} />}
      </div>
   );
};

export default SelfBackupSettings;
