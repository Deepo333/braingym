/* Bloom — app-shell cache with network-first updates
   Same-origin requests always try the network first (bypassing the HTTP
   cache) so a freshly deployed version is picked up immediately whenever
   the device is online; the cache is only a fallback for offline use. */
const CACHE_NAME = "bloom-shell-v2";
const SHELL_FILES = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/data.js",
  "./js/app.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-180.png",
  "./icons/favicon-32.png"
];

self.addEventListener("install", function(event){
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){ return cache.addAll(SHELL_FILES); })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function(event){
  event.waitUntil(
    caches.keys().then(function(names){
      return Promise.all(names.filter(function(n){ return n !== CACHE_NAME; }).map(function(n){ return caches.delete(n); }));
    })
  );
  self.clients.claim();
});

self.addEventListener("fetch", function(event){
  if(event.request.method !== "GET") return;
  const sameOrigin = new URL(event.request.url).origin === self.location.origin;

  if(sameOrigin){
    event.respondWith(
      fetch(event.request, { cache: "no-store" }).then(function(response){
        if(response && response.status === 200){
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, copy); });
        }
        return response;
      }).catch(function(){ return caches.match(event.request); })
    );
    return;
  }

  // Cross-origin (e.g. Google Fonts): cache-first with background refresh —
  // this content rarely changes and isn't part of the app's own deploys.
  event.respondWith(
    caches.match(event.request).then(function(cached){
      const network = fetch(event.request).then(function(response){
        if(response && response.status === 200 && response.type === "basic"){
          const copy = response.clone();
          caches.open(CACHE_NAME).then(function(cache){ cache.put(event.request, copy); });
        }
        return response;
      }).catch(function(){ return cached; });
      return cached || network;
    })
  );
});
