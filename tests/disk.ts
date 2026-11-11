import {existsSync,readFileSync} from 'node:fs';
import type {Store} from '../server/store.js';
/** Bytes of the database file and its write-ahead log, as stored on disk. */
export const onDisk=(store:Store)=>Buffer.concat([store.file,store.file+'-wal'].filter(existsSync).map(f=>readFileSync(f)));
