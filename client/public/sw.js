// Service worker for browser push notifications. The server sends a JSON
// payload ({ title, body, tag }); clicking a notification focuses the app.
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "Note updated", body: event.data.text() };
  }
  const { title = "Note updated", body = "", tag = "note-update" } = payload;
  event.waitUntil(self.registration.showNotification(title, { body, tag }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("focus" in client) return client.focus();
        }
        return self.clients.openWindow("/");
      }),
  );
});
