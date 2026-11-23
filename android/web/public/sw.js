const CACHE='kaggle-studio-v2';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name!==CACHE)await caches.delete(name);await self.clients.claim()})()));
// Never cache credentials, API requests, private conversations, or generated media.
self.addEventListener('fetch',event=>{const u=new URL(event.request.url);if(event.request.method!=='GET'||u.origin!==self.location.origin||!u.pathname.startsWith('/assets/'))return;event.respondWith((async()=>{const cache=await caches.open(CACHE);const hit=await cache.match(event.request);if(hit)return hit;const response=await fetch(event.request);if(response.ok)await cache.put(event.request,response.clone());return response})())});
