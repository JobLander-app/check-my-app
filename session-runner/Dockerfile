# CHE-464: one team's Shopify session browser (runner.mjs). The base is the
# one the CHE-461 spike ran Chrome on without a challenge (and the extension
# runner's): Ubuntu noble with Xvfb, fonts and an unprivileged user under which
# Chrome's sandbox works. Chrome itself is google-chrome-stable from Google's
# repository, as on the VM this replaced — never the base's Chromium for Testing.
FROM mcr.microsoft.com/playwright:v1.58.2-noble
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg xvfb fonts-liberation fonts-noto-color-emoji \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
 && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends google-chrome-stable \
 && rm -rf /var/lib/apt/lists/* \
 && google-chrome-stable --version
WORKDIR /opt/session
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY classify.mjs door.mjs forwarder.mjs jar.mjs jar-rules.mjs lease.mjs probe.mjs runner.mjs session-server.mjs viewer.mjs ./
USER pwuser
ENV HOME=/tmp/home
EXPOSE 9090 9091
CMD ["node", "runner.mjs"]
