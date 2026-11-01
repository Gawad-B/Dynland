import System from 'system';
import {runAll} from './harness.js';
import './layout.test.js';

const failed = await runAll();
System.exit(failed ? 1 : 0);
