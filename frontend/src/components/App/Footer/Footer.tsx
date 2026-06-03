import { useState } from 'react';
import { getUpdateDocLink } from '../../../utils';
import Icon from '../../common/Icon/Icon';
import Upgrade from '../../Upgrade/Upgrade';
import classes from './Footer.module.scss';

interface FooterProps {
   version: string;
   edition?: string;
   latestVersion?: string;
   hideUpgradeLink?: boolean;
   changeLogUrl?: string;
}

const Footer = ({ version = '1.0.0', latestVersion, hideUpgradeLink = false, changeLogUrl, edition = '' }: FooterProps) => {
   const [showUpgrade, setShowUpgrade] = useState(false);
   const updateDocLink = getUpdateDocLink(hideUpgradeLink);
   return (
      <>
         <div className={classes.footer}>
            <span>
               Pluton {edition} v{version}{' '}
               {latestVersion && (
                  <span className={classes.newVersion} title={`Latest version: ${latestVersion}`}>
                     <Icon type="arrow-up" size={12} />{' '}
                     <a href={updateDocLink} target="_blank">
                        (Update Available)
                     </a>
                  </span>
               )}
            </span>{' '}
            <i className="pipe">|</i>
            {!hideUpgradeLink && (
               <>
                  <a onClick={() => setShowUpgrade(true)}>Upgrade</a> <i className="pipe">|</i>
               </>
            )}
            <a href="https://docs.usepluton.com" target="_blank">
               Documentation
            </a>{' '}
            <i className="pipe">|</i>
            <a href={changeLogUrl || 'https://github.com/plutonhq/pluton/blob/main/CHANGELOG.md'} target="_blank">
               Changelog
            </a>
         </div>
         {showUpgrade && <Upgrade onClose={() => setShowUpgrade(false)} />}
      </>
   );
};

export default Footer;
