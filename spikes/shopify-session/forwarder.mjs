// CHE-464: tinyproxy's job inside a team's session container. Chrome cannot
// carry proxy credentials in --proxy-server, so it is pointed at this
// credential-free forwarder on loopback, which sends everything on to the
// residential upstream (IPRoyal, the `session-host-proxy` URL) with the
// credentials added. Nothing is forwarded anywhere else: there is no local
// exception, so a page cannot reach this container's own ports through it.
//
// Two kinds of request, as tinyproxy took them:
//   CONNECT host:port   → a tunnel through the upstream (every https page)
//   GET http://…        → the request, through the upstream as an absolute URI
//
// The upstream's own refusal is passed back unchanged. That is how the probe
// tells "the proxy is out of traffic" (402) or "it refuses our login" (407)
// from a session that ended (classify.mjs proxyState, CHE-453).

import http from "node:http";
import net from "node:net";

const HEAD_LIMIT = 16 * 1024;

// http://user:pass@host:port → where to send, and the header that proves who we are.
export function upstreamOf(url) {
  const u = new URL(url);
  if (u.protocol !== "http:" || !u.hostname || !u.port || !u.username) {
    throw new Error("The proxy URL is not http://user:pass@host:port");
  }
  const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
  return { host: u.hostname, port: Number(u.port), auth: `Basic ${auth}` };
}

export async function startForwarder({ upstream, port = 3128, host = "127.0.0.1", log = (line) => console.log(`[forwarder] ${line}`) }) {
  const up = upstreamOf(upstream);

  const server = http.createServer((req, res) => {
    // A forward proxy is asked for absolute addresses only.
    if (!/^http:\/\//i.test(req.url ?? "")) {
      res.writeHead(400).end();
      return;
    }
    const headers = { ...req.headers, "proxy-authorization": up.auth };
    delete headers["proxy-connection"];
    const out = http.request({ host: up.host, port: up.port, method: req.method, path: req.url, headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    out.setTimeout(60_000, () => out.destroy(new Error("upstream timeout")));
    out.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(out);
  });

  server.on("connect", (req, client, head) => {
    const target = String(req.url ?? "");
    if (!/^[A-Za-z0-9.-]+:\d{1,5}$/.test(target)) {
      client.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    const tunnel = net.connect(up.port, up.host, () => {
      tunnel.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: ${up.auth}\r\n\r\n`);
    });
    tunnel.setTimeout(60_000, () => tunnel.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (data) => {
      buffered = Buffer.concat([buffered, data]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > HEAD_LIMIT) tunnel.destroy();
        return;
      }
      tunnel.removeListener("data", onData);
      tunnel.setTimeout(0);
      const status = buffered.subarray(0, buffered.indexOf("\r\n")).toString("latin1");
      const code = Number(/^HTTP\/1\.[01] (\d{3})/.exec(status)?.[1] ?? 502);
      if (code !== 200) {
        // The upstream's own answer, so Chrome and the probe see why.
        log(`upstream refused a tunnel: ${code}`);
        client.end(`HTTP/1.1 ${code} Upstream Refused\r\n\r\n`);
        tunnel.destroy();
        return;
      }
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      const rest = buffered.subarray(end + 4);
      if (rest.length) client.write(rest);
      if (head?.length) tunnel.write(head);
      tunnel.pipe(client);
      client.pipe(tunnel);
    };
    tunnel.on("data", onData);
    tunnel.on("error", () => client.destroy());
    tunnel.on("close", () => client.destroy());
    client.on("error", () => tunnel.destroy());
    client.on("close", () => tunnel.destroy());
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
