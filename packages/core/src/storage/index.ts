/**
 * Storage Module
 *
 * Provides abstract storage adapter interface.
 * Concrete implementations (SQLite, etc.) live in consumer packages.
 */

export type {
  StorageAdapter,
  KeyValueRecord,
} from './types.js';
