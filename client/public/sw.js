// Service worker for browser push notifications. The server sends a JSON
// payload ({ title, body, tag }); clicking a notification focuses the app.
self.addEventListener("push", (event) => {
  // PushMessageData bodies are single-read, so the text is read once and
  // parsed by hand: calling event.data.text() after event.data.json() has
  // consumed (and failed on) the stream would itself throw.
  const raw = event.data ? event.data.text() : "";
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    payload = { body: raw };
  }
  const {
    title = "Note updated",
    body = "",
    tag = "note-update",
  } = payload ?? {};
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
