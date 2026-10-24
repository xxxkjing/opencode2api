# opencode2api —— 部署即用
# 架构：容器内 opencode serve（官方 CLI）当模型后端 + 自写 Node 网关（OpenAI 兼容）
FROM node:24-slim

WORKDIR /app

# 1) 基础工具（slim 镜像没有 curl，entrypoint 健康检查需要）
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# 2) 官方 opencode CLI（bun 编译二进制）
RUN npm install -g opencode-ai@1.19.4 --loglevel=error \
    && node $(npm root -g)/opencode-ai/postinstall.mjs \
    && mv $(npm root -g)/opencode-ai/bin/opencode.exe /usr/local/bin/opencode

# 3) 预装 opencode serve 按需依赖到缓存（避免运行时联网 npm install）
#    列表来自运行观察（MITM）：express 系 + @opencode-ai/sdk
RUN for pkg in body-parser cors axios cross-spawn express isexe jest path-key shebang-command shebang-regex supertest which; do \
      mkdir -p /root/.cache/opencode/packages/$pkg && cd /root/.cache/opencode/packages/$pkg \
      && npm install $pkg --ignore-scripts --no-audit --no-fund --loglevel=error; \
    done \
    && mkdir -p /root/.cache/opencode/packages/@opencode-ai/sdk \
    && cd /root/.cache/opencode/packages/@opencode-ai/sdk \
    && npm install @opencode-ai/sdk --ignore-scripts --no-audit --no-fund --loglevel=error

# 4) CLI 内置模型表（匿名免费模式需要：serve 不联网也能列出模型）
COPY models.json /root/.cache/opencode/models.json

# 5) 网关（自写，OpenAI 兼容转换）
COPY gateway/gateway.js /app/gateway.js
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# 6) 认证：两种方式二选一
#    a) OAuth（推荐，不用申请 key）：把本机 ~/.local/share/opencode/auth.json 挂载到 /app/auth.json
#    b) API key（旧方式）：设 OPENCODE_API_KEY=oc_sk_xxx 环境变量
#    若两者都无，CLI 以匿名（Bearer public）模式运行——官方支持，免费模型可用（模型表来自 COPY 的 models.json）
ENV OPENCODE_AUTH_FILE=/app/auth.json

# 运行时配置
ENV OPENCODE_SERVER_URL=http://127.0.0.1:4096
ENV PORT=10000
EXPOSE 10000

# entrypoint: 先起 opencode serve，再起网关
CMD ["/app/entrypoint.sh"]
