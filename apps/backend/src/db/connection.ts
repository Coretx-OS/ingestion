import Database from 'better-sqlite3';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

/**
 * Get or create the singleton database connection
 */
export function getDb(): Database.Database {
  if (!db) {
    const dbPath = process.env.DATABASE_PATH || './data/secondbrain.db';

    // Ensure data directory exists
    const dataDir = dirname(dbPath);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }

    db = new Database(dbPath);

    // Enable WAL mode for better concurrency
    db.pragma('journal_mode = WAL');

    // Enable foreign keys
    db.pragma('foreign_keys = ON');

    console.log(`✅ Database connected: ${dbPath}`);
  }

  return db;
}

/**
 * Run database migrations (execute schema.sql)
 */
export function runMigrations(): void {
  const db = getDb();
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');

  // Execute schema (supports multiple statements)
  db.exec(schema);

  console.log('✅ Database migrations complete');
}

/**
 * Close database connection
 */
export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    console.log('✅ Database connection closed');
  }
}

/**
 * Generate a monotonic log_id for inbox_log
 * Uses SQLite auto-increment for thread safety
 */
export function getNextLogId(): number {
  const db = getDb();
  const result = db.prepare('SELECT COALESCE(MAX(log_id), 0) + 1 as next_id FROM inbox_log').get() as { next_id: number };
  return result.next_id;
}
