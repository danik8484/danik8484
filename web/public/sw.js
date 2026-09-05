/* Service worker: receives push notifications and opens the app on click. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = { title: 'לו"ז יומי', body: "", url: "/", tag: "general" };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      dir: "rtl",
      lang: "he",
      tag: data.tag,
      renotify: true,
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) {
          const same = (u) => new URL(u).pathname + new URL(u).search;
          if (same(c.url) !== same(url) && typeof c.navigate === "function") {
            return c.navigate(url).then((navigated) => (navigated ?? c).focus()).catch(() => c.focus());
          }
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
