FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
VOLUME ["/app/data"]
EXPOSE 3000
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server.ts"]
