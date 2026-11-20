/**
 * High-capacity client-side persistent storage for course data and custom default holes.
 * Uses IndexedDB as primary storage (hundreds of megabytes quota) with localStorage as fallback.
 * Completely eliminates the 5MB browser localStorage QuotaExceededError!
 */
export class CourseStorage {
  private static readonly DB_NAME = 'FairwayStudioDB';
  private static readonly DB_VERSION = 1;
  private static readonly STORE_NAME = 'course_data';
  private static readonly RECORD_KEY = 'custom_default_hole';
  private static readonly LOCAL_STORAGE_KEY = 'fairway_studio_custom_default_hole';

  private static dbPromise: Promise<IDBDatabase> | null = null;

  private static getDB(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB not supported in this environment'));
        return;
      }

      const request = indexedDB.open(CourseStorage.DB_NAME, CourseStorage.DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CourseStorage.STORE_NAME)) {
          db.createObjectStore(CourseStorage.STORE_NAME);
        }
      };

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        console.warn('Failed to open IndexedDB:', request.error);
        reject(request.error);
      };
    });

    return this.dbPromise;
  }

  /**
   * Persists the serialized course JSON into IndexedDB (and attempts a localStorage copy).
   */
  public static async saveCourse(jsonString: string): Promise<boolean> {
    let idbSucceeded = false;
    let diskSucceeded = false;

    // 0. Server-side disk persistence: write to public/default_hole.json via Vite API
    try {
      if (typeof fetch !== 'undefined') {
        const res = await fetch('/api/save-default-hole', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: jsonString
        });
        if (res.ok) {
          diskSucceeded = true;
          console.log('Course successfully saved to server disk (public/default_hole.json)');
        }
      }
    } catch (apiErr) {
      console.warn('Failed to dispatch server save API:', apiErr);
    }

    // 1. Primary: Save to IndexedDB (unlimited quota)
    try {
      const db = await this.getDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(CourseStorage.STORE_NAME, 'readwrite');
        const store = tx.objectStore(CourseStorage.STORE_NAME);
        const req = store.put(jsonString, CourseStorage.RECORD_KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
      idbSucceeded = true;
    } catch (idbErr) {
      console.warn('IndexedDB write failed, falling back to localStorage:', idbErr);
    }

    // 2. Secondary: Try saving to localStorage
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(CourseStorage.LOCAL_STORAGE_KEY, jsonString);
        return true;
      }
    } catch (lsErr: any) {
      // If localStorage threw QuotaExceededError, that is harmless as long as IndexedDB or Disk succeeded!
      if (idbSucceeded || diskSucceeded) {
        console.info('Saved course to persistent storage (localStorage quota exceeded, but IndexedDB/Disk succeeded!)');
        return true;
      }
      console.error('All storage mechanisms failed to store course:', lsErr);
    }

    return idbSucceeded || diskSucceeded;
  }

  /**
   * Retrieves the saved custom course JSON (checking IndexedDB first, then localStorage).
   */
  public static async loadCourse(): Promise<string | null> {
    // 1. Try IndexedDB first
    try {
      const db = await this.getDB();
      const result = await new Promise<string | null>((resolve, reject) => {
        const tx = db.transaction(CourseStorage.STORE_NAME, 'readonly');
        const store = tx.objectStore(CourseStorage.STORE_NAME);
        const req = store.get(CourseStorage.RECORD_KEY);
        req.onsuccess = () => resolve((req.result as string) || null);
        req.onerror = () => reject(req.error);
      });
      if (result) return result;
    } catch (e) {
      console.warn('Could not read course from IndexedDB, checking localStorage:', e);
    }

    // 2. Fallback to localStorage
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(CourseStorage.LOCAL_STORAGE_KEY);
      }
    } catch (e) {
      console.warn('Could not read course from localStorage:', e);
    }

    return null;
  }

  /**
   * Synchronous load check from localStorage (useful during early synchronous boots)
   */
  public static loadCourseSync(): string | null {
    try {
      if (typeof localStorage !== 'undefined') {
        return localStorage.getItem(CourseStorage.LOCAL_STORAGE_KEY);
      }
    } catch (e) {}
    return null;
  }

  /**
   * Clears saved course from both IndexedDB and localStorage.
   */
  public static async clearCourse(): Promise<void> {
    try {
      if (typeof fetch !== 'undefined') {
        fetch('/api/reset-default-hole', { method: 'POST' }).catch(() => {});
      }
    } catch (e) {}

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(CourseStorage.LOCAL_STORAGE_KEY);
      }
    } catch (e) {}

    try {
      const db = await this.getDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(CourseStorage.STORE_NAME, 'readwrite');
        const store = tx.objectStore(CourseStorage.STORE_NAME);
        const req = store.delete(CourseStorage.RECORD_KEY);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    } catch (e) {}
  }
}
