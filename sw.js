/* CASA service worker: network-first for the app shell, cache fallback so the app opens offline. Never caches Supabase API calls. */
const CACHE='casa-shell-v75';
self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(CACHE).then(c=>c.addAll(['./','./index.html','./style.css','./app.js','./cloud.js','./vendor/qrcode.min.js','./vendor/supabase-js-2.119.0.umd.js','./manifest.json','./icons/favicon-32.png','./icons/favicon-192.png','./icons/apple-touch-icon.png','./icons/icon-192.png','./icons/icon-512.png','./icons/icon-maskable-512.png','./fonts/AmaticSC-Hebrew.woff2']).catch(()=>{})))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  const req=e.request;const url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin)return;
  e.respondWith(fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy))}return res})
    .catch(()=>caches.match(req,{ignoreSearch:true}).then(r=>r||(req.mode==='navigate'?caches.match('./index.html',{ignoreSearch:true}):undefined)).then(r=>r||Response.error())));
});
