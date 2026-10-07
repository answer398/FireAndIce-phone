FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY server/package*.json ./server/
RUN npm --prefix server ci --omit=dev && npm cache clean --force
COPY common ./common
COPY games ./games
COPY img ./img
COPY index.html CNAME ./
COPY server/src ./server/src
RUN groupadd --system app && useradd --system --gid app --home-dir /app app \
  && chown -R app:app /app
USER app
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server/src/index.js"]
