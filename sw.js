const CACHE_NAME = "ephone-tuk-cache-v30";
const ASSETS_TO_CACHE = [
  "./",
  "./index.html",
  "./style.css",
  "./manifest.json",
  "./icon.png",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
  "./icon.svg"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS_TO_CACHE).catch(err => {
        console.warn("Pre-cache warning: " + err);
      });
    })
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  
  const url = new URL(event.request.url);
  if (!url.protocol.startsWith("http")) return;
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/local-assets") || url.hostname.includes("socket") || url.hostname.includes("hmr")) {
    return;
  }

  const isCodeOrDoc =
    event.request.mode === "navigate" ||
    url.pathname === "/" ||
    url.pathname.endsWith(".html") ||
    url.pathname.endsWith(".js") ||
    url.pathname.endsWith(".css");

  if (isCodeOrDoc) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(() => caches.match(event.request).then(res => res || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then(cachedResponse => {
      if (cachedResponse) {
        fetch(event.request).then(networkResponse => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseClone));
          }
        }).catch(() => {});
        return cachedResponse;
      }

      return fetch(event.request).then(networkResponse => {
        if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== "basic") {
          return networkResponse;
        }
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then(cache => {
          cache.put(event.request, responseToCache);
        });
        return networkResponse;
      }).catch(err => {
        return caches.match("./index.html") || Promise.reject(err);
      });
    })
  );
});

self.addEventListener("notificationclick", event => {
  const notifData = (event.notification && event.notification.data) || {};
  event.notification.close();

  event.waitUntil(
    self.clients
      .matchAll({
        type: "window",
        includeUncontrolled: true
      })
      .then(clientList => {
        for (let i = 0; i < clientList.length; i++) {
          const client = clientList[i];
          if (client && typeof client.postMessage === "function") {
            client.postMessage({
              type: "PEER_NOTIFICATION_CLICK",
              chatId: notifData.chatId || "",
              openRequests: !!notifData.openRequests
            });
          }
          if ("focus" in client) {
            return client.focus();
          }
        }

        if (self.clients.openWindow) {
          return self.clients.openWindow("/");
        }
      })
  );
});

self.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.type !== "SHOW_PEER_NOTIFICATION") return;
  const title = data.title || "新消息";
  const options = {
    body: data.body || "",
    icon: data.icon || "./icon-192.png",
    badge: "./icon-192.png",
    tag: data.tag || ("peer_notif_" + Date.now()),
    renotify: true,
    silent: false,
    vibrate: [200, 100, 200],
    data: {
      chatId: data.chatId || "",
      openRequests: !!data.openRequests
    }
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("push", event => {
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    data = { title: "新消息", body: event.data.text() };
  }

  const title = data.title || "四半世紀";
  const options = {
    body: data.body,
    icon: "icon.png",
    badge: "icon.png",
    renotify: true,
    silent: false,
    vibrate: [200, 100, 200],
    data: data.data || {}
  };

  event.waitUntil(self.registration.showNotification(title, options));
});
