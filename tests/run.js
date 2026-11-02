import System from 'system';
import {runAll} from './harness.js';
import './activityManager.test.js';
import './layout.test.js';
import './prayerCalc.test.js';
import './extensionSettings.test.js';

const failed = await runAll();
System.exit(failed ? 1 : 0);
