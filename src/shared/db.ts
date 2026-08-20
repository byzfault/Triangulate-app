import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

/**
 * One SQLite handle for the whole suite.
 *
 * Every tool caches into the same file, which is what makes the suite cheaper than the sum
 * of its parts: a wallet's trade history fetched by Copy Tracker is already paid for when
 * Triangulate wants it, and vice versa. Each module owns its own tables and creates them at
 * import time, so adding a tool never means touching a central schema.
 */
mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
