// opencode-proxy —— opencode.ai/inference 反代（仿 xopl.dpdns.org 写法）
// 用途：用 Cloudflare workerd 的 TLS 栈访问 opencode，绕过 curl/python/node 的指纹门控
const UPSTREAM = "https://opencode.ai/inference/openai/v1";

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // 路径映射：/v1/* -> UPSTREAM/*（去掉 /v1 前缀，opencode 的 base 已含 openai/v1）
    let path = url.pathname;
    if (path.startsWith("/v1/")) path = path.slice(3); // 保留 /v1 里的版本？见下方注释
    // opencode.ai/inference/openai/v1 是 OpenAI 兼容端点，客户端通常请求 /v1/chat/completions
    // 我们挂载点自身就是 /v1，所以客户端发 /v1/chat/completions 时应转发为 /chat/completions
    if (path.startsWith("/v1/")) path = path.slice(4);
    const target = new URL(UPSTREAM);
    target.pathname = target.pathname + path;
    target.search = url.search;

    // WebSocket 透传（opencode 不一定用，保留兼容）
    if (request.headers.get("Upgrade") === "websocket") {
      return fetch(new Request(target.toString(), request));
    }

    const newReq = new Request(target.toString(), request);

    try {
      const res = await fetch(newReq, {
        method: request.method,
        headers: newReq.headers,
        body: request.body,
        redirect: "manual",
      });

      const headers = new Headers(res.headers);
      headers.delete("content-length");
      headers.delete("content-encoding");
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Credentials", "true");
      headers.set("Connection", "keep-alive");
      headers.set("X-Accel-Buffering", "no");

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers,
      });
    } catch (err) {
      return new Response("Bad Gateway: " + err.message, {
        status: 502,
      });
    }
  },
};
