#include <gio/gio.h>
#include <stdio.h>
#include <string.h>

static void observe(GSocketClient *client, GSocketClientEvent event,
                    GSocketConnectable *target, GIOStream *stream, gpointer data) {
  (void)client; (void)target; (void)stream; (void)data;
  if (event == G_SOCKET_CLIENT_PROXY_NEGOTIATING)
    g_printerr("proxy-negotiating\n");
  if (event == G_SOCKET_CLIENT_PROXY_NEGOTIATED)
    g_printerr("proxy-negotiated\n");
}

int main(int argc, char **argv) {
  if (argc != 2 && argc != 3) return 2;
  GError *error = NULL;
  GProxyResolver *resolver = g_proxy_resolver_get_default();
  g_printerr("resolver=%s\n", G_OBJECT_TYPE_NAME(resolver));
  gchar **proxies = g_proxy_resolver_lookup(resolver, argv[1], NULL, &error);
  if (!proxies) {
    g_printerr("lookup-failed=%s\n", error->message);
    g_error_free(error); return 3;
  }
  for (gsize i = 0; proxies[i]; i++) g_printerr("proxy=%s\n", proxies[i]);
  g_strfreev(proxies);
  if (argc == 2) return 0;

  GSocketClient *client = g_socket_client_new();
  if (!g_socket_client_get_enable_proxy(client) ||
      g_socket_client_get_proxy_resolver(client) != resolver) return 4;
  g_socket_client_set_timeout(client, 4);
  g_signal_connect(client, "event", G_CALLBACK(observe), NULL);
  GSocketConnection *connection = g_socket_client_connect_to_uri(client, argv[1], 80, NULL, &error);
  if (!connection) {
    g_printerr("connect-failed=%s\n", error->message);
    g_error_free(error); g_object_unref(client); return 5;
  }
  GUri *uri = g_uri_parse(argv[1], G_URI_FLAGS_NONE, &error);
  if (!uri) return 6;
  gchar *payload = NULL;
  gsize length = 0;
  if (!g_file_get_contents(argv[2], &payload, &length, &error) || length > 128 * 1024) return 7;
  const gchar *path = g_uri_get_path(uri);
  gchar *header = g_strdup_printf("POST %s HTTP/1.1\r\nHost: %s:%d\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n",
                                  path && *path ? path : "/", g_uri_get_host(uri), g_uri_get_port(uri), length);
  GOutputStream *output = g_io_stream_get_output_stream(G_IO_STREAM(connection));
  gboolean ok = g_output_stream_write_all(output, header, strlen(header), NULL, NULL, &error) &&
                g_output_stream_write_all(output, payload, length, NULL, NULL, &error) &&
                g_output_stream_flush(output, NULL, &error);
  GInputStream *input = g_io_stream_get_input_stream(G_IO_STREAM(connection));
  gchar buffer[8192];
  gssize received;
  gsize total = 0;
  while (ok && (received = g_input_stream_read(input, buffer, sizeof buffer, NULL, &error)) > 0) {
    total += received;
    if (total > length + 64 * 1024 || fwrite(buffer, 1, received, stdout) != (gsize)received) ok = FALSE;
  }
  if (error) { g_printerr("stream-failed=%s\n", error->message); g_error_free(error); ok = FALSE; }
  g_io_stream_close(G_IO_STREAM(connection), NULL, NULL);
  g_free(header); g_free(payload); g_uri_unref(uri);
  g_object_unref(connection); g_object_unref(client);
  return ok ? 0 : 8;
}
