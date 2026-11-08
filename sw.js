// Network-only service worker: never serves stale pages/images/data. Clears any old caches.
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',e=>e.waitUntil((async()=>{try{for(const k of await caches.keys())await caches.delete(k)}catch(_){}await self.clients.claim()})()));
self.addEventListener('fetch',()=>{});
