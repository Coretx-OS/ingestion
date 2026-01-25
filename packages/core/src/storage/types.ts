/**
 * Storage Adapter Types
 *
 * Abstract interface for storage backends.
 * Allows different instances to use different storage while sharing the interface.
 */

export interface StorageAdapter {
  readonly name: string;

  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  has(key: string): Promise<boolean>;

  getMany<T>(keys: string[]): Promise<Map<string, T>>;
  setMany<T>(entries: Map<string, T>): Promise<void>;
  deleteMany(keys: string[]): Promise<number>;

  close(): Promise<void>;
}

export interface KeyValueRecord {
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}
