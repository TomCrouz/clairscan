'use strict';
/* Stockage local des documents (IndexedDB) : rien ne quitte l'appareil. */
const DB = (() => {
  let dbPromise = null;

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open('clairscan', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('docs', { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  async function run(mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('docs', mode);
      const req = fn(tx.objectStore('docs'));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  return {
    all: () => run('readonly', s => s.getAll()),
    put: doc => run('readwrite', s => s.put(doc)),
    remove: id => run('readwrite', s => s.delete(id)),
  };
})();
